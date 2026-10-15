'use client';

import { useState } from 'react';

function EyeIcon({ off }: { off: boolean }) {
  return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z" />
    <circle cx="12" cy="12" r="3" />
    {off && <path d="M4 4l16 16" />}
  </svg>;
}

type PasswordFieldProps = {
  id: string;
  name: string;
  autoComplete: 'current-password' | 'new-password';
  minLength?: number;
  maxLength?: number;
};

export function PasswordField({ id, name, autoComplete, minLength, maxLength }: PasswordFieldProps) {
  const [visible, setVisible] = useState(false);
  return <div className="password-wrap">
    <input id={id} className="input" name={name} type={visible ? 'text' : 'password'} autoComplete={autoComplete} minLength={minLength} maxLength={maxLength} required />
    <button type="button" className="password-toggle" onClick={() => setVisible(v => !v)} aria-pressed={visible} aria-label={visible ? 'ซ่อนรหัสผ่าน' : 'แสดงรหัสผ่าน'}>
      <EyeIcon off={visible} />
    </button>
  </div>;
}
