import Link from 'next/link';
import { EnvironmentTrendChart } from '@/components/environment/trend-chart';
import {
  bandSegments, buildTrendSeries, formatIsoDate, METRIC_VIEW_LABEL, metricsForView, RANGE_KEYS, RANGE_LABEL,
  type MetricView, type TrendMetric, type TrendRange, type TrendRangeKey,
} from '@/lib/environment-trend';
import type { TrendData } from '@/lib/environment-trend-data';
import { logUserMessage } from '@/lib/messages';

// Server-rendered frame around the trend charts. Every choice is a link or GET form, so a chart view can be shared or bookmarked.

type Segment = { key: string; label: string; href: string; current: boolean };
function SegmentedLinks({ label, items }: { label: string; items: Segment[] }) {
  return <nav aria-label={label} className="flex flex-wrap gap-1.5 p-1.5 bg-track rounded-xl w-fit max-w-full">
    {items.map(item => <Link key={item.key} href={item.href} scroll={false} aria-current={item.current ? 'true' : undefined}
      className={`min-h-11 min-w-[4.5rem] flex items-center justify-center rounded-[9px] px-3 text-sm font-extrabold no-underline ${item.current ? 'bg-white text-[#095d79] shadow-sm' : 'text-[#455e6d]'}`}>{item.label}</Link>)}
  </nav>;
}

export function MetricSwitch({ view, hrefFor }: { view: MetricView; hrefFor: (view: MetricView) => string }) {
  return <SegmentedLinks label="เลือกค่าที่แสดงในกราฟ" items={(['both', 'temperature', 'humidity'] as const).map(key => ({ key, label: METRIC_VIEW_LABEL[key], href: hrefFor(key), current: key === view }))} />;
}

export function RangeSwitch({ range, hrefFor }: { range: TrendRangeKey; hrefFor: (range: TrendRangeKey) => string }) {
  return <SegmentedLinks label="เลือกช่วงเวลา" items={RANGE_KEYS.map(key => ({ key, label: RANGE_LABEL[key], href: hrefFor(key), current: key === range }))} />;
}

export function trendPeriodLabel(range: TrendRange) {
  return range.from === range.to ? formatIsoDate(range.from) : `${formatIsoDate(range.from)} – ${formatIsoDate(range.to)}`;
}

export function EnvironmentTrendPanel({ location, range, view, available, data, compact = false, metricHref }: {
  location: { id: string; code: string }; range: TrendRange; view: MetricView | null; available: readonly TrendMetric[];
  data: TrendData; compact?: boolean; metricHref: (view: MetricView) => string;
}) {
  const metrics = metricsForView(view);
  const periodLabel = trendPeriodLabel(range);
  return <div className="trend-panel grid gap-4 min-w-0" data-location={location.code}>
    {view && available.length > 1 && <MetricSwitch view={view} hrefFor={metricHref} />}
    {data.error && <p className="error" role="alert">อ่านข้อมูลกราฟไม่สำเร็จ: {logUserMessage('environmentTrend', data.error)}</p>}
    {data.truncated && <p className="notice" role="status">ช่วงนี้มี {data.total?.toLocaleString()} รายการ · กราฟแสดง {data.readings.length.toLocaleString()} รายการแรกตามเวลาที่ตรวจ · เลือกช่วงให้สั้นลงเพื่อดูครบ</p>}
    {!data.error && metrics.length > 0 && data.readings.length === 0 && <p className="trend-empty rounded-xl border border-line bg-surface-2 p-4 text-sm muted" role="note">ยังไม่มีข้อมูลสำหรับช่วงเวลาที่เลือก ({periodLabel})</p>}
    {!data.error && data.readings.length > 0 && <div className="grid gap-6 min-w-0">
      {metrics.map(metric => <EnvironmentTrendChart key={`${location.id}:${metric}:${range.from}:${range.to}`} metric={metric} locationCode={location.code}
        points={buildTrendSeries(data.readings, data.configs, metric)} segments={bandSegments(data.configs, metric, range.start, range.end)}
        start={range.start} end={range.end} periodLabel={periodLabel} compact={compact} density={data.readings.length} />)}
    </div>}
  </div>;
}
