import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseFallbackProvider, createProviders, isFallbackEligible, ProviderError } from '../providers.js';

const env = {
  API_ACCESS_PASSWORD: 'test-password-123',
  GEMINI_API_KEY: 'test-gemini-key',
  OPENAI_API_KEY: 'test-openai-key',
  ANTHROPIC_API_KEY: 'test-anthropic-key'
};

test('provider discovery only reports configured providers and keeps model metadata', () => {
  const providers = createProviders({ ...env, ANTHROPIC_API_KEY: '' });
  assert.equal(providers.gemini.configured, true);
  assert.equal(typeof providers.gemini.client.interactions.create, 'function');
  assert.equal(providers.openai.configured, true);
  assert.equal(providers.anthropic.configured, false);
  assert.equal(providers.openai.model, 'gpt-5-mini');
});

test('OpenAI adapter uses Responses API, supports web search, and normalizes source citations', async () => {
  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url, options, body: JSON.parse(options.body) };
    return new Response(JSON.stringify({
      output_text: 'A researched answer.',
      output: [{ content: [{ annotations: [{ type: 'url_citation', title: 'Publisher', url: 'https://example.com/story' }] }] }]
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const result = await createProviders(env).openai.chat([{ role: 'user', content: 'What changed today?' }], true);
    assert.equal(request.url, 'https://api.openai.com/v1/responses');
    assert.deepEqual(request.body.tools, [{ type: 'web_search' }]);
    assert.equal(request.body.store, false);
    assert.equal(result.text, 'A researched answer.');
    assert.equal(result.citations.length, 1);
    assert.equal(result.citations[0].title, 'Publisher');
    assert.equal(result.citations[0].publisher, 'example.com');
    assert.ok(result.citations[0].retrievedAt);
    assert.equal(result.citations[0].url, 'https://example.com/story');
  } finally { globalThis.fetch = originalFetch; }
});

test('Anthropic adapter uses Messages API web search and returns cited result links', async () => {
  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url, options, body: JSON.parse(options.body) };
    return new Response(JSON.stringify({ content: [
      { type: 'text', text: 'Current information.' },
      { type: 'web_search_tool_result', content: [{ type: 'web_search_result', title: 'Official', url: 'https://example.org/current' }] }
    ] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const result = await createProviders(env).anthropic.chat([{ role: 'user', content: 'Latest update?' }], true);
    assert.equal(request.url, 'https://api.anthropic.com/v1/messages');
    assert.equal(request.options.headers['anthropic-version'], '2023-06-01');
    assert.equal(request.body.tools[0].type, 'web_search_20250305');
    assert.equal(result.text, 'Current information.');
    assert.equal(result.citations.length, 1);
    assert.equal(result.citations[0].title, 'Official');
    assert.equal(result.citations[0].publisher, 'example.org');
    assert.ok(result.citations[0].retrievedAt);
    assert.equal(result.citations[0].url, 'https://example.org/current');
  } finally { globalThis.fetch = originalFetch; }
});

test('provider adapter classifies upstream rate limits without exposing response bodies', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: 'private upstream details' } }), { status: 429 });
  try {
    await assert.rejects(createProviders(env).openai.chat([{ role: 'user', content: 'hello' }], false), error => {
      assert.ok(error instanceof ProviderError);
      assert.equal(error.provider, 'openai');
      assert.equal(error.status, 429);
      assert.equal(error.message, 'The provider could not complete this request.');
      return true;
    });
  } finally { globalThis.fetch = originalFetch; }
});

test('fallback is opt-in gated and excludes authentication and permission failures', () => {
  const providers = createProviders(env);
  assert.equal(isFallbackEligible(new ProviderError('gemini', 429)), true);
  assert.equal(isFallbackEligible(new ProviderError('gemini', 504)), true);
  assert.equal(isFallbackEligible(new ProviderError('gemini', 403)), false);
  assert.equal(isFallbackEligible(new ProviderError('gemini', 401)), false);
  assert.equal(chooseFallbackProvider(providers, providers.gemini, true).id, 'openai');
  assert.equal(chooseFallbackProvider({ gemini: providers.gemini }, providers.gemini, false), null);
});
