/** @type {import('next').NextConfig} */
// `output: 'standalone'` produces a self-contained .next/standalone dir that
// can run inside a minimal Docker image without node_modules from the workspace.
// Symlink creation inside `next build` requires admin/Developer Mode on Windows,
// so we only enable it when building inside Docker (Linux) where the build
// context is already controlled and CI passes cleanly.
const enableStandalone = process.env.NEXT_OUTPUT_STANDALONE === 'true';

const nextConfig = {
  reactStrictMode: true,
  ...(enableStandalone ? { output: 'standalone' } : {}),
  // Workspace packages ship compiled CJS dist; Next bundles them as-is.
  transpilePackages: ['@ai-wealth/ui', '@ai-wealth/shared', '@ai-wealth/config'],
};

module.exports = nextConfig;
