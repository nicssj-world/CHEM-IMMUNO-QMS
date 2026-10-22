'use client';

import { LockKeyhole, UserRound } from 'lucide-react';
import { signIn } from '@/app/actions/auth';
import { PasswordField } from './password-field';
import { SubmitButton } from './submit-button';
import styles from '@/app/login/login.module.css';

export function LoginForm({ next = '' }: { next?: string }) {
  return (
    <form action={signIn} className={styles.loginForm} autoComplete="on">
      <input type="hidden" name="next" value={next} />
      <div className={styles.formField}>
        <label htmlFor="ephisId"><span aria-hidden="true" className={styles.required}>*</span>Ephis ID</label>
        <div className={styles.inputShell}>
          <UserRound size={22} strokeWidth={1.8} className={styles.leadingIcon} aria-hidden="true" />
          <input
            id="ephisId"
            className={styles.loginInput}
            name="ephisId"
            type="text"
            inputMode="numeric"
            autoComplete="username"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            required
          />
        </div>
      </div>
      <div className={styles.formField}>
        <label htmlFor="password"><span aria-hidden="true" className={styles.required}>*</span>รหัสผ่าน</label>
        <div className={styles.passwordShell}>
          <LockKeyhole size={21} strokeWidth={1.8} className={styles.leadingIcon} aria-hidden="true" />
          <PasswordField id="password" name="password" autoComplete="current-password" />
        </div>
      </div>
      <SubmitButton label="เข้าสู่ระบบ" pendingLabel="กำลังเข้าสู่ระบบ…" className={styles.loginButton} />
    </form>
  );
}
