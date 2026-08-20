/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/**/*.{ts,tsx}', './node_modules/@ai-wealth/ui/dist/**/*.js'],
  // Disable Tailwind's preflight so it does not fight Ant Design's reset.
  corePlugins: { preflight: false },
  theme: { extend: {} },
  plugins: [],
};
