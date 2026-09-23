const PRODUCTION_PROJECT_REF = 'lvddgcogfcvcsaajdqvl';

export type BootstrapTarget = { environment: 'local' | 'preview'; projectRef: string | null };

export function resolveBootstrapTarget(
  urlValue: string,
  expectedProjectRef: string | undefined,
  allowLocal: boolean,
): BootstrapTarget {
  let target: URL;
  try {
    target = new URL(urlValue);
  } catch {
    throw new Error('Provide a valid Supabase URL.');
  }

  const localHosts = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
  if (localHosts.has(target.hostname)) {
    if (!allowLocal) throw new Error('Local Auth bootstrap requires the explicit --allow-local flag.');
    if (target.protocol !== 'http:' || target.port !== '54321' || target.username || target.password ||
        target.pathname !== '/' || target.search || target.hash) {
      throw new Error('Local bootstrap requires the clean local Supabase API URL on port 54321.');
    }
    return { environment: 'local', projectRef: null };
  }

  const projectMatch = target.hostname.match(/^([a-z0-9]+)\.supabase\.co$/);
  if (!projectMatch) throw new Error('The Supabase URL must target a local API or an exact hosted Supabase project URL.');
  if (target.protocol !== 'https:' || target.username || target.password || target.pathname !== '/' || target.search || target.hash) {
    throw new Error('Hosted Supabase bootstrap requires a clean HTTPS project URL.');
  }

  const projectRef = projectMatch[1];
  if (projectRef === PRODUCTION_PROJECT_REF) {
    throw new Error('Refusing to bootstrap the protected Production Supabase project.');
  }
  if (!expectedProjectRef || expectedProjectRef === PRODUCTION_PROJECT_REF || expectedProjectRef !== projectRef) {
    throw new Error('Hosted bootstrap requires CI_EXPECTED_SUPABASE_PROJECT_REF to match the separate Preview project URL.');
  }

  return { environment: 'preview', projectRef };
}
