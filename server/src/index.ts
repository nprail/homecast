import { buildApp, startWorkers } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const server = await buildApp(config);
const { app, ctx } = server;

if (config.startWorkers) startWorkers(server);

await app.listen({ port: config.port, host: config.host });

if (ctx.bootstrap.token) {
  const banner = [
    '',
    '================================================================',
    ' First run: no users exist yet.',
    ` Create the admin account at ${config.publicUrl}/register`,
    ` Bootstrap token: ${ctx.bootstrap.token}`,
    ' (valid until the first account is created; a new one is printed on each restart)',
    '================================================================',
    '',
  ].join('\n');
  app.log.warn(banner);
}

let shuttingDown = false;
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ sig }, 'shutting down');
    server.close().then(() => process.exit(0), () => process.exit(1));
  });
}
