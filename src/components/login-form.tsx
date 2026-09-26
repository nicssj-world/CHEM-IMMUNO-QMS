'use client';

import { signIn } from '@/app/actions/auth';
import { PasswordField } from './password-field';
import { SubmitButton } from './submit-button';

export function LoginForm({ next = '' }: { next?: string }) {
  return <form action={signIn} className="grid gap-5" autoComplete="on">
    <input type="hidden" name="next" value={next} />
    <label className="field">Ephis ID<input className="input" name="ephisId" autoComplete="username" autoCapitalize="off" autoCorrect="off" spellCheck={false} required /></label>
    <div className="field">
      <label htmlFor="password">รหัสผ่าน</label>
      <PasswordField id="password" name="password" autoComplete="current-password" />
    </div>
    <SubmitButton label="เข้าสู่ระบบ" pendingLabel="กำลังเข้าสู่ระบบ…" />
  </form>;
}
