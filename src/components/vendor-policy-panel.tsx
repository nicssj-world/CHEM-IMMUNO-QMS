'use client';

import { useMemo, useState, useTransition, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Lock } from 'lucide-react';
import { approveEvaluationPolicy, saveEvaluationPolicyProposal } from '@/app/actions/evaluation';
import { formatDateBE, formatDateTimeBE } from '@/lib/format';
import { POLICY_STATUS_LABELS, VENDOR_EVALUATION_CRITERIA, VENDOR_EVALUATION_CRITERION_LABELS, criterionLabel, policyProposalError, type EvaluationPolicy } from '@/lib/vendor-evaluation';

const number = new Intl.NumberFormat('th-TH', { maximumFractionDigits: 2 });
const percent = (value: number | null) => (value === null ? 'ยังไม่กำหนด' : `${number.format(value)}%`);
const effectiveYears = (p: EvaluationPolicy) => `${p.effectiveFromFiscalYear} – ${p.effectiveToFiscalYear ?? 'ไม่กำหนดปีสิ้นสุด'}`;

// Layout and copy follow LABCBH-Stock VendorEvaluationPolicyPanel: a proposal is a form (admin only), everything else is a record.
export function VendorPolicyPanel({ policies, canManage }: { policies: EvaluationPolicy[]; canManage: boolean }) {
  const [creating, setCreating] = useState(false);
  const proposal = policies.find(p => p.status === 'proposed');
  const policy = proposal ?? policies[0];
  if (!policy) return <p className="error" role="alert">ไม่พบนโยบายเริ่มต้น กรุณาตรวจว่า migration ล่าสุดถูกนำไปใช้แล้ว</p>;
  const others = policies.filter(p => p.id !== policy.id);
  // A new QP version starts from the newest approved policy: same weights, the year after it ends, no version name yet.
  const latest = policies.filter(p => p.status === 'approved').sort((a, b) => b.effectiveFromFiscalYear - a.effectiveFromFiscalYear)[0] ?? policy;
  const template: EvaluationPolicy = { ...latest, id: '', version: '', status: 'proposed', effectiveFromFiscalYear: (latest.effectiveToFiscalYear ?? latest.effectiveFromFiscalYear) + 1, effectiveToFiscalYear: null, note: '', approvedAt: null, approvedByName: null };
  return <div className="grid gap-6">
    {canManage && proposal ? <PolicyProposalForm key={proposal.id} policy={proposal} onApproved={() => setCreating(false)} />
      : canManage && creating ? <PolicyProposalForm key="new" policy={template} onCancel={() => setCreating(false)} onApproved={() => setCreating(false)} />
      : <><PolicySummary policy={policy} />{canManage && <div><button type="button" className="button secondary" onClick={() => setCreating(true)}>สร้างข้อเสนอนโยบายเวอร์ชันใหม่</button><p className="muted text-xs mt-2">เมื่ออนุมัติ นโยบายเวอร์ชันใหม่จะใช้ตั้งแต่ปีงบประมาณที่ระบุ และนโยบายที่ใช้อยู่จะสิ้นสุดที่ปีก่อนหน้า · รายงานที่สิ้นสุดแล้วยังอ้างนโยบายเดิม</p></div>}</>}
    {others.length > 0 && <section className="surface overflow-hidden" aria-labelledby="policy-versions"><div className="px-5 py-4"><h2 id="policy-versions" className="font-bold">เวอร์ชันอื่น</h2></div>
      <div className="table-wrap"><table className="data-table"><thead><tr><th>เวอร์ชัน</th><th>สถานะ</th><th>ปีงบประมาณที่ใช้</th><th>เกณฑ์ผ่าน</th><th>อนุมัติเมื่อ</th></tr></thead>
        <tbody>{others.map(o => <tr key={o.id}><td className="font-mono">{o.version}</td><td><span className="badge">{POLICY_STATUS_LABELS[o.status]}</span></td><td>{effectiveYears(o)}</td><td>{percent(o.passThreshold)}</td><td>{formatDateTimeBE(o.approvedAt)}</td></tr>)}</tbody></table></div></section>}
  </div>;
}

function PolicySummary({ policy }: { policy: EvaluationPolicy }) {
  const criteria = [...policy.criteria].sort((a, b) => a.displayOrder - b.displayOrder);
  const total = criteria.reduce((sum, c) => sum + (c.weight ?? 0), 0);
  return <>
    <section className="surface p-5 sm:p-6 grid gap-4" aria-labelledby="policy-summary">
      <div className="flex flex-wrap items-start justify-between gap-3"><div><p className="eyebrow">Policy version</p><h2 id="policy-summary" className="text-xl font-extrabold font-mono">{policy.version}</h2></div><span className="badge">{POLICY_STATUS_LABELS[policy.status]}</span></div>
      <p className={policy.status === 'proposed' ? 'notice' : 'notice flex items-start gap-2'} role="status">
        {policy.status === 'approved' && <><Lock size={16} aria-hidden className="mt-1 shrink-0" /><span>อนุมัติโดย <strong>{policy.approvedByName ?? 'ไม่ทราบผู้อนุมัติ'}</strong>{policy.approvedAt && <> เมื่อ {formatDateTimeBE(policy.approvedAt)}</>} · ใช้คำนวณคะแนนรายงานประจำปี และแก้ไขไม่ได้</span></>}
        {policy.status === 'retired' && <><Lock size={16} aria-hidden className="mt-1 shrink-0" /><span>เลิกใช้แล้ว ไม่ใช้กับรายงานใหม่ · เดิมอนุมัติโดย <strong>{policy.approvedByName ?? 'ไม่ทราบผู้อนุมัติ'}</strong></span></>}
        {policy.status === 'proposed' && 'ข้อเสนอนี้ยังไม่ได้รับอนุมัติ จึงยังใช้คำนวณคะแนนหรือผลผ่านไม่ได้ ผู้ดูแลระบบของทั้งสองคลังเป็นผู้แก้ไขและอนุมัติ'}
      </p>
      <dl className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div><dt className="muted text-xs">เกณฑ์ผ่าน</dt><dd className="text-xl font-bold">{percent(policy.passThreshold)}</dd><small className="muted">คะแนนถ่วงน้ำหนักขั้นต่ำ</small></div>
        <div><dt className="muted text-xs">ความครอบคลุมขั้นต่ำ</dt><dd className="text-xl font-bold">{percent(policy.minimumCoveragePercent)}</dd><small className="muted">ของรายการรับของที่ต้องประเมิน</small></div>
        <div><dt className="muted text-xs">ปีงบประมาณที่ใช้ (พ.ศ.)</dt><dd className="text-xl font-bold">{effectiveYears(policy)}</dd></div>
        <div><dt className="muted text-xs">เริ่มช่วงข้อมูล</dt><dd className="text-xl font-bold">{formatDateBE(policy.coverageStartDate)}</dd></div>
      </dl>
    </section>
    <section className="surface overflow-hidden" aria-labelledby="policy-criteria">
      <div className="px-5 py-4 flex justify-between gap-3"><h2 id="policy-criteria" className="font-bold">น้ำหนักเกณฑ์</h2><span className="muted text-sm">{criteria.length} เกณฑ์ · รวม {number.format(total)}%</span></div>
      <div className="table-wrap"><table className="data-table"><thead><tr><th>ลำดับ</th><th>เกณฑ์</th><th>น้ำหนัก</th><th><span className="sr-only">สัดส่วน</span></th></tr></thead>
        <tbody>{criteria.map((c, i) => <tr key={c.criterionCode}><td>{i + 1}</td><th scope="row" className="text-left">{criterionLabel(c.criterionCode, c.label)}</th><td><strong>{c.weight === null ? '—' : `${number.format(c.weight)}%`}</strong></td><td className="w-40">{c.weight !== null && <progress className="w-full" max={100} value={c.weight} aria-hidden />}</td></tr>)}</tbody>
        <tfoot><tr><td /><th scope="row" className="text-left">รวม</th><td><strong>{number.format(total)}%</strong></td><td /></tr></tfoot></table></div>
    </section>
    <section className="surface p-5 grid gap-3" aria-labelledby="policy-definitions"><h2 id="policy-definitions" className="font-bold">นิยามเกณฑ์</h2>
      <div className="grid gap-3">{criteria.map(c => <details key={c.criterionCode} className="rounded-lg border border-line p-3"><summary className="cursor-pointer min-h-11 flex items-center font-semibold">{criterionLabel(c.criterionCode, c.label)}</summary>
        <dl className="grid gap-2 text-sm mt-2"><div><dt className="muted text-xs">หลักฐานที่ใช้</dt><dd>{c.evidenceDefinition}</dd></div><div><dt className="muted text-xs">วิธีคำนวณ</dt><dd>{c.calculationDefinition}</dd></div><div><dt className="muted text-xs">กรณีไม่นำมาคิด (N/A)</dt><dd>{c.naDefinition}</dd></div></dl></details>)}</div></section>
    {policy.note?.trim() && <section className="surface p-5 grid gap-2"><h2 className="font-bold">{policy.status === 'proposed' ? 'หมายเหตุข้อเสนอ' : 'บันทึกตอนเสนอ'}</h2><blockquote className="muted rounded-lg bg-[#f4f8fa] px-3 py-2 whitespace-pre-wrap">{policy.note}</blockquote></section>}
  </>;
}

function PolicyProposalForm({ policy, onCancel, onApproved }: { policy: EvaluationPolicy; onCancel?: () => void; onApproved: () => void }) {
  const router = useRouter();
  const [version, setVersion] = useState(policy.version);
  const [from, setFrom] = useState(String(policy.effectiveFromFiscalYear));
  const [to, setTo] = useState(policy.effectiveToFiscalYear ? String(policy.effectiveToFiscalYear) : '');
  const [threshold, setThreshold] = useState(policy.passThreshold === null ? '' : String(policy.passThreshold));
  const [coverage, setCoverage] = useState(policy.minimumCoveragePercent === null ? '' : String(policy.minimumCoveragePercent));
  const [start, setStart] = useState(policy.coverageStartDate);
  const [note, setNote] = useState(policy.note ?? '');
  const [weights, setWeights] = useState<Record<string, string>>(() => Object.fromEntries(VENDOR_EVALUATION_CRITERIA.map(code => [code, policy.criteria.find(c => c.criterionCode === code)?.weight?.toString() ?? ''])));
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const total = useMemo(() => VENDOR_EVALUATION_CRITERIA.reduce((sum, code) => sum + (Number(weights[code]) || 0), 0), [weights]);
  const totalOk = Math.abs(total - 100) < 0.001;
  const payload = () => ({
    policyId: policy.id || null, version, effectiveFromFiscalYear: from === '' ? Number.NaN : Number(from), effectiveToFiscalYear: to ? Number(to) : null,
    passThreshold: threshold === '' ? Number.NaN : Number(threshold), minimumCoveragePercent: coverage === '' ? Number.NaN : Number(coverage), coverageStartDate: start, note,
    criteria: VENDOR_EVALUATION_CRITERIA.map(criterionCode => ({ criterionCode, weight: weights[criterionCode] === '' ? Number.NaN : Number(weights[criterionCode]) })),
  });

  function save(event: FormEvent) {
    event.preventDefault(); setError(null); setMessage(null);
    const invalid = policyProposalError(payload());
    if (invalid) { setError(invalid); return; }
    startTransition(async () => {
      const result = await saveEvaluationPolicyProposal(payload());
      if (!result.ok) { setError(result.message); return; }
      setMessage('บันทึกข้อเสนอนโยบายแล้ว'); router.refresh();
    });
  }
  function approve() {
    setError(null); setMessage(null);
    const invalid = policyProposalError(payload());
    if (invalid) { setError(invalid); setConfirming(false); return; }
    startTransition(async () => {
      const saved = await saveEvaluationPolicyProposal(payload());
      if (!saved.ok) { setError(saved.message); return; }
      const approved = await approveEvaluationPolicy(saved.data);
      if (!approved.ok) { setError(approved.message); return; }
      setConfirming(false); onApproved(); router.refresh();
    });
  }

  return <form className="grid gap-6" onSubmit={save}>
    <p className="notice" role="status"><strong>ข้อเสนอ (รออนุมัติ)</strong> — ค่าน้ำหนักและเกณฑ์ผ่านยังไม่ใช่นโยบายอย่างเป็นทางการ และยังใช้สร้างคะแนนไม่ได้</p>
    <section className="surface p-5 sm:p-6 grid gap-4" aria-labelledby="policy-details"><div className="flex justify-between gap-3"><h2 id="policy-details" className="font-bold">ข้อมูลนโยบาย</h2><span className="badge">{POLICY_STATUS_LABELS.proposed}</span></div>
      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
        <label className="field">เวอร์ชัน<input className="input font-mono" value={version} onChange={e => setVersion(e.target.value)} /></label>
        <label className="field">ปีงบประมาณที่เริ่มใช้ (พ.ศ.)<input className="input" type="number" inputMode="numeric" value={from} onChange={e => setFrom(e.target.value)} /></label>
        <label className="field">ปีสิ้นสุด (ไม่บังคับ)<input className="input" type="number" inputMode="numeric" value={to} onChange={e => setTo(e.target.value)} /></label>
        <label className="field">เกณฑ์ผ่าน (%)<input className="input" type="number" inputMode="decimal" min="0" max="100" step="0.01" value={threshold} onChange={e => setThreshold(e.target.value)} placeholder="ยังไม่กำหนด" /></label>
        <label className="field">ความครอบคลุมขั้นต่ำ (%)<input className="input" type="number" inputMode="decimal" min="0" max="100" step="0.01" value={coverage} onChange={e => setCoverage(e.target.value)} placeholder="ยังไม่กำหนด" /></label>
        <label className="field">เริ่มช่วงข้อมูล<input className="input" type="date" value={start} onChange={e => setStart(e.target.value)} /></label>
        <label className="field sm:col-span-2 lg:col-span-3">หมายเหตุข้อเสนอ<textarea className="input min-h-20" value={note} onChange={e => setNote(e.target.value)} /><small className="muted font-normal">บันทึกนี้จะเก็บไว้เป็นประวัติของข้อเสนอหลังอนุมัติ</small></label>
      </div></section>
    <section className="surface p-5 sm:p-6 grid gap-4" aria-labelledby="policy-weights"><div className="flex flex-wrap justify-between gap-3"><h2 id="policy-weights" className="font-bold">น้ำหนักเกณฑ์</h2><strong className={totalOk ? 'text-[#2f855a]' : 'text-[#a3263a]'} aria-live="polite">รวม {total.toFixed(2)}%{totalOk ? '' : ' · ต้องเท่ากับ 100%'}</strong></div>
      <div className="grid sm:grid-cols-2 gap-3">{VENDOR_EVALUATION_CRITERIA.map((code, index) => <label key={code} className="flex items-center justify-between gap-3 rounded-lg border border-line p-3"><span><span className="muted text-xs mr-2">{index + 1}</span>{VENDOR_EVALUATION_CRITERION_LABELS[code]}</span>
        <span className="flex items-center gap-1"><input className="input !w-24 text-right" type="number" inputMode="decimal" min="0.01" max="100" step="0.01" value={weights[code]} onChange={e => setWeights(w => ({ ...w, [code]: e.target.value }))} placeholder="—" aria-label={`น้ำหนัก ${VENDOR_EVALUATION_CRITERION_LABELS[code]}`} /><span aria-hidden>%</span></span></label>)}</div></section>
    {error && <p className="error" role="alert">{error}</p>}{message && <p className="notice" role="status">{message}</p>}
    {confirming ? <div className="surface p-5 grid gap-3" role="group" aria-label="ยืนยันอนุมัตินโยบาย"><strong>ยืนยันอนุมัตินโยบาย {version}</strong><p className="muted text-sm">หลังอนุมัติ เวอร์ชัน น้ำหนัก เกณฑ์ผ่าน และความครอบคลุมขั้นต่ำจะแก้ไขไม่ได้ และจะใช้คำนวณคะแนนรายงานประจำปีที่อ้างนโยบายนี้ · หากมีนโยบายอื่นที่อนุมัติแล้วและใช้ต่อเนื่องอยู่ ระบบจะให้นโยบายนั้นสิ้นสุดที่ปีก่อนปีเริ่มใช้ของเวอร์ชันนี้</p>
      <div className="flex flex-wrap justify-end gap-2"><button type="button" className="button secondary" onClick={() => setConfirming(false)} disabled={pending}>ยกเลิก</button><button type="button" className="button" onClick={approve} disabled={pending || !totalOk} aria-busy={pending}>{pending ? 'กำลังอนุมัติ…' : 'ยืนยันบันทึกและอนุมัติ'}</button></div></div>
      : <div className="flex flex-wrap gap-2"><button type="submit" className="button secondary" disabled={pending}>{pending ? 'กำลังบันทึก…' : 'บันทึกข้อเสนอ'}</button><button type="button" className="button" onClick={() => setConfirming(true)} disabled={pending || !totalOk}>บันทึกและอนุมัติ…</button>{onCancel && <button type="button" className="button secondary" onClick={onCancel} disabled={pending}>ยกเลิก</button>}</div>}
  </form>;
}
