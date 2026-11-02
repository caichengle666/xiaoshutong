import { describe, expect, it } from 'vitest';
import { HISTORY_MIN_GAP_MS, shouldSnapshot } from '../index.js';

describe('云端历史版本', () => {
    const existing = { updated_at: '2026-11-01T00:00:00Z', device: 'dev_a', data: '{}' };
    it('云端没有旧数据时不存', () => {
        expect(shouldSnapshot(null, 'dev_a', null)).toBe(false);
    });
    it('换了设备覆盖一定存一份', () => {
        expect(shouldSnapshot(existing, 'dev_b', new Date().toISOString())).toBe(true);
    });
    it('同一台设备连续保存，间隔够久才存', () => {
        const now = Date.now();
        expect(shouldSnapshot(existing, 'dev_a', new Date(now - 60_000).toISOString(), now)).toBe(false);
        expect(shouldSnapshot(existing, 'dev_a', new Date(now - HISTORY_MIN_GAP_MS).toISOString(), now)).toBe(true);
        expect(shouldSnapshot(existing, 'dev_a', null, now)).toBe(true);
    });
});
