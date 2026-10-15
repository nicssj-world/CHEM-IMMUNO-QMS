'use client';

import { useActionState } from 'react';
import { changeOwnPassword, type ChangePasswordState } from '@/app/actions/auth';
import { PasswordField } from './password-field';
import { SubmitButton } from './submit-button';

const initialState: ChangePasswordState = { status: 'idle' };

export function ChangeOwnPasswordForm() {
  const [state, action] = useActionState(changeOwnPassword, initialState);
  return <form action={action} className="grid gap-5">
    {state.status === 'error' && <p className="error text-sm" role="alert">{state.message}</p>}
    {state.status === 'success' && <p className="notice text-sm" role="status">เปลี่ยนรหัสผ่านเรียบร้อยแล้ว</p>}
    <div className="field">
      <label htmlFor="current_password">รหัสผ่านปัจจุบัน</label>
      <PasswordField id="current_password" name="current_password" autoComplete="current-password" />
    </div>
    <div className="field">
      <label htmlFor="new_password">รหัสผ่านใหม่ (อย่างน้อย 12 ตัวอักษร)</label>
      <PasswordField id="new_password" name="new_password" autoComplete="new-password" minLength={12} maxLength={128} />
    </div>
    <div className="field">
      <label htmlFor="confirm_password">ยืนยันรหัสผ่านใหม่</label>
      <PasswordField id="confirm_password" name="confirm_password" autoComplete="new-password" minLength={12} maxLength={128} />
    </div>
    <SubmitButton label="บันทึกรหัสผ่านใหม่" pendingLabel="กำลังบันทึก…" />
  </form>;
}
