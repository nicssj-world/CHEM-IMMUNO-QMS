import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { canMutateRole, canSuperviseRole, resolveAppAccess, type AppRole, type AppWarehouse } from '@/lib/auth-identity';

export type Role = AppRole;
export type Warehouse = AppWarehouse;
export type AccessContext = import('@/lib/auth-identity').AppAccess;

export async function getAccessContext(): Promise<AccessContext | null> {
  const client = await createClient();
  if (!client) return null;
  const { data: userResult, error: authError } = await client.auth.getUser();
  if (authError || !userResult.user) return null;
  const { data: profile, error: profileError } = await client
    .from('ci_user_profiles').select('ephis_id,display_name,active').eq('user_id', userResult.user.id).maybeSingle();
  if (profileError || !profile) return null;
  const { data: access, error } = await client
    .from('ci_user_access')
    .select('warehouse_id,role,active,ci_warehouses(id,code,name)')
    .eq('user_id', userResult.user.id)
    .eq('active', true);
  if (error || !access?.length) return null;
  return resolveAppAccess(userResult.user.id, userResult.user.email, profile, access);
}

export async function requireAccess() {
  const access = await getAccessContext();
  if (!access) redirect('/login');
  return access;
}

export const canMutate = canMutateRole;
export const canSupervise = canSuperviseRole;
