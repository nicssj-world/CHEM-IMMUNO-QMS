'use client';

import { useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowLeft, RotateCcw } from 'lucide-react';

/** Shown instead of an empty 0/0 list: retry reads the SAME round again and never creates one. */
export function CountLoadError({ message }: { message: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return <main className="grid gap-4 max-w-[640px]">
    <section className="surface p-5 sm:p-6 grid gap-3" role="alert">
      <h1 className="text-xl font-bold">โหลดรายการตรวจนับไม่สำเร็จ</h1>
      <p className="text-sm">{message}</p>
      <p className="muted text-sm">ผลตรวจที่บันทึกไว้ยังอยู่ครบ · ระบบยังไม่ให้จบรอบหรือปรับยอดจนกว่าจะโหลดรายการได้ครบ</p>
      <div className="flex flex-wrap gap-2">
        <button type="button" className="button min-h-12" disabled={pending} aria-busy={pending} onClick={() => start(() => router.refresh())}>
          {pending ? <><span className="spinner" aria-hidden /><span role="status">กำลังโหลด…</span></> : <><RotateCcw size={17} aria-hidden /> ลองใหม่</>}
        </button>
        <Link href="/counts" className="button secondary min-h-12"><ArrowLeft size={17} aria-hidden /> กลับไปหน้ารอบตรวจนับ</Link>
      </div>
    </section>
  </main>;
}
