import { useEffect, useState } from 'react';
import { playAudio } from '../lib/audio.js';
import { useSpeechVoices } from '../hooks/useSpeechVoices.js';
import { loadReminder, saveReminder } from '../lib/reminder.js';
import { getVoiceDownloadGuide, supportsSpeechSynthesis } from '../lib/deviceVoiceGuide.js';
import { setVisionSupport } from '../lib/aiCapabilities.js';
import { callLLM as requestLLM, listModels, CLOUDFLARE_MODELS, CLOUDFLARE_DEFAULT_MODEL, getWorkersAIStatus } from '../lib/llm.js';
import { MIN_CODE_LENGTH, getDeviceId, getSyncCode, listHistory, restoreHistory, setSyncCode } from '../lib/cloudSync.js';

const DEFAULT_MODELS = [...CLOUDFLARE_MODELS.map(item => item.id), 'gemini-3-flash-preview', 'gemini-3-pro-preview', 'gemini-2.0-flash-exp', 'gpt-4o-mini', 'gpt-4o', 'deepseek-chat'];

function VoiceDownloadGuide({ language, hasVoices }) {
    const guide = getVoiceDownloadGuide();
    const noVoiceSupport = !supportsSpeechSynthesis();
    const title = noVoiceSupport
        ? '当前浏览器不支持系统朗读'
        : hasVoices
            ? `想添加更多${language}声音？`
            : `还没有找到${language}声音`;

    return (
        <details open={!hasVoices || noVoiceSupport} className="mt-3 rounded-lg bg-white/70 border border-slate-100 p-3 text-xs text-slate-500">
            <summary className="cursor-pointer font-bold text-slate-600">{title}</summary>
            <div className="mt-2 leading-relaxed">
                <div>当前识别为：{guide.deviceName}</div>
                {noVoiceSupport ? (
                    <div className="mt-1">请使用 Safari、Chrome、Edge 等现代浏览器打开本应用。</div>
                ) : (
                    <ol className="list-decimal pl-4 mt-1 space-y-1">
                        {guide.steps.map(step => <li key={step}>{step}</li>)}
                    </ol>
                )}
            </div>
        </details>
    );
}

export default function SettingsView({
    provider, setProvider, baseUrl, setBaseUrl, apiKey, setApiKey, model, setModel,
    viaProxy, setViaProxy,
    voiceURI, setVoiceURI, englishVoiceURI, setEnglishVoiceURI,
    profiles, activeProfileId, setActiveProfileId, addProfile, renameProfile, deleteProfile,
    exportActiveChildData, importActiveChildData, syncStatus, onSyncNow, onRestored, onBack
}) {
    const [p, setP] = useState(provider);
    const [url, setUrl] = useState(baseUrl);
    const [k, setK] = useState(apiKey);
    const [m, setM] = useState(model);
    const [vp, setVp] = useState(viaProxy);
    const [vURI, setVURI] = useState(voiceURI);
    const [enURI, setEnURI] = useState(englishVoiceURI);
    const [isCustom, setIsCustom] = useState(false);
    const [customModel, setCustomModel] = useState('');
    const [aiTestStatus, setAiTestStatus] = useState({ text: '', vision: '' });
    const [fetchedModels, setFetchedModels] = useState([]);
    const [modelFetchStatus, setModelFetchStatus] = useState('');
    const [reminder, setReminder] = useState(() => loadReminder(activeProfileId));
    const [syncCode, setSyncCodeInput] = useState(() => getSyncCode());
    const [syncMessage, setSyncMessage] = useState('');
    const [cfStatus, setCfStatus] = useState(null);
    const [history, setHistory] = useState(null);
    const [historyMessage, setHistoryMessage] = useState('');

    useEffect(() => { setHistory(null); setHistoryMessage(''); }, [activeProfileId]);

    const loadHistory = async () => {
        if (!getSyncCode()) { setHistoryMessage('先填家庭同步码并同步一次'); return; }
        setHistoryMessage('正在读取...');
        try {
            const items = await listHistory(activeProfileId);
            setHistory(items);
            setHistoryMessage(items.length ? '' : '还没有历史版本（云端数据被覆盖时才会自动保存）');
        } catch (error) {
            setHistoryMessage(`读取失败：${error.message || '请检查网络'}`);
        }
    };

    const restoreVersion = async (item) => {
        const name = profiles.find(profile => profile.id === activeProfileId)?.name || '这个孩子';
        if (!confirm(`把「${name}」的数据恢复到 ${new Date(item.updatedAt).toLocaleString()} 的版本？\n现在的数据也会先存进历史，恢复错了还能再找回来。`)) return;
        setHistoryMessage('正在恢复...');
        try {
            await restoreHistory(activeProfileId, item.id);
            onRestored?.(activeProfileId);
            setHistoryMessage('已恢复，其他设备同步后也会变成这个版本');
            setHistory(await listHistory(activeProfileId));
        } catch (error) {
            setHistoryMessage(`恢复失败：${error.message || '请检查网络'}`);
        }
    };
    const isCloudflare = p === 'cloudflare';

    useEffect(() => {
        if (!isCloudflare) return;
        let cancelled = false;
        getWorkersAIStatus().then(status => { if (!cancelled) setCfStatus(status); });
        return () => { cancelled = true; };
    }, [isCloudflare]);

    const syncNow = async () => {
        const code = syncCode.trim();
        if (code && code.length < MIN_CODE_LENGTH) { setSyncMessage(`同步码至少 ${MIN_CODE_LENGTH} 位`); return; }
        if (!code) { setSyncCode(''); setSyncMessage('已关闭云同步，数据只保存在本机'); return; }
        if (code !== getSyncCode()) setSyncCode(code);
        setSyncMessage('正在同步...');
        try {
            await onSyncNow?.();
            setSyncMessage('同步完成');
        } catch (error) {
            setSyncMessage(`同步失败：${error.message || '请检查网络'}`);
        }
    };
    const voiceList = useSpeechVoices('zh');
    const englishVoiceList = useSpeechVoices('en');

    useEffect(() => {
        if (provider === 'cloudflare') {
            setIsCustom(false);
            if (!CLOUDFLARE_MODELS.some(item => item.id === model)) setM(CLOUDFLARE_DEFAULT_MODEL);
            return;
        }
        if (DEFAULT_MODELS.includes(model)) { setIsCustom(false); }
        else { setIsCustom(true); setCustomModel(model); setM('custom'); }
    }, []);

    useEffect(() => {
        setReminder(loadReminder(activeProfileId));
    }, [activeProfileId]);

    const handleProviderChange = (nextProvider) => {
        setP(nextProvider);
        if (nextProvider === 'cloudflare') {
            if (!CLOUDFLARE_MODELS.some(item => item.id === m)) setM(CLOUDFLARE_DEFAULT_MODEL);
            setIsCustom(false);
            return;
        }
        if (m.startsWith('@cf/')) {
            setM(nextProvider === 'gemini' ? 'gemini-3-flash-preview' : 'gpt-4o-mini');
            setIsCustom(false);
            return;
        }
        if (nextProvider === 'gemini' && m !== 'custom' && !m.startsWith('gemini-')) {
            setM('gemini-3-flash-preview');
            setIsCustom(false);
        }
        if (nextProvider === 'openai' && m !== 'custom' && m.startsWith('gemini-')) {
            setM('gpt-4o-mini');
            setIsCustom(false);
        }
    };

    const testAi = async (kind) => {
        const finalModel = isCustom ? customModel.trim() : m;
        const finalUrl = url.trim() || 'https://api.openai.com/v1/chat/completions';
        if ((!isCloudflare && !k.trim()) || !finalModel) {
            setAiTestStatus(prev => ({ ...prev, [kind]: '请先填写 API Key 和模型名称' }));
            return;
        }
        const config = { provider: p, baseUrl: finalUrl, model: finalModel };
        // 注意：测试只用表单里的 config 发请求，不写回 localStorage。
        // 图片能力标记按 config 单独 key 存储（见 aiCapabilities），保存时写入的
        // provider/base_url/model 与此处一致，业务侧 getActiveVisionSupport()
        // 自然能读到；提前写回会导致“测了没保存、刷新后配置错乱”。
        setAiTestStatus(prev => ({ ...prev, [kind]: kind === 'vision' ? '正在测试图片能力...' : '正在测试文字能力...' }));
        const parts = kind === 'vision'
            ? [
                { text: '请回答图片是否可读取。只回答：可以。' },
                { inlineData: { mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=' } }
            ]
            : [{ text: '请只回答：连接正常。' }];
        const result = await requestLLM({ provider: p, baseUrl: finalUrl, apiKey: k.trim(), model: finalModel, payload: { contents: [{ parts }] }, viaProxy: p === 'openai' ? vp : false });
        if (result.error) {
            const message = `测试失败：${result.error}`;
            setAiTestStatus(prev => ({ ...prev, [kind]: message }));
            if (kind === 'vision' && /image|vision|multimodal|图片|图像|不支持|unsupported/i.test(result.error)) {
                setVisionSupport(config, 'unsupported');
            }
            return;
        }
        if (kind === 'vision') setVisionSupport(config, 'supported');
        setAiTestStatus(prev => ({ ...prev, [kind]: '测试通过' }));
    };

    const fetchModels = async () => {
        if (!k.trim()) {
            setModelFetchStatus('请先填写 API Key');
            return;
        }
        setModelFetchStatus('正在拉取模型列表...');
        const result = await listModels({ provider: p, baseUrl: url.trim(), apiKey: k.trim(), viaProxy: p === 'openai' ? vp : false });
        if (result.error) {
            setModelFetchStatus(`拉取失败：${result.error}`);
            return;
        }
        setFetchedModels(result.models);
        setModelFetchStatus(`已找到 ${result.models.length} 个模型`);
    };

    const save = () => {
        const finalModel = isCloudflare ? (CLOUDFLARE_MODELS.some(item => item.id === m) ? m : CLOUDFLARE_DEFAULT_MODEL) : (isCustom ? customModel.trim() : m);
        if (!finalModel) { alert("模型名称不能为空"); return; }
        const code = syncCode.trim();
        if (code && code.length < MIN_CODE_LENGTH) { alert(`家庭同步码至少 ${MIN_CODE_LENGTH} 位`); return; }
        if (code !== getSyncCode()) {
            setSyncCode(code);
            if (code) onSyncNow?.().catch(() => {});
        }
        const finalUrl = url.trim() || 'https://api.openai.com/v1/chat/completions';
        setProvider(p); setBaseUrl(finalUrl); setApiKey(k); setModel(finalModel); setViaProxy(vp);
        setVoiceURI(vURI); setEnglishVoiceURI(enURI);
        saveReminder(activeProfileId, reminder);
        localStorage.setItem('llm_provider', p);
        localStorage.setItem('llm_base_url', finalUrl);
        localStorage.setItem('llm_api_key', k);
        localStorage.setItem('llm_model', finalModel);
        alert("保存成功"); onBack();
    };

    return (
        <div className="p-6 h-full bg-white animate-in slide-in-from-right overflow-y-auto">
            <h2 className="text-xl font-bold mb-6 text-slate-700">系统设置</h2>
            <div className="space-y-6">
                <div>
                    <label className="text-sm font-bold text-slate-600 mb-2 block">孩子档案</label>
                    <div className="bg-orange-50 p-4 rounded-xl border border-orange-100 space-y-3">
                        <select value={activeProfileId} onChange={e => setActiveProfileId(e.target.value)} className="w-full p-3 bg-white border rounded-xl focus:border-orange-500 outline-none text-slate-700 font-medium shadow-sm">
                            {profiles.map(profile => (
                                <option key={profile.id} value={profile.id}>{profile.name}</option>
                            ))}
                        </select>
                        <div className="grid grid-cols-3 gap-2">
                            <button onClick={() => {
                                const name = prompt('新孩子名字：');
                                if (name) addProfile(name);
                            }} className="py-2 bg-orange-500 text-white rounded-xl text-sm font-bold">新增</button>
                            <button onClick={() => {
                                const current = profiles.find(profile => profile.id === activeProfileId);
                                const name = prompt('修改名字：', current?.name || '');
                                if (name) renameProfile(activeProfileId, name);
                            }} className="py-2 bg-white border border-orange-100 text-orange-500 rounded-xl text-sm font-bold">改名</button>
                            <button onClick={() => deleteProfile(activeProfileId)} className="py-2 bg-white border border-red-100 text-red-500 rounded-xl text-sm font-bold">删除</button>
                        </div>
                        <div className="grid grid-cols-2 gap-2">
                            <button onClick={exportActiveChildData} className="py-2 bg-white border border-green-100 text-green-600 rounded-xl text-sm font-bold">完整学习备份</button>
                            <label className="py-2 bg-white border border-blue-100 text-blue-600 rounded-xl text-sm font-bold text-center cursor-pointer">
                                导入完整备份
                                <input type="file" className="hidden" accept=".json,application/json" onChange={async (e) => {
                                    await importActiveChildData(e.target.files?.[0]);
                                    e.target.value = '';
                                }} />
                            </label>
                        </div>
                    </div>
                </div>

                <div>
                    <label className="text-sm font-bold text-slate-600 mb-2 block">云同步（手机、平板数据互通）</label>
                    <div className="bg-emerald-50 p-4 rounded-xl border border-emerald-100 space-y-3">
                        <input value={syncCode} onChange={e => setSyncCodeInput(e.target.value)} type="password" autoComplete="off" className="w-full p-3 bg-white border rounded-xl focus:border-emerald-500 outline-none text-sm" placeholder={`家庭同步码（至少 ${MIN_CODE_LENGTH} 位，每台设备填同一个）`} />
                        <div className="flex items-center gap-3">
                            <button onClick={syncNow} className="shrink-0 py-2 px-3 rounded-lg bg-emerald-500 text-white text-sm font-bold">立即同步</button>
                            <div className="text-xs text-slate-500">
                                {syncMessage || (syncStatus?.state === 'error'
                                    ? `上次同步失败：${syncStatus.message}`
                                    : syncStatus?.at && getSyncCode()
                                        ? `上次同步：${new Date(syncStatus.at).toLocaleString()}`
                                        : '不填则只保存在本机')}
                            </div>
                        </div>
                        <div className="text-xs text-slate-400">同步孩子档案、星星、生字本、听写记录和错题本。同步码就是你家数据的钥匙，请设得长一点、别告诉别人。</div>
                        <details className="rounded-lg bg-white/70 border border-emerald-100 p-3 text-sm" onToggle={e => { if (e.currentTarget.open && history === null) loadHistory(); }}>
                            <summary className="cursor-pointer font-bold text-emerald-700">历史版本（数据被覆盖了？点这里找回）</summary>
                            <div className="mt-2 space-y-2">
                                <div className="text-xs text-slate-500">当前孩子：{profiles.find(profile => profile.id === activeProfileId)?.name}。云端数据被别的设备覆盖前会自动留一份，每个孩子保留最近 30 份。</div>
                                {history?.map(item => (
                                    <div key={item.id} className="flex items-center justify-between gap-2 bg-white rounded-lg border border-slate-100 p-2">
                                        <div className="text-xs text-slate-600">
                                            <div className="font-bold">{new Date(item.updatedAt).toLocaleString()}</div>
                                            <div className="text-slate-400">{item.device === getDeviceId() ? '本机' : '其他设备'} · {Math.max(1, Math.round(item.size / 1024))} KB</div>
                                        </div>
                                        <button onClick={() => restoreVersion(item)} className="shrink-0 py-1 px-3 rounded-lg bg-emerald-500 text-white text-xs font-bold">恢复</button>
                                    </div>
                                ))}
                                {historyMessage && <div className="text-xs text-slate-500">{historyMessage}</div>}
                                <button onClick={loadHistory} className="text-xs text-emerald-600 font-bold">刷新列表</button>
                            </div>
                        </details>
                    </div>
                </div>

                <div>
                    <label className="text-sm font-bold text-slate-600 mb-2 block">学习提醒</label>
                    <div className="bg-blue-50 p-4 rounded-xl border border-blue-100 space-y-3">
                        <label className="flex items-center gap-2 text-sm text-slate-600 font-bold">
                            <input type="checkbox" checked={reminder.enabled} onChange={e => setReminder(prev => ({ ...prev, enabled: e.target.checked }))} />
                            打开应用时提醒学习
                        </label>
                        <input type="time" value={reminder.time} onChange={e => setReminder(prev => ({ ...prev, time: e.target.value }))} className="w-full p-3 bg-white border rounded-xl focus:border-blue-500 outline-none" />
                        <input value={reminder.message} onChange={e => setReminder(prev => ({ ...prev, message: e.target.value }))} className="w-full p-3 bg-white border rounded-xl focus:border-blue-500 outline-none text-sm" placeholder="提醒内容" />
                    </div>
                </div>

                <div>
                    <label className="text-sm font-bold text-slate-600 mb-2 block">AI 接口</label>
                    <div className="space-y-3">
                        <button onClick={() => handleProviderChange('cloudflare')} className={`w-full py-3 rounded-xl font-bold ${isCloudflare ? 'bg-orange-500 text-white' : 'bg-slate-100 text-slate-500'}`}>Cloudflare 免费 AI（推荐，不用填 Key）</button>
                        {isCloudflare && (
                            <div className="text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-xl p-3 space-y-1">
                                <div>用本站自带的 Cloudflare Workers AI，每台设备都不用填 Key，国内也能用。</div>
                                <div>{cfStatus?.error
                                    ? `状态：${cfStatus.error}`
                                    : cfStatus
                                        ? `今日已用约 ${Math.min(100, Math.round(cfStatus.usedToday / cfStatus.budget * 100))}% 免费额度（共 ${cfStatus.requestsToday} 次），北京时间早上 8 点重置。`
                                        : '正在读取今日额度...'}</div>
                            </div>
                        )}
                        <div className="grid grid-cols-2 gap-2">
                            <button onClick={() => handleProviderChange('gemini')} className={`py-3 rounded-xl font-bold ${p === 'gemini' ? 'bg-orange-500 text-white' : 'bg-slate-100 text-slate-500'}`}>Gemini</button>
                            <button onClick={() => handleProviderChange('openai')} className={`py-3 rounded-xl font-bold ${p === 'openai' ? 'bg-orange-500 text-white' : 'bg-slate-100 text-slate-500'}`}>OpenAI 兼容</button>
                        </div>
                        {p === 'gemini' && (
                            <div className="text-xs text-amber-600 bg-amber-50 border border-amber-200 rounded-xl p-3">
                                Gemini 模式直连 Google 官方接口（国内网络不可用），此处不使用自定义地址；要用中转站请切换到「OpenAI 兼容」。
                            </div>
                        )}
                        {p === 'gemini' && isCustom && customModel.trim() && !customModel.trim().startsWith('gemini-') && (
                            <div className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-xl p-3">
                                模型名不是 gemini- 开头，与 Gemini 模式不匹配，拉取/测试会失败；用中转站请切换到「OpenAI 兼容」。
                            </div>
                        )}
                        {p === 'openai' && (
                            <input value={url} onChange={e => setUrl(e.target.value)} className="w-full p-3 bg-white border rounded-xl focus:border-orange-500 outline-none text-sm" placeholder="https://api.openai.com/v1/chat/completions" />
                        )}
                        {p === 'openai' && (
                            <label className="flex items-start gap-2 text-xs text-slate-600 bg-emerald-50 border border-emerald-200 rounded-xl p-3 cursor-pointer">
                                <input type="checkbox" checked={vp} onChange={e => setVp(e.target.checked)} className="w-4 h-4 mt-0.5 accent-orange-500 shrink-0" />
                                <span>通过本站代理请求（推荐开启：中转站没开浏览器跨域时也能用；关闭则浏览器直连中转站）</span>
                            </label>
                        )}
                        {!isCloudflare && <input value={k} onChange={e => setK(e.target.value)} className="w-full p-3 bg-white border rounded-xl focus:border-orange-500 outline-none text-sm" placeholder="API Key" />}
                        <select value={m} onChange={e => {
                            if (e.target.value === 'custom') { setIsCustom(true); setM('custom'); }
                            else { setIsCustom(false); setM(e.target.value); }
                        }} className="w-full p-3 bg-white border rounded-xl focus:border-orange-500 outline-none text-sm">
                            {isCloudflare ? (
                                CLOUDFLARE_MODELS.map(item => <option key={item.id} value={item.id}>{item.label}</option>)
                            ) : p === 'gemini' ? (
                                <>
                                    <option value="gemini-3-flash-preview">gemini-3-flash-preview</option>
                                    <option value="gemini-3-pro-preview">gemini-3-pro-preview</option>
                                    <option value="gemini-2.0-flash-exp">gemini-2.0-flash-exp</option>
                                </>
                            ) : (
                                <>
                                    <option value="gpt-4o-mini">gpt-4o-mini</option>
                                    <option value="gpt-4o">gpt-4o</option>
                                    <option value="deepseek-chat">deepseek-chat</option>
                                </>
                            )}
                            {!isCloudflare && fetchedModels.filter(modelId => !DEFAULT_MODELS.includes(modelId)).map(modelId => (
                                <option key={modelId} value={modelId}>{modelId}</option>
                            ))}
                            {!isCloudflare && <option value="custom">自定义模型</option>}
                        </select>
                        {!isCloudflare && isCustom && (
                            <input value={customModel} onChange={e => setCustomModel(e.target.value)} className="w-full p-3 bg-white border rounded-xl focus:border-orange-500 outline-none text-sm" placeholder="自定义模型名" />
                        )}
                        {!isCloudflare && <div className="flex items-center gap-3">
                            <button onClick={fetchModels} className="shrink-0 py-2 px-3 rounded-lg bg-slate-100 text-slate-600 text-sm font-bold">拉取模型</button>
                            {modelFetchStatus && <div className={`text-xs ${modelFetchStatus.startsWith('拉取失败') ? 'text-red-500' : 'text-slate-500'}`}>{modelFetchStatus}</div>}
                        </div>}
                        <div className="bg-slate-50 rounded-xl border border-slate-100 p-3 space-y-2">
                            <div className="text-sm font-bold text-slate-600">接口能力测试</div>
                            <div className="grid grid-cols-2 gap-2">
                                <button onClick={() => testAi('text')} className="py-2 rounded-lg bg-white border text-slate-600 text-sm font-bold">测试文字</button>
                                <button onClick={() => testAi('vision')} className="py-2 rounded-lg bg-indigo-500 text-white text-sm font-bold">测试图片</button>
                            </div>
                            {aiTestStatus.text && <div className={`text-xs ${aiTestStatus.text === '测试通过' ? 'text-green-600' : 'text-slate-500'}`}>文字：{aiTestStatus.text}</div>}
                            {aiTestStatus.vision && <div className={`text-xs ${aiTestStatus.vision === '测试通过' ? 'text-green-600' : 'text-slate-500'}`}>图片：{aiTestStatus.vision}</div>}
                            <div className="text-xs text-slate-400">通过图片测试后，拍照录题和拍照批改才适合交给孩子使用。</div>
                        </div>
                    </div>
                </div>

                <div>
                    <label className="text-sm font-bold text-slate-600 mb-2 block">中文语音</label>
                    <div className="bg-slate-50 p-4 rounded-xl border border-slate-100">
                        <select value={vURI} onChange={e => { setVURI(e.target.value); playAudio("语音已切换", e.target.value); }} className="w-full p-3 bg-white border rounded-xl focus:border-orange-500 outline-none mb-3 text-slate-700 font-medium shadow-sm">
                            <option value="auto">自动选择中文语音</option>
                            {voiceList.map((v, i) => (
                                <option key={i} value={v.voiceURI}>{v.name} {v.localService ? '[本地]' : ''}</option>
                            ))}
                        </select>
                        <div className="text-xs text-slate-400">
                            {vURI === 'auto'
                                ? "当前模式：自动优先使用 Siri、Ting-Ting 或 Google 高质量中文语音。"
                                : "当前模式：已锁定为你选择的中文语音。"}
                        </div>
                        <VoiceDownloadGuide language="中文" hasVoices={voiceList.length > 0} />
                    </div>
                </div>

                <div>
                    <label className="text-sm font-bold text-slate-600 mb-2 block">英文语音</label>
                    <div className="bg-sky-50 p-4 rounded-xl border border-sky-100">
                        <select value={enURI} onChange={e => { setEnURI(e.target.value); playAudio("English voice ready", e.target.value, 0, 'en'); }} className="w-full p-3 bg-white border rounded-xl focus:border-sky-500 outline-none mb-3 text-slate-700 font-medium shadow-sm">
                            <option value="auto">自动选择英文语音</option>
                            {englishVoiceList.map((v, i) => (
                                <option key={i} value={v.voiceURI}>{v.name} {v.localService ? '[本地]' : ''}</option>
                            ))}
                        </select>
                        <div className="text-xs text-slate-400">
                            {enURI === 'auto'
                                ? "当前模式：英文听写和对话会自动选英文语音，不和中文抢同一个声音。"
                                : "当前模式：英文内容会固定使用你选的英文语音。"}
                        </div>
                        <VoiceDownloadGuide language="英文" hasVoices={englishVoiceList.length > 0} />
                    </div>
                </div>

                <div className="flex gap-3 pt-2">
                    <button onClick={onBack} className="flex-1 py-3 rounded-xl bg-slate-100 text-slate-500 font-bold">返回</button>
                    <button onClick={save} className="flex-1 py-3 rounded-xl bg-orange-500 text-white font-bold shadow-lg shadow-orange-200">保存设置</button>
                </div>
            </div>
        </div>
    );
}
