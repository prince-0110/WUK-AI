import { httpServerHandler } from 'cloudflare:node';
import { app, port } from './app.js';

app.listen(port);

export default httpServerHandler({ port });
