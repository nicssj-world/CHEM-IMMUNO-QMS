'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Download, RefreshCw } from 'lucide-react';
import { createAnnualEvaluationDraft, finalizeAnnualEvaluation, refreshAnnualEvaluationDraft, saveAnnualEvaluationDraft, type DraftInput } from '@/app/actions/evaluation';
import { formatDateBE, formatDateTimeBE } from '@/lib/format';
import { RESULT_LABELS, criterionLabel, draftInputError, finalizeReadiness, type AnnualRevision, type Signer } from '@/lib/vendor-evaluation';

const number = new Intl.NumberFormat('th-TH', { maximumFractionDigits: 2 });
const pct = (v: number | null | undefined) => (v === null || v === undefined ? 'N/A' : `${number.format(Number(v))}%`);

// Layout and behaviour follow LABCBH-Stock AnnualEvaluationEditor: evidence, four judgment fields, three signers, refresh / save / finalize.
export function AnnualEvaluationEditor({ revision, signers, canManage, policyApproved, vendorId }: { revision: AnnualRevision; signers: Signer[]; canManage: boolean; policyApproved: boolean; vendorId: string }) {
  const router = useRouter();
  const isFinal = revision.status === 'final';
  const frozen = revision.frozen_snapshot;
  const evidence = frozen?.evidence ?? revision.evidence_snapshot;
  const editable = canManage && !isFinal;
  const [draft, setDraft] = useState<DraftInput>({
    summary: revision.judgment_summary ?? '', strengths: revision.strengths ?? '', risksConcerns: revision.risks_concerns ?? '', recommendations: revision.recommendations ?? '',
    evaluatorId: revision.evaluator_id ?? '', reviewerId: revision.reviewer_id ?? '', approverId: revision.approver_id ?? '',
  });
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const set = (key: keyof DraftInput) => (value: string) => setDraft(d => ({ ...d, [key]: value }));

  function run(work: () => Promise<{ ok: boolean; message?: string }>, done: string, after?: () => void) {
    setError(null); setMessage(null);
    startTransition(async () => {
      const result = await work();
      if (!result.ok) { setError(result.message ?? 'ทำรายการไม่สำเร็จ'); return; }
      setMessage(done); after?.(); router.refresh();
    });
  }
  const save = () => { const bad = draftInputError(draft); if (bad) { setError(bad); return; } run(() => saveAnnualEvaluationDraft(revision.id, draft), 'บันทึกฉบับร่างแล้ว'); };
  const refresh = () => run(() => refreshAnnualEvaluationDraft(revision.id), 'รีเฟรชหลักฐานแล้ว · ตรวจตัวเลขอีกครั้งก่อนสิ้นสุดรายงาน');
  const finalize = () => {
    const bad = draftInputError(draft); if (bad) { setError(bad); setConfirming(false); return; }
    setError(null); setMessage(null);
    startTransition(async () => {
      const result = await finalizeAnnualEvaluation(revision.id, draft);
      if (!result.ok) { setError(result.message); setConfirming(false); return; }
      setConfirming(false); setMessage(`สิ้นสุดรายงานแล้ว · เลขที่ ${result.data}`); router.refresh();
    });
  }
  const newRevision = () => run(async () => {
    const created = await createAnnualEvaluationDraft(vendorId, revision.warehouse_id, revision.ci_vendor_annual_evaluations.fiscal_year);
    if (created.ok) router.push(`/vendors/${vendorId}/evaluations/${created.data}`);
    return created;
  }, 'สร้างฉบับร่างใหม่แล้ว');

  const readiness = finalizeReadiness({ ...revision, judgment_summary: draft.summary.trim() || null, strengths: draft.strengths.trim() || null, risks_concerns: draft.risksConcerns.trim() || null, recommendations: draft.recommendations.trim() || null,
    evaluator_id: draft.evaluatorId || null, reviewer_id: draft.reviewerId || null, approver_id: draft.approverId || null }, policyApproved);
  const missingSignature = ([['ผู้ประเมิน', draft.evaluatorId], ['ผู้ทบทวน', draft.reviewerId], ['ผู้อนุมัติ', draft.approverId]] as const).filter(([, id]) => id && signers.find(s => s.id === id && !s.hasSignature)).map(([role]) => role);
  const fy = revision.ci_vendor_annual_evaluations.fiscal_year;

  return <div className="grid gap-6">
    <section className="surface p-5 grid gap-3" aria-labelledby="ae-state">
      <div className="flex flex-wrap items-start justify-between gap-3"><div><p className="eyebrow">ปีงบประมาณ {fy} · ฉบับที่ {revision.revision_number}</p><h2 id="ae-state" className="text-xl font-extrabold">{isFinal ? `สิ้นสุดแล้ว · ${revision.report_number}` : 'ฉบับร่าง'}</h2></div><span className="badge">{isFinal ? 'Final' : 'Draft'}</span></div>
      <p className="muted text-sm">{isFinal ? `ตรึงข้อมูลเมื่อ ${formatDateTimeBE(revision.finalized_at)} · นโยบาย ${revision.ci_vendor_evaluation_policies.version}` : `นโยบายที่ใช้: ${revision.ci_vendor_evaluation_policies.version} · หลักฐานเมื่อ ${formatDateTimeBE(evidence.capturedAt)}`}</p>
      {!isFinal && !policyApproved && <p className="notice" role="status">นโยบาย {revision.ci_vendor_evaluation_policies.version} ยังเป็นข้อเสนอ · บันทึกฉบับร่างได้ แต่ยังสิ้นสุดรายงานและแสดงคะแนนอย่างเป็นทางการไม่ได้จนกว่าผู้ดูแลระบบจะอนุมัตินโยบาย</p>}
      {isFinal && frozen && <div className={`assess-decision ${frozen.result === 'fail' ? 'is-conditional' : ''}`} role="status"><span className="muted text-xs">คะแนนถ่วงน้ำหนัก (เกณฑ์ผ่าน {pct(frozen.policy.passThreshold)})</span><strong className="text-3xl">{number.format(frozen.score)} / 100 · {RESULT_LABELS[frozen.result]}</strong></div>}
      {isFinal && <div className="flex flex-wrap gap-2"><a className="button" href={`/api/vendors/${vendorId}/evaluations/${revision.id}/pdf`} target="_blank" rel="noopener noreferrer"><Download size={16} aria-hidden />ดาวน์โหลดรายงาน PDF</a>{canManage && <button type="button" className="button secondary" disabled={pending} onClick={newRevision}>สร้างฉบับร่างใหม่ (แก้ไขรายงาน)</button>}</div>}
    </section>

    <section className="surface overflow-hidden" aria-labelledby="ae-evidence">
      <div className="px-5 py-4 grid gap-1"><h2 id="ae-evidence" className="font-bold">หลักฐาน · {evidence.warehouse.name}</h2>
        <p className="muted text-sm">ช่วงข้อมูล {formatDateBE(evidence.coverage.startDate)} – {formatDateBE(evidence.coverage.endDate)} · ตรวจรับแล้ว {evidence.coverage.completed} · ค้างประเมิน {evidence.coverage.pending} · ความครอบคลุม {pct(evidence.coverage.percentage)}</p></div>
      <div className="table-wrap"><table className="data-table"><thead><tr><th>เกณฑ์</th><th>หลักฐาน (ตัวตั้ง/ตัวหาร)</th><th>ผล</th>{frozen && <><th>น้ำหนักที่ใช้</th><th>คะแนนถ่วงน้ำหนัก</th></>}</tr></thead>
        <tbody>{frozen
          ? frozen.criteria.map(c => <tr key={c.criterionCode}><th scope="row" className="text-left">{criterionLabel(c.criterionCode, c.label)}</th><td>{c.applicable ? `${c.numerator}/${c.denominator}` : 'N/A'}</td><td><strong>{pct(c.percentage)}</strong></td><td>{pct(c.effectiveWeight)}</td><td>{c.weightedScore === null ? '—' : number.format(c.weightedScore)}</td></tr>)
          : evidence.criteria.map(c => <tr key={c.criterionCode}><th scope="row" className="text-left">{criterionLabel(c.criterionCode)}</th><td>{c.applicable ? `${c.numerator}/${c.denominator}` : 'N/A'}</td><td><strong>{pct(c.percentage)}</strong></td></tr>)}</tbody></table></div>
      <div className="p-5 grid gap-3">
        {evidence.receipts && evidence.receipts.length > 0 && <details><summary className="cursor-pointer min-h-11 flex items-center font-semibold">รายการรับของ ({evidence.receipts.length})</summary><ul className="grid gap-1 text-sm mt-2">{evidence.receipts.map((r, i) => <li key={i} className="flex flex-wrap justify-between gap-2 border-b border-line py-1"><span className="font-mono">{r.eventNumber}</span><span>Invoice {r.invoiceNumber} · {formatDateBE(r.receivedDate)}</span><span className="muted">{r.assessmentState === 'completed' ? 'ตรวจรับแล้ว' : r.assessmentState === 'pending' ? 'ค้างประเมิน' : 'ไม่ต้องประเมิน'}</span></li>)}</ul></details>}
        {evidence.issues && evidence.issues.length > 0 && <details><summary className="cursor-pointer min-h-11 flex items-center font-semibold">ปัญหาผู้ขาย ({evidence.issues.length})</summary><ul className="grid gap-1 text-sm mt-2">{evidence.issues.map(i => <li key={i.id} className="border-b border-line py-1">{i.description} <span className="muted">· {i.status === 'resolved' ? 'แก้ไขแล้ว' : 'รอดำเนินการ'}</span></li>)}</ul></details>}
      </div>
    </section>

    <section className="surface p-5 sm:p-6 grid gap-4" aria-labelledby="ae-judgment"><h2 id="ae-judgment" className="font-bold">ข้อสรุปและข้อเสนอแนะ</h2>
      {editable ? <div className="grid gap-4">
        {([['summary', 'สรุปผลการประเมิน'], ['strengths', 'จุดแข็ง'], ['risksConcerns', 'ความเสี่ยง / ข้อกังวล'], ['recommendations', 'ข้อเสนอแนะ']] as const).map(([key, label]) => <div key={key} className="grid gap-1"><label className="field">{label}<textarea className="input min-h-24" maxLength={4000} value={draft[key]} onChange={e => set(key)(e.target.value)} aria-describedby={`ae-count-${key}`} /></label><small id={`ae-count-${key}`} className="muted text-right">{draft[key].length}/4000</small></div>)}
      </div> : <dl className="grid gap-3 text-sm">{([['สรุปผลการประเมิน', revision.judgment_summary], ['จุดแข็ง', revision.strengths], ['ความเสี่ยง / ข้อกังวล', revision.risks_concerns], ['ข้อเสนอแนะ', revision.recommendations]] as const).map(([label, value]) => <div key={label}><dt className="muted text-xs">{label}</dt><dd className="whitespace-pre-wrap break-words">{value || '—'}</dd></div>)}</dl>}
    </section>

    <section className="surface p-5 sm:p-6 grid gap-4" aria-labelledby="ae-signers"><h2 id="ae-signers" className="font-bold">ผู้ลงนาม</h2>
      {editable ? <div className="grid sm:grid-cols-3 gap-4">{([['evaluatorId', 'ผู้ประเมิน'], ['reviewerId', 'ผู้ทบทวน'], ['approverId', 'ผู้อนุมัติ']] as const).map(([key, label]) => <label key={key} className="field">{label}<select className="input" aria-label={label} value={draft[key]} onChange={e => set(key)(e.target.value)}><option value="">เลือกผู้ลงนาม</option>{signers.map(s => <option key={s.id} value={s.id}>{s.name} · {s.position}{s.hasSignature ? '' : ' (ยังไม่มีลายเซ็น)'}</option>)}</select></label>)}</div>
        : <dl className="grid sm:grid-cols-3 gap-4 text-sm">{([['ผู้ประเมิน', revision.evaluator_name_snapshot, revision.evaluator_position_snapshot], ['ผู้ทบทวน', revision.reviewer_name_snapshot, revision.reviewer_position_snapshot], ['ผู้อนุมัติ', revision.approver_name_snapshot, revision.approver_position_snapshot]] as const).map(([role, name, position]) => <div key={role}><dt className="muted text-xs">{role}</dt><dd className="font-semibold">{name ?? '—'}</dd><dd className="muted">{position}</dd></div>)}</dl>}
      {editable && signers.length < 3 && <p className="notice text-sm">มีผู้ที่ระบุตำแหน่งแล้ว {signers.length} คน · ผู้ลงนามต้องมีตำแหน่ง (ระบุที่เมนู “บัญชีของฉัน” หรือแอดมินระบุที่หน้าผู้ใช้) และมีลายเซ็นก่อนสิ้นสุดรายงาน</p>}
      {editable && missingSignature.length > 0 && <p className="notice text-sm" role="status">ยังไม่มีลายเซ็น: {missingSignature.join(', ')} · ให้เจ้าตัวเซ็นที่เมนู “บัญชีของฉัน” ก่อนสิ้นสุดรายงาน</p>}
    </section>

    {editable && <section className="surface p-5 grid gap-3" aria-label="ดำเนินการ">
      {readiness.length > 0 && <ul className="text-sm grid gap-1 list-disc pl-5" aria-label="สิ่งที่ยังต้องทำก่อนสิ้นสุดรายงาน">{readiness.map(r => <li key={r}>{r}</li>)}</ul>}
      {message && <p className="notice" role="status">{message}</p>}{error && <p className="error" role="alert">{error}</p>}
      {confirming ? <div className="grid gap-3" role="group" aria-label="ยืนยันสิ้นสุดรายงาน"><strong>ยืนยันสิ้นสุดรายงานประเมินผู้ขาย</strong><p className="muted text-sm">ระบบจะบันทึกข้อความ ตรึงตัวเลขหลักฐาน คำนวณคะแนนตามนโยบาย {revision.ci_vendor_evaluation_policies.version} คัดลอกลายเซ็นผู้ลงนามทั้ง 3 คน และออกเลขที่รายงาน หลังจากนี้แก้ไขฉบับนี้ไม่ได้ (แก้ได้โดยสร้างฉบับร่างใหม่)</p>
        <div className="flex flex-wrap justify-end gap-2"><button type="button" className="button secondary" disabled={pending} onClick={() => setConfirming(false)}>ยกเลิก</button><button type="button" className="button" disabled={pending} aria-busy={pending} onClick={finalize}>{pending ? 'กำลังสิ้นสุดรายงาน…' : 'ยืนยันสิ้นสุดรายงาน'}</button></div></div>
        : <div className="flex flex-wrap gap-2"><button type="button" className="button secondary" disabled={pending} onClick={refresh}><RefreshCw size={16} aria-hidden />รีเฟรชหลักฐาน</button><button type="button" className="button secondary" disabled={pending} aria-busy={pending} onClick={save}>บันทึกฉบับร่าง</button><button type="button" className="button" disabled={pending || readiness.length > 0} onClick={() => setConfirming(true)}>สิ้นสุดรายงาน…</button></div>}
    </section>}
    {!editable && (message || error) && <section className="grid gap-2">{message && <p className="notice" role="status">{message}</p>}{error && <p className="error" role="alert">{error}</p>}</section>}
  </div>;
}
