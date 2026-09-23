export const PRODUCTION_SUPABASE_PROJECT_REF = 'nivlnbaveanoawfbrmzz';
export const PRODUCTION_SUPABASE_URL = 'https://' + PRODUCTION_SUPABASE_PROJECT_REF + '.supabase.co';

export type BootstrapTarget = { environment: 'local' | 'production'; projectRef: string | null };

export function resolveBootstrapTarget(
  urlValue: string,
  expectedProjectRef: string | undefined,
  allowLocal: boolean,
  productionRollout = false,
): BootstrapTarget {
  let target: URL;
  try {
    target = new URL(urlValue);
  } catch {
    throw new Error('Provide a valid Supabase URL.');
  }

  const localHosts = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
  if (localHosts.has(target.hostname)) {
    if (productionRollout) throw new Error('Production rollout flag requires the exact Production URL.');
    if (!allowLocal) throw new Error('Local Auth bootstrap requires the explicit --allow-local flag.');
    if (target.protocol !== 'http:' || target.port !== '54321' || target.username || target.password ||
        target.pathname !== '/' || target.search || target.hash) {
      throw new Error('Local bootstrap requires the clean local Supabase API URL on port 54321.');
    }
    return { environment: 'local', projectRef: null };
  }

  const projectMatch = target.hostname.match(/^([a-z0-9]+)\.supabase\.co$/);
  if (!projectMatch) throw new Error('The Supabase URL must target a local API or an exact hosted Supabase project URL.');
  if (target.protocol !== 'https:' || target.port || target.username || target.password ||
      target.pathname !== '/' || target.search || target.hash) {
    throw new Error('Hosted Supabase bootstrap requires a clean HTTPS project URL.');
  }

  const projectRef = projectMatch[1];
  if (projectRef !== PRODUCTION_SUPABASE_PROJECT_REF) {
    throw new Error('Unexpected hosted Supabase project; hosted bootstrap is restricted to CHEM-IMMUNO Production.');
  }
  if (expectedProjectRef !== PRODUCTION_SUPABASE_PROJECT_REF) {
    throw new Error('Production bootstrap requires CI_EXPECTED_SUPABASE_PROJECT_REF to match the configured Production project.');
  }
  if (!productionRollout) throw new Error('Production bootstrap requires the explicit --production-rollout flag.');

  return { environment: 'production', projectRef };
}
