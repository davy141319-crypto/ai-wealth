import 'dotenv/config';
import http from 'node:http';
import { env, SERVICE_NAMES } from '@ai-wealth/config';
import { createLogger } from '@ai-wealth/shared';
import { createWorkerQueue } from './queue';
import { buildWorkerHealth } from './health';

async function main(): Promise<void> {
  const cfg = env('worker');
  const logger = createLogger(SERVICE_NAMES.WORKER);

  const { queue, redis, getLastJobAt, close } = await createWorkerQueue(logger);

  // Immediate job on boot — verifies the worker actually processes work.
  await queue.add('health-check', { emittedAt: Date.now() });
  // Continuous liveness — re-enqueue every minute.
  const interval = setInterval(() => {
    void queue.add('health-check', { emittedAt: Date.now() }).catch((e: unknown) => {
      logger.error('failed to enqueue health-check', {
        error: e instanceof Error ? e.message : String(e),
      });
    });
  }, 60_000);

  const server = http.createServer((req, res) => {
    if (!req.url || req.url.split('?')[0] !== '/health') {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({ success: false, error: { code: 'NOT_FOUND', message: 'not found' } }),
      );
      return;
    }
    void (async () => {
      const start = Date.now();
      let status: 'ok' | 'down' = 'down';
      let error: string | undefined;
      try {
        const reply = await redis.ping();
        if (reply === 'PONG') {
          status = 'ok';
        } else {
          error = `unexpected PING reply: ${reply}`;
        }
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }
      const body = buildWorkerHealth(
        { status, latencyMs: Date.now() - start, ...(error ? { error } : {}) },
        getLastJobAt(),
      );
      res.statusCode = body.status === 'ok' ? 200 : 503;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(body));
    })();
  });

  server.listen(cfg.workerPort, () => {
    logger.info('worker health server listening', { port: cfg.workerPort, queue: 'health-check' });
  });

  const shutdown = async (): Promise<void> => {
    clearInterval(interval);
    server.close();
    await close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch((e: unknown) => {
  const message = e instanceof Error ? e.message : String(e);
  process.stderr.write(`worker failed to start: ${message}\n`);
  process.exit(1);
});
