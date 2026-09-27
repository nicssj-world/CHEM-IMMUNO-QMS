import Link from 'next/link';
import { requireAccess } from '@/lib/auth';
import { createClient } from '@/lib/supabase/server';
import { selectedWarehouse } from '@/lib/warehouse';
import { WarehouseSwitch } from '@/components/warehouse-switch';
import { ENV_EXCURSION_COLUMNS, type EnvironmentExcursion } from '@/lib/environment';
import { formatDateTime } from '@/lib/format';
import { logUserMessage } from '@/lib/messages';

const label = { open: 'เปิดอยู่', acknowledged: 'รับทราบแล้ว', resolved: 'ปิดแล้ว' };
export default async function ExcursionsPage({ searchParams }: { searchParams: Promise<{ warehouse?: string }> }) {
  const query = await searchParams;
  const access = await requireAccess(); const warehouse = selectedWarehouse(access, query.warehouse);
  const client = await createClient();
  if (!client) return <main><h1 className="page-title">เหตุการณ์นอกช่วง</h1><p className="error">ยังไม่ได้ตั้งค่าการเชื่อมต่อฐานข้อมูล</p></main>;
  const [eventsResult, locationsResult] = await Promise.all([
    client.from('ci_environment_excursions').select(ENV_EXCURSION_COLUMNS).eq('warehouse_id', warehouse.id).order('opened_at', { ascending: false }).limit(200),
    client.from('ci_locations').select('id,code,name').eq('warehouse_id', warehouse.id),
  ]);
  const error = eventsResult.error ?? locationsResult.error;
  const locations = new Map((locationsResult.data ?? []).map(item => [item.id, item]));
  const events = ((eventsResult.data ?? []) as EnvironmentExcursion[]).sort((a, b) => Number(a.status === 'resolved') - Number(b.status === 'resolved') || b.opened_at.localeCompare(a.opened_at));
  return <main className="grid gap-6"><div><p className="eyebrow mb-2">Environment excursions</p><h1 className="page-title">เหตุการณ์นอกช่วง</h1><p className="muted mt-2">ติดตามการรับทราบและการปิดเหตุการณ์ · ไม่ใช่งาน CAPA</p></div><WarehouseSwitch warehouses={access.warehouses} selected={warehouse} path="/environment/excursions"/>
    {error && <p className="error">อ่านเหตุการณ์ไม่สำเร็จ: {logUserMessage('environmentExcursions', error)}</p>}
    <section className="grid gap-3">{events.length === 0 && !error && <p className="surface p-5 muted">ยังไม่มีเหตุการณ์นอกช่วงในคลังนี้</p>}
      {events.map(event => <Link key={event.id} href={`/environment/excursions/${event.id}`} className="surface p-4 grid gap-2 no-underline text-[var(--ink)]"><div className="flex flex-wrap justify-between gap-2"><strong>{locations.get(event.location_id)?.code ?? '—'} · {locations.get(event.location_id)?.name ?? ''}</strong><span className="badge">{label[event.status]}</span></div><p className="muted text-sm">เปิดเมื่อ {formatDateTime(event.opened_at)} · {event.parameters.map(parameter => parameter === 'temperature' ? 'อุณหภูมิ' : 'ความชื้น').join(' และ ')}</p></Link>)}
    </section>
  </main>;
}
