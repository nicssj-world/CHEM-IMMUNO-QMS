import Link from 'next/link';
import { CircleCheck } from 'lucide-react';
import type { IssueResult } from '@/lib/issue-results';
import { unitLabel } from '@/lib/units';
import { formatThaiDateTime } from '@/lib/format';

const fmt = (n: number) => n.toLocaleString('th-TH', { maximumFractionDigits: 3 });

/** Balance after the issue is the largest number; every figure was recorded when stock was cut. */
export function IssueResultPanel({ result, actorName, nextHref = '/issue', doneHref = '/' }: { result: IssueResult; actorName?: string | null; nextHref?: string; doneHref?: string }) {
  const many = result.lines.length > 1;
  return <section className="surface p-4 sm:p-6 grid gap-4" aria-label="ผลการเบิกน้ำยา" role="status">
    <h2 className="text-xl font-bold text-emerald-800 flex items-center gap-2"><CircleCheck size={24} aria-hidden /> เบิกน้ำยาสำเร็จ{many ? ` ${result.lines.length} รายการ` : ''}</h2>
    <ul className="grid gap-3">
      {result.lines.map(line => {
        const unit = unitLabel(line.unit);
        return <li key={line.id} className="rounded-xl border border-line p-3 sm:p-4 grid gap-3">
          <div>
            <p className="font-semibold leading-snug break-words">{line.productName}</p>
            <p className="muted text-sm">{line.productCode} · LOT {line.lotNumber} · ตำแหน่ง {line.locationCode}</p>
          </div>
          <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1 text-sm items-baseline">
            <span className="muted">ยอดก่อนเบิก</span><span className="tabular-nums text-right">{fmt(line.before)} {unit}</span>
            <span className="muted">จำนวนที่เบิก</span><span className="tabular-nums text-right">−{fmt(line.quantity)} {unit}</span>
            <span className="font-semibold border-t border-line pt-2">ยอดคงเหลือหลังเบิก</span>
            <span className="tabular-nums text-right border-t border-line pt-2"><strong className={'text-3xl ' + (line.after === 0 ? 'text-amber-800' : '')}>{fmt(line.after)}</strong> {unit}</span>
          </div>
          {line.after === 0 && <p className="text-sm text-amber-800">LOT นี้ที่ตำแหน่งนี้หมดแล้ว</p>}
        </li>;
      })}
    </ul>
    <div className="grid gap-1 text-sm">
      {result.products.map(product => <p key={product.productId} className="flex justify-between gap-3">
        <span className="muted min-w-0">ยอดคงเหลือรวมทุก LOT{many ? ` · ${product.productCode}` : ''}</span>
        <span className="tabular-nums font-semibold shrink-0">{fmt(product.totalAfter)} {unitLabel(product.unit)}</span>
      </p>)}
    </div>
    <p className="muted text-xs">ยอด ณ เวลาที่เบิก {formatThaiDateTime(result.issuedAt)}{actorName ? ` · ผู้เบิก ${actorName}` : ''} · ยอดปัจจุบันอาจเปลี่ยนหากมีรายการอื่นภายหลัง</p>
    <div className="grid grid-cols-2 gap-2">
      <Link href={nextHref} className="button min-h-12">เบิกรายการถัดไป</Link>
      <Link href={doneHref} className="button secondary min-h-12">เสร็จสิ้น</Link>
    </div>
  </section>;
}
