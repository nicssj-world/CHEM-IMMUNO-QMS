export type AppRole = 'admin' | 'supervisor' | 'staff' | 'viewer';
export type AppWarehouse = { id: string; code: 'CHE' | 'IMM'; name: string; role: AppRole };
export type AppAccess = {
  userId: string;
  ephisId: string;
  displayName: string;
  warehouses: AppWarehouse[];
};

const roles = new Set<AppRole>(['admin', 'supervisor', 'staff', 'viewer']);

export function normalizeEphisId(value: string): string | null {
  const normalized = value.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9._-]{0,63}$/.test(normalized) ? normalized : null;
}

export function internalAuthEmail(value: string): string | null {
  const ephisId = normalizeEphisId(value);
  return ephisId ? `ephis.${ephisId}@chem-immuno.internal` : null;
}

type UserProfile = { ephis_id?: unknown; display_name?: unknown; active?: unknown } | null;
type AccessRow = {
  warehouse_id?: unknown;
  role?: unknown;
  active?: unknown;
  ci_warehouses?: unknown;
};

function isRole(value: unknown): value is AppRole {
  return typeof value === 'string' && roles.has(value as AppRole);
}

export function resolveAppAccess(
  userId: string,
  authEmail: string | null | undefined,
  profile: UserProfile,
  rows: AccessRow[] | null | undefined,
  expectedEphisId?: string,
): AppAccess | null {
  if (!profile || profile.active !== true) return null;
  const ephisId = typeof profile.ephis_id === 'string' ? normalizeEphisId(profile.ephis_id) : null;
  const displayName = typeof profile.display_name === 'string' ? profile.display_name.trim() : '';
  if (!ephisId || !displayName || !authEmail || authEmail.toLowerCase() !== internalAuthEmail(ephisId)) return null;
  if (expectedEphisId !== undefined && normalizeEphisId(expectedEphisId) !== ephisId) return null;

  const warehouses = (rows ?? []).flatMap((row): AppWarehouse[] => {
    if (row.active !== true || !isRole(row.role)) return [];
    const related = Array.isArray(row.ci_warehouses) ? row.ci_warehouses[0] : row.ci_warehouses;
    if (!related || typeof related !== 'object') return [];
    const warehouse = related as Record<string, unknown>;
    if (warehouse.code !== 'CHE' && warehouse.code !== 'IMM') return [];
    if (String(row.warehouse_id) !== String(warehouse.id)) return [];
    return [{ id: String(warehouse.id), code: warehouse.code, name: String(warehouse.name), role: row.role }];
  });
  if (warehouses.length === 0) return null;
  return { userId, ephisId, displayName, warehouses };
}

export function canMutateRole(role: AppRole) { return role !== 'viewer'; }
export function canSuperviseRole(role: AppRole) { return role === 'admin' || role === 'supervisor'; }
