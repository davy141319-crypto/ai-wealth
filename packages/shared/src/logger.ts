/**
 * Unified structured logger.
 *
 * Emits one JSON object per line with at least:
 *   timestamp, level, service, request_id?, message, ...extra fields
 *
 * In production this is machine-parseable JSON logging; in development the same
 * JSON shape is used (kept simple on purpose) so log pipelines are identical.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogFields {
  service?: string;
  request_id?: string;
  [key: string]: unknown;
}

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function resolveLevel(): LogLevel {
  const raw = (
    process.env.LOG_LEVEL || (process.env.NODE_ENV === 'production' ? 'info' : 'debug')
  ).toLowerCase();
  if (raw === 'debug' || raw === 'info' || raw === 'warn' || raw === 'error') {
    return raw;
  }
  return 'info';
}

function emit(level: LogLevel, message: string, fields: LogFields): void {
  if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[resolveLevel()]) {
    return;
  }
  const entry: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    level,
    message,
    ...fields,
  };
  const line = JSON.stringify(entry);
  if (level === 'error' || level === 'warn') {
    process.stderr.write(line + '\n');
  } else {
    process.stdout.write(line + '\n');
  }
}

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  child(fields: LogFields): Logger;
}

export function createLogger(service: string, baseFields: LogFields = {}): Logger {
  const ctx: LogFields = { service, ...baseFields };
  const build = (extra: LogFields): Logger => {
    const current: LogFields = { ...ctx, ...extra };
    return {
      debug: (m, f) => emit('debug', m, { ...current, ...f }),
      info: (m, f) => emit('info', m, { ...current, ...f }),
      warn: (m, f) => emit('warn', m, { ...current, ...f }),
      error: (m, f) => emit('error', m, { ...current, ...f }),
      child: (f) => build({ ...current, ...f }),
    };
  };
  return build({});
}
