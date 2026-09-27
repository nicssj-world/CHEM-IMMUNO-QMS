import Link from 'next/link';
import { requireAccess } from '@/lib/auth';
import { createClient } from '@/lib/supabase/server';
import { selectedWarehouse } from '@/lib/warehouse';
import { PrintButton } from '@/components/print-button';
import { bangkokMonth, environmentRange, readingValues, ROUND_LABEL, type EnvironmentReading, type MonitorConfig } from '@/lib/environment';
import { formatDate, formatDateTime, formatMonth } from '@/lib/format';
import { logUserMessage } from '@/lib/messages';
import { ENV_CONFIG_COLUMNS } from '@/lib/environment';

type ReportRow = { location_id: string; check_date: string; round_no: number | null; due_time: string | null;
  state: string; reading: EnvironmentReading | null; config: MonitorConfig | null; children: string[]; excursions: { id: string; opened_at: string; parameters: string[] }[] };
export default async function EnvironmentReportPage({ searchParams }: { searchParams: Promise<{ warehouse?: string; month?: string; location?: string }> }) {
  const query = await searchParams;
  const access = await requireAccess(); const warehouse = selectedWarehouse(access, query.warehouse);
  const month = query.month ?? bangkokMonth();
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return <main><h1 className="page-title">รายงานสภาพแวดล้อม</h1><p className="error">เดือนรายงานไม่ถูกต้อง</p></main>;
  const client = await createClient();
  if (!client) return <main><h1 className="page-title">รายงานสภาพแวดล้อม</h1><p className="error">ยังไม่ได้ตั้งค่าการเชื่อมต่อฐานข้อมูล</p></main>;
  const locationId = query.location && /^[0-9a-f-]{36}$/i.test(query.location) ? query.location : null;
  const nextMonth = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 1) - 7 * 60 * 60 * 1000);
  const [reportResult, locationResult, configResult] = await Promise.all([
    client.rpc('ci_environment_month_report', { p_warehouse_id: warehouse.id, p_month: `${month}-01`, p_location_id: locationId }).range(0, 999),
    client.from('ci_locations').select('id,code,name').eq('warehouse_id', warehouse.id).order('code'),
    client.from('ci_location_env_configs').select(ENV_CONFIG_COLUMNS).eq('warehouse_id', warehouse.id).lt('effective_from', nextMonth.toISOString()).order('effective_from').order('id').range(0, 999),
  ]);
  const error = reportResult.error ?? locationResult.error ?? configResult.error;
  if (error) return <main><h1 className="page-title">รายงานสภาพแวดล้อม</h1><p className="error">อ่านรายงานไม่สำเร็จ: {logUserMessage('environmentReport', error)}</p></main>;
  const rows = (reportResult.data ?? []) as ReportRow[];
  while (rows.length > 0 && rows.length % 1000 === 0) {
    const next = await client.rpc('ci_environment_month_report', { p_warehouse_id: warehouse.id, p_month: `${month}-01`, p_location_id: locationId }).range(rows.length, rows.length + 999);
    if (next.error) return <main><h1 className="page-title">รายงานสภาพแวดล้อม</h1><p className="error">อ่านรายงานไม่สำเร็จ: {logUserMessage('environmentReport', next.error)}</p></main>;
    rows.push(...((next.data ?? []) as ReportRow[]));
    if ((next.data ?? []).length < 1000) break;
  }
  const locations = new Map((locationResult.data ?? []).map(item => [item.id, item]));
  const actorIds = [...new Set(rows.map(row => row.reading?.recorded_by).filter((id): id is string => Boolean(id)))];
  const namesResult = await client.rpc('ci_environment_actor_names', { p_user_ids: actorIds });
  const names = new Map<string, string>(((namesResult.data ?? []) as { user_id: string; display_name: string }[]).map(item => [item.user_id, item.display_name]));
  const grouped = new Map<string, ReportRow[]>();
  for (const row of rows) grouped.set(row.location_id, [...(grouped.get(row.location_id) ?? []), row]);
  const configs = (configResult.data ?? []) as MonitorConfig[];
  while (configs.length > 0 && configs.length % 1000 === 0) {
    const next = await client.from('ci_location_env_configs').select(ENV_CONFIG_COLUMNS).eq('warehouse_id', warehouse.id).lt('effective_from', nextMonth.toISOString()).order('effective_from').order('id').range(configs.length, configs.length + 999);
    if (next.error) return <main><h1 className="page-title">รายงานสภาพแวดล้อม</h1><p className="error">อ่านรายงานไม่สำเร็จ: {logUserMessage('environmentReport', next.error)}</p></main>;
    configs.push(...((next.data ?? []) as MonitorConfig[]));
    if ((next.data ?? []).length < 1000) break;
  }
  return <main className="grid gap-6 report-page environment-report min-w-0"><div className="print-hide"><Link href="/environment">← ภาพรวมสภาพแวดล้อม</Link></div>
    <header className="flex flex-wrap justify-between items-end gap-3"><div><p className="eyebrow">Environment monthly report</p><h1 className="page-title">รายงานอุณหภูมิ/ความชื้นประจำเดือน</h1><p className="muted">{formatMonth(month)} · {warehouse.name} · เวลา Asia/Bangkok</p><p className="print-only text-xs">พิมพ์โดย {access.displayName} · {formatDateTime(new Date())}</p></div><PrintButton/></header>
    <form method="get" className="surface p-4 flex flex-wrap items-end gap-3 print-hide"><label className="field">คลัง<select className="input" name="warehouse" defaultValue={warehouse.code}>{access.warehouses.map(item => <option key={item.code} value={item.code}>{item.name}</option>)}</select></label><label className="field">เดือน<input className="input" type="month" name="month" defaultValue={month} required/></label><label className="field">ตำแหน่ง<select className="input" name="location" defaultValue={query.location ?? ''}><option value="">ทั้งหมด</option>{(locationResult.data ?? []).map(item => <option key={item.id} value={item.id}>{item.code} · {item.name}</option>)}</select></label><button className="button">แสดงรายงาน</button></form>
    {rows.length === 0 && <p className="surface p-5 muted">ยังไม่มีตำแหน่งเฝ้าระวังในเดือนนี้ · ไม่สร้างข้อมูลตัวอย่างในรายงาน</p>}
    {[...grouped.entries()].map(([id, locationRows]) => {
      const location = locations.get(id);
      const monthStart = Date.parse(`${month}-01T00:00:00+07:00`);
      const versions = configs.filter(config => config.location_id === id && Date.parse(config.effective_from) >= monthStart);
      const firstConfig = locationRows.find(row => row.config)?.config;
      const byDate = new Map<string, ReportRow[]>(); for (const row of locationRows) byDate.set(row.check_date, [...(byDate.get(row.check_date) ?? []), row]);
      const events = [...new Map(locationRows.flatMap(row => row.excursions).map(event => [event.id, event])).values()];
      const missed = locationRows.filter(row => row.state === 'missed').length;
      const satisfied = locationRows.filter(row => row.state === 'satisfied').length;
      return <section key={id} className="surface p-4 sm:p-6 grid gap-4 min-w-0 break-inside-avoid"><div><h2 className="text-xl font-bold">{location?.code ?? '—'} · {location?.name ?? ''}</h2><p className="text-sm">ช่วงที่ยอมรับได้: {environmentRange(firstConfig)}</p><p className="text-sm">เวลาตรวจ: {firstConfig?.check_times.length ? firstConfig.check_times.map(time => time.slice(0,5)).join(', ') : 'ยังไม่ตั้งเวลา'} · สถานะ {firstConfig?.monitoring_state === 'paused' ? 'หยุดเฝ้าระวัง' : 'ใช้งาน'}</p><p className="muted text-sm">ครอบคลุม: {locationRows[0]?.children.length ? locationRows[0].children.join(', ') : 'ไม่มีตำแหน่งย่อย'}</p></div>
        {versions.length > 0 && <div className="text-xs"><strong>การเปลี่ยนค่ากำหนดในเดือน:</strong> {versions.map(version => `${formatDateTime(version.effective_from)} ${environmentRange(version)} / ${version.check_times.map(time => time.slice(0,5)).join(', ') || 'ยังไม่ตั้งเวลา'} / ${version.monitoring_state}`).join(' · ')}</div>}
        <p className="text-sm">ตรวจครบ {satisfied} รอบ · ขาด {missed} รอบ · เหตุการณ์นอกช่วง {events.length}</p>
        <div className="table-wrap max-w-full"><table className="data-table report-table text-xs"><thead><tr><th>วันที่</th>{[1,2,3,4].map(n => <th key={n}>รอบ {n}</th>)}</tr></thead><tbody>{[...byDate.entries()].map(([date, dayRows]) => <tr key={date}><td className="whitespace-nowrap">{formatDate(date)}</td>{[1,2,3,4].map(n => { const row = dayRows.find(item => item.round_no === n) ?? (n === 1 ? dayRows.find(item => item.round_no === null) : undefined); return <td key={n}>{row ? <><strong>{row.due_time?.slice(0,5) ?? '—'}</strong><br/>{row.state === 'missed' ? 'ขาด' : row.state === 'satisfied' && row.reading ? <>{readingValues(row.reading)}<br/>{names.get(row.reading.recorded_by)?.split(' ')[0] ?? 'ผู้บันทึก'}{row.reading.entry_mode === 'late' ? ' · ย้อนหลัง' : ''}{row.reading.entry_kind === 'correction' ? ' · แก้ไข' : ''}</> : ROUND_LABEL[row.state as keyof typeof ROUND_LABEL] ?? row.state}</> : '—'}</td>; })}</tr>)}</tbody></table></div>
        {events.length > 0 && <div className="text-sm"><h3 className="font-bold">เหตุการณ์นอกช่วง</h3>{events.map(event => <p key={event.id}>{formatDateTime(event.opened_at)} · {event.parameters.join(', ')}</p>)}</div>}
        <div className="grid grid-cols-2 gap-6 pt-6 text-sm"><p>ผู้ทบทวน ____________________</p><p>วันที่ ____________________</p></div>
      </section>;
    })}
    {namesResult.error && <p className="error">อ่านชื่อผู้บันทึกไม่สำเร็จ: {logUserMessage('environmentNames', namesResult.error)}</p>}
  </main>;
}
