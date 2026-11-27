import { internalAuthEmail, resolveAppAccess, type AppAccess } from './auth-identity';

type AuthQueryResult = { data: unknown; error: unknown | null };
type AuthQuery = PromiseLike<AuthQueryResult> & {
  eq: (column: string, value: unknown) => AuthQuery;
  maybeSingle: () => Promise<AuthQueryResult>;
};
type AuthAdapterClient = {
  auth: {
    signInWithPassword: (credentials: { email: string; password: string }) => Promise<{
      data: { user: { id: string; email?: string | null } | null };
      error: unknown | null;
    }>;
    signOut: (options?: { scope: 'local' }) => Promise<unknown>;
  };
  from: (table: string) => { select: (columns: string) => AuthQuery };
};

// The login page shows one generic message for every refusal, so the stage and
// the Supabase error are logged server-side. Never the password or any key.
function logSignInFailure(stage: string, error?: unknown) {
  const detail = error && typeof error === 'object' ? error as Record<string, unknown> : {};
  let host = 'unset';
  try { host = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? '').host; } catch { host = 'invalid-url'; }
  console.warn('[auth] sign-in refused', JSON.stringify({
    stage, host, code: detail.code, status: detail.status, name: detail.name,
    message: typeof detail.message === 'string' ? detail.message.slice(0, 200) : undefined,
  }));
}

export async function signInWithEphisId(
  value: unknown,
  rawEphisId: string,
  password: string,
): Promise<AppAccess | null> {
  const client = value as AuthAdapterClient;
  const email = internalAuthEmail(rawEphisId);
  if (!email || password.length === 0) {
    logSignInFailure('input');
    return null;
  }

  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error || !data.user) {
    logSignInFailure('auth', error);
    return null;
  }

  const [profileResult, accessResult] = await Promise.all([
    client.from('ci_user_profiles').select('ephis_id,display_name,active').eq('user_id', data.user.id).maybeSingle(),
    client.from('ci_user_access').select('warehouse_id,role,active,ci_warehouses(id,code,name)')
      .eq('user_id', data.user.id).eq('active', true),
  ]);
  const access = profileResult.error || accessResult.error
    ? null
    : resolveAppAccess(data.user.id, data.user.email, profileResult.data as Record<string, unknown> | null,
      accessResult.data as Array<Record<string, unknown>> | null, rawEphisId);
  if (!access) {
    logSignInFailure(profileResult.error || accessResult.error ? 'access-query' : 'access-denied',
      profileResult.error ?? accessResult.error);
    await client.auth.signOut({ scope: 'local' });
    return null;
  }
  return access;
}
