import Link from 'next/link';
import { requireAccess, canSupervise } from '@/lib/auth';
import { createClient } from '@/lib/supabase/server';
import { selectedWarehouse } from '@/lib/warehouse';
import { WarehouseSwitch } from '@/components/warehouse-switch';
import { EnvironmentCorrectionForm } from '@/components/environment/correction-form';
import { EnvironmentTrendPanel, RangeSwitch, trendPeriodLabel } from '@/components/environment/trend-panel';
import { bangkokDate, ENV_READING_COLUMNS, readingValues, READING_LABEL, type EnvironmentReading } from '@/lib/environment';
import { latestConfigByLocation } from '@/lib/environment-monitor';
import { normalizeMetricView, rangeQuery, resolveChartTarget, resolveTrendRange, type MetricView, type TrendRangeKey } from '@/lib/environment-trend';
import { loadTrendData, loadWarehouseConfigs, trendMetrics } from '@/lib/environment-trend-data';
import { LOCATION_COLUMNS, type LocationRow } from '@/lib/locations';
import { formatDateTime } from '@/lib/format';
import { logUserMessage } from '@/lib/messages';

type Query = { warehouse?: string; location?: string; month?: string; from?: string; to?: string; status?: string; range?: string; metric?: string };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUSES = ['in_range', 'out_of_range', 'incomplete', 'void'];

export default async function EnvironmentHistoryPage({ searchParams }: { searchParams: Promise<Query> }) {
  const query = await searchParams;
  const access = await requireAccess();
  const warehouse = selectedWarehouse(access, query.warehouse);
  const client = await createClient();
  if (!client) return <main><h1 className="page-title">ประวัติการตรวจ</h1><p className="error">ยังไม่ได้ตั้งค่าการเชื่อมต่อฐานข้อมูล</p></main>;
  // One Bangkok period drives both the chart and the evidence list below it; by default the whole current month.
  const range = resolveTrendRange(query);
  const status = query.status && STATUSES.includes(query.status) ? query.status : undefined;

  // Locations and every configuration version of this warehouse only; RLS keeps other warehouses out regardless.
  const [locationResult, configResult] = await Promise.all([
    client.from('ci_locations').select(LOCATION_COLUMNS).eq('warehouse_id', warehouse.id).order('code'),
    loadWarehouseConfigs(client, Number(warehouse.id)),
  ]);
  const locations = (locationResult.data ?? []) as LocationRow[];
  const configs = configResult.rows;
  const byId = new Map(locations.map(item => [item.id, item]));
  const current = latestConfigByLocation(configs);
  // Chart targets are monitored containers with their own current configuration, never inherited shelves.
  const requestedId = query.location ? (uuid.test(query.location) ? query.location : 'invalid') : null;
  const { monitored, target, inheritedFrom, notMonitored, unknownRequested, evidenceLocationId } = resolveChartTarget(requestedId, locations, configs);

  const targetConfigs = target ? configs.filter(config => config.location_id === target.id) : [];
  const available = target ? trendMetrics(targetConfigs, current.get(target.id), range) : [];
  const view = normalizeMetricView(query.metric, available);

  let request = client.from('ci_environment_readings').select(ENV_READING_COLUMNS, { count: 'exact' }).eq('warehouse_id', warehouse.id)
    .gte('check_date', range.from).lte('check_date', range.to).order('recorded_at', { ascending: false }).limit(200);
  if (evidenceLocationId) request = request.eq('location_id', evidenceLocationId);
  if (status) request = request.eq('overall_status', status);
  const [readingResult, trend] = await Promise.all([
    request,
    target ? loadTrendData(client, Number(warehouse.id), target.id, range, targetConfigs) : Promise.resolve(null),
  ]);
  const readings = (readingResult.data ?? []) as EnvironmentReading[];
  const ids = readings.map(reading => reading.id);
  const [successorsResult, namesResult] = await Promise.all([
    ids.length ? client.from('ci_environment_readings').select('corrects_reading_id').in('corrects_reading_id', ids) : Promise.resolve({ data: [], error: null }),
    client.rpc('ci_environment_actor_names', { p_user_ids: [...new Set(readings.map(reading => reading.recorded_by))] }),
  ]);
  const error = readingResult.error ?? locationResult.error ?? configResult.error ?? successorsResult.error ?? namesResult.error;
  const successors = new Set((successorsResult.data ?? []).map(item => item.corrects_reading_id));
  const names = new Map<string, string>(((namesResult.data ?? []) as { user_id: string; display_name: string }[]).map(item => [item.user_id, item.display_name]));

  // Links keep the whole view: warehouse, canonical location, period, metric and the evidence filter.
  // The canonical location: a shelf's link becomes its monitor; no request stays no request (whole-warehouse evidence).
  const linkLocation = evidenceLocationId;
  const href = (changes: { range?: TrendRangeKey; metric?: MetricView; location?: string | null }) => {
    const params = new URLSearchParams({ warehouse: warehouse.code });
    const location = changes.location === undefined ? linkLocation : changes.location;
    if (location) params.set('location', location);
    for (const [name, value] of rangeQuery(changes.range ?? range.key, range)) params.set(name, value);
    const metric = changes.metric ?? view;
    if (metric) params.set('metric', metric);
    if (status) params.set('status', status);
    // "เลือกเดือน" opens the same month with the picker in view.
    return `/environment/history?${params}${changes.range === 'pick' ? '#trend-month' : ''}`;
  };
  const selectable = target && !monitored.some(item => item.id === target.id) ? [...monitored, target] : monitored;
  const periodLabel = trendPeriodLabel(range);
  const evidenceScope = evidenceLocationId ? byId.get(evidenceLocationId)?.code ?? '—' : 'ทุกตำแหน่งในคลัง';

  return <main className="grid gap-6 min-w-0"><div><p className="eyebrow mb-2">Environment history</p><h1 className="page-title">ประวัติอุณหภูมิ/ความชื้น</h1><p className="muted mt-2">กราฟแสดงค่าที่มีผลอยู่ (หลังแก้ไข ไม่รวมข้อมูลที่ยกเลิก) · รายการหลักฐานด้านล่างแสดงทุกแถว รวมค่าเดิม ค่าที่แก้ไข และข้อมูลที่ยกเลิก · เวลาไทย</p></div>
    <WarehouseSwitch warehouses={access.warehouses} selected={warehouse} path="/environment/history"/>
    {range.notice && <p className="notice" role="status">{range.notice}</p>}
    {unknownRequested && <p className="notice" role="status">ไม่พบตำแหน่งที่ระบุในคลังนี้ · แสดงตำแหน่งที่เฝ้าระวังตำแหน่งแรกแทน</p>}
    {error && <p className="error" role="alert">อ่านประวัติไม่สำเร็จ: {logUserMessage('environmentHistory', error)}</p>}

    <section className="surface p-4 sm:p-5 grid gap-4 min-w-0" aria-labelledby="trend-heading">
      <div className="flex flex-wrap items-baseline justify-between gap-2"><h2 id="trend-heading" className="font-bold text-lg">กราฟแนวโน้ม{target ? ` · ${target.code}` : ''}</h2><span className="muted text-sm">{periodLabel}</span></div>
      <RangeSwitch range={range.key} hrefFor={key => href({ range: key })} />
      <form className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3 items-end" method="get">
        <input type="hidden" name="warehouse" value={warehouse.code}/><input type="hidden" name="range" value={range.key === 'custom' ? 'custom' : 'month'}/>
        {view && <input type="hidden" name="metric" value={view}/>}
        {selectable.length > 0 && <label className="field">ตำแหน่งที่เฝ้าระวัง<select className="input" name="location" defaultValue={target?.id ?? ''}>
          {!target && <option value="">เลือกตำแหน่ง</option>}
          {selectable.map(item => <option key={item.id} value={item.id}>{item.code} · {item.name}{item.active ? '' : ' (ปิดใช้งาน)'}</option>)}
        </select></label>}
        {range.key !== 'custom' && <label className="field">เลือกเดือน<input className="input" id="trend-month" name="month" type="month" required defaultValue={range.month ?? range.today.slice(0, 7)} max={range.today.slice(0, 7)}/></label>}
        {range.key === 'custom' && <>
          <label className="field">ตั้งแต่<input className="input" name="from" type="date" required defaultValue={range.from} max={range.today}/></label>
          <label className="field">ถึง<input className="input" name="to" type="date" required defaultValue={range.to} max={range.today}/></label>
        </>}
        <label className="field">ผลในรายการหลักฐาน<select className="input" name="status" defaultValue={status ?? ''}><option value="">ทั้งหมด</option>{Object.entries(READING_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <button className="button">แสดง</button>
      </form>
      {inheritedFrom && target && <p className="notice" role="status">{inheritedFrom.code} อยู่ใน {target.code} · กราฟแสดงข้อมูลของ {target.code} (ตำแหน่งนี้ใช้การเฝ้าระวังของ {target.code} ไม่มีค่าแยกของตัวเอง)</p>}
      {notMonitored && <p className="notice" role="status">{notMonitored.code} ไม่ได้เฝ้าระวังอุณหภูมิ/ความชื้นในปัจจุบัน และไม่ได้อยู่ในตู้/ห้องที่เฝ้าระวัง · เลือกตำแหน่งที่เฝ้าระวังเพื่อดูกราฟ · รายการหลักฐานด้านล่างยังแสดงข้อมูลเดิมของตำแหน่งนี้</p>}
      {!target && !notMonitored && monitored.length === 0 && !locationResult.error && !configResult.error && <p className="trend-empty rounded-xl border border-line bg-surface-2 p-4 text-sm muted" role="note">ยังไม่มีตำแหน่งที่ตั้งค่าการเฝ้าระวัง</p>}
      {target && trend && <EnvironmentTrendPanel location={target} range={range} view={view} available={available} data={trend} metricHref={metric => href({ metric })} />}
    </section>

    <section className="grid gap-3 min-w-0" aria-labelledby="evidence-heading"><div className="flex flex-wrap items-baseline justify-between gap-2"><h2 id="evidence-heading" className="font-bold">รายการหลักฐาน · {evidenceScope} · {periodLabel} ({readingResult.count ?? 0})</h2>{evidenceLocationId && <Link className="text-sm" href={href({ location: null })}>ดูหลักฐานทุกตำแหน่ง</Link>}</div>
      {readings.length === 0 && !error && <p className="surface p-5 muted">ยังไม่มีข้อมูลในช่วงที่เลือก</p>}
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
