import 'dotenv/config';
import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';
import { createApp } from './app.js';

const configuredPort = process.env.PORT ?? '3001';
if (!/^\d{1,5}$/.test(configuredPort)) throw new Error('PORT must be an integer from 1 to 65535.');
const port = Number(configuredPort);
if (port < 1 || port > 65_535) throw new Error('PORT must be an integer from 1 to 65535.');

const databasePath = process.env.DATABASE_PATH?.trim();
const app = createApp(databasePath ? { databasePath } : {});
const webRoot = resolve(process.cwd(), 'dist', 'client');

try {
  await access(resolve(webRoot, 'index.html'));
  await app.register(fastifyStatic, { root: webRoot, prefix: '/' });
} catch {
  // The API can run without a built web client during development.
}

await app.listen({ host: '127.0.0.1', port });
installShutdownHandlers(app);

function installShutdownHandlers(server: FastifyInstance): void {
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    try { await server.close(); }
    catch { process.exitCode = 1; }
  };
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
}
