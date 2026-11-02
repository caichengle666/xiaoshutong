// Cloudflare Worker 入口：
// 1. /api/llm  —— OpenAI 兼容接口的同源代理（解决第三方中转站不开放浏览器 CORS 的问题）
// 2. /api/sync —— D1 云同步（孩子档案、生字本、错题本），用家庭同步码区分家庭，见 handleSync
// 3. /api/ai   —— Cloudflare Workers AI（免 Key，用账号每天的免费额度），见 handleWorkersAI
// 4. 其他请求  —— 交给静态资源（SPA，index.html 兜底）

const ALLOWED_PATH_SUFFIXES = ['/chat/completions', '/models'];
const MAX_BODY_BYTES = 8 * 1024 * 1024;

function isPrivateHostname(hostname) {
    const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
    if (!h || h === 'localhost' || h === '::1' || h === '0.0.0.0' || h === '169.254.169.254') return true;
    if (/^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h)) return true;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
    if (/^::ffff:(127\.|10\.|192\.168\.)/.test(h)) return true;
    return false;
}

// 代理目标白名单：只允许 OpenAI 兼容的两个接口路径，防止被当成通用代理滥用。
export function isProxyTargetAllowed(target) {
    let url;
    try {
        url = new URL(String(target || ''));
    } catch {
        return false;
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
    if (isPrivateHostname(url.hostname)) return false;
    const path = url.pathname.replace(/\/+$/, '');
    return ALLOWED_PATH_SUFFIXES.some(suffix => path === suffix || path.endsWith(suffix));
}

function corsHeaders() {
    return {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, X-Sync-Key',
    };
}

function jsonEnvelope(obj) {
    return new Response(JSON.stringify(obj), {
        status: 200,
        headers: { 'Content-Type': 'application/json', ...corsHeaders() },
    });
}

async function handleLlmProxy(request, env) {
    if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: corsHeaders() });
    }
    if (!isSameOrigin(request)) return jsonEnvelope({ ok: false, status: 403, error: '不允许跨站调用' });
    const auth = await authorizeFamily(request, env);
    if (!auth.ok) return jsonEnvelope({ ok: false, status: auth.status, error: auth.error });
    if (request.method !== 'POST') {
        return jsonEnvelope({ ok: false, status: 405, error: '仅支持 POST' });
    }
    let payload = null;
    try {
        payload = await request.json();
    } catch {
        return jsonEnvelope({ ok: false, status: 400, error: '请求体不是合法 JSON' });
    }
    const { target, apiKey, method, body } = payload || {};
    if (!target || !isProxyTargetAllowed(target)) {
        return jsonEnvelope({ ok: false, status: 400, error: '不允许的代理目标' });
    }
    if (!apiKey || typeof apiKey !== 'string') {
        return jsonEnvelope({ ok: false, status: 400, error: '缺少 API Key' });
    }
    const upstreamMethod = method === 'GET' ? 'GET' : 'POST';
    const headers = { Authorization: `Bearer ${apiKey}` };
    let upstreamBody;
    if (upstreamMethod === 'POST') {
        headers['Content-Type'] = 'application/json';
        const raw = typeof body === 'string' ? body : JSON.stringify(body ?? {});
        if (raw.length > MAX_BODY_BYTES) {
            return jsonEnvelope({ ok: false, status: 413, error: '请求体过大' });
        }
        upstreamBody = raw;
    }
    let upstream;
    try {
        upstream = await fetch(target, { method: upstreamMethod, headers, body: upstreamBody });
    } catch {
        return jsonEnvelope({ ok: false, status: 502, error: '上游连接失败' });
    }
    const text = await upstream.text();
    let data = null;
    try {
        data = JSON.parse(text);
    } catch {
        // 上游没返回 JSON，按失败处理
    }
    const upstreamError = data && data.error
        ? (typeof data.error === 'string' ? data.error : data.error.message)
        : null;
    if (!upstream.ok || upstreamError || data === null) {
        return jsonEnvelope({ ok: false, status: upstream.status, error: upstreamError || `上游返回 ${upstream.status}` });
    }
    return jsonEnvelope({ ok: true, status: upstream.status, data });
}


// ---------------- D1 云同步 ----------------
// 设计：零服务端配置。家长在每台设备的设置里填同一个“家庭同步码”，
// 前端把它做 SHA-256 得到 X-Sync-Key 发过来；服务端再 hash 一次作为 family 主键，
// 数据库里不保存可直接使用的同步码。每个孩子的工作区是一整行 JSON，按 updatedAt 后写者胜。
// 表在第一次请求时自动建好；D1 数据库由 wrangler deploy 按 wrangler.jsonc 的 binding 自动创建。

const SYNC_MAX_BYTES = 1_800_000; // D1 单行上限约 2MB，留余量
const SYNC_RATE_PER_MINUTE = 120;
const PROFILE_ID_RE = /^[A-Za-z0-9_\-]{1,64}$/;
let schemaReady = null;

function syncJson(obj, status = 200) {
    return new Response(JSON.stringify(obj), {
        status,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
}

async function sha256Hex(text) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export function isSyncKeyValid(key) {
    return /^[a-f0-9]{64}$/.test(String(key || ''));
}

export function isSameOrigin(request) {
    const origin = request.headers.get('Origin');
    if (!origin) return true;
    try {
        return new URL(origin).host === new URL(request.url).host;
    } catch {
        return false;
    }
}

const syncHits = new Map();
export function syncRateLimited(ip, now = Date.now(), limit = SYNC_RATE_PER_MINUTE) {
    const list = (syncHits.get(ip) || []).filter(t => t > now - 60_000);
    list.push(now);
    syncHits.set(ip, list);
    if (syncHits.size > 5000) syncHits.clear();
    return list.length > limit;
}

function ensureSchema(db) {
    if (!schemaReady) {
        schemaReady = (async () => {
            await db.prepare(
                'CREATE TABLE IF NOT EXISTS workspaces (family TEXT NOT NULL, profile_id TEXT NOT NULL, updated_at TEXT NOT NULL, device TEXT, data TEXT NOT NULL, PRIMARY KEY (family, profile_id))'
            ).run();
            await db.prepare(
                'CREATE TABLE IF NOT EXISTS workspace_history (id INTEGER PRIMARY KEY AUTOINCREMENT, family TEXT NOT NULL, profile_id TEXT NOT NULL, updated_at TEXT NOT NULL, device TEXT, data TEXT NOT NULL, saved_at TEXT NOT NULL)'
            ).run();
            await db.prepare('CREATE INDEX IF NOT EXISTS workspace_history_lookup ON workspace_history (family, profile_id, id)').run();
        })().catch(error => { schemaReady = null; throw error; });
    }
    return schemaReady;
}

// ---------------- 云端历史版本 ----------------
// 每次云端数据被覆盖前，把旧版本存一份。同一台设备连续保存时最多 20 分钟存一份，
// 换了设备一定存（两台设备互相覆盖时能找回）。每个孩子保留最近 HISTORY_KEEP 份。
export const HISTORY_KEEP = 30;
export const HISTORY_MIN_GAP_MS = 20 * 60 * 1000;

export function shouldSnapshot(existing, nextDevice, lastSavedAt, now = Date.now()) {
    if (!existing) return false;
    if ((existing.device || '') !== (nextDevice || '')) return true;
    if (!lastSavedAt) return true;
    return now - Date.parse(lastSavedAt) >= HISTORY_MIN_GAP_MS;
}

async function snapshotBeforeOverwrite(db, family, profileId, existing, nextDevice) {
    const last = await db
        .prepare('SELECT saved_at FROM workspace_history WHERE family = ? AND profile_id = ? ORDER BY id DESC LIMIT 1')
        .bind(family, profileId)
        .first();
    if (!shouldSnapshot(existing, nextDevice, last?.saved_at)) return;
    await db.prepare(
        'INSERT INTO workspace_history (family, profile_id, updated_at, device, data, saved_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)'
    ).bind(family, profileId, existing.updated_at, existing.device || '', existing.data, new Date().toISOString()).run();
    await db.prepare(
        `DELETE FROM workspace_history WHERE family = ?1 AND profile_id = ?2 AND id NOT IN
         (SELECT id FROM workspace_history WHERE family = ?1 AND profile_id = ?2 ORDER BY id DESC LIMIT ?3)`
    ).bind(family, profileId, HISTORY_KEEP).run();
}

async function handleHistory(request, env, family, parts) {
    if (request.method !== 'GET') return syncJson({ ok: false, error: '仅支持 GET' }, 405);
    const profileId = decodeURIComponent(parts[0] || '');
    if (!PROFILE_ID_RE.test(profileId)) return syncJson({ ok: false, error: '档案 ID 不合法' }, 400);
    if (parts.length === 1) {
        const { results } = await env.DB
            .prepare('SELECT id, updated_at, device, saved_at, length(data) AS size FROM workspace_history WHERE family = ? AND profile_id = ? ORDER BY id DESC')
            .bind(family, profileId)
            .all();
        return syncJson({
            ok: true,
            items: (results || []).map(row => ({ id: row.id, updatedAt: row.updated_at, device: row.device, savedAt: row.saved_at, size: row.size }))
        });
    }
    const id = Number(parts[1]);
    if (!Number.isInteger(id) || id <= 0) return syncJson({ ok: false, error: '版本 ID 不合法' }, 400);
    const row = await env.DB
        .prepare('SELECT id, updated_at, data FROM workspace_history WHERE family = ? AND profile_id = ? AND id = ?')
        .bind(family, profileId, id)
        .first();
    if (!row) return syncJson({ ok: false, error: '这个历史版本不存在' }, 404);
    return syncJson({ ok: true, id: row.id, updatedAt: row.updated_at, data: JSON.parse(row.data) });
}

// ---------------- 家长主人码（防止外人用本站 AI / 同步） ----------------
// 零配置：第一个用“家庭同步码”访问本站的家庭自动成为主人（记在 D1 的 site_owner 表），
// 之后 /api/ai、/api/llm、/api/sync 只接受这个家庭的同步码。
// 想换主人：Cloudflare 控制台 → D1 → 执行 DELETE FROM site_owner; 然后用新同步码打开一次。
let ownerSchemaReady = null;
function ensureOwnerSchema(db) {
    if (!ownerSchemaReady) {
        ownerSchemaReady = db.prepare('CREATE TABLE IF NOT EXISTS site_owner (id INTEGER PRIMARY KEY CHECK (id = 1), family TEXT NOT NULL, created_at TEXT NOT NULL)')
            .run().catch(error => { ownerSchemaReady = null; throw error; });
    }
    return ownerSchemaReady;
}

export async function familyForKey(syncKey) {
    return sha256Hex(`family:${syncKey}`);
}

// 返回 { ok: true, family } 或 { ok: false, status, error }
export async function authorizeFamily(request, env) {
    if (!env.DB) return { ok: false, status: 503, error: '服务器还没有绑定 D1 数据库（重新部署一次即可自动创建）' };
    const syncKey = request.headers.get('X-Sync-Key');
    if (!isSyncKeyValid(syncKey)) return { ok: false, status: 401, error: '请先在「设置」里填写家庭同步码，才能使用 AI 和云同步' };
    const family = await familyForKey(syncKey);
    await ensureOwnerSchema(env.DB);
    let row = await env.DB.prepare('SELECT family FROM site_owner WHERE id = 1').first();
    if (!row) {
        // 老数据兼容：已经有同步数据的家庭优先成为主人
        await ensureSchema(env.DB);
        const existing = await env.DB.prepare('SELECT family FROM workspaces LIMIT 1').first();
        await env.DB.prepare('INSERT OR IGNORE INTO site_owner (id, family, created_at) VALUES (1, ?1, ?2)')
            .bind(existing?.family || family, new Date().toISOString()).run();
        row = await env.DB.prepare('SELECT family FROM site_owner WHERE id = 1').first();
    }
    if (row?.family !== family) return { ok: false, status: 403, error: '家庭同步码不对：这个网站只给自家人用' };
    return { ok: true, family };
}

async function handleSync(request, env, url) {
    if (!env.DB) return syncJson({ ok: false, error: '服务器还没有绑定 D1 数据库（重新部署一次即可自动创建）' }, 503);
    if (!isSameOrigin(request)) return syncJson({ ok: false, error: '不允许跨站调用' }, 403);
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    if (syncRateLimited(ip)) return syncJson({ ok: false, error: '同步太频繁，请稍后再试' }, 429);
    const auth = await authorizeFamily(request, env);
    if (!auth.ok) return syncJson({ ok: false, error: auth.error }, auth.status);
    const family = auth.family;
    await ensureSchema(env.DB);

    const rest = url.pathname.replace(/^\/api\/sync\/?/, '').replace(/\/+$/, '');
    if (rest.startsWith('history/')) return handleHistory(request, env, family, rest.split('/').slice(1));

    if (request.method === 'GET' && !rest) {
        const { results } = await env.DB
            .prepare('SELECT profile_id, updated_at, data FROM workspaces WHERE family = ?')
            .bind(family)
            .all();
        const items = (results || []).map(row => {
            let data = null;
            try { data = JSON.parse(row.data); } catch { /* 坏数据跳过 */ }
            return { profileId: row.profile_id, updatedAt: row.updated_at, data };
        }).filter(item => item.data !== null);
        return syncJson({ ok: true, items });
    }

    if (request.method === 'PUT' && rest) {
        const profileId = decodeURIComponent(rest);
        if (!PROFILE_ID_RE.test(profileId)) return syncJson({ ok: false, error: '档案 ID 不合法' }, 400);
        const raw = await request.text();
        if (new TextEncoder().encode(raw).length > SYNC_MAX_BYTES) return syncJson({ ok: false, error: '这个孩子的数据太大，超过云同步上限' }, 413);
        let body;
        try { body = JSON.parse(raw); } catch { return syncJson({ ok: false, error: '请求体不是合法 JSON' }, 400); }
        const updatedAt = String(body?.updatedAt || '');
        if (!updatedAt || Number.isNaN(Date.parse(updatedAt)) || body.data === undefined) {
            return syncJson({ ok: false, error: '缺少 updatedAt 或 data' }, 400);
        }
        const data = JSON.stringify(body.data);
        const device = String(body.device || '').slice(0, 64);
        const existing = await env.DB
            .prepare('SELECT updated_at, device, data FROM workspaces WHERE family = ? AND profile_id = ?')
            .bind(family, profileId)
            .first();
        if (existing && updatedAt > existing.updated_at) {
            await snapshotBeforeOverwrite(env.DB, family, profileId, existing, device);
        }
        // 只有比云端新才覆盖（后写者胜），旧数据不会冲掉新数据
        await env.DB.prepare(
            `INSERT INTO workspaces (family, profile_id, updated_at, device, data) VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT (family, profile_id) DO UPDATE SET updated_at = excluded.updated_at, device = excluded.device, data = excluded.data
             WHERE excluded.updated_at > workspaces.updated_at`
        ).bind(family, profileId, updatedAt, device, data).run();
        const row = await env.DB
            .prepare('SELECT updated_at, data FROM workspaces WHERE family = ? AND profile_id = ?')
            .bind(family, profileId)
            .first();
        const applied = row?.updated_at === updatedAt;
        return syncJson({
            ok: true,
            applied,
            updatedAt: row?.updated_at,
            // 云端更新时把云端版本带回去，前端直接采用
            data: applied ? undefined : JSON.parse(row.data)
        });
    }

    return syncJson({ ok: false, error: '接口不存在' }, 404);
}


// ---------------- Cloudflare Workers AI（免 Key） ----------------
// 设备上不用填 Key：Worker 通过 wrangler.jsonc 的 "ai" 绑定直接调用 Workers AI。
// 免费额度是每天 10,000 Neurons（UTC 0 点重置）。为防止被外人刷光或在付费计划上产生费用，
// 这里按模型单价估算每次用量，记在 D1 里，每天超过 AI_DAILY_NEURON_BUDGET 就停。
// 单价来自 https://developers.cloudflare.com/workers-ai/platform/pricing/（neurons / 百万 tokens）。

export const WORKERS_AI_MODELS = {
    '@cf/google/gemma-4-26b-a4b-it': { label: 'Gemma 4（推荐，能看图）', vision: true, input: 9091, output: 27273 },
    '@cf/mistralai/mistral-small-3.1-24b-instruct': { label: 'Mistral Small 3.1（能看图）', vision: true, input: 31876, output: 50488 },
    '@cf/qwen/qwen3-30b-a3b-fp8': { label: 'Qwen3 30B（中文好，只能文字）', vision: false, input: 4625, output: 30475 },
};
export const DEFAULT_WORKERS_AI_MODEL = '@cf/google/gemma-4-26b-a4b-it';
const AI_DAILY_NEURON_BUDGET = 9500;
const AI_RATE_PER_MINUTE = 20;
const AI_MAX_OUTPUT_TOKENS = 2048;
let aiSchemaReady = null;

export function estimateNeurons(modelId, usage) {
    const price = WORKERS_AI_MODELS[modelId];
    if (!price || !usage) return 0;
    const input = Number(usage.prompt_tokens || usage.input_tokens || 0);
    const output = Number(usage.completion_tokens || usage.output_tokens || 0);
    return (input * price.input + output * price.output) / 1_000_000;
}

export function extractWorkersAIText(result) {
    if (!result) return '';
    if (typeof result === 'string') return result;
    const choice = result.choices?.[0];
    const content = choice?.message?.content ?? choice?.text;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) return content.map(part => part?.text || '').join('');
    if (typeof result.response === 'string') return result.response;
    return '';
}

// 有些模型会把思考过程包在 <think> 里，孩子不需要看到
export function stripThinking(text) {
    return String(text || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

const aiHits = new Map();
function aiRateLimited(ip, now = Date.now()) {
    const list = (aiHits.get(ip) || []).filter(t => t > now - 60_000);
    list.push(now);
    aiHits.set(ip, list);
    if (aiHits.size > 5000) aiHits.clear();
    return list.length > AI_RATE_PER_MINUTE;
}

function ensureAiSchema(db) {
    if (!aiSchemaReady) {
        aiSchemaReady = db.prepare('CREATE TABLE IF NOT EXISTS ai_usage (day TEXT PRIMARY KEY, neurons REAL NOT NULL DEFAULT 0, requests INTEGER NOT NULL DEFAULT 0)')
            .run().catch(error => { aiSchemaReady = null; throw error; });
    }
    return aiSchemaReady;
}

function utcDay(now = new Date()) {
    return now.toISOString().slice(0, 10);
}

async function readUsage(env) {
    if (!env.DB) return { neurons: 0, requests: 0 };
    await ensureAiSchema(env.DB);
    const row = await env.DB.prepare('SELECT neurons, requests FROM ai_usage WHERE day = ?').bind(utcDay()).first();
    return { neurons: Number(row?.neurons || 0), requests: Number(row?.requests || 0) };
}

async function addUsage(env, neurons) {
    if (!env.DB) return;
    await env.DB.prepare(
        'INSERT INTO ai_usage (day, neurons, requests) VALUES (?1, ?2, 1) ON CONFLICT (day) DO UPDATE SET neurons = neurons + ?2, requests = requests + 1'
    ).bind(utcDay(), neurons).run();
}

async function handleWorkersAI(request, env) {
    if (!isSameOrigin(request)) return syncJson({ ok: false, error: '不允许跨站调用' }, 403);
    if (!env.AI) return syncJson({ ok: false, error: '服务器还没有绑定 Workers AI（用最新代码重新部署一次即可）' }, 503);
    const auth = await authorizeFamily(request, env);
    if (!auth.ok) return syncJson({ ok: false, error: auth.error }, auth.status);

    if (request.method === 'GET') {
        const usage = await readUsage(env).catch(() => ({ neurons: 0, requests: 0 }));
        return syncJson({
            ok: true,
            defaultModel: DEFAULT_WORKERS_AI_MODEL,
            models: Object.entries(WORKERS_AI_MODELS).map(([id, info]) => ({ id, label: info.label, vision: info.vision })),
            usedToday: Math.round(usage.neurons),
            requestsToday: usage.requests,
            budget: AI_DAILY_NEURON_BUDGET,
        });
    }
    if (request.method !== 'POST') return syncJson({ ok: false, error: '仅支持 GET / POST' }, 405);

    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    if (aiRateLimited(ip)) return syncJson({ ok: false, error: 'AI 请求太频繁，请稍等一分钟' }, 429);

    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) return syncJson({ ok: false, error: '图片太大，请重新拍一张' }, 413);
    let body;
    try { body = JSON.parse(raw); } catch { return syncJson({ ok: false, error: '请求体不是合法 JSON' }, 400); }
    const model = WORKERS_AI_MODELS[body?.model] ? body.model : DEFAULT_WORKERS_AI_MODEL;
    const messages = Array.isArray(body?.messages) ? body.messages : null;
    if (!messages?.length) return syncJson({ ok: false, error: '缺少 messages' }, 400);
    const hasImage = messages.some(msg => Array.isArray(msg?.content) && msg.content.some(part => part?.type === 'image_url'));
    if (hasImage && !WORKERS_AI_MODELS[model].vision) {
        return syncJson({ ok: false, error: '这个模型不支持图片，请在设置里换成能看图的模型' }, 400);
    }

    const usage = await readUsage(env).catch(() => ({ neurons: 0 }));
    if (usage.neurons >= AI_DAILY_NEURON_BUDGET) {
        return syncJson({ ok: false, error: '今天的免费 AI 额度用完了，北京时间早上 8 点后恢复' }, 429);
    }

    let result;
    try {
        result = await env.AI.run(model, {
            messages,
            temperature: typeof body.temperature === 'number' ? body.temperature : 0.4,
            max_tokens: AI_MAX_OUTPUT_TOKENS,
        });
    } catch (error) {
        const message = String(error?.message || '');
        if (/neuron|quota|limit|429|exceed/i.test(message)) {
            return syncJson({ ok: false, error: '今天的免费 AI 额度用完了，北京时间早上 8 点后恢复' }, 429);
        }
        return syncJson({ ok: false, error: `Workers AI 出错：${message.slice(0, 200) || '未知错误'}` }, 502);
    }
    const text = stripThinking(extractWorkersAIText(result));
    // 拿不到 usage 时按保守值估算，避免额度统计偏小
    const neurons = estimateNeurons(model, result?.usage) || 30;
    await addUsage(env, neurons).catch(() => {});
    if (!text) return syncJson({ ok: false, error: 'AI 没有返回内容' }, 502);
    return syncJson({ ok: true, text, model });
}

export default {
    async fetch(request, env) {
        const url = new URL(request.url);
        if (url.pathname === '/api/llm' || url.pathname.startsWith('/api/llm/')) {
            try {
                return await handleLlmProxy(request, env);
            } catch {
                return jsonEnvelope({ ok: false, status: 500, error: '代理服务出错，请稍后再试' });
            }
        }
        if (url.pathname === '/api/sync' || url.pathname.startsWith('/api/sync/')) {
            try {
                return await handleSync(request, env, url);
            } catch {
                return syncJson({ ok: false, error: '云同步服务出错，请稍后再试' }, 500);
            }
        }
        if (url.pathname === '/api/ai') {
            try {
                return await handleWorkersAI(request, env);
            } catch {
                return syncJson({ ok: false, error: 'AI 服务出错，请稍后再试' }, 500);
            }
        }
        return env.ASSETS.fetch(request);
    },
};
