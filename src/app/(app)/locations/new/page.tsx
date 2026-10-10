import Link from 'next/link';
import { requireAccess, canSupervise } from '@/lib/auth';
import { createClient } from '@/lib/supabase/server';
import { EMPTY_LOCATION_FORM, LocationForm } from '@/components/location-form';
import { LOCATION_COLUMNS, parentOptions, type LocationRow } from '@/lib/locations';

export default async function NewLocationPage({ searchParams }: { searchParams: Promise<{ warehouse?: string }> }) {
  const params = await searchParams;
  const access = await requireAccess();
  void params;
  const manager = access.warehouses.find(w => canSupervise(w.role));
  const client = await createClient();
  const { data } = client ? await client.from('ci_locations').select(LOCATION_COLUMNS).order('code') : { data: [] };
  const parents = parentOptions((data ?? []) as LocationRow[], {}).map(parent => ({ id: parent.id, label: `${parent.code} · ${parent.name}` }));
  return <main className="grid gap-6 max-w-[900px]"><div><p className="eyebrow mb-2">Storage locations</p><h1 className="page-title">เพิ่มตำแหน่งจัดเก็บ</h1><p className="muted mt-2 text-sm">ตั้งประเภท ตำแหน่งแม่ และลิงก์เครื่องมือใน Portal · ใช้ร่วมกันทั้ง CHE และ IMM</p></div>
    {manager
      ? <LocationForm mode="create" warehouse={{ id: Number(manager.id), code: manager.code, name: manager.name }} initial={EMPTY_LOCATION_FORM} parents={parents} cancelHref="/locations" />
      : <p className="notice">เพิ่มตำแหน่งได้เฉพาะหัวหน้างานหรือผู้ดูแลระบบ · <Link href="/locations">กลับไปรายการตำแหน่ง</Link></p>}
  </main>;
}
