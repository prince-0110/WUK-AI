export const DEFAULT_API_URL = (process.env.EXPO_PUBLIC_API_URL || 'https://wuk-ai.onrender.com').replace(/\/+$/, '');
const CHAT_TIMEOUT_MS = 70000;
const HEALTH_TIMEOUT_MS = 65000;
const IMAGE_TIMEOUT_MS = 90000;

async function requestJson(url, options = {}, timeoutMs = HEALTH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const externalSignal = options.signal;
  const cancelWithParent = () => controller.abort();
  if (externalSignal?.aborted) controller.abort();
  else externalSignal?.addEventListener('abort', cancelWithParent, { once: true });
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const raw = await response.text();
    let data = {};
    if (raw) {
      try { data = JSON.parse(raw); }
      catch {
        if (response.status === 404) throw new Error('This WUK AI server does not support this feature yet. Deploy the updated backend and try again.');
        throw new Error(`The server returned an invalid response (HTTP ${response.status}).`);
      }
    }
    if (!response.ok) {
      const error = new Error(typeof data.error === 'string' ? data.error : `The server returned HTTP ${response.status}.`);
      error.status = response.status;
      throw error;
    }
    return data;
  } catch (error) {
    if (error?.name === 'AbortError') {
      if (externalSignal?.aborted) throw error;
      const timeout = new Error(timeoutMs === CHAT_TIMEOUT_MS ? 'WUK AI is taking too long to respond. The service may be waking up; try again.' : 'WUK AI is still waking up or the service did not respond. Try the connection check again.');
      timeout.code = 'TIMEOUT';
      throw timeout;
    }
    if (error?.status) throw error;
    const network = new Error('Could not reach the WUK AI backend. Check your connection and try again.');
    network.code = 'NETWORK';
    throw network;
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener('abort', cancelWithParent);
  }
}

function authHeaders(token) {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${token.trim()}` };
}

export async function checkBackend(baseUrl, token) {
  const base = (baseUrl || DEFAULT_API_URL).trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(base)) throw new Error('Enter a complete backend address beginning with https:// or http://.');
  const health = await requestJson(`${base}/health`);
  if (health.ok !== true) throw new Error('The backend health check returned an unexpected response.');
  if (!token?.trim()) return { service: 'reachable', ready: null, message: 'Backend reachable. Add the private access token to check Gemini readiness.' };
  try {
    const status = await requestJson(`${base}/api/status`, { headers: authHeaders(token) });
    return status.ready
      ? { service: 'reachable', ready: true, message: `Backend is reachable and Gemini is configured${status.model ? ` · ${status.model}` : ''}. A real chat request is needed to verify a Gemini response.` }
      : { service: 'reachable', ready: false, message: 'Backend is reachable, but Gemini is not configured on the server.' };
  } catch (error) {
    if (error.status === 401) {
      return { service: 'reachable', ready: false, message: 'Backend is reachable, but the access token was rejected.' };
    }
    throw error;
  }
}

export async function sendToBackend(baseUrl, token, messages, signal) {
  const base = (baseUrl || DEFAULT_API_URL).trim().replace(/\/+$/, '');
  if (!token?.trim()) throw new Error('Add your backend access token in Settings before sending AI messages.');
  const response = await requestJson(`${base}/api/chat`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ messages: messages.filter(m => ['user', 'assistant'].includes(m.role)).slice(-16).map(({ role, text: content }) => ({ role, content: content.slice(0, 2000) })) }),
    signal,
  }, CHAT_TIMEOUT_MS);
  if (typeof response.reply !== 'string' || !response.reply.trim()) throw new Error('The backend returned an empty answer. Try again.');
  return response.reply.trim();
}

export async function askAboutImage(baseUrl, token, prompt, imageBase64, mimeType, signal) {
  const base = (baseUrl || DEFAULT_API_URL).trim().replace(/\/+$/, '');
  if (!token?.trim()) throw new Error('Add your backend access token in Settings before sending AI messages.');
  if (typeof imageBase64 !== 'string' || !imageBase64 || imageBase64.length > 4_800_000) throw new Error('This image is too large to send. Choose a smaller photo.');
  const response = await requestJson(`${base}/api/vision`, {
    method: 'POST', headers: authHeaders(token),
    body: JSON.stringify({ prompt: prompt.trim().slice(0, 1500) || 'Describe this image and answer what you can see.', image: imageBase64, mimeType }), signal,
  }, IMAGE_TIMEOUT_MS);
  if (typeof response.reply !== 'string' || !response.reply.trim()) throw new Error('Gemini returned no answer about the image. Try again.');
  return response.reply.trim();
}

export async function generateImage(baseUrl, token, prompt, signal) {
  const base = (baseUrl || DEFAULT_API_URL).trim().replace(/\/+$/, '');
  if (!token?.trim()) throw new Error('Add your backend access token in Settings before generating an image.');
  if (!prompt?.trim()) throw new Error('Describe the image you want to create.');
  const response = await requestJson(`${base}/api/image`, {
    method: 'POST', headers: authHeaders(token),
    body: JSON.stringify({ prompt: prompt.trim().slice(0, 1000) }), signal,
  }, IMAGE_TIMEOUT_MS);
  const image = response.image;
  if (typeof image?.data !== 'string' || !image.data || !/^image\/(jpeg|png|webp)$/.test(image.mimeType || '')) {
    throw new Error('Gemini did not return a displayable image. Try a different prompt.');
  }
  return { reply: typeof response.reply === 'string' && response.reply.trim() ? response.reply.trim() : 'Here is the image Gemini generated.', image };
}
