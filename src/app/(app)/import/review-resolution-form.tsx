'use client';

import { useState } from 'react';
import { resolveImportReview } from '@/app/actions/import';
import { SubmitButton } from '@/components/submit-button';

type ReagentOption = { ref: string; name: string };

export function ReviewResolutionForm({
  itemId, kind, warehouseCode, reagentOptions,
}: {
  itemId: string;
  kind: string;
  warehouseCode: 'CHE' | 'IMM';
  reagentOptions: ReagentOption[];
}) {
  const [mode, setMode] = useState(kind === 'used_with' ? 'unlinked' : 'source');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<ReagentOption[]>([]);
  const matches = reagentOptions.filter((option) =>
    !selected.some((picked) => picked.ref === option.ref) &&
    `${option.ref} ${option.name}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
  ).slice(0, 6);

  return <form action={resolveImportReview} className="mt-4 grid gap-3 border-t border-[var(--line)] pt-4">
    <input type="hidden" name="itemId" value={itemId} />
    <input type="hidden" name="mode" value={mode} />
    {kind === 'used_with' ? <>
      <label className="field">ผลการตรวจสอบ
        <select className="input" value={mode} onChange={(event) => setMode(event.target.value)}>
          <option value="unlinked">ยืนยันว่าไม่ผูกความสัมพันธ์</option>
          <option value="product">ผูกกับน้ำยาที่ตรวจสอบแล้ว</option>
          <option value="platform">ผูกกับเครื่อง/กลุ่มเครื่องที่ตรวจสอบแล้ว</option>
        </select>
      </label>
      {mode === 'product' && <div className="grid gap-2">
        <label className="field">ค้นหาน้ำยาปลายทาง (REF หรือชื่อ)
          <input className="input" type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="พิมพ์ REF หรือชื่อน้ำยา" />
        </label>
        {query && <div className="grid gap-1 rounded-xl border border-[var(--line)] p-2" role="listbox" aria-label="น้ำยาที่ตรงกับคำค้น">
          {matches.map((option) => <button key={option.ref} type="button" className="min-h-11 rounded-lg px-3 py-2 text-left hover:bg-[#eef6f7]" onClick={() => { setSelected([...selected, option]); setQuery(''); }}>
            <strong>{option.ref}</strong> · {option.name}
          </button>)}
          {matches.length === 0 && <p className="muted px-3 py-2 text-sm">ไม่พบ REF ที่ตรงกัน</p>}
        </div>}
        <input type="hidden" name="targetRefs" value={selected.map((option) => option.ref).join(',')} />
        {selected.length > 0 && <div className="flex flex-wrap gap-2" aria-label="น้ำยาที่เลือก">
          {selected.map((option) => <button key={option.ref} type="button" className="badge min-h-11" title="กดเพื่อนำออก" onClick={() => setSelected(selected.filter((picked) => picked.ref !== option.ref))}>
            {option.ref} ×
          </button>)}
        </div>}
      </div>}
      {mode === 'platform' && <label className="field">เครื่อง / กลุ่มเครื่อง
        <select className="input" name="platformKey" required defaultValue="">
          <option value="" disabled>เลือกจากข้อมูลที่ยืนยันแล้ว</option>
          {warehouseCode === 'CHE' ? <>
          <option value="c503_c703_ise">c503 / c703 / ISE (กลุ่มตามต้นทาง)</option>
            <option value="c503">c503</option>
            <option value="c513">c513</option>
            <option value="ise_neo">ISE neo</option>
            <option value="ISE">ISE</option>
            <option value="c703">c703</option>
          </> : <option value="e801">e801</option>}
        </select>
      </label>}
    </> : <p className="notice text-sm">รับรองค่าตามต้นทางหลังตรวจเอกสารและบันทึกเหตุผลไว้ หากยังยืนยันไม่ได้ ให้คงรายการนี้เปิดอยู่</p>}
    <label className="field">หลักฐาน / เหตุผลการตัดสิน
      <textarea className="input min-h-24" name="note" minLength={3} maxLength={2000} required placeholder="ระบุผลตรวจและหลักฐานประกอบ" />
    </label>
    <SubmitButton className="button w-full sm:w-fit" label="บันทึกผลตรวจ" pendingLabel="กำลังบันทึก…"/>
  </form>;
}
