import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireAccess, canSupervise } from '@/lib/auth';
import { createClient } from '@/lib/supabase/server';
import { LocationForm, type LocationFormFields } from '@/components/location-form';
import { ENV_CONFIG_COLUMNS, LOCATION_COLUMNS, isMonitorableType, parentOptions, type EnvConfigRow, type LocationRow } from '@/lib/locations';
import { hasOwnMonitoring, latestConfigByLocation } from '@/lib/environment-monitor';
import { formatDateTime } from '@/lib/format';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const text = (value: number | string | null | undefined) => (value === null || value === undefined ? '' : String(Number(value)));

export default async function EditLocationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const access = await requireAccess();
  const client = await createClient();
  if (!client || !uuid.test(id)) notFound();
  const { data } = await client.from('ci_locations').select(LOCATION_COLUMNS).eq('id', id).maybeSingle();
  const location = data as LocationRow | null;
  // A location outside the user's warehouses is not readable, so it looks exactly like a missing one.
  const warehouse = location && access.warehouses.find(item => Number(item.id) === location.warehouse_id);
  if (!location || !warehouse) notFound();
  if (!canSupervise(warehouse.role)) {
    return <main className="grid gap-4 max-w-[900px]"><h1 className="page-title">แก้ไขตำแหน่ง {location.code}</h1><p className="notice">แก้ไขตำแหน่งได้เฉพาะหัวหน้างานหรือผู้ดูแลระบบของคลังนี้ · <Link href={`/locations/${location.id}?warehouse=${warehouse.code}`}>กลับไปดูรายละเอียด</Link></p></main>;
  }
  const [siblingResult, configResult, movement, receipt, count] = await Promise.all([
    client.from('ci_locations').select(LOCATION_COLUMNS).eq('warehouse_id', warehouse.id).order('code'),
    client.from('ci_location_env_configs').select(ENV_CONFIG_COLUMNS).eq('location_id', id),
    client.from('ci_stock_movement_lines').select('id').eq('location_id', id).limit(1),
    client.from('ci_receipt_lines').select('id').eq('location_id', id).limit(1),
    client.from('ci_stock_count_lines').select('id').eq('location_id', id).limit(1),
  ]);
  const locations = (siblingResult.data ?? []) as LocationRow[];
  const config = latestConfigByLocation((configResult.data ?? []) as EnvConfigRow[]).get(id) as EnvConfigRow | undefined;
  const codeLocked = [movement, receipt, count].some(result => (result.data?.length ?? 0) > 0);
  const hasChildren = locations.some(item => item.parent_location_id === id);
  const parents = parentOptions(locations, { warehouseId: Number(warehouse.id), selfId: id }).map(parent => ({ id: parent.id, label: `${parent.code} · ${parent.name}` }));
  // The current parent stays selectable even if it has since been deactivated, so saving other fields does not silently detach it.
  if (location.parent_location_id && !parents.some(parent => parent.id === location.parent_location_id)) {
    const current = locations.find(item => item.id === location.parent_location_id);
    if (current) parents.push({ id: current.id, label: `${current.code} · ${current.name}` });
  }
  const initial: LocationFormFields = {
    code: location.code, name: location.name, location_type: location.location_type, parent_location_id: location.parent_location_id ?? '',
    room: location.room ?? '', description: location.description ?? '', storage_condition: location.storage_condition ?? '',
    portal_equipment_url: location.portal_equipment_url ?? '', portal_equipment_label: location.portal_equipment_label ?? '',
    own_monitoring: !isMonitorableType(location.location_type) && hasOwnMonitoring(config),
    temperature_monitored: config?.temperature_monitored ?? false, temp_min_c: text(config?.temp_min_c), temp_max_c: text(config?.temp_max_c),
    humidity_monitored: config?.humidity_monitored ?? false, rh_min_pct: text(config?.rh_min_pct), rh_max_pct: text(config?.rh_max_pct),
  };
  return <main className="grid gap-6 max-w-[900px]"><div><p className="eyebrow mb-2">Storage locations</p><h1 className="page-title">แก้ไขตำแหน่ง {location.code}</h1><p className="muted mt-2 text-sm">{warehouse.name} · แก้ไขล่าสุด {formatDateTime(location.updated_at)}</p></div>
    <LocationForm mode="edit" warehouse={{ id: Number(warehouse.id), code: warehouse.code, name: warehouse.name }} initial={initial} parents={parents} cancelHref={`/locations/${id}?warehouse=${warehouse.code}`} locationId={id} expectedUpdatedAt={location.updated_at} codeLocked={codeLocked} hasChildren={hasChildren} />
  </main>;
}
