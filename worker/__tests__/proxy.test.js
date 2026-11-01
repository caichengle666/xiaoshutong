import { describe, expect, it } from 'vitest';
import { isProxyTargetAllowed } from '../index.js';

describe('isProxyTargetAllowed 代理目标白名单', () => {
    it('放行 OpenAI 兼容的两个接口', () => {
        expect(isProxyTargetAllowed('https://oc2.021800.xyz/v1/chat/completions')).toBe(true);
        expect(isProxyTargetAllowed('https://oc2.021800.xyz/v1/models')).toBe(true);
        expect(isProxyTargetAllowed('https://api.openai.com/v1/chat/completions/')).toBe(true);
        expect(isProxyTargetAllowed('http://192.0.2.1:8080/v1/models')).toBe(true);
    });
    it('拦截非接口路径', () => {
        expect(isProxyTargetAllowed('https://oc2.021800.xyz/')).toBe(false);
        expect(isProxyTargetAllowed('https://oc2.021800.xyz/v1')).toBe(false);
        expect(isProxyTargetAllowed('https://example.com/admin')).toBe(false);
        expect(isProxyTargetAllowed('not-a-url')).toBe(false);
        expect(isProxyTargetAllowed('')).toBe(false);
    });
    it('拦截非 http(s) 协议', () => {
        expect(isProxyTargetAllowed('ftp://example.com/v1/models')).toBe(false);
        expect(isProxyTargetAllowed('file:///etc/passwd')).toBe(false);
    });
    it('拦截内网与本地地址（防 SSRF）', () => {
        expect(isProxyTargetAllowed('http://localhost/v1/models')).toBe(false);
        expect(isProxyTargetAllowed('http://127.0.0.1/v1/models')).toBe(false);
        expect(isProxyTargetAllowed('http://10.0.0.5/v1/models')).toBe(false);
        expect(isProxyTargetAllowed('http://192.168.1.1/v1/models')).toBe(false);
        expect(isProxyTargetAllowed('http://172.20.0.1/v1/models')).toBe(false);
        expect(isProxyTargetAllowed('http://169.254.169.254/v1/models')).toBe(false);
    });
});

import worker, { isSameOrigin, isSyncKeyValid, syncRateLimited } from '../index.js';

describe('D1 云同步保护', () => {
    it('同步 key 必须是 64 位十六进制', () => {
        expect(isSyncKeyValid('a'.repeat(64))).toBe(true);
        expect(isSyncKeyValid('abc')).toBe(false);
        expect(isSyncKeyValid('')).toBe(false);
    });
    it('拒绝跨站 Origin', () => {
        expect(isSameOrigin(new Request('https://a.com/api/sync', { headers: { Origin: 'https://evil.com' } }))).toBe(false);
        expect(isSameOrigin(new Request('https://a.com/api/sync', { headers: { Origin: 'https://a.com' } }))).toBe(true);
    });
    it('按 IP 限流', () => {
        for (let i = 0; i < 2; i++) expect(syncRateLimited('ip-t', 1000 + i, 2)).toBe(false);
        expect(syncRateLimited('ip-t', 1005, 2)).toBe(true);
    });
    it('没绑定 D1 时给出明确提示', async () => {
        const res = await worker.fetch(new Request('https://a.com/api/sync'), {});
        expect(res.status).toBe(503);
    });
});

import { estimateNeurons, extractWorkersAIText, stripThinking, WORKERS_AI_MODELS } from '../index.js';

function fakeUsageDb() {
    const rows = new Map();
    return {
        rows,
        prepare(sql) {
            const stmt = {
                args: [],
                bind(...args) { stmt.args = args; return stmt; },
                async run() {
                    if (sql.startsWith('INSERT INTO ai_usage')) {
                        const [day, neurons] = stmt.args;
                        const row = rows.get(day) || { neurons: 0, requests: 0 };
                        rows.set(day, { neurons: row.neurons + neurons, requests: row.requests + 1 });
                    }
                    return {};
                },
                async first() { return rows.get(stmt.args[0]) || null; },
            };
            return stmt;
        },
    };
}

function aiRequest(body, origin = 'https://kid.example') {
    return new Request('https://kid.example/api/ai', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: origin, 'CF-Connecting-IP': `ip-${Math.random()}` },
        body: JSON.stringify(body),
    });
}

describe('Cloudflare Workers AI（免 Key）', () => {
    it('估算 neurons 和解析返回', () => {
        const id = '@cf/google/gemma-4-26b-a4b-it';
        expect(estimateNeurons(id, { prompt_tokens: 1_000_000, completion_tokens: 0 })).toBe(WORKERS_AI_MODELS[id].input);
        expect(extractWorkersAIText({ choices: [{ message: { content: '你好' } }] })).toBe('你好');
        expect(extractWorkersAIText({ response: 'hi' })).toBe('hi');
        expect(stripThinking('<think>想一想</think>答案')).toBe('答案');
    });

    it('正常调用并记录用量，未知模型回落到默认模型', async () => {
        const calls = [];
        const env = {
            DB: fakeUsageDb(),
            AI: { async run(model, input) { calls.push({ model, input }); return { choices: [{ message: { content: '连接正常' } }], usage: { prompt_tokens: 100, completion_tokens: 10 } }; } },
        };
        const res = await worker.fetch(aiRequest({ model: 'evil/model', messages: [{ role: 'user', content: 'hi' }] }), env);
        const data = await res.json();
        expect(data).toMatchObject({ ok: true, text: '连接正常' });
        expect(calls[0].model).toBe('@cf/google/gemma-4-26b-a4b-it');
        expect([...env.DB.rows.values()][0].requests).toBe(1);
    });

    it('超过每日额度就停止调用', async () => {
        const db = fakeUsageDb();
        db.rows.set(new Date().toISOString().slice(0, 10), { neurons: 99999, requests: 5 });
        let called = false;
        const env = { DB: db, AI: { async run() { called = true; return {}; } } };
        const res = await worker.fetch(aiRequest({ messages: [{ role: 'user', content: 'hi' }] }), env);
        expect(res.status).toBe(429);
        expect(called).toBe(false);
    });

    it('拒绝跨站调用、文字模型收到图片', async () => {
        const env = { DB: fakeUsageDb(), AI: { async run() { return { response: 'x' }; } } };
        expect((await worker.fetch(aiRequest({ messages: [{ role: 'user', content: 'hi' }] }, 'https://evil.example'), env)).status).toBe(403);
        const img = [{ role: 'user', content: [{ type: 'text', text: '看图' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AA' } }] }];
        expect((await worker.fetch(aiRequest({ model: '@cf/qwen/qwen3-30b-a3b-fp8', messages: img }), env)).status).toBe(400);
    });

    it('没有绑定 AI 时提示重新部署', async () => {
        const res = await worker.fetch(aiRequest({ messages: [{ role: 'user', content: 'hi' }] }), { DB: fakeUsageDb() });
        expect(res.status).toBe(503);
    });
});
