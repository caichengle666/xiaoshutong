import { familyAuthHeaders } from './cloudSync.js';
export function normalizeOpenAIUrl(url) {
  const clean = (url || '').trim().replace(/\/+$/, '');
  if (!clean) return 'https://api.openai.com/v1/chat/completions';
  return clean.endsWith('/v1') ? `${clean}/chat/completions` : clean;
}

function openAIModelsUrl(url) {
  return normalizeOpenAIUrl(url).replace(/\/chat\/completions\/?$/, '/models');
}

function geminiPayloadToMessages(payload) {
  const parts = payload?.contents?.[0]?.parts || [];
  const content = parts.map(part => {
    if (part.text) return { type: 'text', text: part.text };
    if (part.inlineData?.data) {
      return {
        type: 'image_url',
        image_url: { url: `data:${part.inlineData.mimeType || 'image/jpeg'};base64,${part.inlineData.data}` }
      };
    }
    return null;
  }).filter(Boolean);

  return [{ role: 'user', content: content.length === 1 && content[0].type === 'text' ? content[0].text : content }];
}

// 经本站 Worker 同源代理请求 OpenAI 兼容接口（绕开中转站的浏览器 CORS 限制）。
// Worker 只做透传：目标白名单校验在服务端做，这里只负责把上游 JSON 取出来。
async function requestViaProxy({ target, apiKey, method, body }) {
  const response = await fetch('/api/llm', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await familyAuthHeaders()) },
    body: JSON.stringify({ target, apiKey, method, body: body ?? null })
  });
  const envelope = await response.json();
  if (!envelope || envelope.ok !== true) {
    throw new Error(envelope?.error || `代理请求失败 (${response.status})`);
  }
  return envelope.data;
}

// Cloudflare Workers AI：走本站 /api/ai，不需要 API Key
export const CLOUDFLARE_PROVIDER = 'cloudflare';
export const CLOUDFLARE_DEFAULT_MODEL = '@cf/google/gemma-4-26b-a4b-it';
export const CLOUDFLARE_MODELS = [
  { id: '@cf/google/gemma-4-26b-a4b-it', label: 'Gemma 4（推荐，能看图）', vision: true },
  { id: '@cf/mistralai/mistral-small-3.1-24b-instruct', label: 'Mistral Small 3.1（能看图）', vision: true },
  { id: '@cf/qwen/qwen3-30b-a3b-fp8', label: 'Qwen3 30B（中文好，只能文字）', vision: false }
];

async function callWorkersAI({ model, payload }) {
  try {
    const response = await fetch('/api/ai', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await familyAuthHeaders()) },
      body: JSON.stringify({ model: model || CLOUDFLARE_DEFAULT_MODEL, messages: geminiPayloadToMessages(payload), temperature: 0.4 })
    });
    let data = null;
    try { data = await response.json(); } catch { /* 非 JSON */ }
    if (!data?.ok) {
      if (response.status === 404 || data === null) return { error: '当前网址没有 Cloudflare AI 服务（本地 npm run dev 不可用，请用部署后的网址）' };
      return { error: data.error || `请求失败 (${response.status})` };
    }
    return data.text ? { text: data.text } : { error: 'AI 没有返回内容' };
  } catch {
    return { error: '网络错误：连不上本站 AI 服务，请检查网络' };
  }
}

export async function getWorkersAIStatus() {
  try {
    const response = await fetch('/api/ai', { headers: { 'Content-Type': 'application/json', ...(await familyAuthHeaders()) } });
    const data = await response.json();
    return data?.ok ? data : { error: data?.error || `请求失败 (${response.status})` };
  } catch {
    return { error: '连不上本站 AI 服务' };
  }
}

export async function callLLM({ provider, baseUrl, apiKey, model, payload, viaProxy }) {
  if (provider === CLOUDFLARE_PROVIDER) return callWorkersAI({ model, payload });
  if (!apiKey) return { error: "请配置 API Key" };

  const isGemini = provider === 'gemini';
  const useProxy = !isGemini && !!viaProxy;
  try {
    let data;
    if (useProxy) {
      data = await requestViaProxy({
        target: normalizeOpenAIUrl(baseUrl),
        apiKey,
        method: 'POST',
        body: { model, messages: geminiPayloadToMessages(payload), temperature: 0.4 }
      });
    } else {
      const response = await fetch(
        isGemini
          ? `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`
          : normalizeOpenAIUrl(baseUrl),
        isGemini
          ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }
          : {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
              body: JSON.stringify({ model, messages: geminiPayloadToMessages(payload), temperature: 0.4 })
            }
      );
      data = await response.json();
      if (!response.ok) return { error: data?.error?.message || `请求失败 (${response.status})` };
    }
    if (data.error) return { error: data.error?.message || `请求失败` };
    const result = isGemini
      ? { text: data.candidates?.[0]?.content?.parts?.[0]?.text }
      : { text: data.choices?.[0]?.message?.content };
    if (!result.text) return { error: "AI 没有返回内容" };
    return result;
  } catch (error) {
    // 代理模式的错误信息已由服务端组装好（上游 401/429 等），直接透出
    if (useProxy) return { error: error?.message || "代理请求失败" };
    const geminiMode = provider === 'gemini';
    return {
      error: geminiMode
        ? "网络错误：连不上 Google 接口（国内直连不可用），请改用「OpenAI 兼容」模式填中转地址"
        : "网络错误：接口地址不可达，或被浏览器跨域拦截（中转站需放行 CORS，或开启本站代理）"
    };
  }
}

export async function listModels({ provider, baseUrl, apiKey, viaProxy }) {
  if (provider === CLOUDFLARE_PROVIDER) return { models: CLOUDFLARE_MODELS.map(item => item.id) };
  if (!apiKey) return { error: '请配置 API Key' };

  const isGemini = provider === 'gemini';
  const useProxy = !isGemini && !!viaProxy;
  try {
    let data;
    if (useProxy) {
      data = await requestViaProxy({ target: openAIModelsUrl(baseUrl), apiKey, method: 'GET' });
    } else {
      const response = await fetch(
        isGemini
          ? `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`
          : openAIModelsUrl(baseUrl),
        isGemini
          ? { headers: { 'Content-Type': 'application/json' } }
          : { headers: { 'Authorization': `Bearer ${apiKey}` } }
      );
      data = await response.json();
      if (!response.ok) return { error: data?.error?.message || `请求失败 (${response.status})` };
    }
    if (data.error) return { error: data.error?.message || `请求失败` };

    const models = isGemini
      ? (data.models || [])
          .filter(item => item.supportedGenerationMethods?.includes('generateContent'))
          .map(item => String(item.name || '').replace(/^models\//, ''))
      : (data.data || []).map(item => String(item.id || ''));
    const uniqueModels = [...new Set(models.filter(Boolean))].sort((left, right) => left.localeCompare(right));
    return uniqueModels.length ? { models: uniqueModels } : { error: '接口没有返回可用模型' };
  } catch {
    if (useProxy) return { error: '代理请求失败，请检查网络后重试' };
    const geminiMode = provider === 'gemini';
    return {
      error: geminiMode
        ? '无法拉取模型：连不上 Google 接口（国内直连不可用），请改用「OpenAI 兼容」模式填中转地址'
        : '无法拉取模型：请检查接口地址、网络，或中转站是否放行了浏览器跨域（CORS）；也可开启本站代理'
    };
  }
}
