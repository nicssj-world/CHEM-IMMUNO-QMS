import Link from 'next/link';
import { requireAccess } from '@/lib/auth';
import { createClient } from '@/lib/supabase/server';
import { selectedWarehouse } from '@/lib/warehouse';
import { WarehouseSwitch } from '@/components/warehouse-switch';
import { bangkokDate, environmentRange, readingValues, READING_LABEL, ROUND_LABEL } from '@/lib/environment';
import { environmentPriority, loadEnvironmentOverview, roundSummary } from '@/lib/environment-data';
import { formatDateTime } from '@/lib/format';
import { logUserMessage } from '@/lib/messages';

export default async function EnvironmentPage({ searchParams }: { searchParams: Promise<{ warehouse?: string }> }) {
  const query = await searchParams;
  const access = await requireAccess();
  const warehouse = selectedWarehouse(access, query.warehouse);
  const client = await createClient();
  if (!client) return <main><h1 className="page-title">อุณหภูมิ/ความชื้น</h1><p className="error">ยังไม่ได้ตั้งค่าการเชื่อมต่อฐานข้อมูล</p></main>;
  const today = bangkokDate();
  const data = await loadEnvironmentOverview(client, Number(warehouse.id), today);
  if (data.error) return <main><h1 className="page-title">อุณหภูมิ/ความชื้น</h1><p className="error">อ่านข้อมูลไม่สำเร็จ: {logUserMessage('environmentOverview', data.error)}</p></main>;
  const openByLocation = new Map(data.excursions.map(item => [item.location_id, item]));
  const rows = data.monitored.map(location => ({
    location, config: data.configs.get(location.id)!, reading: data.latest.get(location.id),
    rounds: roundSummary(data.rounds, location.id), excursion: openByLocation.get(location.id),
  })).sort((a, b) => environmentPriority(a.rounds, a.reading, a.excursion) - environmentPriority(b.rounds, b.reading, b.excursion) || a.location.code.localeCompare(b.location.code));
  const due = data.rounds.filter(round => round.state === 'due').length;
  const missed = data.rounds.filter(round => round.state === 'missed').length;
  const checked = rows.filter(row => data.readings.some(reading => reading.location_id === row.location.id && reading.check_date === today && reading.overall_status !== 'incomplete')).length;
  const canWork = warehouse.role !== 'viewer';
  return <main className="grid gap-6 min-w-0"><div className="flex flex-wrap items-start justify-between gap-3"><div><p className="eyebrow mb-2">Environment · {today}</p><h1 className="page-title">อุณหภูมิ/ความชื้น</h1><p className="muted mt-2">ตรวจตามตำแหน่งที่เฝ้าระวังจริง · เวลาไทย (Asia/Bangkok)</p></div>{canWork && <Link href={`/environment/check?warehouse=${warehouse.code}`} className="button">ตรวจด้วย QR</Link>}</div>
    <WarehouseSwitch warehouses={access.warehouses} selected={warehouse} path="/environment"/>
    <section aria-label="สรุปวันนี้" className="grid grid-cols-2 lg:grid-cols-4 gap-3">
      {[['ถึงเวลาตรวจ', due], ['ขาดวันนี้', missed], ['เหตุการณ์นอกช่วง', data.excursions.length], ['ตรวจแล้ว', `${checked}/${rows.length}`]].map(([label, value]) => <div key={label} className="surface p-4"><p className="muted text-sm">{label}</p><strong className="text-2xl tabular-nums">{value}</strong></div>)}
    </section>
    <section className="grid gap-3" aria-label="ตำแหน่งเฝ้าระวัง"><h2 className="font-bold text-lg">ตำแหน่งที่เฝ้าระวัง</h2>
      {rows.length === 0 && <div className="surface p-5"><p className="muted">ยังไม่มีตำแหน่งเฝ้าระวังในคลังนี้ · ตั้งค่าช่วงและเวลาตรวจที่ตำแหน่งจริงก่อนเริ่มใช้งาน</p></div>}
      {rows.map(({ location, config, reading, rounds, excursion }) => <article key={location.id} className="surface p-4 sm:p-5 grid gap-3 min-w-0">
        <div className="flex flex-wrap justify-between gap-2"><div><Link className="font-bold text-lg" href={`/locations/${location.id}?warehouse=${warehouse.code}`}>{location.code}</Link><p className="muted text-sm">{location.name} · {environmentRange(config)}</p></div><span className="badge">{excursion ? 'นอกช่วงที่ยังไม่ปิด' : rounds.some(round => round.state === 'missed') ? 'ขาดการตรวจ' : rounds.some(round => round.state === 'due') ? 'ถึงเวลาตรวจ' : rounds.some(round => round.state === 'unscheduled') ? 'ยังไม่ตั้งเวลา' : config.monitoring_state === 'paused' ? 'หยุดเฝ้าระวัง' : 'ปกติ'}</span></div>
        <p><strong>{readingValues(reading)}</strong>{reading && <> · {READING_LABEL[reading.overall_status] ?? reading.overall_status} · {formatDateTime(reading.observed_at)}</>}</p>
        <div className="flex flex-wrap gap-2 text-sm">{rounds.map((round, i) => <span key={`${round.round_no ?? 'special'}:${i}`} className="badge">{round.due_time?.slice(0, 5) ?? '—'} · {ROUND_LABEL[round.state]}</span>)}</div>
        <div className="flex flex-wrap gap-2">{canWork && config.monitoring_state === 'active' && <Link className="button" href={`/environment/check/${location.id}?warehouse=${warehouse.code}`}>บันทึกค่า</Link>}<Link className="button secondary" href={`/environment/history?warehouse=${warehouse.code}&location=${location.id}`}>ประวัติ</Link>{excursion && <Link className="button secondary" href={`/environment/excursions/${excursion.id}`}>ดูเหตุการณ์</Link>}</div>
      </article>)}
    </section>
  </main>;
}
