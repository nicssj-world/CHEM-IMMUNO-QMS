import Link from 'next/link';
import { formatDateTimeBE } from '@/lib/format';
import { label, movementKindLabels } from '@/lib/labels';
import { unitLabel } from '@/lib/units';
import type { MovementDetail, MovementDetailLine } from '@/lib/stock-history';

const quantity = (n: number) => n.toLocaleString('th-TH', { maximumFractionDigits: 3 });

function MovementLine({ row }: { row: MovementDetailLine }) {
  const unit = row.unit ? ' ' + unitLabel(row.unit) : '';
  return <div className="rounded-lg border border-line p-3 grid gap-1 text-sm min-w-0">
    <div className="flex flex-wrap justify-between items-start gap-2">
      <div className="min-w-0">
        {row.productId ? <Link className="font-bold text-brand break-words" href={'/products/' + row.productId + '?tab=history'}>{row.productName}</Link> : <strong>{row.productName}</strong>}
        <p className="muted text-xs break-all">{row.productCode}{row.ref ? ' · REF ' + row.ref : ''}</p>
      </div>
      <strong className={row.delta < 0 ? 'text-red-700 tabular-nums' : 'text-emerald-800 tabular-nums'}>
        {row.delta > 0 ? '+' : ''}{quantity(row.delta)}{unit}
      </strong>
    </div>
    <p className="text-xs">LOT <strong>{row.lotNumber}</strong> · EXP {row.expiryDate ?? '—'} · ตำแหน่ง {row.location}</p>
    <p className="text-xs muted">คงเหลือปัจจุบันของ LOT/ตำแหน่งนี้ <strong className="text-[var(--ink)]">{row.currentLotLocationBalance === null ? '—' : quantity(row.currentLotLocationBalance)}{unit}</strong></p>
  </div>;
}

/** Shared detailed audit presentation for dashboard, product history and movement ledger.
 * "Current" balances are never mislabeled as historical balances.
 */
export function StockMovementCards({ rows, compact = false }: { rows: MovementDetail[]; compact?: boolean }) {
  if (!rows.length) return <p className="muted text-sm">ยังไม่มีรายการเคลื่อนไหว</p>;
  return <div className="grid gap-3">
    {rows.map(row => <article key={row.id} className="rounded-xl border border-line p-3 sm:p-4 grid gap-3 min-w-0">
      <header className="flex flex-wrap gap-2 items-start justify-between">
        <div>
          <strong className="text-sm">{label(movementKindLabels,row.kind)}</strong>
          {row.purpose && <span className="muted text-xs"> · {row.purpose}</span>}
          <p className="muted text-xs mt-1">{formatDateTimeBE(row.created_at)}</p>
        </div>
        <span className="muted text-xs">#{row.id.slice(0,8)}</span>
      </header>
      {row.lines.length === 1 ? <MovementLine row={row.lines[0]}/> :
        row.lines.length > 1 ? <details open={!compact} className="grid gap-2">
          <summary className="cursor-pointer text-brand font-semibold text-sm min-h-9">รายละเอียดน้ำยา {row.lines.length} รายการ</summary>
          <div className="grid gap-2 mt-2">{row.lines.map((line,i) => <MovementLine key={line.lotId + ':' + line.locationId + ':' + i} row={line}/>)}</div>
        </details> : <p className="error text-xs">ไม่พบรายละเอียด movement ของรายการนี้</p>}
      <div className="grid gap-1 text-xs">
        <p><span className="muted">{row.kind === 'issue' ? 'ผู้เบิก' : 'ผู้ทำรายการ'}:</span> <strong>{row.actorName ?? 'ไม่พบชื่อผู้ทำรายการ — โปรดตรวจสอบทะเบียนผู้ใช้'}</strong></p>
        {row.reason && <p><span className="muted">เหตุผล:</span> {row.reason}</p>}
        {row.source_transaction_id && <p className="muted">อ้างอิงรายการต้นทาง #{row.source_transaction_id.slice(0,8)}</p>}
      </div>
    </article>)}
  </div>;
}
