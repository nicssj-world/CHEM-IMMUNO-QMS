import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';
import { randomBytes } from 'node:crypto';
import { AUTH_COOKIE_OPTIONS } from '@/lib/supabase/cookies';
import { buildContentSecurityPolicy } from '@/lib/csp';

export async function proxy(request: NextRequest) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  const nonce = randomBytes(16).toString('base64');
  const contentSecurityPolicy = buildContentSecurityPolicy({
    nonce,
    supabaseUrl: url,
    development: process.env.NODE_ENV === 'development',
  });
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  // Lets requireAccess send an expired session back to this page after login.
  requestHeaders.set('x-return-to', `${request.nextUrl.pathname}${request.nextUrl.search}`);
  requestHeaders.set('Content-Security-Policy', contentSecurityPolicy);

  const continueRequest = () => {
    requestHeaders.set('cookie', request.cookies.toString());
    const next = NextResponse.next({ request: { headers: requestHeaders } });
    next.headers.set('Content-Security-Policy', contentSecurityPolicy);
    return next;
  };

  let response = continueRequest();
  if (!url || !key) return response;
  const client = createServerClient(url, key, {
    cookieOptions: AUTH_COOKIE_OPTIONS,
    cookies: {
      getAll() { return request.cookies.getAll(); },
      setAll(items) {
        items.forEach(({ name, value }) => request.cookies.set(name, value));
        response = continueRequest();
        items.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
      },
    },
  });
  // Refresh expired Auth tokens before Server Components read them. Authorization
  // still happens in the page and PostgreSQL RLS/RPC, never in this proxy alone.
  await client.auth.getUser();
  return response;
}

export const config = { matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)'] };
