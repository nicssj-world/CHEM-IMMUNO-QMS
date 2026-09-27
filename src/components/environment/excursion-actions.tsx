'use client';

import { useState, useTransition, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { acknowledgeEnvironmentExcursion, resolveEnvironmentExcursion } from '@/app/actions/environment';

export function EnvironmentExcursionActions({ id, status, canWork, canResolve, latestOut }: { id: string; status: string; canWork: boolean; canResolve: boolean; latestOut: boolean }) {
  const router = useRouter();
  const [action, setAction] = useState('');
  const [resolution, setResolution] = useState('');
  const [referred, setReferred] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  function ack(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); startTransition(async () => { const result = await acknowledgeEnvironmentExcursion(id, action); setMessage(result.message); if (result.ok) router.refresh(); });
  }
  function resolve(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); startTransition(async () => { const result = await resolveEnvironmentExcursion(id, resolution, referred); setMessage(result.message); if (result.ok) router.refresh(); });
  }
  return <div className="grid gap-4">{message && <p role="status" className="notice">{message}</p>}
    {status === 'open' && canWork && <form onSubmit={ack} className="surface p-5 grid gap-3"><h2 className="font-bold">รับทราบเหตุการณ์</h2><label className="field">การดำเนินการเบื้องต้น<textarea className="input" required rows={3} value={action} onChange={event => setAction(event.target.value)}/></label><button disabled={pending} className="button justify-self-start">รับทราบ</button></form>}
    {status !== 'resolved' && canResolve && <form onSubmit={resolve} className="surface p-5 grid gap-3"><h2 className="font-bold">ปิดเหตุการณ์</h2>{latestOut && <p className="error" role="alert">ค่าล่าสุดยังอยู่นอกช่วง · ตรวจสถานการณ์จริงก่อนปิดเหตุการณ์</p>}<label className="field">สรุปการแก้ไข<textarea className="input" required rows={3} value={resolution} onChange={event => setResolution(event.target.value)}/></label><label className="flex items-center gap-2"><input type="checkbox" checked={referred} onChange={event => setReferred(event.target.checked)}/>ส่งต่อให้ตรวจสอบเครื่องมือใน Portal แล้ว</label><button disabled={pending} className="button justify-self-start">ปิดเหตุการณ์</button></form>}
  </div>;
}
