'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { setVendorActive } from '@/app/actions/vendors';

// As in LABCBH-Stock VendorActiveControl: deactivating asks for a reason, reactivating does not.
export function VendorActiveControl({ vendorId, active }: { vendorId: string; active: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function confirm() {
    setError(null);
    startTransition(async () => {
      const result = await setVendorActive(vendorId, !active, note);
      if (!result.ok) { setError(result.message); return; }
      setOpen(false); setNote('');
      router.refresh();
    });
  }

  if (!open) return <button type="button" className={`button ${active ? 'secondary' : ''}`} onClick={() => setOpen(true)}>{active ? 'ปิดการใช้งาน' : 'เปิดใช้งานอีกครั้ง'}</button>;
  return <div className="surface p-4 grid gap-3 w-full max-w-md" role="group" aria-label={active ? 'ยืนยันปิดการใช้งานผู้ขาย' : 'ยืนยันเปิดใช้งานผู้ขายอีกครั้ง'}>
    <strong>{active ? 'ยืนยันปิดการใช้งานผู้ขาย' : 'ยืนยันเปิดใช้งานผู้ขายอีกครั้ง'}</strong>
    <p className="muted text-sm">{active ? 'ผู้ขายที่ปิดการใช้งานจะไม่ถูกเลือกใน Invoice ใหม่ ประวัติเดิมยังอยู่ครบ' : 'ผู้ขายจะกลับมาเลือกได้ใน Invoice ใหม่'}</p>
    {active && <label className="field"><span>เหตุผลที่ปิดการใช้งาน <span className="text-[#a3263a]" aria-hidden>*</span></span><textarea className="input min-h-20" value={note} onChange={e => setNote(e.target.value)} maxLength={1000} required /></label>}
    {error && <p className="error" role="alert">{error}</p>}
    <div className="flex flex-wrap justify-end gap-2"><button type="button" className="button secondary" disabled={pending} onClick={() => setOpen(false)}>ยกเลิก</button><button type="button" className={`button ${active ? 'danger' : ''}`} disabled={pending} aria-busy={pending} onClick={confirm}>{pending ? 'กำลังบันทึก…' : active ? 'ปิดการใช้งาน' : 'เปิดใช้งาน'}</button></div>
  </div>;
}
