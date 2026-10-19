import { GoogleGenAI } from '@google/genai';
import { createAdditionalProviders } from './providerExtras.js';

const GOOGLE_SEARCH_PROMPT = 'Research this request using current web information. Cite factual claims with the sources returned by your search. Never invent source URLs, titles, dates, or quotations.';
const SYSTEM_PROMPT = 'You are WUK AI, a clear, useful personal assistant created by Wuk72. Be honest about uncertainty. Do not claim to have performed actions outside this chat.';

export class ProviderError extends Error {
  constructor(provider, status, message = 'The provider could not complete this request.') {
    super(message);
    this.name = 'ProviderError';
    this.provider = provider;
    this.status = status;
  }
}

export function isFallbackEligible(error) {
  return error instanceof ProviderError && (error.status === 0 || error.status === 402 || error.status === 408 || error.status === 425 || error.status === 429 || error.status >= 500);
}

export function chooseFallbackProvider(providers, selected, research) {
  return Object.values(providers).find(candidate => candidate.configured && candidate.id !== selected.id && candidate.capabilities.includes('chat') && (!research || candidate.capabilities.includes('webResearch'))) || null;
}

export function providerCandidates(providers, requested = 'auto', capability = 'chat', research = false, excluded = []) {
  const blocked = new Set(excluded);
  const candidates = Object.values(providers).filter(item => item.configured && item.capabilities.includes(capability) && (!research || item.capabilities.includes('webResearch')) && !blocked.has(item.id));
  const order = research ? ['gemini', 'openai', 'anthropic', 'groq', 'openrouter', 'mistral'] : ({
    chat: ['gemini', 'groq', 'mistral', 'openrouter', 'openai', 'anthropic', 'cloudflare'],
    vision: ['gemini', 'openrouter', 'mistral', 'groq', 'cloudflare', 'openai', 'anthropic'],
    image: ['openrouter', 'gemini', 'mistral', 'cloudflare', 'openai'],
  }[capability] || []);
  candidates.sort((a, b) => (order.indexOf(a.id) < 0 ? 99 : order.indexOf(a.id)) - (order.indexOf(b.id) < 0 ? 99 : order.indexOf(b.id)));
  if (requested !== 'auto') {
    const selectedIndex = candidates.findIndex(item => item.id === requested);
    if (selectedIndex > 0) candidates.unshift(candidates.splice(selectedIndex, 1)[0]);
  }
  return candidates;
}

export async function withProviderFallback(candidates, requested, allowFallback, run) {
  const attempts = allowFallback ? candidates : candidates.slice(0, 1);
  let lastError;
  for (let index = 0; index < attempts.length; index += 1) {
    const provider = attempts[index];
    try {
      const result = await run(provider);
      return { provider, result, fallback: index > 0 || (requested !== 'auto' && provider.id !== requested) };
    } catch (error) {
      lastError = error;
      if (!isFallbackEligible(error) || index === attempts.length - 1) throw error;
      console.warn(`${provider.id} unavailable; trying the next compatible provider.`);
    }
  }
  throw lastError || new ProviderError('auto', 503);
}

function configured(value) {
  return Boolean(value && !/replace|placeholder|change.?me/i.test(value));
}

function citationsFromGemini(interaction) {
  const citations = [];
  for (const step of interaction.steps || []) {
    if (step.type !== 'model_output') continue;
    for (const item of step.content || []) {
      for (const annotation of item.annotations || []) {
        if (annotation.type === 'url_citation' && annotation.url) citations.push({ url: annotation.url, title: annotation.title || annotation.url });
      }
    }
  }
  // Older Interactions responses can still contain output annotations.
  for (const output of interaction.outputs || []) {
    if (output.type !== 'text') continue;
    for (const annotation of output.annotations || []) if (annotation.source) citations.push({ url: annotation.source, title: annotation.title || annotation.source });
  }
  return normalizeCitations(citations);
}

function normalizeCitations(items) {
  const seen = new Set();
  return items.filter(item => {
    try {
      const url = new URL(item.url);
      if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
      if (seen.has(url.href)) return false;
      seen.add(url.href);
      item.url = url.href;
      item.publisher = item.publisher || url.hostname;
      item.retrievedAt = new Date().toISOString();
      return true;
    } catch { return false; }
  }).slice(0, 12);
}

async function fetchJson(provider, url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    let body;
    try { body = await response.json(); } catch { body = {}; }
    if (!response.ok) throw new ProviderError(provider, response.status);
    return body;
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    throw new ProviderError(provider, error.name === 'AbortError' ? 504 : 0);
  } finally { clearTimeout(timer); }
}

function extractOpenAi(response) {
  const citations = [];
  for (const item of response.output || []) {
    for (const content of item.content || []) {
      for (const annotation of content.annotations || []) {
        if (annotation.type === 'url_citation' && annotation.url) citations.push({ url: annotation.url, title: annotation.title || annotation.url });
      }
    }
  }
  return { text: response.output_text?.trim() || '', citations: normalizeCitations(citations) };
}

function extractAnthropic(response) {
  const text = [];
  const citations = [];
  for (const block of response.content || []) {
    if (block.type === 'text' && block.text) text.push(block.text);
    if (block.type === 'web_search_tool_result') {
      for (const item of block.content || []) if (item.type === 'web_search_result' && item.url) citations.push({ url: item.url, title: item.title || item.url });
    }
    for (const citation of block.citations || []) if (citation.url) citations.push({ url: citation.url, title: citation.title || citation.url });
  }
  return { text: text.join('\n').trim(), citations: normalizeCitations(citations) };
}

export function createProviders(env = process.env) {
  const geminiKey = configured(env.GEMINI_API_KEY) ? env.GEMINI_API_KEY : '';
  const openAiKey = configured(env.OPENAI_API_KEY) ? env.OPENAI_API_KEY : '';
  const anthropicKey = configured(env.ANTHROPIC_API_KEY) ? env.ANTHROPIC_API_KEY : '';
  const geminiModel = env.GEMINI_MODEL || 'gemini-3.8-flash';
  const geminiImageModel = env.GEMINI_IMAGE_MODEL || 'gemini-3.1-flash-image';
  const openAiModel = env.OPENAI_MODEL || 'gpt-5-mini';
  const openAiImageModel = env.OPENAI_IMAGE_MODEL || 'gpt-image-1';
  const anthropicModel = env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';
  // Keep the existing multimedia client separate from the bounded-time chat client.
  const gemini = geminiKey ? new GoogleGenAI({ apiKey: geminiKey }) : null;
  const geminiChat = geminiKey ? new GoogleGenAI({ apiKey: geminiKey, httpOptions: { timeout: 60_000 } }) : null;

  const providers = {
    gemini: {
      id: 'gemini', name: 'Gemini', model: geminiModel, visionModel: geminiModel, imageModel: geminiImageModel, configured: Boolean(gemini), capabilities: ['chat', 'vision', 'image', 'webResearch'], client: gemini,
      async chat(messages, research) {
        const transcript = messages.map(message => `${message.role === 'assistant' ? 'WUK AI' : 'User'}: ${message.content}`).join('\n\n');
        try {
          const interaction = await geminiChat.interactions.create({ model: geminiModel, input: research ? `${GOOGLE_SEARCH_PROMPT}\n\n${transcript}` : transcript, ...(research ? { tools: [{ type: 'google_search' }] } : {}), system_instruction: SYSTEM_PROMPT, store: false });
          const result = extractGeminiText(interaction);
          return { ...result, citations: research ? citationsFromGemini(interaction) : [] };
        } catch (error) {
          throw new ProviderError('gemini', Number(error?.status) || 0);
        }
      }
    },
    openai: {
      id: 'openai', name: 'OpenAI API', model: openAiModel, visionModel: openAiModel, imageModel: openAiImageModel, configured: Boolean(openAiKey), capabilities: ['chat', 'vision', 'webResearch', 'image'],
      async chat(messages, research) {
        const response = await fetchJson('openai', 'https://api.openai.com/v1/responses', { method: 'POST', headers: { Authorization: `Bearer ${openAiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: openAiModel, instructions: SYSTEM_PROMPT, input: messages.map(({ role, content }) => ({ role, content })), ...(research ? { tools: [{ type: 'web_search' }] } : {}), store: false }) });
        return extractOpenAi(response);
      },
      async vision(prompt, image, mimeType) {
        const response = await fetchJson('openai', 'https://api.openai.com/v1/responses', { method: 'POST', headers: { Authorization: `Bearer ${openAiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: openAiModel, instructions: SYSTEM_PROMPT, input: [{ role: 'user', content: [{ type: 'input_text', text: prompt }, { type: 'input_image', image_url: `data:${mimeType};base64,${image}` }] }], store: false }) });
        return extractOpenAi(response);
      },
      async generateImage(prompt) {
        const response = await fetchJson('openai', 'https://api.openai.com/v1/images/generations', { method: 'POST', headers: { Authorization: `Bearer ${openAiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: openAiImageModel, prompt, size: '1024x1024' }) });
        if (!response.data?.[0]?.b64_json) throw new ProviderError('openai', 502);
        return { data: response.data[0].b64_json, mimeType: 'image/png' };
      }
    },
    anthropic: {
      id: 'anthropic', name: 'Claude API', model: anthropicModel, visionModel: anthropicModel, configured: Boolean(anthropicKey), capabilities: ['chat', 'vision', 'webResearch'],
      async chat(messages, research) {
        const system = research ? `${SYSTEM_PROMPT}\n\n${GOOGLE_SEARCH_PROMPT}` : SYSTEM_PROMPT;
        const response = await fetchJson('anthropic', 'https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, body: JSON.stringify({ model: anthropicModel, max_tokens: 2048, system, messages: messages.map(({ role, content }) => ({ role, content })), ...(research ? { tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 4 }] } : {}) }) });
        return extractAnthropic(response);
      },
      async vision(prompt, image, mimeType) {
        const response = await fetchJson('anthropic', 'https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, body: JSON.stringify({ model: anthropicModel, max_tokens: 2048, system: SYSTEM_PROMPT, messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, { type: 'image', source: { type: 'base64', media_type: mimeType, data: image } }] }] }) });
        return extractAnthropic(response);
      }
    },
    ...createAdditionalProviders(env, { ProviderError, normalizeCitations })
  };

  return providers;
}

function extractGeminiText(interaction) {
  const text = interaction.output_text?.trim();
  if (text) return { text, citations: [] };
  const parts = [];
  for (const step of interaction.steps || []) if (step.type === 'model_output') for (const item of step.content || []) if (item.type === 'text' && item.text) parts.push(item.text);
  for (const output of interaction.outputs || []) if (output.type === 'text' && output.text) parts.push(output.text);
  return { text: parts.join('\n').trim(), citations: [] };
}
