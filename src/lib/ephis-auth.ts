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

export async function signInWithEphisId(
  value: unknown,
  rawEphisId: string,
  password: string,
): Promise<AppAccess | null> {
  const client = value as AuthAdapterClient;
  const email = internalAuthEmail(rawEphisId);
  if (!email || password.length === 0) return null;

  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error || !data.user) return null;

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
    await client.auth.signOut({ scope: 'local' });
    return null;
  }
  return access;
}
