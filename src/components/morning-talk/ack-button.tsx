'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { CheckCircle2 } from 'lucide-react';
import { acknowledgeMorningTalk } from '@/app/actions/morning-talk';
import { formatDateTime } from '@/lib/format';

/**
 * The attendee's own acknowledgement ("รับทราบ", not a signature). Nobody can press it for someone else: the database function takes
 * only the talk id and always acts as the signed-in user. `sticky` pins it above the bottom bar on phones.
 */
export function AckButton({ talkId, acknowledgedAt, sticky = false }: { talkId: string; acknowledgedAt: string | null; sticky?: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  if (acknowledgedAt) return <p className="flex items-center gap-2 font-semibold text-[#096f70]" role="status"><CheckCircle2 size={20} aria-hidden />รับทราบแล้ว · {formatDateTime(acknowledgedAt)}</p>;
  const press = () => {
    setError(null);
    startTransition(async () => {
      const result = await acknowledgeMorningTalk(talkId);
      if (!result.ok) { setError(result.message); return; }
      router.refresh();
    });
  };
  return <div className={sticky ? 'sticky-action' : ''}>
    <button type="button" className="button w-full min-h-14 text-base" onClick={press} disabled={pending} aria-busy={pending}>
      {pending ? <><span className="spinner" aria-hidden="true" /><span role="status">กำลังบันทึก…</span></> : <><CheckCircle2 size={20} aria-hidden />รับทราบ</>}
    </button>
    {error && <p className="error mt-2" role="alert">{error}</p>}
  </div>;
}
