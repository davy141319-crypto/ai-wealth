import { Queue, Worker } from 'bullmq';
import Redis from 'ioredis';
import { env, QUEUES } from '@ai-wealth/config';
import type { Logger } from '@ai-wealth/shared';

export interface WorkerHandle {
  queue: Queue;
  worker: Worker;
  redis: Redis;
  getLastJobAt: () => string | null;
  close: () => Promise<void>;
}

/**
 * Creates the BullMQ Queue + Worker for the health-check job and the shared
 * Redis connection used by the HTTP health probe.
 *
 * Future long-running work (settlement, blockchain listening, notifications,
 * reports, risk, data sync) will be added as additional queues/processors here;
 * the API never runs such work inline.
 */
export async function createWorkerQueue(logger: Logger): Promise<WorkerHandle> {
  // env('worker') is the preset the worker process booted with (see main.ts).
  // Calling it again returns the cached config; passing a different preset
  // would throw because a process must use one preset only.
  const cfg = env('worker');
  const redisUrl = cfg.redisUrl;
  const sharedConn = new Redis(redisUrl, { maxRetriesPerRequest: null });
  const workerConn = new Redis(redisUrl, { maxRetriesPerRequest: null });

  const queue = new Queue(QUEUES.HEALTH_CHECK, { connection: sharedConn });
  let lastJobAt: string | null = null;

  const worker = new Worker(
    QUEUES.HEALTH_CHECK,
    async (job) => {
      lastJobAt = new Date().toISOString();
      logger.info('health-check job processed', {
        job_id: job.id ?? 'unknown',
        job_name: job.name,
      });
      return { ok: true, processedAt: lastJobAt };
    },
    { connection: workerConn, concurrency: cfg.workerConcurrency },
  );

  worker.on('failed', (job, err) => {
    logger.error('health-check job failed', {
      job_id: job?.id ?? 'unknown',
      error: err.message,
    });
  });

  return {
    queue,
    worker,
    redis: sharedConn,
    getLastJobAt: () => lastJobAt,
    close: async () => {
      await worker.close();
      await queue.close();
      await workerConn.quit();
      await sharedConn.quit();
    },
  };
}
