import { afterEach, describe, expect, it } from 'vitest';
import { normalizeOpenAIUrl } from '../llm.js';
import { parsePracticeCheck } from '../transferPractice.js';
import { submitReviewAnswer, summarizeReviewSession } from '../reviewNotebook.js';
import { parseEnglishItems } from '../../components/EnglishDictationMode.jsx';

describe('normalizeOpenAIUrl', () => {
    it('空地址回退到官方默认', () => {
        expect(normalizeOpenAIUrl('')).toBe('https://api.openai.com/v1/chat/completions');
        expect(normalizeOpenAIUrl('   ')).toBe('https://api.openai.com/v1/chat/completions');
    });
    it('/v1 结尾自动补全 chat/completions', () => {
        expect(normalizeOpenAIUrl('https://api.deepseek.com/v1'))
            .toBe('https://api.deepseek.com/v1/chat/completions');
    });
    it('/v1/ 尾斜杠同样能规范化（回归：之前漏掉）', () => {
        expect(normalizeOpenAIUrl('https://api.deepseek.com/v1/'))
            .toBe('https://api.deepseek.com/v1/chat/completions');
    });
    it('已完整的地址保持不变', () => {
        const full = 'https://api.openai.com/v1/chat/completions';
        expect(normalizeOpenAIUrl(full)).toBe(full);
        expect(normalizeOpenAIUrl(full + '/')).toBe(full);
    });
});

describe('parsePracticeCheck', () => {
    it('correct + shouldMaster:true 透出已掌握信号', () => {
        const r = parsePracticeCheck(JSON.stringify({ result: 'correct', feedback: '好', shouldMaster: true }));
        expect(r.result).toBe('correct');
        expect(r.shouldMaster).toBe(true);
    });
    it('wrong 时 shouldMaster 被强制为 false', () => {
        const r = parsePracticeCheck(JSON.stringify({ result: 'wrong', feedback: '差', shouldMaster: true }));
        expect(r.result).toBe('wrong');
        expect(r.shouldMaster).toBe(false);
    });
    it('非法 result 回退为 uncertain', () => {
        const r = parsePracticeCheck(JSON.stringify({ result: 'nope', feedback: '' }));
        expect(r.result).toBe('uncertain');
        expect(r.shouldMaster).toBe(false);
    });
    it('兼容 ```json 代码块包裹', () => {
        const r = parsePracticeCheck('```json\n{"result":"correct","feedback":"棒"}\n```');
        expect(r.result).toBe('correct');
    });
});

function makeReviewState() {
    return {
        mistakes: [{ id: 'm1', subject: '语文', status: '未复习', reviewCount: 0, correctAnswer: '好', originalQuestion: '好' }],
        reviewSessions: [{ id: 's1', mistakeIds: ['m1'], reviewedMistakeIds: [], correctMistakeIds: [], incorrectMistakeIds: [] }],
        reviewAttempts: []
    };
}

describe('submitReviewAnswer shouldMaster', () => {
    it('AI 判定 shouldMaster 时状态为已掌握', () => {
        const r = submitReviewAnswer(makeReviewState(), 's1', 'm1', '好',
            { isCorrect: true, source: 'ai-text', feedback: '全对', shouldMaster: true });
        expect(r.ok).toBe(true);
        expect(r.state.mistakes[0].status).toBe('已掌握');
        const summary = summarizeReviewSession(r.state, 's1');
        expect(summary.masteredCount).toBe(1);
    });
    it('普通答对仍是已复习', () => {
        const r = submitReviewAnswer(makeReviewState(), 's1', 'm1', '好',
            { isCorrect: true, source: 'ai-text', feedback: '对' });
        expect(r.state.mistakes[0].status).toBe('已复习');
    });
    it('答错时即使带 shouldMaster 也不标记掌握', () => {
        const r = submitReviewAnswer(makeReviewState(), 's1', 'm1', '坏',
            { isCorrect: false, source: 'ai-text', feedback: '错', shouldMaster: true });
        expect(r.state.mistakes[0].status).toBe('需再次复习');
    });
});

describe('parseEnglishItems', () => {
    it('释义里的冒号不被截断（回归：之前 split 会丢掉）', () => {
        const items = parseEnglishItems('apple：苹果：一种水果');
        expect(items).toHaveLength(1);
        expect(items[0].text).toBe('apple');
        expect(items[0].meaning).toBe('苹果：一种水果');
    });
    it('JSON 数组格式正常解析', () => {
        const items = parseEnglishItems(JSON.stringify([{ text: 'cat', meaning: '猫' }]));
        expect(items[0]).toMatchObject({ text: 'cat', meaning: '猫' });
    });
    it('含空格的识别为句子', () => {
        const items = parseEnglishItems('I am happy');
        expect(items[0].type).toBe('sentence');
    });
});

describe('llm 网络错误提示区分 provider', () => {
    const realFetch = globalThis.fetch;
    afterEach(() => { globalThis.fetch = realFetch; });

    it('listModels 网络异常时不抛 ReferenceError，按 provider 给提示', async () => {
        globalThis.fetch = () => Promise.reject(new TypeError('Failed to fetch'));
        const { listModels } = await import('../llm.js');
        const g = await listModels({ provider: 'gemini', baseUrl: '', apiKey: 'k' });
        expect(g.error).toMatch(/Google/);
        const o = await listModels({ provider: 'openai', baseUrl: 'https://x/v1', apiKey: 'k' });
        expect(o.error).toMatch(/跨域/);
    });

    it('callLLM 网络异常时按 provider 给提示', async () => {
        globalThis.fetch = () => Promise.reject(new TypeError('Failed to fetch'));
        const { callLLM } = await import('../llm.js');
        const g = await callLLM({ provider: 'gemini', apiKey: 'k', model: 'gemini-x', payload: {} });
        expect(g.error).toMatch(/Google/);
        const o = await callLLM({ provider: 'openai', baseUrl: 'https://x/v1', apiKey: 'k', model: 'm', payload: {} });
        expect(o.error).toMatch(/跨域/);
    });
});

describe('llm 本站代理模式', () => {
    const realFetch = globalThis.fetch;
    afterEach(() => { globalThis.fetch = realFetch; });

    it('callLLM viaProxy 走 /api/llm 并解析上游结果', async () => {
        const seen = [];
        globalThis.fetch = (url, init) => {
            seen.push([url, init]);
            return Promise.resolve({
                json: () => Promise.resolve({ ok: true, status: 200, data: { choices: [{ message: { content: '连接正常。' } }] } })
            });
        };
        const { callLLM } = await import('../llm.js');
        const r = await callLLM({ provider: 'openai', baseUrl: 'https://oc2.021800.xyz/v1/', apiKey: 'k', model: 'm', payload: { contents: [{ parts: [{ text: 'hi' }] }] }, viaProxy: true });
        expect(r.text).toBe('连接正常。');
        expect(seen[0][0]).toBe('/api/llm');
        const sent = JSON.parse(seen[0][1].body);
        expect(sent.target).toBe('https://oc2.021800.xyz/v1/chat/completions');
        expect(sent.apiKey).toBe('k');
        expect(sent.body.model).toBe('m');
    });

    it('callLLM viaProxy 上游报错时透出服务端信息', async () => {
        globalThis.fetch = () => Promise.resolve({
            json: () => Promise.resolve({ ok: false, status: 401, error: 'Incorrect API key' })
        });
        const { callLLM } = await import('../llm.js');
        const r = await callLLM({ provider: 'openai', baseUrl: 'https://x/v1', apiKey: 'bad', model: 'm', payload: {}, viaProxy: true });
        expect(r.error).toBe('Incorrect API key');
    });

    it('listModels viaProxy 拉取模型列表', async () => {
        globalThis.fetch = (url, init) => {
            const sent = JSON.parse(init.body);
            expect(sent.method).toBe('GET');
            expect(sent.target.endsWith('/v1/models')).toBe(true);
            return Promise.resolve({
                json: () => Promise.resolve({ ok: true, status: 200, data: { data: [{ id: 'b' }, { id: 'a' }] } })
            });
        };
        const { listModels } = await import('../llm.js');
        const r = await listModels({ provider: 'openai', baseUrl: 'https://x/v1/', apiKey: 'k', viaProxy: true });
        expect(r.models).toEqual(['a', 'b']);
    });

    it('gemini 不走代理（viaProxy 被忽略）', async () => {
        const seen = [];
        globalThis.fetch = (url) => {
            seen.push(url);
            return Promise.resolve({ ok: true, json: () => Promise.resolve({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }) });
        };
        const { callLLM } = await import('../llm.js');
        const r = await callLLM({ provider: 'gemini', apiKey: 'k', model: 'gemini-x', payload: {}, viaProxy: true });
        expect(r.text).toBe('ok');
        expect(String(seen[0]).includes('generativelanguage.googleapis.com')).toBe(true);
    });
});

describe('Cloudflare 免费 AI provider', () => {
    it('不需要 API Key，走 /api/ai', async () => {
        const { callLLM } = await import('../llm.js');
        const original = globalThis.fetch;
        let calledUrl = '';
        globalThis.fetch = async (url) => { calledUrl = url; return { ok: true, status: 200, json: async () => ({ ok: true, text: '好的' }) }; };
        try {
            const r = await callLLM({ provider: 'cloudflare', apiKey: '', model: '', payload: { contents: [{ parts: [{ text: 'hi' }] }] } });
            expect(r).toEqual({ text: '好的' });
            expect(calledUrl).toBe('/api/ai');
        } finally {
            globalThis.fetch = original;
        }
    });
});
