import Link from 'next/link';
import { requireAccess, canSupervise } from '@/lib/auth';
import { selectedWarehouse } from '@/lib/warehouse';
import { createClient } from '@/lib/supabase/server';
import { WarehouseSwitch } from '@/components/warehouse-switch';
import { EMPTY_LOCATION_FORM, LocationForm } from '@/components/location-form';
import { LOCATION_COLUMNS, parentOptions, type LocationRow } from '@/lib/locations';

export default async function NewLocationPage({ searchParams }: { searchParams: Promise<{ warehouse?: string }> }) {
  const params = await searchParams;
  const access = await requireAccess();
  const warehouse = selectedWarehouse(access, params.warehouse);
  const client = await createClient();
  const { data } = client ? await client.from('ci_locations').select(LOCATION_COLUMNS).eq('warehouse_id', warehouse.id).order('code') : { data: [] };
  const parents = parentOptions((data ?? []) as LocationRow[], { warehouseId: Number(warehouse.id) }).map(parent => ({ id: parent.id, label: `${parent.code} · ${parent.name}` }));
  return <main className="grid gap-6 max-w-[900px]"><div><p className="eyebrow mb-2">Storage locations</p><h1 className="page-title">เพิ่มตำแหน่งจัดเก็บ</h1><p className="muted mt-2 text-sm">ตั้งประเภท ตำแหน่งแม่ ช่วงอุณหภูมิ/ความชื้น และลิงก์เครื่องมือใน Portal · {warehouse.name}</p></div>
    <WarehouseSwitch warehouses={access.warehouses} selected={warehouse} path="/locations/new"/>
    {canSupervise(warehouse.role)
      ? <LocationForm key={warehouse.code} mode="create" warehouse={{ id: Number(warehouse.id), code: warehouse.code, name: warehouse.name }} initial={EMPTY_LOCATION_FORM} parents={parents} cancelHref={`/locations?warehouse=${warehouse.code}`} />
      : <p className="notice">เพิ่มตำแหน่งได้เฉพาะหัวหน้างานหรือผู้ดูแลระบบของคลังนี้ · <Link href={`/locations?warehouse=${warehouse.code}`}>กลับไปรายการตำแหน่ง</Link></p>}
  </main>;
}
