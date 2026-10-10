/** Only same-site app paths may be returned to after login; anything else (other hosts, `//x`, the login page itself) falls back to home. */
export function safeReturnPath(value: string | null | undefined): string | null {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return null;
  if (value === '/login' || value.startsWith('/login?') || value.startsWith('/_next')) return null;
  return value.length > 1000 ? null : value;
}
