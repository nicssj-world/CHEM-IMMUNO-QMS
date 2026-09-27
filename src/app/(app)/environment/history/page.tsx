import Link from 'next/link';
import { requireAccess, canSupervise } from '@/lib/auth';
import { createClient } from '@/lib/supabase/server';
import { selectedWarehouse } from '@/lib/warehouse';
import { WarehouseSwitch } from '@/components/warehouse-switch';
import { EnvironmentCorrectionForm } from '@/components/environment/correction-form';
import { bangkokDate, ENV_READING_COLUMNS, readingValues, READING_LABEL, type EnvironmentReading } from '@/lib/environment';
import { formatDateTime } from '@/lib/format';
import { logUserMessage } from '@/lib/messages';

type Query = { warehouse?: string; location?: string; from?: string; to?: string; status?: string };
export default async function EnvironmentHistoryPage({ searchParams }: { searchParams: Promise<Query> }) {
  const query = await searchParams;
  const access = await requireAccess();
  const warehouse = selectedWarehouse(access, query.warehouse);
  const client = await createClient();
  if (!client) return <main><h1 className="page-title">ประวัติการตรวจ</h1><p className="error">ยังไม่ได้ตั้งค่าการเชื่อมต่อฐานข้อมูล</p></main>;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  let request = client.from('ci_environment_readings').select(ENV_READING_COLUMNS, { count: 'exact' }).eq('warehouse_id', warehouse.id).order('recorded_at', { ascending: false }).limit(200);
  if (query.location && uuid.test(query.location)) request = request.eq('location_id', query.location);
  if (query.from && /^\d{4}-\d{2}-\d{2}$/.test(query.from)) request = request.gte('check_date', query.from);
  if (query.to && /^\d{4}-\d{2}-\d{2}$/.test(query.to)) request = request.lte('check_date', query.to);
  if (query.status && ['in_range','out_of_range','incomplete','void'].includes(query.status)) request = request.eq('overall_status', query.status);
  const [readingResult, locationResult] = await Promise.all([
    request,
    client.from('ci_locations').select('id,code,name').eq('warehouse_id', warehouse.id).order('code'),
  ]);
  const readings = (readingResult.data ?? []) as EnvironmentReading[];
  const ids = readings.map(reading => reading.id);
  const [successorsResult, namesResult] = await Promise.all([
    ids.length ? client.from('ci_environment_readings').select('corrects_reading_id').in('corrects_reading_id', ids) : Promise.resolve({ data: [], error: null }),
    client.rpc('ci_environment_actor_names', { p_user_ids: [...new Set(readings.map(reading => reading.recorded_by))] }),
  ]);
  const error = readingResult.error ?? locationResult.error ?? successorsResult.error ?? namesResult.error;
  const successors = new Set((successorsResult.data ?? []).map(item => item.corrects_reading_id));
  const names = new Map<string, string>(((namesResult.data ?? []) as { user_id: string; display_name: string }[]).map(item => [item.user_id, item.display_name]));
  const byId = new Map((locationResult.data ?? []).map(item => [item.id, item]));
  return <main className="grid gap-6"><div><p className="eyebrow mb-2">Environment history</p><h1 className="page-title">ประวัติอุณหภูมิ/ความชื้น</h1><p className="muted mt-2">แสดงทุกแถวหลักฐาน รวมค่าที่แก้ไขและข้อมูลที่ยกเลิก</p></div>
    <WarehouseSwitch warehouses={access.warehouses} selected={warehouse} path="/environment/history"/>
    <form className="surface p-4 grid sm:grid-cols-2 lg:grid-cols-5 gap-3" method="get"><input type="hidden" name="warehouse" value={warehouse.code}/><label className="field">ตำแหน่ง<select className="input" name="location" defaultValue={query.location ?? ''}><option value="">ทั้งหมด</option>{(locationResult.data ?? []).map(item => <option key={item.id} value={item.id}>{item.code} · {item.name}</option>)}</select></label><label className="field">ตั้งแต่<input className="input" name="from" type="date" defaultValue={query.from ?? ''}/></label><label className="field">ถึง<input className="input" name="to" type="date" defaultValue={query.to ?? ''}/></label><label className="field">ผล<select className="input" name="status" defaultValue={query.status ?? ''}><option value="">ทั้งหมด</option>{Object.entries(READING_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><button className="button self-end">ค้นหา</button></form>
    {error && <p className="error">อ่านประวัติไม่สำเร็จ: {logUserMessage('environmentHistory', error)}</p>}
    <section className="grid gap-3"><h2 className="font-bold">รายการ ({readingResult.count ?? 0})</h2>{readings.length === 0 && !error && <p className="surface p-5 muted">ยังไม่มีข้อมูลในช่วงที่เลือก</p>}
      {readings.map(reading => { const location = byId.get(reading.location_id); const mayCorrect = !successors.has(reading.id) && reading.entry_kind !== 'void' && (canSupervise(warehouse.role) || (warehouse.role !== 'viewer' && reading.recorded_by === access.userId && reading.check_date === bangkokDate())); return <article key={reading.id} className="surface p-4 grid gap-2 min-w-0"><div className="flex flex-wrap justify-between gap-2"><div><strong>{location?.code ?? '—'}</strong> · {formatDateTime(reading.observed_at)}<p className="muted text-xs">บันทึกโดย {names.get(reading.recorded_by) ?? 'ผู้ใช้'} · {formatDateTime(reading.recorded_at)}</p></div><span className="badge">{READING_LABEL[reading.overall_status] ?? reading.overall_status}</span></div>
        <p>{readingValues(reading)}{reading.entry_mode === 'late' && <span className="badge ml-2">บันทึกย้อนหลัง</span>}{reading.entry_kind === 'correction' && <span className="badge ml-2">แก้ไขจาก {reading.corrects_reading_id?.slice(0, 8)}</span>}{reading.entry_kind === 'void' && <span className="badge ml-2">ยกเลิกข้อมูล</span>}{successors.has(reading.id) && <span className="badge ml-2">มีการแก้ไขต่อ</span>}</p>
        {reading.reason && <p className="text-sm">เหตุผล: {reading.reason}</p>}{reading.note && <p className="muted text-sm">หมายเหตุ: {reading.note}</p>}
        {reading.excursion_id && <Link className="text-sm" href={`/environment/excursions/${reading.excursion_id}`}>ดูเหตุการณ์นอกช่วง</Link>}
        {mayCorrect && <details><summary className="font-semibold cursor-pointer">แก้ไข / ยกเลิกหลักฐานนี้</summary><EnvironmentCorrectionForm reading={reading}/></details>}
      </article>; })}
      {(readingResult.count ?? 0) > readings.length && <p className="muted text-sm">แสดง 200 รายการล่าสุด · ใช้ตัวกรองเพื่อจำกัดช่วงเวลา</p>}
    </section>
  </main>;
}
