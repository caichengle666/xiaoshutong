function capabilityKey({ provider, baseUrl, model }) {
    return `llm_vision_support_${encodeURIComponent([provider || '', baseUrl || '', model || ''].join('|'))}`;
}

// Cloudflare Workers AI 的模型能力是已知的，不用先测试
const CLOUDFLARE_VISION_MODELS = ['@cf/google/gemma-4-26b-a4b-it', '@cf/mistralai/mistral-small-3.1-24b-instruct'];

export function getVisionSupport(config) {
    const stored = localStorage.getItem(capabilityKey(config));
    if (stored) return stored;
    if (config?.provider === 'cloudflare') return CLOUDFLARE_VISION_MODELS.includes(config.model) ? 'supported' : 'unsupported';
    return 'unknown';
}

export function setVisionSupport(config, support) {
    localStorage.setItem(capabilityKey(config), support);
}

export function getActiveVisionSupport() {
    return getVisionSupport({
        provider: localStorage.getItem('llm_provider') || 'cloudflare',
        baseUrl: localStorage.getItem('llm_base_url') || '',
        model: localStorage.getItem('llm_model') || (localStorage.getItem('llm_provider') ? '' : '@cf/google/gemma-4-26b-a4b-it')
    });
}
