import 'dotenv/config';
import { app, providers, port } from './app.js';

const accessPassword = process.env.API_ACCESS_PASSWORD || process.env.API_ACCESS_TOKEN || '';
if (accessPassword.length < 12 || /replace|placeholder|change.?me/i.test(accessPassword)) {
  throw new Error('API_ACCESS_PASSWORD must be at least 12 characters. Use a private passphrase, not a short PIN.');
}
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be a valid TCP port.');

app.listen(port, '0.0.0.0', () => {
  console.log(`WUK AI backend listening on port ${port}`);
  console.log(`Configured AI providers: ${Object.values(providers).filter(provider => provider.configured).map(provider => provider.id).join(', ') || 'none (health checks only)'}`);
});
