'use client';

import { useState, useTransition, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { completeEnvironmentExcursion } from '@/app/actions/environment';
import { excursionCompletionView, type EnvironmentExcursion } from '@/lib/environment';

// One user, one form, one Save: the excursion becomes resolved immediately. No separate Admin/Supervisor
// approval or closure step - this is a lightweight Environment Excursion record, not CAPA.
export function EnvironmentExcursionActions({ id, status, canWork, existingAction, latestOut }: {
  id: string; status: EnvironmentExcursion['status']; canWork: boolean; existingAction: string | null; latestOut: boolean;
}) {
  const router = useRouter();
  const view = excursionCompletionView(status, canWork);
  const legacy = view === 'legacy-complete';
  const [action, setAction] = useState('');
  const [resolution, setResolution] = useState('');
  const [referred, setReferred] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  if (view === 'hidden') return null;

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    startTransition(async () => {
      const result = await completeEnvironmentExcursion(id, legacy ? '' : action, resolution, referred);
      setMessage(result.message);
      if (result.ok) router.refresh();
    });
  }

  return <form onSubmit={save} className="surface p-5 grid gap-3">
    {message && <p role="status" className="notice">{message}</p>}
    <h2 className="font-bold">เหตุการณ์นอกช่วง</h2>
    {latestOut && <p className="error" role="alert">ค่าล่าสุดยังอยู่นอกช่วงที่กำหนด กรุณาตรวจสอบก่อนบันทึกการแก้ไข</p>}
    {legacy
      ? <div className="field"><span>การดำเนินการแก้ไข</span><p className="input" style={{ background: 'var(--surface-2)' }}>{existingAction ?? '—'}</p></div>
      : <label className="field">การดำเนินการแก้ไข *<textarea className="input" required rows={3} value={action} onChange={event => setAction(event.target.value)} /></label>}
    <label className="field">ผลหลังดำเนินการ *<textarea className="input" required rows={3} value={resolution} onChange={event => setResolution(event.target.value)} /></label>
    <label className="flex items-center gap-2"><input type="checkbox" checked={referred} onChange={event => setReferred(event.target.checked)} />ส่งต่อเรื่องเครื่องมือไป Portal</label>
    <button disabled={pending} className="button justify-self-start">บันทึกการแก้ไข</button>
  </form>;
}
