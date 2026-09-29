import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { requireAccess, canSupervise } from '@/lib/auth';
import { createClient } from '@/lib/supabase/server';
import { EnvironmentCheckForm } from '@/components/environment/check-form';
import { bangkokDate, environmentRange, readingValues, ROUND_LABEL, type DayRound, type EnvironmentReading, type MonitorConfig } from '@/lib/environment';
import { ENV_CONFIG_COLUMNS, ENV_READING_COLUMNS } from '@/lib/environment';
import { latestConfigByLocation } from '@/lib/environment-monitor';
import { formatDateTime } from '@/lib/format';
import { logUserMessage } from '@/lib/messages';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export default async function EnvironmentCheckPage({ params, searchParams }: { params: Promise<{ locationId: string }>; searchParams: Promise<{ from?: string; source?: string }> }) {
  const { locationId } = await params;
  const query = await searchParams;
  const access = await requireAccess();
  const client = await createClient();
  if (!client || !UUID.test(locationId)) notFound();
  const { data: location } = await client.from('ci_locations').select('id,warehouse_id,code,name,active').eq('id', locationId).maybeSingle();
  const warehouse = location && access.warehouses.find(item => Number(item.id) === location.warehouse_id);
  if (!location || !warehouse) notFound();
  const { data: monitorId } = await client.rpc('ci_environment_monitor_location_id', { p_location_id: locationId });
  if (!monitorId) redirect(`/locations/${locationId}?warehouse=${warehouse.code}`);
  if (monitorId !== locationId) redirect(`/environment/check/${monitorId}?from=${locationId}&warehouse=${warehouse.code}&source=${query.source === 'qr' ? 'qr' : 'manual'}`);
  const [configResult, readingResult, roundsResult, fromResult] = await Promise.all([
    client.from('ci_location_env_configs').select(ENV_CONFIG_COLUMNS).eq('location_id', locationId).order('effective_from', { ascending: false }).limit(20),
    client.from('ci_environment_effective_readings').select(ENV_READING_COLUMNS).eq('location_id', locationId).order('observed_at', { ascending: false }).limit(1),
    client.rpc('ci_environment_day_status', { p_warehouse_id: warehouse.id, p_date: bangkokDate() }),
    query.from && UUID.test(query.from) ? client.from('ci_locations').select('id,code').eq('id', query.from).maybeSingle() : Promise.resolve({ data: null }),
  ]);
  const error = configResult.error ?? readingResult.error ?? roundsResult.error;
  const config = latestConfigByLocation((configResult.data ?? []) as MonitorConfig[]).get(locationId);
  if (!config) redirect(`/locations/${locationId}?warehouse=${warehouse.code}`);
  const latest = (readingResult.data?.[0] ?? null) as EnvironmentReading | null;
  const rounds = ((roundsResult.data ?? []) as DayRound[]).filter(round => round.location_id === locationId);
  const from = fromResult.data;
  const canWork = warehouse.role !== 'viewer' && location.active && config.monitoring_state === 'active';
  return <main className="grid gap-5 max-w-[760px]"><div><p className="eyebrow mb-2">Environment check · {warehouse.name}</p><h1 className="page-title">{location.code} · {location.name}</h1></div>
    {from && from.id !== locationId && <p className="notice">{from.code} อยู่ใน {location.code} — บันทึกให้ {location.code}</p>}
    {error && <p className="error">อ่านข้อมูลสภาพแวดล้อมไม่สำเร็จ: {logUserMessage('environmentCheck', error)}</p>}
    <section className="surface p-5 grid gap-3"><h2 className="font-bold">ข้อมูลตำแหน่งเฝ้าระวัง</h2><p>ช่วงที่ยอมรับได้: <strong>{environmentRange(config)}</strong></p><p>ค่าล่าสุด: <strong>{readingValues(latest)}</strong>{latest && <> · {formatDateTime(latest.observed_at)}</>}</p>
      <div className="flex flex-wrap gap-2">{rounds.map((round, i) => <span className="badge" key={`${round.round_no ?? 'special'}:${i}`}>{round.due_time?.slice(0,5) ?? '—'} · {ROUND_LABEL[round.state]}</span>)}</div>
      {config.check_times.length === 0 && <p className="notice">ยังไม่ได้ตั้งเวลาตรวจ · บันทึกค่าได้ แต่ระบบจะไม่แจ้งว่าขาดรอบ</p>}
      <div className="flex flex-wrap gap-2"><Link href={`/locations/${locationId}?warehouse=${warehouse.code}`} className="button secondary">รายละเอียดตำแหน่ง</Link><Link href={`/environment/history?warehouse=${warehouse.code}&location=${locationId}`} className="button secondary">ดูประวัติ</Link></div>
    </section>
    {canWork && !error ? <EnvironmentCheckForm locationId={locationId} warehouseCode={warehouse.code} config={config} source={query.source === 'qr' ? 'qr' : 'manual'} canLate={canSupervise(warehouse.role)}/> : <p className="notice">{!location.active ? 'ตำแหน่งนี้ปิดการใช้งานอยู่' : config.monitoring_state === 'paused' ? `หยุดเฝ้าระวัง: ${config.pause_reason ?? '—'}` : 'บัญชีนี้ดูข้อมูลได้ แต่บันทึกค่าไม่ได้'}</p>}
  </main>;
}
