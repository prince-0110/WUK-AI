import crypto from 'node:crypto';
import express from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { createProviders, providerCandidates, ProviderError, withProviderFallback } from './providers.js';
import { createCorsMiddleware } from './cors.js';

export const port = Number(process.env.PORT || 8787);
const accessPassword = process.env.API_ACCESS_PASSWORD || '';
const model = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
const imageModel = process.env.GEMINI_IMAGE_MODEL || 'gemini-3.1-flash-image';

export const providers = createProviders(process.env);
const gemini = providers.gemini.configured ? providers.gemini.client : null;
export const app = express();
app.disable('x-powered-by');
app.use(helmet({ crossOriginResourcePolicy: { policy: 'same-site' } }));
app.use(createCorsMiddleware({ origins: process.env.WEB_ORIGINS }));
app.use(express.json({ limit: '6mb', strict: true }));

function authorized(req, res, next) {
  const supplied = req.get('x-backend-password') || '';
  const expectedBytes = Buffer.from(accessPassword);
  const suppliedBytes = Buffer.from(supplied);
  const valid = accessPassword.length >= 12 && expectedBytes.length === suppliedBytes.length && crypto.timingSafeEqual(expectedBytes, suppliedBytes);
  if (!valid) return res.status(401).json({ error: 'Incorrect backend password.' });
  next();
}

app.get('/', (_req, res) => res.json({ ok: true, service: 'WUK AI backend', health: '/health' }));
app.get('/health', (_req, res) => res.json({ ok: true, service: 'WUK AI backend' }));

const chatLimit = rateLimit({
  windowMs: 5 * 60 * 1000,
  limit: 25,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Too many requests. Wait a few minutes and try again.' }
});
const imageLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 4,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Image generation limit reached. Wait 15 minutes and try again.' }
});
const visionLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 12,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Image question limit reached. Wait 15 minutes and try again.' }
});

app.get('/api/status', authorized, (_req, res) => {
  res.json({ ready: Object.values(providers).some(provider => provider.configured), model: gemini ? model : null, imageModel: gemini ? imageModel : null, providers: Object.values(providers).map(({ id, name, model: providerModel, configured, capabilities }) => ({ id, name, model: configured ? providerModel : null, configured, capabilities })) });
});

app.post('/api/chat', authorized, chatLimit, async (req, res) => {
  const providerId = req.body?.provider || 'auto';
  if (providerId !== 'auto' && !providers[providerId]) return res.status(400).json({ error: 'Choose Auto or a supported configured AI provider.' });
  const research = req.body?.research === true;
  const allowFallback = req.body?.allowFallback === true;
  const messages = req.body?.messages;
  if (!Array.isArray(messages) || messages.length < 1 || messages.length > 16) return res.status(400).json({ error: 'Send between 1 and 16 chat messages.' });
  const safeMessages = [];
  for (const message of messages) {
    if (!message || !['user', 'assistant'].includes(message.role) || typeof message.content !== 'string' || !message.content.trim() || message.content.length > 2000) {
      return res.status(400).json({ error: 'Each message needs a user or assistant role and up to 2,000 characters of text.' });
    }
    safeMessages.push({ role: message.role, content: message.content.trim() });
  }
  const candidates = providerCandidates(providers, providerId, 'chat', research);
  if (providerId !== 'auto' && !providers[providerId].configured) return res.status(503).json({ error: `${providers[providerId].name} is not configured on the backend.` });
  if (!candidates.length) return res.status(503).json({ error: research ? 'No configured provider supports the requested web research. Choose Auto or turn research off.' : 'No compatible AI provider is configured on the backend.' });
  try {
    const { provider: answeredBy, result, fallback } = await withProviderFallback(candidates, providerId, providerId === 'auto' || allowFallback, async provider => {
      const answer = await provider.chat(safeMessages, research);
      if (!answer.text) throw new ProviderError(provider.id, 502);
      return answer;
    });
    return res.json({ reply: result.text, provider: answeredBy.id, providerName: answeredBy.name, model: answeredBy.model, fallback, searched: Boolean(result.searched || (research && (result.citations || []).length)), citations: result.citations || [] });
  } catch (error) {
    const failedProvider = error instanceof ProviderError ? error.provider : providerId;
    const status = Number(error?.status);
    console.error(`${failedProvider} request failed${Number.isInteger(status) && status > 0 ? ` (HTTP ${status})` : ''}.`);
    if (error instanceof ProviderError && (status === 401 || status === 403)) return res.status(502).json({ error: `${providers[failedProvider]?.name || 'The selected provider'} rejected its backend credential or model permission. Check server configuration.` });
    if (error instanceof ProviderError && status === 429) return res.status(429).json({ error: 'All compatible configured AI providers are currently rate limited. Try again later.' });
    return res.status(502).json({ error: 'All compatible configured AI providers failed to complete this request. Check provider configuration and try again.' });
  }
});

app.post('/api/vision', authorized, visionLimit, async (req, res) => {
  const { prompt, image, mimeType, provider: providerId = 'auto', allowFallback = true } = req.body || {};
  if (typeof prompt !== 'string' || prompt.length > 1500) return res.status(400).json({ error: 'Add an image question up to 1,500 characters.' });
  if (typeof image !== 'string' || image.length < 100 || image.length > 4_800_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(image)) return res.status(400).json({ error: 'Image data is missing, invalid, or too large.' });
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(mimeType)) return res.status(400).json({ error: 'Use a JPEG, PNG, or WebP image.' });
  if (providerId !== 'auto' && !providers[providerId]) return res.status(400).json({ error: 'Choose Auto or a supported configured AI provider.' });
  const candidates = providerCandidates(providers, providerId, 'vision');
  if (providerId !== 'auto' && !providers[providerId].configured) return res.status(503).json({ error: `${providers[providerId].name} is not configured on the backend.` });
  if (!candidates.length) return res.status(503).json({ error: 'No configured provider supports image questions.' });
  try {
    const { provider: selected, result, fallback } = await withProviderFallback(candidates, providerId, providerId === 'auto' || allowFallback, async provider => {
      const answer = await provider.vision(prompt.trim() || 'Describe this image and answer what you can see.', image, mimeType);
      if (!answer.text) throw new ProviderError(provider.id, 502);
      return answer;
    });
    return res.json({ reply: result.text, provider: selected.id, providerName: selected.name, model: selected.visionModel || selected.model, fallback });
  } catch (error) {
    console.error(`Image question failed at ${error?.provider || providerId}.`);
    return res.status(502).json({ error: 'No compatible configured vision provider could answer this image. Check provider model access and try again.' });
  }
});

app.post('/api/image', authorized, imageLimit, async (req, res) => {
  const { prompt, provider: providerId = 'auto', allowFallback = true } = req.body || {};
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 1000) return res.status(400).json({ error: 'Describe the image you want to generate (up to 1,000 characters).' });
  if (providerId !== 'auto' && !providers[providerId]) return res.status(400).json({ error: 'Choose Auto or a supported configured AI provider.' });
  const candidates = providerCandidates(providers, providerId, 'image');
  if (providerId !== 'auto' && !providers[providerId].configured) return res.status(503).json({ error: `${providers[providerId].name} is not configured on the backend.` });
  if (!candidates.length) return res.status(503).json({ error: 'No configured provider supports image generation.' });
  try {
    const { provider: selected, result: image, fallback } = await withProviderFallback(candidates, providerId, providerId === 'auto' || allowFallback, async provider => {
      const result = await provider.generateImage(prompt.trim());
      if (!result?.data) throw new ProviderError(provider.id, 502);
      return result;
    });
    return res.json({ reply: `Image generated by ${selected.name}.`, provider: selected.id, providerName: selected.name, model: selected.imageModel || selected.model, fallback, image });
  } catch (error) {
    console.error(`Image generation failed at ${error?.provider || providerId}.`);
    return res.status(502).json({ error: 'No compatible configured image provider could generate this request. Check model access and try again.' });
  }
});

app.use((error, req, res, _next) => {
  if (error?.type === 'entity.too.large') return res.status(413).json({ error: 'Request is too large.' });
  if (error instanceof SyntaxError) return res.status(400).json({ error: 'Request body must be valid JSON.' });
  // Keep implementation details out of the API response, but log enough context
  // in the private Worker logs to diagnose failures without logging credentials
  // or request bodies.
  console.error('Unexpected backend error.', {
    method: req.method,
    path: req.path,
    name: error?.name || 'Error',
    message: error?.message || String(error),
  });
  return res.status(500).json({ error: 'Unexpected backend error.' });
});
