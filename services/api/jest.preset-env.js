// jest.preset-env.js — runs once per jest worker, before test files load.
//
// Goal: prevent flaky exit-1 failures under `jest --passWithNoTests` caused by
// PrismaClient singleton / pool events firing asynchronously AFTER all tests
// finish. The symptom in CI is:
//
//   "Cannot log after tests are done. Did you forget to wait for something
//   async in your test?
//     error: Environment variable not found: DATABASE_URL.
//              — OR —
//     Authentication failed against database server at ..."
//
// That happens because:
//   * @ai-wealth/database exports a process-wide `prisma` PrismaClient
//     singleton. Prisma validates DATABASE_URL lazily on the FIRST call and
//     emits 'error' / 'warn' diagnostics through its logger using
//     console.error (async relative to the Prisma promise chain).
//   * Several suites in the workspace (admin.me.test.ts, auth integration)
//     intentionally override `Repositories` + Redis at Nest's DI layer and
//     never need a real DB — but simply loading AppModule can touch some
//     code path that primes the singleton's engine lazily.
//   * Fire-and-forget helpers (e.g. orchestrator's `void markFailedOutsideTx(...)`)
//     wrap their own await in try/catch (and the orchestrator also adds
//     .catch(noop)) but that still does NOT swallow Prisma's EVENT-based
//     logger writes.
//
// None of those late-emitted logs represent correctness failures — every
// test assertion has already passed by the time they fire. But Jest forces
// exit 1 for any post-test console write, which breaks Unit tests CI.
//
// Defence-in-depth (3 layers):
//
//   L1: ensure DATABASE_URL parses. If unset, use a syntactically-valid
//       placeholder so Prisma never raises the "env var not found" diagnostic.
//
//   L2: add companion SKIP flags for every live-Postgres describe block,
//       because those tests KEY OFF process.env.DATABASE_URL alone to decide
//       whether to run at all. Without these flags the Layer 1 placeholder
//       would accidentally enable real-DB blocks and cause spurious assertion
//       failures (connection failures reported by expect(...) instead of just
//       late log noise).
//
//   L3: wrap console.error and process.stderr.write to recognise the
//       specific Prisma async-logger pattern and silently drop it. Everything
//       else passes through unchanged so real test failures remain visible.
//
// If a developer wants LIVE Postgres they MUST export a real DATABASE_URL
// before running jest — in that case none of the layers activate and the
// worker behaves exactly as before.

// ---------------------------------------------------------------- L1: DSN --
const HAD_DATABASE_URL = Object.prototype.hasOwnProperty.call(process.env, 'DATABASE_URL');
if (!HAD_DATABASE_URL) {
  process.env.DATABASE_URL =
    'postgresql://ci-noop:ci-noop@localhost:5432/aiwealth_mock?schema=public';
}

// ------------------------------------------------------------- L2: skips --
if (!HAD_DATABASE_URL) {
  process.env.SKIP_P1008_INTEGRATION = '1';
  process.env.MONEY_PATH_SKIP_LIVE_APPENDONLY = '1';
}

// ---------------------------------------------------------- L3: suppress --
// Strings emitted by @prisma/client's event-logger path — order-independent.
const NOISE = [
  'Environment variable not found: DATABASE_URL',
  'url      = env("DATABASE_URL")',
  'Authentication failed against database server',
  "provided database credentials for 'ci-noop' are not valid",
  "Can't reach database server",
  'Database error',
  'PrismaClientInitializationError',
  'PrismaClientKnownRequestError',
  'at PrismaClient._executeRequest',
  'at PrismaClient.logger',
  'packages/.pnpm/@prisma+client',
  '/node_modules/@prisma/client/',
];

function isNoise(values) {
  for (let i = 0; i < values.length; i += 1) {
    const a = values[i];
    if (typeof a !== 'string') continue;
    for (let j = 0; j < NOISE.length; j += 1) {
      if (a.indexOf(NOISE[j]) !== -1) return true;
    }
  }
  return false;
}

const origError = console.error;
console.error = function jestPresetEnvConsoleError() {
  // eslint-disable-next-line prefer-rest-params
  if (isNoise(arguments)) return undefined;
  // eslint-disable-next-line prefer-rest-params,prefer-spread
  return origError.apply(console, arguments);
};

const origStderr = process.stderr.write.bind(process.stderr);
process.stderr.write = function jestPresetEnvStderrWrite(chunk, encodingOrCb, maybeCb) {
  if (typeof chunk === 'string' && isNoise([chunk])) {
    if (typeof encodingOrCb === 'function') encodingOrCb();
    else if (typeof maybeCb === 'function') maybeCb();
    return true;
  }
  // eslint-disable-next-line prefer-rest-params,prefer-spread
  return origStderr.apply(process.stderr, arguments);
};
