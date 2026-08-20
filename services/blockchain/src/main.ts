import 'dotenv/config';
import http from 'node:http';
import { env, SERVICE_NAMES } from '@ai-wealth/config';
import { createLogger } from '@ai-wealth/shared';
import { buildBlockchainHealth } from './health';

async function main(): Promise<void> {
  const cfg = env('blockchain');
  const logger = createLogger(SERVICE_NAMES.BLOCKCHAIN);

  const server = http.createServer((req, res) => {
    if (!req.url || req.url.split('?')[0] !== '/health') {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({ success: false, error: { code: 'NOT_FOUND', message: 'not found' } }),
      );
      return;
    }
    const body = buildBlockchainHealth();
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(body));
  });

  server.listen(cfg.blockchainPort, () => {
    logger.info('blockchain placeholder listening', { port: cfg.blockchainPort });
  });

  const shutdown = (): void => {
    server.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e: unknown) => {
  const message = e instanceof Error ? e.message : String(e);
  process.stderr.write(`blockchain service failed to start: ${message}\n`);
  process.exit(1);
});
