import 'dotenv/config';
import { app, providers, port } from './app.js';

if ((process.env.API_ACCESS_TOKEN || '').length < 32 || /replace|placeholder|change.?me/i.test(process.env.API_ACCESS_TOKEN || '')) {
  throw new Error('API_ACCESS_TOKEN must be at least 32 characters. Generate one with crypto.randomBytes(32).toString("hex").');
}
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be a valid TCP port.');

app.listen(port, '0.0.0.0', () => {
  console.log(`WUK AI backend listening on port ${port}`);
  console.log(`Configured AI providers: ${Object.values(providers).filter(provider => provider.configured).map(provider => provider.id).join(', ') || 'none (health checks only)'}`);
});
