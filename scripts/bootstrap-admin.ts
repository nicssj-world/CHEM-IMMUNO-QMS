import { createClient } from '@supabase/supabase-js';
import { internalAuthEmail, normalizeEphisId } from '../src/lib/auth-identity';
import { parseBootstrapArguments } from './bootstrap-admin-args';
import { resolveBootstrapTarget } from './bootstrap-admin-target';

async function readPasswordFromStdin(): Promise<string> {
  let value = '';
  for await (const chunk of process.stdin) value += String(chunk);
  return value.replace(/[\r\n]+$/, '');
}

type AuthAdminClient = {
  auth: {
    admin: {
      listUsers: (params: { page: number; perPage: number }) => Promise<{
        data: { users: Array<{ id: string; email?: string | null }> };
        error: { code?: string } | null;
      }>;
    };
  };
};

async function findUserByEmail(admin: AuthAdminClient, email: string) {
  for (let page = 1; page <= 100; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw new Error(`Could not verify Auth identity (${error.code ?? 'auth_lookup_failed'}).`);
    const user = data.users.find(item => item.email?.toLowerCase() === email);
    if (user) return user;
    if (data.users.length < 1000) return null;
  }
  throw new Error('Auth user directory is too large to search safely.');
}

async function main() {
  const { ephisId: rawEphisId, displayName: rawDisplayName, passwordFromStdin, allowLocal } = parseBootstrapArguments(process.argv.slice(2));
  const ephisId = normalizeEphisId(rawEphisId);
  const displayName = rawDisplayName.trim();
  const password = passwordFromStdin ? await readPasswordFromStdin() : process.env.CI_BOOTSTRAP_PASSWORD ?? '';
  const urlValue = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!ephisId || displayName.length < 1 || displayName.length > 120) throw new Error('Provide a valid --ephis and --name.');
  if (password.length < 12 || password.length > 128) throw new Error('Initial password must contain 12 to 128 characters.');
  if (!urlValue || !serviceRoleKey) throw new Error('Set the target Supabase URL and server-only SUPABASE_SERVICE_ROLE_KEY.');

  const target = resolveBootstrapTarget(urlValue, process.env.CI_EXPECTED_SUPABASE_PROJECT_REF, allowLocal);
  const local = target.environment === 'local';
  const projectRef = target.projectRef;
  console.log(`Target environment: ${local ? 'LOCAL disposable Supabase' : 'PREVIEW'}`);
  if (projectRef) console.log(`Target project ref: ${projectRef}`);

  const email = internalAuthEmail(ephisId);
  if (!email) throw new Error('Invalid Ephis ID.');
  const admin = createClient(urlValue, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  });
  let user = await findUserByEmail(admin, email);
  let created = false;
  if (!user) {
    const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    if (error || !data.user) throw new Error(`Could not create the Auth identity (${error?.code ?? 'auth_create_failed'}).`);
    user = data.user;
    created = true;
  }

  const { error } = await admin.rpc('ci_bootstrap_first_admin', {
    p_ephis_id: ephisId,
    p_display_name: displayName,
  });
  if (error) throw new Error(`Database bootstrap failed (${error.code ?? 'provisioning_failed'}).`);

  console.log(`Bootstrap complete for Ephis ID ${ephisId}.`);
  console.log(`Application role: Admin; warehouses: Clinical Chemistry + Immunology.`);
  console.log(`Auth account: ${created ? 'created' : 'existing account safely reconciled'}; password was not changed or displayed.`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Bootstrap failed.');
  process.exitCode = 1;
});
