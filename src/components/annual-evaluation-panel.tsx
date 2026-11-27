'use client';

import Link from 'next/link';
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Download } from 'lucide-react';
import { createAnnualEvaluationDraft } from '@/app/actions/evaluation';
import { RESULT_LABELS, isOfficial, type AnnualRevision } from '@/lib/vendor-evaluation';

const number = new Intl.NumberFormat('th-TH', { maximumFractionDigits: 2 });

/** Annual reports for one vendor and warehouse (LABCBH-Stock VendorAnnualEvaluationPanel): score and PDF appear only for official (final, approved-policy) reports. */
export function AnnualEvaluationPanel({ revisions, vendorId, warehouseId, fiscalYear, canManage, hasDraftForYear }: { revisions: AnnualRevision[]; vendorId: string; warehouseId: number; fiscalYear: number; canManage: boolean; hasDraftForYear: string | null }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  function open() {
    if (hasDraftForYear) { router.push(`/vendors/${vendorId}/evaluations/${hasDraftForYear}`); return; }
    setError(null);
    startTransition(async () => {
      const result = await createAnnualEvaluationDraft(vendorId, warehouseId, fiscalYear);
      if (!result.ok) { setError(result.message); return; }
      router.push(`/vendors/${vendorId}/evaluations/${result.data}`);
    });
  }
  return <div className="grid gap-4">
    {canManage && <div className="flex flex-wrap items-center gap-3"><button type="button" className="button" disabled={pending} aria-busy={pending} onClick={open}>{hasDraftForYear ? `ดำเนินการฉบับร่างปี ${fiscalYear}` : `สร้างฉบับร่างปี ${fiscalYear}`}</button><Link href="/vendors/evaluation-policy" className="text-sm">นโยบายและเกณฑ์</Link></div>}
    {error && <p className="error" role="alert">{error}</p>}
    {revisions.length === 0 ? <p className="muted text-sm">ยังไม่มีรายงานประเมินของผู้ขายนี้ในคลังนี้</p> : <div className="table-wrap"><table className="data-table"><thead><tr><th>ปีงบประมาณ</th><th>ฉบับ</th><th>นโยบาย</th><th>สถานะ</th><th>คะแนน</th><th>ผล</th><th><span className="sr-only">ลิงก์</span></th></tr></thead>
      <tbody>{revisions.map(r => { const official = isOfficial(r); const f = r.frozen_snapshot; return <tr key={r.id}>
        <td>{r.ci_vendor_annual_evaluations.fiscal_year}</td><td>{r.revision_number}</td>
        <td><span className="font-mono">{r.ci_vendor_evaluation_policies.version}</span>{r.ci_vendor_evaluation_policies.status !== 'approved' && <small className="block muted">ข้อเสนอ ยังไม่อนุมัติ</small>}</td>
        <td><span className="badge">{r.status === 'final' ? 'สิ้นสุดแล้ว' : 'ฉบับร่าง'}</span>{r.report_number && <small className="block font-mono muted">{r.report_number}</small>}</td>
        <td>{official && f ? number.format(f.score) : '—'}</td><td>{official && f ? RESULT_LABELS[f.result] : '—'}</td>
        <td className="whitespace-nowrap"><Link href={`/vendors/${vendorId}/evaluations/${r.id}`}>รายละเอียด</Link>{official && <> · <a href={`/api/vendors/${vendorId}/evaluations/${r.id}/pdf`} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1"><Download size={14} aria-hidden />PDF</a></>}</td></tr>; })}</tbody></table></div>}
  </div>;
}
