'use client';

import { useActionState, useEffect, useId, useRef } from 'react';
import { resetUserPassword, type PasswordResetState } from '@/app/actions/users';
import { PasswordField } from './password-field';
import { SubmitButton } from './submit-button';

const initialState: PasswordResetState = { status: 'idle' };

export function ChangePasswordDialog({ ephisId, displayName }: { ephisId: string; displayName: string }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [state, action] = useActionState(resetUserPassword, initialState);
  // The page renders each person twice (desktop table and phone cards), so ids must be per instance, not per person.
  const idBase = `pw-${useId()}`;

  useEffect(() => {
    if (state.status === 'success') dialogRef.current?.close();
  }, [state]);

  return <>
    <button type="button" className="button secondary text-sm" onClick={() => dialogRef.current?.showModal()}>เปลี่ยนรหัสผ่าน</button>
    {state.status === 'success' && <p className="text-xs mt-1 text-[var(--teal)]" role="status">เปลี่ยนรหัสผ่านแล้ว</p>}
    <dialog ref={dialogRef} className="dialog" aria-labelledby={`${idBase}-title`}>
      <form action={action} className="grid gap-4">
        <div>
          <h2 id={`${idBase}-title`} className="font-extrabold text-lg">เปลี่ยนรหัสผ่าน</h2>
          <p className="muted text-sm mt-1"><span className="font-bold text-[var(--ink)]">{ephisId}</span> · {displayName}</p>
        </div>
        <input type="hidden" name="ephis_id" value={ephisId} />
        {state.status === 'error' && <p className="error text-sm" role="alert">{state.message}</p>}
        <div className="field">
          <label htmlFor={`${idBase}-new`}>รหัสผ่านใหม่ (อย่างน้อย 12 ตัวอักษร)</label>
          <PasswordField id={`${idBase}-new`} name="new_password" autoComplete="new-password" minLength={12} maxLength={128} />
        </div>
        <div className="field">
          <label htmlFor={`${idBase}-confirm`}>ยืนยันรหัสผ่านใหม่</label>
          <PasswordField id={`${idBase}-confirm`} name="confirm_password" autoComplete="new-password" minLength={12} maxLength={128} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <button type="button" className="button secondary" onClick={() => dialogRef.current?.close()}>ยกเลิก</button>
          <SubmitButton label="บันทึกรหัสผ่าน" pendingLabel="กำลังบันทึก…" />
        </div>
      </form>
    </dialog>
  </>;
}
