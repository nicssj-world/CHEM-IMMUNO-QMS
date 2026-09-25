'use client';

import { ASSESSMENT_REASON_CODES, REASON_LABELS, deriveAcceptanceDecision, suggestedReasonCodes, type AssessmentInput, type ReasonCode } from '@/lib/receipt-assessment';

function Choice({ name, label, value, options, onChange }: { name: string; label: string; value: string; options: ReadonlyArray<readonly [string, string, boolean]>; onChange: (value: string) => void }) {
  return <div className="assess-question" role="radiogroup" aria-label={label}>
    <span>{label}</span>
    <div>{options.map(([option, text, isProblem]) => <label key={option} className={value === option ? (isProblem ? 'is-selected is-problem' : 'is-selected') : ''}>
      <input type="radio" name={`assess-${name}`} value={option} checked={value === option} onChange={() => onChange(option)} /><span>{text}</span>
    </label>)}</div>
  </div>;
}

/** Controlled by the parent so it can validate before submit; the whole answer is posted as one JSON field. */
export function ReceiptAssessmentFields({ value, onChange }: { value: AssessmentInput; onChange: (next: AssessmentInput) => void }) {
  const decision = deriveAcceptanceDecision(value);
  const conditional = decision === 'accepted_with_justification';
  const set = (change: Partial<AssessmentInput>) => {
    const next = { ...value, ...change };
    // Back to all-pass: conditional reasons no longer apply, as in LABCBH.
    onChange(deriveAcceptanceDecision(next) === 'accepted' ? { ...next, reasonCodes: [], otherReasonDetail: '' } : next);
  };
  const setDocumentation = (documentation: AssessmentInput['documentation']) => {
    const withoutAutomatic = value.reasonCodes.filter(code => code !== 'documentation_pending');
    set({ documentation, reasonCodes: documentation === 'incomplete' ? [...withoutAutomatic, ...suggestedReasonCodes({ ...value, documentation })] : withoutAutomatic });
  };
  const toggleReason = (code: ReasonCode) => set({ reasonCodes: value.reasonCodes.includes(code) ? value.reasonCodes.filter(c => c !== code) : [...value.reasonCodes, code] });

  return <div className="grid gap-4">
    <input type="hidden" name="assessment" value={JSON.stringify(value)} />
    <fieldset className="assess-questions"><legend className="font-bold mb-1">ผลการตรวจรับ</legend>
      <Choice name="product" label="สภาพสินค้า" value={value.productCondition} options={[['normal', 'ปกติ', false], ['abnormal', 'ผิดปกติ', true]]} onChange={v => set({ productCondition: v as AssessmentInput['productCondition'] })} />
      <Choice name="docs" label="เอกสารประกอบ" value={value.documentation} options={[['complete', 'ครบถ้วน', false], ['incomplete', 'ไม่ครบถ้วน', true]]} onChange={v => setDocumentation(v as AssessmentInput['documentation'])} />
      <Choice name="items" label="ความถูกต้องของรายการ" value={value.itemCorrectness} options={[['correct', 'ถูกต้อง', false], ['problem', 'พบปัญหา', true]]} onChange={v => set({ itemCorrectness: v as AssessmentInput['itemCorrectness'] })} />
      <Choice name="cold" label="การควบคุมอุณหภูมิ" value={value.coldChainApplicable ? 'yes' : 'no'} options={[['no', 'ไม่เกี่ยวข้อง', false], ['yes', 'เกี่ยวข้อง', false]]} onChange={v => set({ coldChainApplicable: v === 'yes', coldChainCondition: v === 'yes' ? value.coldChainCondition ?? 'appropriate' : null })} />
      {value.coldChainApplicable && <Choice name="cold-ok" label="สภาพอุณหภูมิ" value={value.coldChainCondition ?? ''} options={[['appropriate', 'เหมาะสม', false], ['inappropriate', 'ไม่เหมาะสม', true]]} onChange={v => set({ coldChainCondition: v as AssessmentInput['coldChainCondition'] })} />}
      <Choice name="complaint" label="ข้อร้องเรียน" value={value.hasComplaint ? 'yes' : 'no'} options={[['no', 'ไม่มี', false], ['yes', 'มีข้อร้องเรียน', true]]} onChange={v => set({ hasComplaint: v === 'yes' })} />
    </fieldset>

    {conditional && <fieldset className="assess-reasons"><legend className="font-bold">เหตุผลที่ยอมรับสินค้าแบบมีเงื่อนไข <span className="text-[#8a5a00]">(จำเป็น)</span></legend>
      <p className="muted text-sm">เลือกอย่างน้อย 1 ข้อ ระบบเสนอ “เอกสารอยู่ระหว่างติดตาม” ให้อัตโนมัติเฉพาะเมื่อเอกสารไม่ครบ</p>
      <div className="grid sm:grid-cols-2 gap-2">{ASSESSMENT_REASON_CODES.map(code => <label key={code} className="assess-reason"><input type="checkbox" checked={value.reasonCodes.includes(code)} onChange={() => toggleReason(code)} /><span>{REASON_LABELS[code]}</span></label>)}</div>
      {value.reasonCodes.includes('other') && <label className="field">ระบุเหตุผลอื่น<input className="input" value={value.otherReasonDetail} maxLength={1000} onChange={e => set({ otherReasonDetail: e.target.value })} required /></label>}
    </fieldset>}

    <label className="field"><span>หมายเหตุ {conditional ? <span className="text-[#8a5a00]">(จำเป็น)</span> : <span className="muted font-normal">(ไม่บังคับ)</span>}</span><textarea className="input min-h-20" maxLength={2000} value={value.note} onChange={e => set({ note: e.target.value })} required={conditional} /></label>

    <div className={`assess-decision ${conditional ? 'is-conditional' : ''}`} role="status">
      <span className="muted text-xs">ผลการรับสินค้า (คำนวณจากคำตอบ)</span>
      <strong>{conditional ? 'รับสินค้าแบบมีเงื่อนไข' : 'รับสินค้า'}</strong>
      <small className="muted">ผลนี้ไม่กักกันสินค้าและไม่ย้อนกลับรายการรับเข้าคลัง</small>
    </div>
  </div>;
}
