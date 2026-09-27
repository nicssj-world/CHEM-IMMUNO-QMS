'use client';

import { useEffect, useId, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import {
  bandChanges, describePoint, formatBangkokDateTime, formatLimits, formatMeasure, formatTick, lineRuns, METRIC_TITLE, METRIC_UNIT,
  niceTicks, POINT_STATUS_LABEL, summarizeSeries, timeTicks, valueDomain,
  type BandSegment, type TrendMetric, type TrendPoint,
} from '@/lib/environment-trend';

// Native SVG trend chart. Meaning never depends on colour alone: ● in range, ✕ out of range, ◆ corrected value, a dashed ring
// for a late entry. The acceptable band is drawn per configuration version, and every point is also listed as text.

const COLOR = {
  inRange: '#157a4a', out: '#b42335', corrected: '#a15c07', late: '#155e99', line: '#7b95a3',
  grid: '#e3ecef', axis: '#9fb4bd', text: '#526a79', ink: '#153044', plot: '#fbfdfd',
  band: { temperature: '#e1f3e9', humidity: '#e0eff8' }, limit: '#5d8f79', change: '#8a6d3b', selected: '#153044',
};

export type TrendChartProps = {
  metric: TrendMetric; locationCode: string; points: TrendPoint[]; segments: BandSegment[];
  start: number; end: number; periodLabel: string;
  compact?: boolean;
  /** Readings in the period (all metrics), so two charts of one location get the same width and x scale. */
  density: number;
};

export function EnvironmentTrendChart({ metric, locationCode, points, segments, start, end, periodLabel, compact = false, density }: TrendChartProps) {
  const unit = METRIC_UNIT[metric];
  const title = `${METRIC_TITLE[metric]} (${unit}) · ${locationCode}`;
  const plotted = useMemo(() => points.filter(point => point.value !== null), [points]);
  const summary = useMemo(() => summarizeSeries(points), [points]);
  const [selected, setSelected] = useState(plotted.length - 1);
  const [width, setWidth] = useState(compact ? 560 : 720);
  const scroller = useRef<HTMLDivElement>(null);
  const ids = useId();

  useEffect(() => {
    const element = scroller.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    // Floor, never round up: a chart even half a pixel wider than its box would make the box scroll.
    const observer = new ResizeObserver(entries => setWidth(Math.floor(entries[0].contentRect.width)));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const height = compact ? 176 : 264;
  const pad = { top: 22, right: compact ? 14 : 78, bottom: 30, left: 50 };
  const minPlot = Math.min(2400, density * (compact ? 3 : 5));
  const W = Math.max(width, 260, minPlot + pad.left + pad.right);
  const scrollable = W > width;
  const plotW = W - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;

  // Dense periods scroll inside the card; start at the newest end, which is what people look for first.
  useEffect(() => {
    const element = scroller.current;
    if (element && element.scrollWidth > element.clientWidth) element.scrollLeft = element.scrollWidth;
  }, [W]);

  const domain = valueDomain(plotted, segments);
  if (plotted.length === 0 || !domain) {
    return <div className="trend-empty rounded-xl border border-line bg-surface-2 p-4 text-sm" role="note" data-metric={metric}>
      <p className="font-bold">{METRIC_TITLE[metric]} ({unit})</p>
      <p className="muted mt-1">ยังไม่มีค่า{METRIC_TITLE[metric]}สำหรับช่วงเวลาที่เลือก ({periodLabel})</p>
      {segments.some(segment => segment.monitored) && <p className="muted mt-1">เกณฑ์ปัจจุบัน {formatLimits(segments.filter(segment => segment.monitored).at(-1)!.limits, unit)}</p>}
    </div>;
  }
  const [low, high] = domain;
  const x = (t: number) => pad.left + ((Math.min(Math.max(t, start), end) - start) / (end - start)) * plotW;
  const y = (value: number) => pad.top + ((high - Math.min(Math.max(value, low), high)) / (high - low)) * plotH;
  const yTicks = niceTicks(low, high, compact ? 4 : 5);
  const xTicks = timeTicks(start, end, Math.max(2, Math.floor(plotW / (compact ? 78 : 88))));
  const changes = bandChanges(segments);
  const lastBand = segments.filter(segment => segment.monitored).at(-1);
  const current = plotted[Math.min(Math.max(selected, 0), plotted.length - 1)];
  const latest = plotted.at(-1)!;

  function pick(event: MouseEvent<SVGSVGElement>) {
    const box = event.currentTarget.getBoundingClientRect();
    const px = ((event.clientX - box.left) / box.width) * W;
    let best = 0;
    plotted.forEach((point, index) => { if (Math.abs(x(point.t) - px) < Math.abs(x(plotted[best].t) - px)) best = index; });
    setSelected(best);
  }

  const summaryText = [
    `${METRIC_TITLE[metric]}ของ ${locationCode} ช่วง ${periodLabel}: ${summary.plotted} จุด`,
    `นอกช่วง ${summary.outOfRange} จุด`,
    summary.corrected ? `ค่าที่แก้ไขแล้ว ${summary.corrected} จุด` : null,
    summary.late ? `บันทึกย้อนหลัง ${summary.late} จุด` : null,
    summary.total > summary.plotted ? `ไม่มีค่า ${summary.total - summary.plotted} ครั้ง (เว้นช่องในเส้น)` : null,
    `ต่ำสุด ${formatMeasure(summary.min!)} สูงสุด ${formatMeasure(summary.max!)} ${unit}`,
    `ล่าสุด ${formatMeasure(latest.value!)} ${unit} (${POINT_STATUS_LABEL[latest.status]}) เมื่อ ${formatBangkokDateTime(latest.t)}`,
  ].filter(Boolean).join(' · ');
  const criteria = segments.filter(segment => segment.monitored).map(segment =>
    `${formatLimits(segment.limits, unit)} (${formatBangkokDateTime(segment.start)} – ${formatBangkokDateTime(segment.end)})`);

  return <figure className="trend-chart grid gap-2 min-w-0 m-0" data-metric={metric}>
    <figcaption className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
      <span className="font-bold">{METRIC_TITLE[metric]} <span className="muted font-normal">({unit})</span></span>
      {lastBand && <span className="muted text-xs">เกณฑ์ล่าสุด {formatLimits(lastBand.limits, unit)}{changes.length ? ` · เปลี่ยนเกณฑ์ ${changes.length} ครั้งในช่วงนี้` : ''}</span>}
    </figcaption>
    {/* When the chart is wider than the card it scrolls here, never the page; the scroller is then reachable by keyboard. */}
    <div ref={scroller} className="trend-scroll overflow-x-auto max-w-full rounded-xl border border-line"
      tabIndex={scrollable ? 0 : undefined} role={scrollable ? 'group' : undefined} aria-label={scrollable ? `${title} · เลื่อนซ้าย–ขวาเพื่อดูทั้งช่วง` : undefined}>
      <svg width={W} height={height} viewBox={`0 0 ${W} ${height}`} role="img" aria-label={`กราฟ${summaryText}`} aria-describedby={`${ids}-criteria`}
        onClick={pick} className="block" style={{ cursor: 'crosshair' }}>
        <title>{`แนวโน้ม${title}`}</title>
        <rect x={pad.left} y={pad.top} width={plotW} height={plotH} fill={COLOR.plot} />
        {segments.filter(segment => segment.monitored).map(segment => {
          const top = segment.limits.max !== null ? y(segment.limits.max) : pad.top;
          const bottom = segment.limits.min !== null ? y(segment.limits.min) : pad.top + plotH;
          const x1 = x(segment.start), x2 = x(segment.end);
          return <g key={`${segment.configId}-${segment.start}`} className="trend-band" data-band-min={segment.limits.min ?? ''} data-band-max={segment.limits.max ?? ''}>
            <rect x={x1} y={top} width={Math.max(0, x2 - x1)} height={Math.max(0, bottom - top)} fill={COLOR.band[metric]} />
            {segment.limits.max !== null && <line x1={x1} x2={x2} y1={top} y2={top} stroke={COLOR.limit} strokeWidth={1.2} strokeDasharray="5 3" />}
            {segment.limits.min !== null && <line x1={x1} x2={x2} y1={bottom} y2={bottom} stroke={COLOR.limit} strokeWidth={1.2} strokeDasharray="5 3" />}
          </g>;
        })}
        {yTicks.map(tick => <g key={`y${tick}`}>
          <line x1={pad.left} x2={pad.left + plotW} y1={y(tick)} y2={y(tick)} stroke={COLOR.grid} strokeWidth={0.8} />
          <text x={pad.left - 7} y={y(tick) + 4} textAnchor="end" fontSize={11} fill={COLOR.text}>{formatMeasure(tick).replace(/\.00$/, '')}</text>
        </g>)}
        {xTicks.map(({ t, step }) => <g key={`x${t}`}>
          <line x1={x(t)} x2={x(t)} y1={pad.top} y2={pad.top + plotH} stroke={COLOR.grid} strokeWidth={0.8} />
          <text x={x(t)} y={pad.top + plotH + 17} textAnchor="middle" fontSize={11} fill={COLOR.text}>{formatTick(t, step)}</text>
        </g>)}
        <line x1={pad.left} x2={pad.left + plotW} y1={pad.top + plotH} y2={pad.top + plotH} stroke={COLOR.axis} />
        <line x1={pad.left} x2={pad.left} y1={pad.top} y2={pad.top + plotH} stroke={COLOR.axis} />
        {changes.map(t => <g key={`c${t}`} className="trend-band-change">
          <line x1={x(t)} x2={x(t)} y1={pad.top} y2={pad.top + plotH} stroke={COLOR.change} strokeWidth={1.2} strokeDasharray="2 3" />
          {!compact && <text x={x(t) + 4} y={pad.top + 11} fontSize={10.5} fill={COLOR.change}>เปลี่ยนเกณฑ์</text>}
        </g>)}
        {!compact && lastBand && <>
          {lastBand.limits.max !== null && <text x={pad.left + plotW + 6} y={y(lastBand.limits.max) + 4} fontSize={10.5} fill={COLOR.limit}>สูงสุด {formatMeasure(lastBand.limits.max)}</text>}
          {lastBand.limits.min !== null && <text x={pad.left + plotW + 6} y={y(lastBand.limits.min) + 4} fontSize={10.5} fill={COLOR.limit}>ต่ำสุด {formatMeasure(lastBand.limits.min)}</text>}
        </>}
        {lineRuns(points).map(run => <polyline key={`r${run[0].id}`} points={run.map(point => `${x(point.t)},${y(point.value!)}`).join(' ')}
          fill="none" stroke={COLOR.line} strokeWidth={1.8} strokeLinejoin="round" strokeLinecap="round" />)}
        {current && <line x1={x(current.t)} x2={x(current.t)} y1={pad.top} y2={pad.top + plotH} stroke={COLOR.selected} strokeWidth={0.8} strokeOpacity={0.35} />}
        {plotted.map(point => <TrendMarker key={point.id} point={point} cx={x(point.t)} cy={y(point.value!)} metric={metric}
          isLatest={point === latest} isSelected={point === current} />)}
        {!compact && <text x={x(latest.t) < pad.left + 90 ? x(latest.t) + 8 : x(latest.t) - 6} y={Math.max(y(latest.value!) - 11, pad.top + 10)}
          textAnchor={x(latest.t) < pad.left + 90 ? 'start' : 'end'} fontSize={11} fontWeight={700} fill={COLOR.ink}>
          ล่าสุด {formatMeasure(latest.value!)}
        </text>}
      </svg>
    </div>
    <TrendLegend metric={metric} />
    <p className="text-sm" aria-live="polite"><span className="font-semibold">{current === latest ? 'จุดล่าสุด' : 'จุดที่เลือก'}:</span> {describePoint(current, metric)}</p>
    {!compact && plotted.length > 1 && <div className="flex flex-wrap gap-2">
      <button type="button" className="button secondary" onClick={() => setSelected(index => Math.max(0, Math.min(index, plotted.length - 1) - 1))} disabled={selected <= 0}>‹ จุดก่อนหน้า</button>
      <button type="button" className="button secondary" onClick={() => setSelected(index => Math.min(plotted.length - 1, index + 1))} disabled={selected >= plotted.length - 1}>จุดถัดไป ›</button>
    </div>}
    <p id={`${ids}-criteria`} className="muted text-xs">เกณฑ์ที่ใช้ตามช่วงเวลา: {criteria.length ? criteria.join(' → ') : 'ไม่มีเกณฑ์ในช่วงนี้'}</p>
    {!compact && <details className="text-sm">
      <summary className="cursor-pointer font-semibold min-h-11 flex items-center">ดูทุกจุดเป็นตาราง ({summary.plotted} จุด)</summary>
      <div className="table-wrap overflow-x-auto max-w-full mt-2">
        <table className="data-table text-xs">
          <caption className="sr-only">ค่า{METRIC_TITLE[metric]}ทุกจุดในกราฟ เรียงตามเวลาที่ตรวจ</caption>
          <thead><tr><th scope="col">เวลาที่ตรวจ</th><th scope="col">ค่า ({unit})</th><th scope="col">ผล</th><th scope="col">เกณฑ์ขณะนั้น</th><th scope="col">การบันทึก</th><th scope="col">ข้อมูล</th><th scope="col">บันทึกเมื่อ</th><th scope="col">ช่องทาง</th></tr></thead>
          <tbody>{plotted.map(point => <tr key={point.id}>
            <td>{formatBangkokDateTime(point.t)}</td><td className="tabular-nums">{formatMeasure(point.value!)}</td>
            <td>{point.status === 'out_of_range' ? '✕ ' : '● '}{POINT_STATUS_LABEL[point.status]}</td><td>{formatLimits(point.limits, unit)}</td>
            <td>{point.late ? 'ย้อนหลัง' : 'ทันที'}</td><td>{point.corrected ? '◆ แก้ไขแล้ว' : 'ค่าเดิม'}</td>
            <td>{formatBangkokDateTime(point.recordedAt)}</td><td>{point.source === 'qr' ? 'QR' : 'บันทึกเอง'}</td>
          </tr>)}</tbody>
        </table>
      </div>
    </details>}
  </figure>;
}

function TrendMarker({ point, cx, cy, metric, isLatest, isSelected }: { point: TrendPoint; cx: number; cy: number; metric: TrendMetric; isLatest: boolean; isSelected: boolean }) {
  const out = point.status === 'out_of_range';
  return <g className="trend-point" data-status={point.status} data-corrected={point.corrected ? 'true' : undefined} data-late={point.late ? 'true' : undefined} data-latest={isLatest ? 'true' : undefined}>
    <title>{describePoint(point, metric)}</title>
    {(isSelected || isLatest) && <circle cx={cx} cy={cy} r={isSelected ? 11 : 9.5} fill="none" stroke={COLOR.selected} strokeWidth={isSelected ? 1.6 : 1} strokeOpacity={isSelected ? 0.7 : 0.35} />}
    {point.late && <circle cx={cx} cy={cy} r={7.5} fill="none" stroke={COLOR.late} strokeWidth={1.4} strokeDasharray="2 2" />}
    {point.corrected && <rect x={cx - 5.5} y={cy - 5.5} width={11} height={11} transform={`rotate(45 ${cx} ${cy})`}
      fill={out ? '#ffffff' : COLOR.corrected} stroke={COLOR.corrected} strokeWidth={1.6} />}
    {out ? <g stroke={COLOR.out} strokeWidth={2.4} strokeLinecap="round">
      <line x1={cx - 4} y1={cy - 4} x2={cx + 4} y2={cy + 4} /><line x1={cx - 4} y1={cy + 4} x2={cx + 4} y2={cy - 4} />
    </g> : !point.corrected && <circle cx={cx} cy={cy} r={3.8} fill={COLOR.inRange} stroke="#ffffff" strokeWidth={1.3} />}
    {/* A larger transparent target makes each point easy to hover with a mouse. */}
    <circle cx={cx} cy={cy} r={10} fill="transparent" />
  </g>;
}

function TrendLegend({ metric }: { metric: TrendMetric }) {
  const item = (icon: ReactNode, label: string) => <li className="flex items-center gap-1.5"><svg width={18} height={18} viewBox="-9 -9 18 18" aria-hidden="true">{icon}</svg>{label}</li>;
  return <ul className="trend-legend flex flex-wrap gap-x-4 gap-y-1 text-xs muted" aria-label="คำอธิบายสัญลักษณ์">
    {item(<circle r={3.8} fill={COLOR.inRange} stroke="#fff" strokeWidth={1.3} />, 'อยู่ในช่วง')}
    {item(<g stroke={COLOR.out} strokeWidth={2.4} strokeLinecap="round"><line x1={-4} y1={-4} x2={4} y2={4} /><line x1={-4} y1={4} x2={4} y2={-4} /></g>, 'นอกช่วง')}
    {item(<rect x={-4.5} y={-4.5} width={9} height={9} transform="rotate(45)" fill={COLOR.corrected} />, 'ค่าที่แก้ไขแล้ว')}
    {item(<circle r={6.5} fill="none" stroke={COLOR.late} strokeWidth={1.4} strokeDasharray="2 2" />, 'บันทึกย้อนหลัง')}
    {item(<rect x={-8} y={-5} width={16} height={10} fill={COLOR.band[metric]} stroke={COLOR.limit} strokeDasharray="3 2" />, 'ช่วงที่ยอมรับได้ตามเกณฑ์ขณะนั้น')}
  </ul>;
}
