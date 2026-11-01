import { describe, it, expect } from 'vitest';
import { authorizeFamily } from '../index.js';

// 极简 D1 假实现：只支持 owner 锁用到的几条语句
function fakeDb(existingFamily = null) {
    const state = { owner: null };
    return {
        state,
        prepare(sql) {
            let args = [];
            const stmt = {
                bind(...a) { args = a; return stmt; },
                async run() {
                    if (sql.startsWith('INSERT OR IGNORE INTO site_owner') && !state.owner) state.owner = { family: args[0] };
                    return {};
                },
                async first() {
                    if (sql.startsWith('SELECT family FROM site_owner')) return state.owner;
                    if (sql.startsWith('SELECT family FROM workspaces')) return existingFamily ? { family: existingFamily } : null;
                    return null;
                },
            };
            return stmt;
        },
    };
}

const key = c => c.repeat(64);
const req = k => new Request('https://x.test/api/ai', { headers: k ? { 'X-Sync-Key': k } : {} });

describe('家长主人码', () => {
    it('没填同步码直接拒绝', async () => {
        const r = await authorizeFamily(req(null), { DB: fakeDb() });
        expect(r.ok).toBe(false);
        expect(r.status).toBe(401);
    });
    it('第一个同步码成为主人，别的码被拒', async () => {
        const env = { DB: fakeDb() };
        expect((await authorizeFamily(req(key('a')), env)).ok).toBe(true);
        expect((await authorizeFamily(req(key('a')), env)).ok).toBe(true);
        const other = await authorizeFamily(req(key('b')), env);
        expect(other.ok).toBe(false);
        expect(other.status).toBe(403);
    });
    it('已有同步数据的家庭优先成为主人', async () => {
        const env = { DB: fakeDb('somebody-else') };
        const r = await authorizeFamily(req(key('a')), env);
        expect(r.ok).toBe(false);
    });
});
