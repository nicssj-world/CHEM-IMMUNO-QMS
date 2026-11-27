'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { setUserPosition } from '@/app/actions/signature';

/** Inline editor for a person's position title (printed under their name on evaluation reports). */
export function PositionCell({ userId, name, position }: { userId: string; name: string; position: string | null }) {
  const router = useRouter();
  const [value, setValue] = useState(position ?? '');
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const dirty = value.trim() !== (position ?? '');
  return <div className="grid gap-1 min-w-48">
    <div className="flex gap-1"><input className="input !min-h-10 text-sm" aria-label={`ตำแหน่งของ ${name}`} value={value} maxLength={200} onChange={e => setValue(e.target.value)} placeholder="ยังไม่ระบุ" />
      <button type="button" className="button secondary !min-h-10 px-3 text-sm" disabled={!dirty || pending} aria-busy={pending} onClick={() => { setError(null); startTransition(async () => { const r = await setUserPosition(userId, value); if (!r.ok) setError(r.message); else router.refresh(); }); }}>บันทึก</button></div>
    {error && <p className="text-xs text-[#a3263a]" role="alert">{error}</p>}
  </div>;
}
