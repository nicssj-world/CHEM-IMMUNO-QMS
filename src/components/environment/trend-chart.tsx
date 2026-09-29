'use client';

import { useEffect, useId, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import {
  bandChanges, dayAxis, describePoint, formatAxis, formatBangkokDateTime, formatBangkokShort, formatLimits, formatMeasure, lineRuns,
  METRIC_CARD_TITLE, METRIC_TITLE, METRIC_UNIT, niceTicks, POINT_STATUS_LABEL, summarizeSeries, valueDomain,
  type BandSegment, type TrendMetric, type TrendPoint,
} from '@/lib/environment-trend';

// Monthly chart card in the style of the lab's existing temperature sheets: the acceptable band in the middle, the zones above
// the maximum and below the minimum tinted, dashed max/min guides labelled on the right, and the whole month on the x axis.
// Meaning never depends on colour alone: ● in range, ✕ out of range, ◆ corrected value, a dashed ring for a late entry.

const COLOR = {
  inRange: '#157a4a', out: '#b42335', corrected: '#a15c07', late: '#155e99', line: '#6f8c99',
  grid: '#e3ecef', dayGrid: '#eef3f5', axis: '#9fb4bd', text: '#526a79', ink: '#153044', plot: '#fbfdfd',
  band: { temperature: '#e3f4ea', humidity: '#e2eff8' }, danger: '#fdeef0', limit: '#cf6f7b', limitText: '#8a4b00',
  change: '#8a6d3b', selected: '#153044', future: '#ffffff',
};

export type TrendChartProps = {
  metric: TrendMetric; locationCode: string; points: TrendPoint[]; segments: BandSegment[];
  /** Full x domain (a whole month in a month view) and the render time; the axis never shrinks to the days with readings. */
  start: number; end: number; now: number; periodLabel: string;
  compact?: boolean;
  /** Readings in the period (all metrics), so two charts of one location get the same width and x scale. */
  density: number;
};

export function EnvironmentTrendChart({ metric, locationCode, points, segments, start, end, now, periodLabel, compact = false, density }: TrendChartProps) {
  const unit = METRIC_UNIT[metric];
  const cardTitle = `${METRIC_CARD_TITLE[metric]} (${unit})`;
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

  const height = compact ? 196 : 280;
  const pad = { top: 14, right: 58, bottom: 28, left: 46 };
  const minPlot = Math.min(2400, density * (compact ? 3 : 5));
  const W = Math.max(width, 280, minPlot + pad.left + pad.right);
  const scrollable = W > width;
  const plotW = W - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;

  // Dense periods scroll inside the card; start at the newest end, which is what people look for first.
  useEffect(() => {
    const element = scroller.current;
    if (element && element.scrollWidth > element.clientWidth) element.scrollLeft = element.scrollWidth;
  }, [W]);

  const latest = plotted.at(-1);
  const header = <figcaption className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
    <span className="min-w-0"><span className="block font-bold">{cardTitle}</span><span className="block muted text-xs">{METRIC_TITLE[metric]} · {locationCode}</span></span>
    <span className="text-right"><span className="block font-bold text-sm">{periodLabel}</span>
      {latest ? <span className="block text-xs"><span className="font-bold tabular-nums">ล่าสุด {formatMeasure(latest.value!)} {unit}</span> <span className="muted">· {formatBangkokShort(latest.t)} · {latest.status === 'out_of_range' ? '✕ ' : ''}{POINT_STATUS_LABEL[latest.status]}</span></span>
        : <span className="block muted text-xs">ยังไม่มีค่าในช่วงนี้</span>}
    </span>
  </figcaption>;

  const domain = valueDomain(plotted, segments);
  if (plotted.length === 0 || !domain) {
    const lastBand = segments.filter(segment => segment.monitored).at(-1);
    return <figure className="trend-chart trend-empty rounded-2xl border border-line bg-surface p-3 sm:p-4 grid gap-2 min-w-0 m-0" data-metric={metric}>
      {header}
      <p className="rounded-xl bg-surface-2 p-4 text-sm muted" role="note">ยังไม่มีค่า{METRIC_TITLE[metric]}สำหรับช่วงเวลาที่เลือก ({periodLabel}){lastBand ? ` · เกณฑ์ ${formatLimits(lastBand.limits, unit)}` : ''}</p>
    </figure>;
  }
  const [low, high] = domain;
  const plotTop = pad.top, plotBottom = pad.top + plotH;
  const x = (t: number) => pad.left + ((Math.min(Math.max(t, start), end) - start) / (end - start)) * plotW;
  const y = (value: number) => pad.top + ((high - Math.min(Math.max(value, low), high)) / (high - low)) * plotH;
  const yTicks = niceTicks(low, high, compact ? 4 : 5);
  const days = dayAxis(start, end, Math.floor(plotW / (compact ? 30 : 34)));
  const changes = bandChanges(segments);
  const monitoredSegments = segments.filter(segment => segment.monitored);
  const lastBand = monitoredSegments.at(-1);
  const current = plotted[Math.min(Math.max(selected, 0), plotted.length - 1)];
  const lastPoint = latest!;
  const futureFrom = now < end ? Math.max(now, start) : null;

  function pick(event: MouseEvent<SVGSVGElement>) {
    const box = event.currentTarget.getBoundingClientRect();
    const px = ((event.clientX - box.left) / box.width) * W;
    let best = 0;
    plotted.forEach((point, index) => { if (Math.abs(x(point.t) - px) < Math.abs(x(plotted[best].t) - px)) best = index; });
    setSelected(best);
  }

  const summaryText = [
    `${METRIC_TITLE[metric]}ของ ${locationCode} ${periodLabel}: ${summary.plotted} จุดใน ${days.length} วัน`,
    `นอกช่วง ${summary.outOfRange} จุด`,
    summary.corrected ? `ค่าที่แก้ไขแล้ว ${summary.corrected} จุด` : null,
    summary.late ? `บันทึกย้อนหลัง ${summary.late} จุด` : null,
    summary.total > summary.plotted ? `ไม่มีค่า ${summary.total - summary.plotted} ครั้ง (เว้นช่องในเส้น)` : null,
    `ต่ำสุด ${formatMeasure(summary.min!)} สูงสุด ${formatMeasure(summary.max!)} ${unit}`,
    `ล่าสุด ${formatMeasure(lastPoint.value!)} ${unit} (${POINT_STATUS_LABEL[lastPoint.status]}) เมื่อ ${formatBangkokDateTime(lastPoint.t)}`,
  ].filter(Boolean).join(' · ');
  const criteria = monitoredSegments.map(segment =>
    `${formatLimits(segment.limits, unit)} (${formatBangkokDateTime(segment.start)} – ${formatBangkokDateTime(segment.end)})`);

  return <figure className="trend-chart rounded-2xl border border-line bg-surface p-3 sm:p-4 grid gap-2 min-w-0 m-0" data-metric={metric}>
    {header}
    {/* When the chart is wider than the card it scrolls here, never the page; the scroller is then reachable by keyboard. */}
    <div ref={scroller} className="trend-scroll overflow-x-auto max-w-full rounded-xl border border-line"
      tabIndex={scrollable ? 0 : undefined} role={scrollable ? 'group' : undefined} aria-label={scrollable ? `${cardTitle} · เลื่อนซ้าย–ขวาเพื่อดูทั้งเดือน` : undefined}>
      <svg width={W} height={height} viewBox={`0 0 ${W} ${height}`} role="img" aria-label={`กราฟ${summaryText}`} aria-describedby={`${ids}-criteria`}
        onClick={pick} className="block" style={{ cursor: 'crosshair' }} data-axis-days={days.length}>
        <title>{`${cardTitle} · ${locationCode} · ${periodLabel}`}</title>
        <rect x={pad.left} y={plotTop} width={plotW} height={plotH} fill={COLOR.plot} />
        {monitoredSegments.map(segment => {
          const top = segment.limits.max !== null ? y(segment.limits.max) : plotTop;
          const bottom = segment.limits.min !== null ? y(segment.limits.min) : plotBottom;
          const x1 = x(segment.start), w = Math.max(0, x(segment.end) - x1);
          return <g key={`${segment.configId}-${segment.start}`} className="trend-band" data-band-min={segment.limits.min ?? ''} data-band-max={segment.limits.max ?? ''}>
            {segment.limits.max !== null && <rect className="trend-zone-high" x={x1} y={plotTop} width={w} height={Math.max(0, top - plotTop)} fill={COLOR.danger} />}
            <rect x={x1} y={top} width={w} height={Math.max(0, bottom - top)} fill={COLOR.band[metric]} />
            {segment.limits.min !== null && <rect className="trend-zone-low" x={x1} y={bottom} width={w} height={Math.max(0, plotBottom - bottom)} fill={COLOR.danger} />}
          </g>;
        })}
        {days.map(slot => <line key={`d${slot.start}`} x1={x(slot.start)} x2={x(slot.start)} y1={plotTop} y2={plotBottom} stroke={COLOR.dayGrid} strokeWidth={0.7} />)}
        {yTicks.map(tick => <g key={`y${tick}`}>
          <line x1={pad.left} x2={pad.left + plotW} y1={y(tick)} y2={y(tick)} stroke={COLOR.grid} strokeWidth={0.8} />
          <text x={pad.left - 7} y={y(tick) + 4} textAnchor="end" fontSize={11} fill={COLOR.text}>{formatAxis(tick)}</text>
        </g>)}
        {monitoredSegments.map(segment => {
          const x1 = x(segment.start), x2 = x(segment.end);
          return <g key={`l${segment.configId}-${segment.start}`}>
            {segment.limits.max !== null && <line x1={x1} x2={x2} y1={y(segment.limits.max)} y2={y(segment.limits.max)} stroke={COLOR.limit} strokeWidth={1.2} strokeDasharray="4 3" />}
            {segment.limits.min !== null && <line x1={x1} x2={x2} y1={y(segment.limits.min)} y2={y(segment.limits.min)} stroke={COLOR.limit} strokeWidth={1.2} strokeDasharray="4 3" />}
          </g>;
        })}
        {futureFrom !== null && <g className="trend-future">
          <rect x={x(futureFrom)} y={plotTop} width={Math.max(0, pad.left + plotW - x(futureFrom))} height={plotH} fill={COLOR.future} fillOpacity={0.55} />
          <line x1={x(futureFrom)} x2={x(futureFrom)} y1={plotTop} y2={plotBottom} stroke={COLOR.axis} strokeWidth={1} strokeDasharray="2 2" />
          <text x={x(futureFrom) + 4} y={plotBottom - 5} fontSize={10.5} fill={COLOR.text}>วันนี้</text>
        </g>}
        <line x1={pad.left} x2={pad.left + plotW} y1={plotBottom} y2={plotBottom} stroke={COLOR.axis} />
        <line x1={pad.left} x2={pad.left} y1={plotTop} y2={plotBottom} stroke={COLOR.axis} />
        {days.filter(slot => slot.label).map(slot => <g key={`t${slot.start}`}>
          <line x1={x(slot.start)} x2={x(slot.start)} y1={plotBottom} y2={plotBottom + 4} stroke={COLOR.axis} />
          <text x={(x(slot.start) + x(slot.end)) / 2} y={plotBottom + 17} textAnchor="middle" fontSize={11} fill={COLOR.text}>{slot.label}</text>
        </g>)}
        {changes.map(t => <g key={`c${t}`} className="trend-band-change">
          <line x1={x(t)} x2={x(t)} y1={plotTop} y2={plotBottom} stroke={COLOR.change} strokeWidth={1.3} strokeDasharray="2 3" />
          {!compact && <text x={x(t) + 4} y={plotTop + 11} fontSize={10.5} fill={COLOR.change}>เปลี่ยนเกณฑ์</text>}
        </g>)}
        {lastBand && <g className="trend-limit-labels">
          {lastBand.limits.max !== null && <text x={pad.left + plotW + 5} y={y(lastBand.limits.max) + 4} fontSize={10.5} fontWeight={700} fill={COLOR.limitText}>max {formatAxis(lastBand.limits.max)}</text>}
          {lastBand.limits.min !== null && <text x={pad.left + plotW + 5} y={y(lastBand.limits.min) + 4} fontSize={10.5} fontWeight={700} fill={COLOR.limitText}>min {formatAxis(lastBand.limits.min)}</text>}
        </g>}
        {lineRuns(points).map(run => <polyline key={`r${run[0].id}`} points={run.map(point => `${x(point.t)},${y(point.value!)}`).join(' ')}
          fill="none" stroke={COLOR.line} strokeWidth={1.8} strokeLinejoin="round" strokeLinecap="round" />)}
        <line x1={x(current.t)} x2={x(current.t)} y1={plotTop} y2={plotBottom} stroke={COLOR.selected} strokeWidth={0.8} strokeOpacity={0.35} />
        {plotted.map(point => <TrendMarker key={point.id} point={point} cx={x(point.t)} cy={y(point.value!)} metric={metric}
          isLatest={point === lastPoint} isSelected={point === current} />)}
      </svg>
    </div>
    <p className="trend-summary text-sm"><span className="font-semibold">{periodLabel}:</span> {summary.plotted} จุด · นอกช่วง {summary.outOfRange} จุด · ต่ำสุด {formatMeasure(summary.min!)} · สูงสุด {formatMeasure(summary.max!)} {unit}{summary.corrected ? ` · แก้ไขแล้ว ${summary.corrected}` : ''}{summary.late ? ` · ย้อนหลัง ${summary.late}` : ''}</p>
    <TrendLegend metric={metric} />
    <p className="text-sm" aria-live="polite"><span className="font-semibold">{current === lastPoint ? 'จุดล่าสุด' : 'จุดที่เลือก'}:</span> {describePoint(current, metric)}</p>
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
    {item(<rect x={-8} y={-5} width={16} height={10} fill={COLOR.band[metric]} stroke={COLOR.limit} strokeDasharray="3 2" />, 'ช่วงปกติตามเกณฑ์ขณะนั้น')}
    {item(<rect x={-8} y={-5} width={16} height={10} fill={COLOR.danger} />, 'เกินเกณฑ์ (สูงกว่า max / ต่ำกว่า min)')}
  </ul>;
}
