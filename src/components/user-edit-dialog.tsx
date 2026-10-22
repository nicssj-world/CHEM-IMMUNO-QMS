'use client';

import { useId, useRef } from 'react';
import { Pencil } from 'lucide-react';
import { provisionUser } from '@/app/actions/users';
import { isGenericUserName } from '@/lib/user-display-name';
import { SubmitButton } from '@/components/submit-button';

type Props = {
  ephisId: string;
  displayName: string;
  role: string;
  active: boolean;
};

/** Edits an existing person, never their Ephis ID or password.
 * The server action enforces two-warehouse Admin authorization and updates both ledgers.
 */
export function UserEditDialog({ ephisId, displayName, role, active }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const headingId = useId();
  const genericName = isGenericUserName(displayName);
  return <>
    <button ref={triggerRef} type="button" className="button secondary min-h-11 inline-flex items-center gap-2"
      aria-label={`แก้ไขข้อมูล ${displayName} Ephis ID ${ephisId}`}
      onClick={() => dialogRef.current?.showModal()}>
      <Pencil size={16} aria-hidden="true"/>แก้ไขข้อมูล
    </button>
    <dialog ref={dialogRef} aria-labelledby={headingId}
      onClose={() => triggerRef.current?.focus()}
      className="w-[min(94vw,520px)] max-w-none max-h-[calc(100dvh-32px)] overflow-y-auto rounded-2xl border border-line bg-white p-0 text-[var(--ink)] shadow-2xl backdrop:bg-slate-950/60">
      <div className="p-5 sm:p-6 grid gap-4">
        <header className="flex gap-3 justify-between items-start">
          <div className="min-w-0">
            <h2 id={headingId} className="text-xl font-extrabold">แก้ไขข้อมูลผู้ใช้</h2>
            <p className="muted text-sm mt-1">Ephis ID: <strong>{ephisId}</strong> · ไม่สามารถเปลี่ยนรหัสบัญชีได้</p>
          </div>
          <button type="button" className="button secondary !min-h-10 px-3" onClick={() => dialogRef.current?.close()} aria-label="ปิดหน้าต่างแก้ไขข้อมูล">✕</button>
        </header>
        {genericName && <p className="notice text-sm" role="note">
          บัญชีนี้ยังใช้ชื่อทั่วไปแทนชื่อบุคคล กรุณาระบุชื่อและนามสกุลของเจ้าของบัญชีที่ถูกต้อง
          ประวัติที่เคยใช้บัญชีร่วมกันจะไม่สามารถยืนยันผู้ปฏิบัติรายบุคคลย้อนหลังได้
        </p>}
        <form action={provisionUser} className="grid gap-4">
          <input type="hidden" name="ephis_id" value={ephisId}/>
          <label className="field">ชื่อ–นามสกุลที่แสดง <span className="text-red-700" aria-hidden="true">*</span>
            <input className="input" name="display_name" defaultValue={displayName} maxLength={120} autoComplete="off" required/>
          </label>
          <label className="field">สิทธิ์ใช้งานในระบบ
            <select className="input" name="role" defaultValue={role}>
              <option value="viewer">ดูอย่างเดียว (Viewer)</option>
              <option value="staff">เจ้าหน้าที่ (Staff)</option>
              <option value="supervisor">หัวหน้างาน (Supervisor)</option>
              <option value="admin">ผู้ดูแลระบบ (Admin)</option>
            </select>
          </label>
          <label className="flex gap-3 items-center text-sm font-medium min-h-11">
            <input type="checkbox" name="active" defaultChecked={active}/>
            เปิดใช้งานบัญชีและสิทธิ์
          </label>
          <p className="muted text-xs">
            การเปลี่ยนชื่อไม่เปลี่ยนรหัสผ่านหรือ Ephis ID และไม่เปลี่ยนบทบาทถ้าไม่ได้เลือกใหม่
            ตำแหน่งงานแก้ไขจากช่อง “ตำแหน่ง” ในหน้าผู้ใช้
          </p>
          <div className="grid grid-cols-2 gap-3">
            <button type="button" className="button secondary w-full" onClick={() => dialogRef.current?.close()}>ยกเลิก</button>
            <SubmitButton className="button w-full" label="บันทึกการแก้ไข" pendingLabel="กำลังบันทึก…"/>
          </div>
        </form>
      </div>
    </dialog>
  </>;
}
