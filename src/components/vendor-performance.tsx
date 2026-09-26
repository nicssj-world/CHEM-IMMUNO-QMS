import Link from 'next/link';
import { formatDateBE } from '@/lib/format';
import { criterionLabel, type Snapshot } from '@/lib/vendor-evaluation';

const number = new Intl.NumberFormat('th-TH', { maximumFractionDigits: 1 });
const pct = (v: number | null | undefined) => (v === null || v === undefined ? 'N/A' : `${number.format(Number(v))}%`);

export type TrendPoint = { fiscalYear: number; receipts: number; issues: number; officialScore: number | null };

/** Live performance for one vendor, warehouse and fiscal year (LABCBH-Stock VendorPerformance): KPI tiles, criteria table, coverage donut, trend. */
export function VendorPerformance({ snapshot, trend, hrefForYear, officialScore }: { snapshot: Snapshot; trend: TrendPoint[]; hrefForYear: (fy: number) => string; officialScore: { score: number; result: 'pass' | 'fail' } | null }) {
  const cov = snapshot.coverage;
  const total = cov.completed + cov.pending;
  return <div className="grid gap-5">
    <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-3">
      <Tile label="Invoice" value={snapshot.activity.invoices} />
      <Tile label="การรับของ" value={snapshot.activity.receipts} />
      <Tile label="ตรวจรับแล้ว" value={snapshot.activity.completedAssessments} hint={total ? `ความครอบคลุม ${pct(cov.percentage)}` : undefined} />
      <Tile label="ปัญหาที่เปิดอยู่" value={snapshot.activity.openIssues} tone={snapshot.activity.openIssues > 0 ? 'warn' : undefined} />
      <Tile label="ปัญหาที่แก้ไขแล้ว" value={snapshot.activity.resolvedIssues} />
      <Tile label="คะแนนประจำปี" value={officialScore ? `${number.format(officialScore.score)}` : '—'} hint={officialScore ? (officialScore.result === 'pass' ? 'ผ่าน' : 'ไม่ผ่าน') : 'ยังไม่มีรายงานอย่างเป็นทางการ'} tone={officialScore?.result === 'fail' ? 'alert' : undefined} />
    </div>

    <div className="grid lg:grid-cols-[1fr_260px] gap-5">
      <section className="surface overflow-hidden" aria-labelledby="perf-criteria">
        <div className="px-5 py-4"><h3 id="perf-criteria" className="font-bold">ผลตามเกณฑ์ 8 ข้อ (ข้อมูลสด)</h3><p className="muted text-xs mt-1">ช่วงข้อมูล {formatDateBE(cov.startDate)} – {formatDateBE(cov.endDate)} · ตัวเลขนี้ยังไม่ใช่คะแนนอย่างเป็นทางการ</p></div>
        <div className="desktop-table table-wrap"><table className="data-table"><thead><tr><th>เกณฑ์</th><th>หลักฐาน</th><th>ผล</th><th><span className="sr-only">แถบสัดส่วน</span></th></tr></thead>
          <tbody>{snapshot.criteria.map(c => <tr key={c.criterionCode}><th scope="row" className="text-left">{criterionLabel(c.criterionCode)}{c.criterionCode === 'complaint_performance' && !!c.supplementaryCount && <small className="block muted font-normal">ข้อร้องเรียนที่บันทึกด้วยมือ {c.supplementaryCount} รายการ</small>}</th><td>{c.applicable ? `${c.numerator}/${c.denominator}` : 'N/A'}</td><td><strong>{pct(c.percentage)}</strong></td><td className="w-40">{c.applicable && <progress className="w-full" max={100} value={Number(c.percentage)} aria-hidden />}</td></tr>)}</tbody></table></div>
        <div className="mobile-card-list px-4 pb-4">{snapshot.criteria.map(c => <div key={c.criterionCode} className="rounded-xl border border-line p-3"><div className="flex justify-between gap-2"><strong>{criterionLabel(c.criterionCode)}</strong><span className="font-bold">{pct(c.percentage)}</span></div><p className="muted text-xs mt-1">{c.applicable ? `หลักฐาน ${c.numerator}/${c.denominator}` : 'ไม่มีข้อมูล (N/A)'}</p>{c.applicable && <progress className="w-full mt-2" max={100} value={Number(c.percentage)} aria-hidden />}</div>)}</div>
      </section>
      <section className="surface p-5 grid gap-3 content-start justify-items-center text-center" aria-labelledby="perf-coverage"><h3 id="perf-coverage" className="font-bold">ความครอบคลุมผลตรวจรับ</h3>
        <Donut value={cov.percentage} />
        <p className="muted text-sm">{total ? `ตรวจรับแล้ว ${cov.completed} จาก ${total} ครั้งที่ต้องประเมิน` : 'ยังไม่มีการรับของที่ต้องประเมินในปีนี้'}</p></section>
    </div>

    <section className="surface p-5 grid gap-3" aria-labelledby="perf-trend"><h3 id="perf-trend" className="font-bold">แนวโน้ม 5 ปีงบประมาณ</h3>
      <TrendChart points={trend} />
      <div className="table-wrap"><table className="data-table"><thead><tr><th>ปีงบประมาณ (พ.ศ.)</th><th>การรับของ</th><th>ปัญหา</th><th>คะแนนอย่างเป็นทางการ</th></tr></thead>
        <tbody>{trend.map(t => <tr key={t.fiscalYear}><td><Link href={hrefForYear(t.fiscalYear)} className={t.fiscalYear === snapshot.fiscalYear ? 'font-bold' : ''} aria-current={t.fiscalYear === snapshot.fiscalYear ? 'true' : undefined}>{t.fiscalYear}</Link></td><td>{t.receipts}</td><td>{t.issues}</td><td>{t.officialScore === null ? '—' : number.format(t.officialScore)}</td></tr>)}</tbody></table></div>
    </section>
  </div>;
}

function Tile({ label, value, hint, tone }: { label: string; value: number | string; hint?: string; tone?: 'warn' | 'alert' }) {
  return <div className="kpi surface p-4" data-tone={tone ?? 'neutral'}><p className="muted text-sm">{label}</p><strong className="text-2xl mt-1 block tabular-nums">{value}</strong>{hint && <p className="muted text-xs mt-1">{hint}</p>}</div>;
}

function Donut({ value }: { value: number | null }) {
  const radius = 44; const circumference = 2 * Math.PI * radius; const filled = value === null ? 0 : Math.max(0, Math.min(100, Number(value)));
  return <svg viewBox="0 0 120 120" className="w-32 h-32" role="img" aria-label={value === null ? 'ไม่มีข้อมูลความครอบคลุม' : `ความครอบคลุม ${value}%`}>
    <circle cx="60" cy="60" r={radius} fill="none" stroke="#e5eff1" strokeWidth="14" />
    <circle cx="60" cy="60" r={radius} fill="none" stroke="#087d78" strokeWidth="14" strokeLinecap="round" strokeDasharray={`${(filled / 100) * circumference} ${circumference}`} transform="rotate(-90 60 60)" />
    <text x="60" y="66" textAnchor="middle" fontSize="20" fontWeight="700" fill="#153044">{value === null ? 'N/A' : `${number.format(filled)}%`}</text>
  </svg>;
}

// Receipt and issue bars per fiscal year, with the official score as a line on a 0–100 axis, drawn as inline SVG like LABCBH.
function TrendChart({ points }: { points: TrendPoint[] }) {
  const width = 640; const height = 200; const pad = { l: 36, r: 36, t: 12, b: 28 };
  const max = Math.max(1, ...points.flatMap(p => [p.receipts, p.issues]));
  const slot = (width - pad.l - pad.r) / points.length;
  const y = (v: number) => height - pad.b - (v / max) * (height - pad.t - pad.b);
  const yScore = (v: number) => height - pad.b - (v / 100) * (height - pad.t - pad.b);
  const line = points.filter(p => p.officialScore !== null).map(p => `${pad.l + slot * points.indexOf(p) + slot / 2},${yScore(p.officialScore!)}`).join(' ');
  return <svg viewBox={`0 0 ${width} ${height}`} className="w-full max-w-[720px]" role="img" aria-label="กราฟแนวโน้มการรับของ ปัญหา และคะแนนรายปี">
    <line x1={pad.l} x2={width - pad.r} y1={height - pad.b} y2={height - pad.b} stroke="#bfd0d8" />
    {points.map((p, i) => { const x = pad.l + slot * i; const bar = slot * 0.28; return <g key={p.fiscalYear}>
      <rect x={x + slot / 2 - bar - 2} y={y(p.receipts)} width={bar} height={height - pad.b - y(p.receipts)} fill="#155e99" rx="2" />
      <rect x={x + slot / 2 + 2} y={y(p.issues)} width={bar} height={height - pad.b - y(p.issues)} fill="#c0392b" rx="2" />
      <text x={x + slot / 2} y={height - 8} textAnchor="middle" fontSize="11" fill="#526a79">{p.fiscalYear}</text></g>; })}
    {line && <polyline points={line} fill="none" stroke="#2f855a" strokeWidth="2.5" />}
    {points.filter(p => p.officialScore !== null).map(p => <circle key={p.fiscalYear} cx={pad.l + slot * points.indexOf(p) + slot / 2} cy={yScore(p.officialScore!)} r="4" fill="#2f855a"><title>{`ปี ${p.fiscalYear}: ${p.officialScore}`}</title></circle>)}
    <text x={pad.l - 6} y={y(max) + 4} textAnchor="end" fontSize="10" fill="#526a79">{max}</text><text x={width - pad.r + 6} y={yScore(100) + 4} fontSize="10" fill="#2f855a">100</text>
    <g fontSize="11" fill="#526a79"><rect x={pad.l} y="0" width="10" height="10" fill="#155e99" /><text x={pad.l + 14} y="9">การรับของ</text><rect x={pad.l + 90} y="0" width="10" height="10" fill="#c0392b" /><text x={pad.l + 104} y="9">ปัญหา</text><rect x={pad.l + 160} y="0" width="10" height="10" fill="#2f855a" /><text x={pad.l + 174} y="9">คะแนนทางการ</text></g>
  </svg>;
}
