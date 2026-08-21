export function normalizeBasename(base: string): '/' | '/admin' {
  switch (base) {
    case '/':
      return '/';
    case '/admin/':
      return '/admin';
    default:
      throw new Error(`Unsupported Vite base="${base}". Allowed: '/' (dev) or '/admin/' (prod).`);
  }
}
