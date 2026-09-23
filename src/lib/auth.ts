import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';

export type Role = 'admin' | 'supervisor' | 'staff' | 'viewer';
export type Warehouse = { id: string; code: 'CHE' | 'IMM'; name: string; role: Role };
export type AccessContext = {
  userId: string;
  ephisId: string;
  warehouses: Warehouse[];
};

export async function getAccessContext(): Promise<AccessContext | null> {
  const client = await createClient();
  if (!client) return null;
  const { data: userResult, error: authError } = await client.auth.getUser();
  if (authError || !userResult.user) return null;
  const { data: profile, error: profileError } = await client
    .from('ci_user_profiles').select('ephis_id,active').eq('user_id', userResult.user.id).eq('active', true).single();
  if (profileError || !profile) return null;
  const { data: access, error } = await client
    .from('ci_user_access')
    .select('warehouse_id,role,active,ci_warehouses(id,code,name)')
    .eq('user_id', userResult.user.id)
    .eq('active', true);
  if (error || !access?.length) return null;
  const warehouses = access.flatMap((row) => {
    const raw = row.ci_warehouses as unknown;
    const warehouse = Array.isArray(raw) ? raw[0] : raw;
    if (!warehouse || typeof warehouse !== 'object') return [];
    const value = warehouse as Record<string, unknown>;
    if (value.code !== 'CHE' && value.code !== 'IMM') return [];
    return [{ id: String(value.id), code: value.code as Warehouse['code'], name: String(value.name), role: row.role as Role }];
  });
  if (!warehouses.length) return null;
  return { userId: userResult.user.id, ephisId: String(profile.ephis_id), warehouses };
}

export async function requireAccess() {
  const access = await getAccessContext();
  if (!access) redirect('/login');
  return access;
}

export function canMutate(role: Role) { return role !== 'viewer'; }
export function canSupervise(role: Role) { return role === 'admin' || role === 'supervisor'; }
