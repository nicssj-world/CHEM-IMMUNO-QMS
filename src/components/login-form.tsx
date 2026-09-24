'use client';

import { signIn } from '@/app/actions/auth';
import { PasswordField } from './password-field';
import { SubmitButton } from './submit-button';

export function LoginForm() {
  return <form action={signIn} className="grid gap-5" autoComplete="on">
    <label className="field">Ephis ID<input className="input" name="ephisId" autoComplete="username" required /></label>
    <div className="field">
      <label htmlFor="password">รหัสผ่าน</label>
      <PasswordField id="password" name="password" autoComplete="current-password" />
    </div>
    <SubmitButton label="เข้าสู่ระบบ" pendingLabel="กำลังเข้าสู่ระบบ…" />
  </form>;
}
