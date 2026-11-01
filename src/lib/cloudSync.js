// D1 云同步（前端）
// - 家长在设置里填“家庭同步码”，所有设备填同一个即可互通；不填就完全本地使用。
// - 同步码只在本机保存；发给服务器的是它的 SHA-256（X-Sync-Key）。
// - 每个孩子的工作区整份上传，按 updatedAt 后写者胜；孩子档案列表作为特殊档案 __profiles__ 同步。
import {
    applyRemoteWorkspace,
    getChildWorkspaceMeta,
    onWorkspacePersisted,
    readStoredChildWorkspace
} from './childWorkspace.js';

export const PROFILES_ID = '__profiles__';
const CODE_KEY = 'sync_code';
const PROFILES_UPDATED_KEY = 'child_profiles_updated_at';
const DEVICE_KEY = 'sync_device_id';
const LAST_SYNC_KEY = 'sync_last_at';
const PUSH_DELAY_MS = 2500;
export const MIN_CODE_LENGTH = 8;

const pendingPush = new Map();
let statusListeners = new Set();
const hasStorage = () => typeof localStorage !== 'undefined';
let status = { state: 'off', message: '', at: (hasStorage() && localStorage.getItem(LAST_SYNC_KEY)) || '' };

function setStatus(next) {
    status = { ...status, ...next };
    if (next.state === 'ok') {
        status.at = new Date().toISOString();
        localStorage.setItem(LAST_SYNC_KEY, status.at);
    }
    statusListeners.forEach(listener => listener(status));
}

export function getSyncStatus() {
    return status;
}

export function onSyncStatus(listener) {
    statusListeners.add(listener);
    return () => statusListeners.delete(listener);
}

export function getSyncCode() {
    return (hasStorage() && localStorage.getItem(CODE_KEY)) || '';
}

export function setSyncCode(code) {
    const clean = String(code || '').trim();
    if (clean) localStorage.setItem(CODE_KEY, clean);
    else localStorage.removeItem(CODE_KEY);
    cachedKey = null;
    setStatus({ state: clean ? 'idle' : 'off', message: '' });
}

export function isSyncEnabled() {
    return getSyncCode().length >= MIN_CODE_LENGTH;
}

function deviceId() {
    let id = localStorage.getItem(DEVICE_KEY);
    if (!id) {
        id = `dev_${Math.random().toString(36).slice(2, 10)}`;
        localStorage.setItem(DEVICE_KEY, id);
    }
    return id;
}

let cachedKey = null;
export async function syncKeyFor(code) {
    const bytes = new TextEncoder().encode(`ai-hanzi-tutor:${code}`);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// 给 /api/ai、/api/llm 用：带上家庭同步码的 hash，没填同步码时返回空
export async function familyAuthHeaders() {
    if (!getSyncCode()) return {};
    if (!cachedKey) cachedKey = await syncKeyFor(getSyncCode());
    return { 'X-Sync-Key': cachedKey };
}

async function headers() {
    if (!cachedKey) cachedKey = await syncKeyFor(getSyncCode());
    return { 'Content-Type': 'application/json', 'X-Sync-Key': cachedKey };
}

async function request(path, init = {}) {
    const response = await fetch(path, { ...init, headers: { ...(await headers()), ...(init.headers || {}) } });
    let body = null;
    try { body = await response.json(); } catch { /* 非 JSON */ }
    if (!body || body.ok !== true) throw new Error(body?.error || `云同步失败 (${response.status})`);
    return body;
}

// ---- 孩子档案列表 ----
export function getProfilesUpdatedAt() {
    return localStorage.getItem(PROFILES_UPDATED_KEY) || '';
}

export function markProfilesChanged() {
    const now = new Date().toISOString();
    localStorage.setItem(PROFILES_UPDATED_KEY, now);
    return now;
}

// ---- 上传 ----
async function pushNow(profileId, updatedAt, data) {
    const result = await request(`/api/sync/${encodeURIComponent(profileId)}`, {
        method: 'PUT',
        body: JSON.stringify({ updatedAt, data, device: deviceId() })
    });
    return result;
}

export function schedulePush(profileId, getPayload, onRemoteNewer) {
    if (!isSyncEnabled()) return;
    clearTimeout(pendingPush.get(profileId));
    pendingPush.set(profileId, setTimeout(async () => {
        pendingPush.delete(profileId);
        try {
            setStatus({ state: 'syncing', message: '' });
            const payload = await getPayload();
            if (!payload) return;
            const result = await pushNow(profileId, payload.updatedAt, payload.data);
            if (!result.applied && result.data && onRemoteNewer) {
                await onRemoteNewer({ updatedAt: result.updatedAt, data: result.data });
            }
            setStatus({ state: 'ok', message: '' });
        } catch (error) {
            setStatus({ state: 'error', message: error.message || '云同步失败' });
        }
    }, PUSH_DELAY_MS));
}

// 本地保存后自动上传（App 启动时调用一次）
export function startAutoPush(onRemoteNewer) {
    return onWorkspacePersisted((profileId, snapshot) => {
        schedulePush(profileId, async () => ({ updatedAt: snapshot.updatedAt, data: snapshot.data }), remote => onRemoteNewer(profileId, remote));
    });
}

// ---- 全量同步：拉云端 → 新的覆盖本地 → 本地更新的推上去 ----
// profiles: 当前本机档案列表；返回 { profiles?: 云端更新的档案列表, changedProfileIds: 被云端覆盖的孩子 }
export async function syncAll(profiles) {
    if (!isSyncEnabled()) return { changedProfileIds: [] };
    setStatus({ state: 'syncing', message: '' });
    try {
        const { items } = await request('/api/sync');
        const remoteById = new Map(items.map(item => [item.profileId, item]));
        const result = { changedProfileIds: [] };

        // 1) 档案列表
        let finalProfiles = profiles;
        const remoteProfiles = remoteById.get(PROFILES_ID);
        const localProfilesAt = getProfilesUpdatedAt();
        if (remoteProfiles && Array.isArray(remoteProfiles.data) && remoteProfiles.data.length
            && (!localProfilesAt || remoteProfiles.updatedAt > localProfilesAt)) {
            finalProfiles = remoteProfiles.data;
            localStorage.setItem(PROFILES_UPDATED_KEY, remoteProfiles.updatedAt);
            result.profiles = finalProfiles;
        } else if (!remoteProfiles || remoteProfiles.updatedAt < localProfilesAt || !localProfilesAt) {
            const at = localProfilesAt || markProfilesChanged();
            await pushNow(PROFILES_ID, at, profiles);
        }

        // 2) 每个孩子的工作区
        for (const profile of finalProfiles) {
            const remote = remoteById.get(profile.id);
            const local = getChildWorkspaceMeta(profile.id) || await readStoredChildWorkspace(profile.id);
            if (remote && (!local?.updatedAt || remote.updatedAt > local.updatedAt)) {
                if (await applyRemoteWorkspace(profile.id, remote)) result.changedProfileIds.push(profile.id);
            } else if (local?.updatedAt && (!remote || local.updatedAt > remote.updatedAt)) {
                const stored = await readStoredChildWorkspace(profile.id);
                if (stored?.data) await pushNow(profile.id, stored.updatedAt, stored.data);
            }
        }
        setStatus({ state: 'ok', message: '' });
        return result;
    } catch (error) {
        setStatus({ state: 'error', message: error.message || '云同步失败' });
        throw error;
    }
}
