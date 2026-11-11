import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

export function middleware(req: NextRequest) {
  const url = new URL(req.url);
  const path = url.pathname || '';

  if (!path.startsWith('/api/')) return NextResponse.next();

  // Internal-only API gate.
  //
  // Goal: prevent any public internet access to /api/* (data exfiltration,
  // side effects, and request-flood cost). Only Railway internal services
  // (web/worker) should be able to call these.
  //
  // Requirements:
  // - Request must come via Railway private networking hostname, AND
  // - Request must include a shared secret header.
  const expectedKey = process.env.INTERNAL_API_KEY ?? '';
  const providedKey = req.headers.get('x-inga-internal-key') ?? '';
  if (!expectedKey || providedKey !== expectedKey) {
    return new NextResponse('Not found', { status: 404 });
  }

  const hostHeader = (req.headers.get('host') ?? '').toLowerCase();
  const host = hostHeader.split(':')[0] ?? '';
  const privateDomain = (process.env.RAILWAY_PRIVATE_DOMAIN ?? '').toLowerCase();
  const isDevHost =
    process.env.NODE_ENV !== 'production' &&
    (host === 'localhost' || host === '127.0.0.1');
  const hostIsPrivate =
    isDevHost ||
    (privateDomain && host === privateDomain) ||
    host.endsWith('.railway.internal');
  if (!hostIsPrivate) {
    return new NextResponse('Not found', { status: 404 });
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/api/:path*'],
};
