import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireAccess } from '@/lib/auth';
import { createClient } from '@/lib/supabase/server';
import { PortalLink } from '@/components/portal-link';
import { EnvironmentExcursionActions } from '@/components/environment/excursion-actions';
import { ENV_EXCURSION_COLUMNS, ENV_READING_COLUMNS, EXCURSION_STATUS_LABEL, readingValues, READING_LABEL, type EnvironmentExcursion, type EnvironmentReading } from '@/lib/environment';
import { formatDateTime } from '@/lib/format';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export default async function ExcursionDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params; const access = await requireAccess(); const client = await createClient();
  if (!client || !uuid.test(id)) notFound();
  const { data } = await client.from('ci_environment_excursions').select(ENV_EXCURSION_COLUMNS).eq('id', id).maybeSingle();
  const event = data as EnvironmentExcursion | null;
  const warehouse = event && access.warehouses.find(item => Number(item.id) === event.warehouse_id);
  if (!event || !warehouse) notFound();
  const [locationResult, readingResult, latestResult, namesResult] = await Promise.all([
    client.from('ci_locations').select('id,code,name,portal_equipment_url,portal_equipment_label').eq('id', event.location_id).maybeSingle(),
    client.from('ci_environment_readings').select(ENV_READING_COLUMNS).eq('excursion_id', id).order('observed_at', { ascending: true }).limit(200),
    client.from('ci_environment_effective_readings').select(ENV_READING_COLUMNS).eq('location_id', event.location_id).order('observed_at', { ascending: false }).limit(1),
    client.rpc('ci_environment_actor_names', { p_user_ids: [event.acknowledged_by, event.resolved_by].filter((value): value is string => Boolean(value)) }),
  ]);
  const location = locationResult.data;
  const readings = (readingResult.data ?? []) as EnvironmentReading[];
  const latest = (latestResult.data?.[0] ?? null) as EnvironmentReading | null;
  const names = new Map<string, string>(((namesResult.data ?? []) as { user_id: string; display_name: string }[]).map(item => [item.user_id, item.display_name]));
  const who = (userId: string | null) => (userId && names.get(userId)) || (userId ? 'ผู้ใช้' : null);
  return <main className="grid gap-5 max-w-[850px]"><div><p className="eyebrow mb-2">Environment excursion</p><h1 className="page-title">{location?.code ?? 'ตำแหน่ง'} · เหตุการณ์นอกช่วง</h1><p className="muted">เปิดเมื่อ {formatDateTime(event.opened_at)} · {EXCURSION_STATUS_LABEL[event.status]}</p></div>
    <section className="surface p-5 grid gap-2"><h2 className="font-bold">สรุปเหตุการณ์</h2>
      <p>พารามิเตอร์: {event.parameters.map(item => item === 'temperature' ? 'อุณหภูมิ' : 'ความชื้น').join(' · ')}</p>
      {event.acknowledged_at && <p className="muted text-sm">บันทึกไว้ก่อนหน้า (ขั้นตอนเดิม): รับทราบโดย {who(event.acknowledged_by)} เมื่อ {formatDateTime(event.acknowledged_at)}</p>}
      <p>การดำเนินการแก้ไข: {event.immediate_action ?? 'ยังไม่ระบุ'}</p>
      {event.status === 'resolved' ? <>
        <p>ผลหลังดำเนินการ: {event.resolution_note}</p>
        <p>ส่งต่อเรื่องเครื่องมือไป Portal: {event.equipment_referred ? 'ใช่' : 'ไม่ใช่'}</p>
        <p>บันทึกโดย {who(event.resolved_by)} เมื่อ {formatDateTime(event.resolved_at)}</p>
      </> : <p className="muted">ยังไม่มีการบันทึกการแก้ไข</p>}
      <div className="flex flex-wrap gap-2"><Link className="button secondary" href={`/locations/${event.location_id}`}>ดูตำแหน่ง</Link><PortalLink url={location?.portal_equipment_url ?? null} label={location?.portal_equipment_label ?? null} context="ตรวจสอบเครื่องใน Portal"/></div>
    </section>
    <section className="surface p-5 grid gap-3"><h2 className="font-bold">ค่าที่เกี่ยวข้อง</h2>{readings.length === 0 && <p className="muted">ยังไม่มีค่าที่แสดง</p>}{readings.map(reading => <div key={reading.id} className="border-t border-line pt-2"><strong>{readingValues(reading)}</strong> · {READING_LABEL[reading.overall_status] ?? reading.overall_status}<p className="muted text-sm">{formatDateTime(reading.observed_at)}{reading.note && ` · ${reading.note}`}</p></div>)}</section>
    <EnvironmentExcursionActions id={id} status={event.status} canWork={warehouse.role !== 'viewer'} existingAction={event.immediate_action} latestOut={latest?.overall_status === 'out_of_range'}/>
  </main>;
}
