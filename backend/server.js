import 'dotenv/config';

import crypto from 'node:crypto';
import express from 'express';
import helmet from 'helmet';
import { GoogleGenAI } from '@google/genai';
import { rateLimit } from 'express-rate-limit';

const app = express();
const port = Number(process.env.PORT || 8787);
const accessToken = process.env.API_ACCESS_TOKEN || '';
const model = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
const imageModel = process.env.GEMINI_IMAGE_MODEL || 'gemini-3.1-flash-image';
const apiKey = process.env.GEMINI_API_KEY || '';

if (accessToken.length < 32 || /replace|placeholder|change.?me/i.test(accessToken)) {
  throw new Error('API_ACCESS_TOKEN must be at least 32 characters. Generate one with crypto.randomBytes(32).toString("hex").');
}
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be a valid TCP port.');

const hasApiKey = Boolean(apiKey && !/replace|placeholder|change.?me/i.test(apiKey));
const gemini = hasApiKey ? new GoogleGenAI({ apiKey }) : null;
app.disable('x-powered-by');
app.use(helmet({ crossOriginResourcePolicy: { policy: 'same-site' } }));
app.use(express.json({ limit: '6mb', strict: true }));

function authorized(req, res, next) {
  const header = req.get('authorization') || '';
  const supplied = header.startsWith('Bearer ') ? header.slice(7) : '';
  const expectedBytes = Buffer.from(accessToken);
  const suppliedBytes = Buffer.from(supplied);
  const valid = expectedBytes.length === suppliedBytes.length && crypto.timingSafeEqual(expectedBytes, suppliedBytes);
  if (!valid) return res.status(401).json({ error: 'Invalid backend access token.' });
  next();
}

app.get('/', (_req, res) => res.json({ ok: true, service: 'WUK AI Gemini backend', health: '/health' }));
app.get('/health', (_req, res) => res.json({ ok: true, service: 'WUK AI Gemini backend' }));

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
  res.json({ ready: Boolean(gemini), model: gemini ? model : null, imageModel: gemini ? imageModel : null });
});

app.post('/api/chat', authorized, chatLimit, async (req, res) => {
  if (!gemini) return res.status(503).json({ error: 'The backend has no Gemini API key configured.' });
  const messages = req.body?.messages;
  if (!Array.isArray(messages) || messages.length < 1 || messages.length > 16) {
    return res.status(400).json({ error: 'Send between 1 and 16 chat messages.' });
  }
  const safeMessages = [];
  for (const message of messages) {
    if (!message || !['user', 'assistant'].includes(message.role) || typeof message.content !== 'string' || !message.content.trim() || message.content.length > 2000) {
      return res.status(400).json({ error: 'Each message needs a user or assistant role and up to 2,000 characters of text.' });
    }
    safeMessages.push({ role: message.role, content: message.content.trim() });
  }

  // The stateless transcript keeps local chat history useful without asking Gemini to store it.
  const transcript = safeMessages
    .map(message => `${message.role === 'assistant' ? 'WUK AI' : 'User'}: ${message.content}`)
    .join('\n\n');

  try {
    const interaction = await gemini.interactions.create({
      model,
      input: transcript,
      system_instruction: 'You are WUK AI, a clear, useful personal assistant created by Wuk72. Treat lines labeled User as user messages and lines labeled WUK AI as earlier assistant replies. Be honest about uncertainty. Do not claim to have performed actions outside this chat.',
      store: false
    });
    const reply = interaction.output_text?.trim();
    if (!reply) return res.status(502).json({ error: 'Gemini returned no text. Try again.' });
    return res.json({ reply });
  } catch (error) {
    const status = Number(error?.status);
    // Do not return provider error bodies, request details, or credentials to the mobile app.
    console.error(`Gemini request failed${Number.isInteger(status) ? ` (HTTP ${status})` : ''}.`);
    return res.status(502).json({ error: 'Gemini could not complete this request. Check backend logs and try again.' });
  }
});

app.post('/api/vision', authorized, visionLimit, async (req, res) => {
  if (!gemini) return res.status(503).json({ error: 'The backend has no Gemini API key configured.' });
  const { prompt, image, mimeType } = req.body || {};
  if (typeof prompt !== 'string' || prompt.length > 1500) return res.status(400).json({ error: 'Add an image question up to 1,500 characters.' });
  if (typeof image !== 'string' || image.length < 100 || image.length > 4_800_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(image)) {
    return res.status(400).json({ error: 'Image data is missing, invalid, or too large.' });
  }
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(mimeType)) return res.status(400).json({ error: 'Use a JPEG, PNG, or WebP image.' });

  try {
    const interaction = await gemini.interactions.create({
      model,
      input: [
        { type: 'text', text: prompt.trim() || 'Describe this image and answer what you can see.' },
        { type: 'image', data: image, mime_type: mimeType }
      ],
      system_instruction: 'You are WUK AI by Wuk72. Describe only what is visible, be clear when uncertain, and do not claim to identify people.',
      store: false
    });
    const reply = interaction.output_text?.trim();
    if (!reply) return res.status(502).json({ error: 'Gemini returned no image answer. Try again.' });
    return res.json({ reply });
  } catch (error) {
    const status = Number(error?.status);
    console.error(`Gemini image question failed${Number.isInteger(status) ? ` (HTTP ${status})` : ''}.`);
    return res.status(502).json({ error: 'Gemini could not answer about this image. Try again.' });
  }
});

app.post('/api/image', authorized, imageLimit, async (req, res) => {
  if (!gemini) return res.status(503).json({ error: 'The backend has no Gemini API key configured.' });
  const prompt = req.body?.prompt;
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 1000) {
    return res.status(400).json({ error: 'Describe the image you want to generate (up to 1,000 characters).' });
  }

  try {
    const interaction = await gemini.interactions.create({
      model: imageModel,
      input: prompt.trim(),
      response_format: { type: 'image', mime_type: 'image/jpeg', aspect_ratio: '1:1', image_size: '1K' },
      store: false
    });
    const output = interaction.output_image;
    if (!output?.data) return res.status(502).json({ error: 'Gemini did not return an image. Try a different prompt.' });
    const mimeType = ['image/jpeg', 'image/png', 'image/webp'].includes(output.mime_type) ? output.mime_type : 'image/jpeg';
    return res.json({ reply: interaction.output_text?.trim() || 'Here is the image Gemini generated.', image: { mimeType, data: output.data } });
  } catch (error) {
    const status = Number(error?.status);
    console.error(`Gemini image generation failed${Number.isInteger(status) ? ` (HTTP ${status})` : ''}.`);
    return res.status(502).json({ error: 'Gemini could not generate this image. Check image-model access and try again.' });
  }
});

app.use((error, _req, res, _next) => {
  if (error?.type === 'entity.too.large') return res.status(413).json({ error: 'Request is too large.' });
  if (error instanceof SyntaxError) return res.status(400).json({ error: 'Request body must be valid JSON.' });
  console.error('Unexpected backend error.');
  return res.status(500).json({ error: 'Unexpected backend error.' });
});

app.listen(port, '0.0.0.0', () => {
  console.log(`WUK AI Gemini backend listening on port ${port}`);
  console.log(`Model: ${gemini ? model : 'not configured (health checks only)'}`);
});
