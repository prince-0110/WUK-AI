import test from 'node:test';
import assert from 'node:assert/strict';
import { createProviders, isFallbackEligible, providerCandidates, ProviderError, withProviderFallback } from '../providers.js';

const env = {
  GROQ_API_KEY: 'groq-test', OPENROUTER_API_KEY: 'router-test',
  CLOUDFLARE_API_TOKEN: 'cloudflare-test', CLOUDFLARE_ACCOUNT_ID: 'account-123',
  MISTRAL_API_KEY: 'mistral-test',
};

test('additional providers expose only documented task capabilities and use configured secrets', () => {
  const providers = createProviders(env);
  for (const id of ['groq', 'openrouter', 'cloudflare', 'mistral']) assert.equal(providers[id].configured, true);
  assert.ok(providers.groq.capabilities.includes('webResearch'));
  assert.ok(providers.cloudflare.capabilities.includes('image'));
  assert.ok(!providers.groq.capabilities.includes('image'));
  assert.equal(createProviders({ ...env, CLOUDFLARE_ACCOUNT_ID: '' }).cloudflare.configured, false);
});

test('auto routing selects task-capable providers and reorders a compatible preference first', () => {
  const providers = createProviders({ ...env, GEMINI_API_KEY: 'gemini-test' });
  assert.equal(providerCandidates(providers, 'auto', 'image')[0].id, 'openrouter');
  assert.equal(providerCandidates(providers, 'auto', 'chat', true)[0].id, 'gemini');
  assert.equal(providerCandidates(providers, 'groq', 'image')[0].id, 'openrouter');
  assert.equal(isFallbackEligible(new ProviderError('groq', 429)), true);
  assert.equal(isFallbackEligible(new ProviderError('groq', 402)), true);
  assert.equal(isFallbackEligible(new ProviderError('groq', 403)), false);
});

test('automatic provider failover continues after an upstream quota error', async () => {
  const tried = [];
  const providers = [{ id: 'gemini' }, { id: 'groq' }, { id: 'mistral' }];
  const result = await withProviderFallback(providers, 'auto', true, async provider => {
    tried.push(provider.id);
    if (provider.id !== 'mistral') throw new ProviderError(provider.id, 429);
    return 'answered';
  });
  assert.deepEqual(tried, ['gemini', 'groq', 'mistral']);
  assert.equal(result.provider.id, 'mistral');
  assert.equal(result.result, 'answered');
  assert.equal(result.fallback, true);
});

test('Groq vision sends base64 image input to its configured vision model', async () => {
  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url, body: JSON.parse(options.body) };
    return new Response(JSON.stringify({ choices: [{ message: { content: 'A visible object.' } }] }), { status: 200 });
  };
  try {
    const result = await createProviders(env).groq.vision('Describe this.', 'aGVsbG8=', 'image/jpeg');
    assert.match(request.url, /api\.groq\.com\/openai\/v1\/chat\/completions$/);
    assert.equal(request.body.model, 'qwen/qwen3.8-27b');
    assert.match(request.body.messages[1].content[1].image_url.url, /^data:image\/jpeg;base64,/);
    assert.equal(result.text, 'A visible object.');
  } finally { globalThis.fetch = originalFetch; }
});

test('OpenRouter image generation returns base64 image data from its image endpoint', async () => {
  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url, body: JSON.parse(options.body) };
    return new Response(JSON.stringify({ data: [{ b64_json: 'aGVsbG8=', media_type: 'image/png' }] }), { status: 200 });
  };
  try {
    const result = await createProviders(env).openrouter.generateImage('A green landscape');
    assert.equal(request.url, 'https://openrouter.ai/api/v1/images');
    assert.equal(request.body.model, 'google/gemini-3.1-flash-image');
    assert.deepEqual(result, { data: 'aGVsbG8=', mimeType: 'image/png' });
  } finally { globalThis.fetch = originalFetch; }
});

test('Mistral web research uses Conversations API with web_search tool enabled', async () => {
  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url, body: JSON.parse(options.body) };
    return new Response(JSON.stringify({ outputs: [{ type: 'message.output', content: [{ type: 'text', text: 'Current answer.' }, { type: 'tool_reference', title: 'Source', url: 'https://example.test/news' }] }] }), { status: 200 });
  };
  try {
    const result = await createProviders(env).mistral.chat([{ role: 'user', content: 'What happened today?' }], true);
    assert.equal(request.url, 'https://api.mistral.ai/v1/conversations');
    assert.deepEqual(request.body.tools, [{ type: 'web_search' }]);
    assert.equal(request.body.store, false);
    assert.equal(result.text, 'Current answer.');
    assert.equal(result.citations[0].url, 'https://example.test/news');
  } finally { globalThis.fetch = originalFetch; }
});

test('Cloudflare image generation uses the configured account and Workers AI model route', async () => {
  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url, options };
    return new Response(Uint8Array.from([137, 80, 78, 71]), { status: 200, headers: { 'content-type': 'application/octet-stream' } });
  };
  try {
    const result = await createProviders(env).cloudflare.generateImage('An emerald city at night');
    assert.match(request.url, /accounts\/account-123\/ai\/run\/@cf\/stabilityai\/stable-diffusion-xl-base-1\.0$/);
    assert.equal(JSON.parse(request.options.body).prompt, 'An emerald city at night');
    assert.equal(result.mimeType, 'image/png');
    assert.equal(Buffer.from(result.data, 'base64')[0], 137);
  } finally { globalThis.fetch = originalFetch; }
});
