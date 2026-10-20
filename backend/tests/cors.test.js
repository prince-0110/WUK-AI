import test from 'node:test';
import assert from 'node:assert/strict';
import { createCorsMiddleware } from '../cors.js';

function invoke(middleware, { origin, method = 'GET' }) {
  const headers = {};
  const result = { statusCode: null, body: null, ended: false, next: false };
  const res = {
    setHeader: (name, value) => { headers[name] = value; },
    status(code) { result.statusCode = code; return this; },
    json(body) { result.body = body; return this; },
    end() { result.ended = true; return this; },
  };
  middleware({ get: name => name === 'origin' ? origin : undefined, method }, res, () => { result.next = true; });
  return { ...result, headers };
}

test('production CORS allows only exact configured website origins', () => {
  const middleware = createCorsMiddleware({ origins: 'https://app.example, https://admin.example', production: true });
  const allowed = invoke(middleware, { origin: 'https://app.example' });
  assert.equal(allowed.next, true);
  assert.equal(allowed.headers['Access-Control-Allow-Origin'], 'https://app.example');
  assert.equal(invoke(middleware, { origin: 'https://evil.example' }).statusCode, 403);
});

test('development allows local Expo web origins and preflights requested headers', () => {
  const middleware = createCorsMiddleware({ production: false });
  const response = invoke(middleware, { origin: 'http://localhost:8081', method: 'OPTIONS' });
  assert.equal(response.statusCode, 204);
  assert.equal(response.ended, true);
  assert.match(response.headers['Access-Control-Allow-Headers'], /X-Backend-Password/i);
  assert.equal(invoke(middleware, { origin: 'https://random.example' }).statusCode, 403);
});
