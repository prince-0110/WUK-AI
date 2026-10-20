const BASE_SYSTEM = 'You are WUK AI, a clear, useful personal assistant created by Wuk72. Be honest about uncertainty.';
const CHAT_TIMEOUT_MS = 25_000;

function isConfigured(value) { return Boolean(value && !/replace|placeholder|change.?me/i.test(value)); }

async function jsonRequest(ProviderError, provider, url, key, body, { headers = {}, timeoutMs = 90_000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), signal: controller.signal });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new ProviderError(provider, response.status);
    return data;
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    throw new ProviderError(provider, error.name === 'AbortError' ? 504 : 0);
  } finally { clearTimeout(timer); }
}

function textFromMessage(value) {
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) return value.filter(part => typeof part?.text === 'string').map(part => part.text).join('\n').trim();
  return '';
}

function extractCompatible(data, normalizeCitations) {
  const message = data.choices?.[0]?.message || {};
  const citations = [...(message.citations || []), ...(data.citations || [])].filter(item => item?.url).map(item => ({ url: item.url, title: item.title || item.url }));
  return { text: textFromMessage(message.content || message.text), citations: normalizeCitations(citations), searched: Boolean(data.search_results || data.web_search_results || citations.length) };
}

function dataImage(base64, mimeType = 'image/jpeg') {
  return { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64}` } };
}

function compatibleMessages(messages) { return [{ role: 'system', content: BASE_SYSTEM }, ...messages.map(({ role, content }) => ({ role, content }))]; }

async function fetchImage(ProviderError, provider, url, headers = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90_000);
  try {
    const response = await fetch(url, { headers, signal: controller.signal });
    if (!response.ok) throw new ProviderError(provider, response.status);
    const declaredType = response.headers.get('content-type')?.split(';')[0] || '';
    const mimeType = ['image/jpeg', 'image/png', 'image/webp'].includes(declaredType) ? declaredType : 'image/png';
    return { mimeType, data: Buffer.from(await response.arrayBuffer()).toString('base64') };
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    throw new ProviderError(provider, error.name === 'AbortError' ? 504 : 0);
  } finally { clearTimeout(timer); }
}

export function createAdditionalProviders(env, { ProviderError, normalizeCitations }) {
  const groqKey = isConfigured(env.GROQ_API_KEY) ? env.GROQ_API_KEY : '';
  const routerKey = isConfigured(env.OPENROUTER_API_KEY) ? env.OPENROUTER_API_KEY : '';
  // CLOUDFLARE_API_TOKEN is reserved by Wrangler for deployment authentication.
  // Prefer the explicit Workers AI name; accept the legacy name for existing hosts.
  const cloudflareToken = env.CLOUDFLARE_WORKERS_AI_API_TOKEN || env.CLOUDFLARE_API_TOKEN;
  const cloudflareKey = isConfigured(cloudflareToken) ? cloudflareToken : '';
  const cloudflareAccount = env.CLOUDFLARE_ACCOUNT_ID || '';
  const mistralKey = isConfigured(env.MISTRAL_API_KEY) ? env.MISTRAL_API_KEY : '';
  const groqModel = env.GROQ_MODEL || 'openai/gpt-oss-20b';
  const groqVisionModel = env.GROQ_VISION_MODEL || 'qwen/qwen3.8-27b';
  const routerModel = env.OPENROUTER_MODEL || 'openrouter/free';
  const routerImageModel = env.OPENROUTER_IMAGE_MODEL || 'google/gemini-3.1-flash-image';
  const cloudflareModel = env.CLOUDFLARE_MODEL || '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
  const cloudflareVisionModel = env.CLOUDFLARE_VISION_MODEL || '@cf/qwen/qwen3.8-27b';
  const cloudflareImageModel = env.CLOUDFLARE_IMAGE_MODEL || '@cf/stabilityai/stable-diffusion-xl-base-1.0';
  const mistralModel = env.MISTRAL_MODEL || 'mistral-small-latest';
  const mistralVisionModel = env.MISTRAL_VISION_MODEL || 'ministral-14b-latest';

  const groqUrl = 'https://api.groq.com/openai/v1/chat/completions';
  const providers = {
    groq: {
      id: 'groq', name: 'Groq', model: groqModel, visionModel: groqVisionModel, configured: Boolean(groqKey), capabilities: ['chat', 'vision', 'webResearch'],
      async chat(messages, research) {
        if (research) {
          const response = await jsonRequest(ProviderError, 'groq', 'https://api.groq.com/openai/v1/responses', groqKey, { model: groqModel, instructions: BASE_SYSTEM, input: messages.map(m => `${m.role}: ${m.content}`).join('\n\n'), tools: [{ type: 'browser_search' }], tool_choice: 'required' }, { timeoutMs: CHAT_TIMEOUT_MS });
          const citations = (response.output || []).flatMap(item => (item.content || []).flatMap(part => (part.annotations || []).filter(annotation => annotation.url).map(annotation => ({ url: annotation.url, title: annotation.title || annotation.url }))));
          return { text: response.output_text?.trim() || '', citations: normalizeCitations(citations), searched: true };
        }
        const response = await jsonRequest(ProviderError, 'groq', groqUrl, groqKey, { model: groqModel, messages: compatibleMessages(messages) }, { timeoutMs: CHAT_TIMEOUT_MS });
        return extractCompatible(response, normalizeCitations);
      },
      async vision(prompt, image, mimeType) {
        const response = await jsonRequest(ProviderError, 'groq', groqUrl, groqKey, { model: groqVisionModel, messages: [{ role: 'system', content: BASE_SYSTEM }, { role: 'user', content: [{ type: 'text', text: prompt }, dataImage(image, mimeType)] }] });
        return extractCompatible(response, normalizeCitations);
      }
    },
    openrouter: {
      id: 'openrouter', name: 'OpenRouter', model: routerModel, visionModel: routerModel, imageModel: routerImageModel, configured: Boolean(routerKey), capabilities: ['chat', 'vision', 'webResearch', 'image'],
      async chat(messages, research) {
        const response = await jsonRequest(ProviderError, 'openrouter', 'https://openrouter.ai/api/v1/chat/completions', routerKey, { model: routerModel, messages: compatibleMessages(messages), ...(research ? { tools: [{ type: 'openrouter:web_search' }] } : {}) }, { timeoutMs: CHAT_TIMEOUT_MS });
        return extractCompatible(response, normalizeCitations);
      },
      async vision(prompt, image, mimeType) {
        const response = await jsonRequest(ProviderError, 'openrouter', 'https://openrouter.ai/api/v1/chat/completions', routerKey, { model: routerModel, messages: [{ role: 'system', content: BASE_SYSTEM }, { role: 'user', content: [{ type: 'text', text: prompt }, dataImage(image, mimeType)] }] });
        return extractCompatible(response, normalizeCitations);
      },
      async generateImage(prompt) {
        const data = await jsonRequest(ProviderError, 'openrouter', 'https://openrouter.ai/api/v1/images', routerKey, { model: routerImageModel, prompt });
        const image = data.data?.[0];
        if (!image?.b64_json) throw new ProviderError('openrouter', 502);
        return { data: image.b64_json, mimeType: image.media_type || 'image/png' };
      }
    },
    cloudflare: {
      id: 'cloudflare', name: 'Cloudflare Workers AI', model: cloudflareModel, visionModel: cloudflareVisionModel, imageModel: cloudflareImageModel, configured: Boolean(cloudflareKey && cloudflareAccount), capabilities: ['chat', 'vision', 'image'],
      async chat(messages) {
        const response = await jsonRequest(ProviderError, 'cloudflare', `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(cloudflareAccount)}/ai/v1/chat/completions`, cloudflareKey, { model: cloudflareModel, messages: compatibleMessages(messages) }, { timeoutMs: CHAT_TIMEOUT_MS });
        return extractCompatible(response, normalizeCitations);
      },
      async vision(prompt, image, mimeType) {
        const response = await jsonRequest(ProviderError, 'cloudflare', `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(cloudflareAccount)}/ai/v1/chat/completions`, cloudflareKey, { model: cloudflareVisionModel, messages: [{ role: 'system', content: BASE_SYSTEM }, { role: 'user', content: [{ type: 'text', text: prompt }, dataImage(image, mimeType)] }] });
        return extractCompatible(response, normalizeCitations);
      },
      async generateImage(prompt) {
        if (!/^@cf\/[a-z0-9._/-]+$/i.test(cloudflareImageModel)) throw new ProviderError('cloudflare', 400);
        const modelPath = cloudflareImageModel;
        const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 90_000);
        try {
          const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(cloudflareAccount)}/ai/run/${modelPath}`, { method: 'POST', headers: { Authorization: `Bearer ${cloudflareKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt, width: 1024, height: 1024, num_steps: 20 }), signal: controller.signal });
          if (!response.ok) throw new ProviderError('cloudflare', response.status);
          const declaredType = response.headers.get('content-type')?.split(';')[0] || '';
          const mimeType = ['image/jpeg', 'image/png', 'image/webp'].includes(declaredType) ? declaredType : 'image/png';
          return { data: Buffer.from(await response.arrayBuffer()).toString('base64'), mimeType };
        } catch (error) { if (error instanceof ProviderError) throw error; throw new ProviderError('cloudflare', error.name === 'AbortError' ? 504 : 0); }
        finally { clearTimeout(timer); }
      }
    },
    mistral: {
      id: 'mistral', name: 'Mistral', model: mistralModel, visionModel: mistralVisionModel, imageModel: mistralModel, configured: Boolean(mistralKey), capabilities: ['chat', 'vision', 'webResearch', 'image'],
      async chat(messages, research) {
        if (research) {
          const response = await jsonRequest(ProviderError, 'mistral', 'https://api.mistral.ai/v1/conversations', mistralKey, { model: mistralModel, instructions: `${BASE_SYSTEM} Use web_search for current facts. Cite retrieved sources.`, inputs: messages.map(m => `${m.role}: ${m.content}`).join('\n\n'), tools: [{ type: 'web_search' }], store: false }, { timeoutMs: CHAT_TIMEOUT_MS });
          const entries = response.outputs || [];
          const content = entries.flatMap(entry => entry.content || []);
          const citations = content.filter(part => part.url).map(part => ({ url: part.url, title: part.title || part.url }));
          return { text: content.filter(part => part.type === 'text').map(part => part.text).join('\n').trim(), citations: normalizeCitations(citations), searched: true };
        }
        const response = await jsonRequest(ProviderError, 'mistral', 'https://api.mistral.ai/v1/chat/completions', mistralKey, { model: mistralModel, messages: compatibleMessages(messages) }, { timeoutMs: CHAT_TIMEOUT_MS });
        return extractCompatible(response, normalizeCitations);
      },
      async vision(prompt, image, mimeType) {
        const response = await jsonRequest(ProviderError, 'mistral', 'https://api.mistral.ai/v1/chat/completions', mistralKey, { model: mistralVisionModel, messages: [{ role: 'system', content: BASE_SYSTEM }, { role: 'user', content: [{ type: 'text', text: prompt }, { type: 'image_url', image_url: `data:${mimeType};base64,${image}` }] }] });
        return extractCompatible(response, normalizeCitations);
      },
      async generateImage(prompt) {
        const response = await jsonRequest(ProviderError, 'mistral', 'https://api.mistral.ai/v1/chat/completions', mistralKey, { model: mistralModel, messages: [{ role: 'system', content: BASE_SYSTEM }, { role: 'user', content: prompt }], tools: [{ type: 'image_generation' }] }, { timeoutMs: 120_000 });
        const outputText = (response.choices?.[0]?.messages || [response.choices?.[0]?.message]).map(message => textFromMessage(message?.content)).filter(Boolean).join('\n');
        const url = outputText.match(/https:\/\/files\.mistral\.ai\/[A-Za-z0-9_./?=&%-]+/)?.[0];
        if (!url) throw new ProviderError('mistral', 502);
        return await fetchImage(ProviderError, 'mistral', url);
      }
    }
  };

  return providers;
}
