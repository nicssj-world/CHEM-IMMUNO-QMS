'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { reviseReceiptAssessment } from '@/app/actions/vendors';
import { ReceiptAssessmentFields } from './receipt-assessment-fields';
import { REASON_LABELS, assessmentAnswerLines, assessmentError, deriveAcceptanceDecision, fromAssessmentRow, type AssessmentRow } from '@/lib/receipt-assessment';
import { formatDateTime } from '@/lib/format';

/** One receipt event: read-only answers by default (as LABCBH ReadOnlyAssessment); supervisors and admins can revise, and every revision is kept. */
export function ReceiptAssessmentCard({ eventNumber, invoiceNumber, receivedAt, assessment, revisions, canRevise }: {
  eventNumber: string | null; invoiceNumber: string; receivedAt: string; assessment: AssessmentRow | null;
  revisions: { revision_number: number; changed_at: string }[]; canRevise: boolean;
}) {
  const router = useRouter();
  const saved = assessment ? fromAssessmentRow(assessment) : null;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(saved);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function save() {
    if (!assessment || !draft) return;
    const problem = assessmentError(draft);
    if (problem) { setError(problem); return; }
    setError(null);
    startTransition(async () => {
      const result = await reviseReceiptAssessment(assessment.id, JSON.stringify(draft));
      if (!result.ok) { setError(result.message); return; }
      setEditing(false); router.refresh();
    });
  }

  const conditional = saved ? deriveAcceptanceDecision(saved) === 'accepted_with_justification' : false;
  return <article className="rounded-xl border border-line p-4 grid gap-3">
    <header className="flex flex-wrap items-center justify-between gap-2">
      <div><strong className="font-mono">{eventNumber ?? '—'}</strong><span className="muted text-sm"> · Invoice {invoiceNumber} · รับเมื่อ {formatDateTime(receivedAt)}</span></div>
      {saved && <span className={`badge ${conditional ? '!bg-[#fff3d6] !text-[#7a4f00]' : ''}`}>{conditional ? 'รับสินค้าแบบมีเงื่อนไข' : 'รับสินค้า'}</span>}
    </header>
    {!saved || !assessment ? <p className="muted text-sm">ไม่มีผลตรวจรับ</p> : editing && draft ? <div className="grid gap-4">
      <ReceiptAssessmentFields value={draft} onChange={setDraft} />
      {error && <p className="error" role="alert">{error}</p>}
      <div className="flex flex-wrap justify-end gap-2"><button type="button" className="button secondary" disabled={pending} onClick={() => { setEditing(false); setDraft(saved); setError(null); }}>ยกเลิก</button><button type="button" className="button" disabled={pending} aria-busy={pending} onClick={save}>{pending ? 'กำลังบันทึก…' : 'บันทึกการแก้ไข'}</button></div>
    </div> : <>
      <dl className="grid sm:grid-cols-2 gap-x-6 gap-y-1 text-sm">{assessmentAnswerLines(saved).map(line => <div key={line.label} className="flex justify-between gap-3 border-b border-line py-1"><dt className="muted">{line.label}</dt><dd className={line.exception ? 'font-bold text-[#8a5a00]' : ''}>{line.exception && <span className="mr-1 text-xs">ข้อยกเว้น ·</span>}{line.value}</dd></div>)}</dl>
      {saved.reasonCodes.length > 0 && <p className="text-sm"><strong>เหตุผลที่ยอมรับแบบมีเงื่อนไข:</strong> {saved.reasonCodes.map(code => code === 'other' && saved.otherReasonDetail ? `${REASON_LABELS[code]}: ${saved.otherReasonDetail}` : REASON_LABELS[code]).join(' · ')}</p>}
      {saved.note && <p className="text-sm break-words"><strong>หมายเหตุ:</strong> {saved.note}</p>}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="muted text-xs">{revisions.length ? `แก้ไขแล้ว ${revisions.length} ครั้ง · ล่าสุด ${formatDateTime(revisions[revisions.length - 1].changed_at)}` : `ตรวจรับเมื่อ ${formatDateTime(assessment.assessed_at)}`}</p>
        {canRevise && <button type="button" className="button secondary" onClick={() => { setDraft(saved); setEditing(true); }}>แก้ไขผลตรวจรับ</button>}
      </div>
    </>}
  </article>;
}
