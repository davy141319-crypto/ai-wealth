/**
 * Admin Jest custom transformer: wraps ts-jest to pre-process Vite import.meta.env
 * references so Jest can load them in CJS mode (SyntaxError-free).
 *
 *   import.meta.env.VITE_API_URL   → process.env.VITE_API_URL ?? 'http://localhost:4000/api'
 *   import.meta.env.BASE_URL       → process.env.BASE_URL ?? '/'
 *   import.meta.env                → process.env
 *   import.meta.env[...]           → process.env[...]
 *
 * Order matters: specific VITE_* substitutions happen BEFORE the
 * catch-all `import.meta.env` replace.
 */
const { TsJestTransformer } = require('ts-jest');

const tsjestTransformer = new TsJestTransformer({});

const REPLACEMENTS = [
  [
    /import\.meta\.env\.VITE_API_URL/g,
    "(process.env.VITE_API_URL ?? 'http://localhost:4000/api')",
  ],
  [/import\.meta\.env\.BASE_URL/g, "(process.env.BASE_URL ?? '/')"],
  [
    /import\.meta\.env\[(['"]?)([^'"\]]+)\1\]/g,
    (_match, quote, name) => `process.env[${quote}${name}${quote}]`,
  ],
  [/import\.meta\.env/g, 'process.env'],
];

function preprocess(sourceText) {
  let code = sourceText;
  for (const [re, rep] of REPLACEMENTS) code = code.replace(re, rep);
  return code;
}

module.exports = {
  process(sourceText, sourcePath, options) {
    const transformed = preprocess(sourceText);
    return tsjestTransformer.process(transformed, sourcePath, options);
  },
  processAsync(sourceText, sourcePath, options) {
    const transformed = preprocess(sourceText);
    if (tsjestTransformer.processAsync) {
      return tsjestTransformer.processAsync(transformed, sourcePath, options);
    }
    return Promise.resolve(
      tsjestTransformer.process(transformed, sourcePath, options),
    );
  },
  getCacheKey(fileData, filePath, jestConfig, options) {
    const ruleSig = REPLACEMENTS.map(([r]) => r.toString()).join('|');
    const base = tsjestTransformer.getCacheKey
      ? tsjestTransformer.getCacheKey(fileData, filePath, jestConfig, options)
      : fileData.length + filePath;
    return String(base) + '|vite-env-xform:' + ruleSig;
  },
};
