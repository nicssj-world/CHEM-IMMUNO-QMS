type CspOptions = {
  nonce: string;
  supabaseUrl?: string;
  development?: boolean;
};

export function buildContentSecurityPolicy({ nonce, supabaseUrl, development = false }: CspOptions): string {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(nonce)) throw new Error('Invalid CSP nonce');

  const connectSources = new Set(["'self'"]);
  let secureSupabaseOrigin = false;
  if (supabaseUrl) {
    try {
      const url = new URL(supabaseUrl);
      if (url.protocol === 'https:' || url.protocol === 'http:') {
        connectSources.add(url.origin);
        const websocket = new URL(url.origin);
        websocket.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
        connectSources.add(websocket.origin);
        secureSupabaseOrigin = url.protocol === 'https:';
      }
    } catch {
      // Never copy unparsed configuration into a policy header.
    }
  }

  const directives = [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${development ? " 'unsafe-eval'" : ''}`,
    development ? "style-src 'self' 'unsafe-inline'" : `style-src 'self' 'nonce-${nonce}'`,
    "img-src 'self' blob: data:",
    "font-src 'self' data:",
    `connect-src ${[...connectSources].join(' ')}`,
    "media-src 'self' blob:",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
  ];
  if (!development && secureSupabaseOrigin) directives.push('upgrade-insecure-requests');
  return directives.join('; ');
}
