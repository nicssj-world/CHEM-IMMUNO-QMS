'use client';

import { useState, useTransition, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { createVendorRecord, updateVendorRecord } from '@/app/actions/vendors';
import { vendorInputError, type VendorInput } from '@/lib/vendors';

// Fields and copy follow LABCBH-Stock components/vendors/VendorForm.tsx.
export function VendorForm({ mode, initial, vendorId, updatedAt, returnTo }: { mode: 'create' | 'edit'; initial: VendorInput; vendorId?: string; updatedAt?: string; returnTo?: string | null }) {
  const router = useRouter();
  const [value, setValue] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const set = (field: keyof VendorInput) => (event: { target: { value: string } }) => setValue(current => ({ ...current, [field]: event.target.value }));

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const problem = vendorInputError(value);
    if (problem) { setError(problem); return; }
    startTransition(async () => {
      const result = mode === 'create' ? await createVendorRecord(value) : await updateVendorRecord(vendorId!, value, updatedAt!);
      if (!result.ok) { setError(result.message); return; }
      const done = mode === 'create' ? `เพิ่มผู้ขาย ${value.name.trim()}` : 'บันทึกการแก้ไขแล้ว';
      const target = returnTo ?? `/vendors/${result.id}`;
      router.push(`${target}${target.includes('?') ? '&' : '?'}saved=${encodeURIComponent(done)}&at=${Date.now().toString(36)}`);
      router.refresh();
    });
  }

  const req = <span className="text-[#a3263a]" aria-hidden> *</span>;
  return <form className="surface p-5 sm:p-7 grid gap-5" onSubmit={submit} noValidate>
    <div className="grid sm:grid-cols-2 gap-4">
      <label className="field"><span>รหัสผู้ขาย{req}</span><input className="input font-mono" value={value.vendorCode} onChange={set('vendorCode')} maxLength={80} required aria-required autoCapitalize="characters" autoCorrect="off" spellCheck={false} /></label>
      <label className="field sm:col-span-2"><span>ชื่อผู้ขาย{req}</span><input className="input" value={value.name} onChange={set('name')} maxLength={200} required aria-required autoComplete="organization" /><small className="muted font-normal">ใช้ชื่อตามที่ปรากฏบนใบเสนอราคา/Invoice รวมคำนำหน้านิติบุคคล เช่น “บริษัท … จำกัด”</small></label>
      <label className="field sm:col-span-2">ชื่อตามหนังสือรับรอง (ถ้าต่างจากชื่อข้างบน)<input className="input" value={value.legalName} onChange={set('legalName')} maxLength={300} /></label>
      <label className="field">เลขประจำตัวผู้เสียภาษี<input className="input font-mono" inputMode="numeric" placeholder="13 หลัก" value={value.taxId} onChange={e => setValue(c => ({ ...c, taxId: e.target.value.replace(/\D/g, '').slice(0, 13) }))} /></label>
      <label className="field"><span>รหัสสาขา</span><input className="input font-mono" inputMode="numeric" placeholder="00000" value={value.taxBranchCode} onChange={e => setValue(c => ({ ...c, taxBranchCode: e.target.value.replace(/\D/g, '').slice(0, 5) }))} /><small className="muted font-normal">สำนักงานใหญ่คือ 00000</small></label>
      <label className="field sm:col-span-2">ที่อยู่<textarea className="input min-h-20" rows={3} value={value.address} onChange={set('address')} maxLength={1000} /></label>
      <label className="field">ผู้ติดต่อ<input className="input" value={value.contactPerson} onChange={set('contactPerson')} maxLength={200} /></label>
      <label className="field">โทรศัพท์<input className="input" inputMode="tel" value={value.phone} onChange={set('phone')} maxLength={60} /></label>
      <label className="field sm:col-span-2">อีเมล<input className="input" type="email" value={value.email} onChange={set('email')} maxLength={200} autoCapitalize="off" /></label>
      <label className="field sm:col-span-2">หมายเหตุ<textarea className="input min-h-20" rows={3} value={value.note} onChange={set('note')} maxLength={2000} /></label>
    </div>
    {error && <p className="error" role="alert">{error}</p>}
    <div className="flex flex-wrap justify-end gap-2">
      <button type="button" className="button secondary" disabled={pending} onClick={() => (returnTo ? router.push(returnTo) : router.back())}>ยกเลิก</button>
      <button type="submit" className="button" disabled={pending} aria-busy={pending}>{pending ? <><span className="spinner" aria-hidden />กำลังบันทึก…</> : mode === 'create' ? 'เพิ่มผู้ขาย' : 'บันทึกการแก้ไข'}</button>
    </div>
  </form>;
}
