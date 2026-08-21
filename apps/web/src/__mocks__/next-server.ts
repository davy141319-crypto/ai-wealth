// Mock for next/server in tests (middleware test uses NextResponse)
export class NextResponse {
  constructor(body?: unknown, init?: unknown) {
    // minimal stub
  }
  static next() {
    return { type: 'next' };
  }
  static redirect(url: unknown) {
    return { type: 'redirect', url: String(url) };
  }
}

export class NextRequest {
  cookies = { get: () => undefined };
  nextUrl = {
    pathname: '/',
    search: '',
    clone() {
      return this;
    },
  };
}
