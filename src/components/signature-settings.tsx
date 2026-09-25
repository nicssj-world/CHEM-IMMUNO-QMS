'use client';

import { useEffect, useRef, useState, useTransition, type PointerEvent as ReactPointerEvent } from 'react';
import Image from 'next/image';
import { useRouter } from 'next/navigation';
import { clearMySignature, saveMySignature, setUserPosition } from '@/app/actions/signature';

const WIDTH = 900;
const HEIGHT = 260;

/** Photos are far larger than the request limit allows, so the browser shrinks them first; the server still re-encodes the result. */
async function shrink(file: File) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, (WIDTH * 2) / bitmap.width, (HEIGHT * 2) / bitmap.height);
  const flat = document.createElement('canvas');
  flat.width = Math.max(1, Math.round(bitmap.width * scale)); flat.height = Math.max(1, Math.round(bitmap.height * scale));
  const ctx = flat.getContext('2d');
  if (!ctx) throw new Error('canvas unavailable');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, flat.width, flat.height);
  ctx.drawImage(bitmap, 0, 0, flat.width, flat.height); bitmap.close();
  return flat.toDataURL('image/jpeg', 0.9);
}

/** Position title and signature shown on vendor evaluation reports: draw with a finger or pen, or upload an image. */
export function SignatureSettings({ userId, position, signature }: { userId: string; position: string | null; signature: string | null }) {
  const router = useRouter();
  const canvas = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const [inked, setInked] = useState(false);
  const [title, setTitle] = useState(position ?? '');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    const ctx = canvas.current?.getContext('2d');
    if (!ctx) return;
    ctx.lineWidth = 4; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#0b2540';
  }, []);

  const point = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: (event.clientX - rect.left) * (WIDTH / rect.width), y: (event.clientY - rect.top) * (HEIGHT / rect.height) };
  };
  function start(event: ReactPointerEvent<HTMLCanvasElement>) {
    const ctx = canvas.current?.getContext('2d'); if (!ctx) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drawing.current = true; const p = point(event);
    ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x + 0.1, p.y + 0.1); ctx.stroke(); setInked(true);
  }
  function move(event: ReactPointerEvent<HTMLCanvasElement>) {
    if (!drawing.current) return;
    const ctx = canvas.current?.getContext('2d'); if (!ctx) return;
    const p = point(event); ctx.lineTo(p.x, p.y); ctx.stroke();
  }
  const stop = () => { drawing.current = false; };
  function wipe() { canvas.current?.getContext('2d')?.clearRect(0, 0, WIDTH, HEIGHT); setInked(false); }

  function submit(dataUrl: string) {
    setError(null); setMessage(null);
    startTransition(async () => {
      const result = await saveMySignature(dataUrl);
      if (!result.ok) { setError(result.message); return; }
      wipe(); setMessage('บันทึกลายเซ็นแล้ว'); router.refresh();
    });
  }
  async function upload(file?: File) {
    if (!file) return;
    if (file.size > 15 * 1024 * 1024) { setError('ไฟล์ลายเซ็นต้องมีขนาดไม่เกิน 15 MB'); return; }
    try { submit(await shrink(file)); } catch { setError('อ่านไฟล์ภาพไม่สำเร็จ กรุณาใช้ไฟล์ PNG, JPG หรือ WebP อื่น'); }
  }
  function savePosition() {
    setError(null); setMessage(null);
    startTransition(async () => {
      const result = await setUserPosition(userId, title);
      if (!result.ok) { setError(result.message); return; }
      setMessage('บันทึกตำแหน่งแล้ว'); router.refresh();
    });
  }

  return <div className="grid gap-6">
    <div className="grid gap-3"><div><h3 className="font-bold">ตำแหน่ง</h3><p className="muted text-sm">แสดงใต้ชื่อบนรายงานประเมินผู้ขาย · ต้องมีตำแหน่งจึงถูกเลือกเป็นผู้ลงนามได้</p></div>
      <div className="flex flex-wrap gap-2 items-end"><label className="field flex-1 min-w-56">ตำแหน่ง<input className="input" value={title} maxLength={200} onChange={e => setTitle(e.target.value)} placeholder="เช่น นักเทคนิคการแพทย์ชำนาญการ" /></label><button type="button" className="button" disabled={pending} onClick={savePosition}>บันทึกตำแหน่ง</button></div></div>

    <div className="grid gap-3"><div><h3 className="font-bold">ลายเซ็น</h3><p className="muted text-sm">ใช้พิมพ์ลงรายงานประเมินผู้ขายเมื่อคุณเป็นผู้ประเมิน ผู้ทบทวน หรือผู้อนุมัติ · เก็บเป็นความลับ ระบบนำไปใช้เฉพาะตอนสิ้นสุดรายงาน</p></div>
      <div className="rounded-xl border border-line p-3 grid gap-2"><p className="muted text-xs">ลายเซ็นปัจจุบัน</p>
        {signature ? <div className="grid gap-2 justify-items-start"><Image src={signature} alt="ลายเซ็นปัจจุบันของคุณ" width={450} height={130} unoptimized className="h-auto max-h-24 w-auto rounded bg-white border border-line" /><button type="button" className="button secondary" disabled={pending} onClick={() => { if (window.confirm('ลบลายเซ็นที่บันทึกไว้?')) startTransition(async () => { const r = await clearMySignature(); if (!r.ok) setError(r.message); else { setMessage('ลบลายเซ็นแล้ว'); router.refresh(); } }); }}>ลบลายเซ็น</button></div> : <p className="text-sm">ยังไม่มีลายเซ็น</p>}</div>
      <div className="grid gap-2"><p className="text-sm font-semibold">เซ็นใหม่ด้วยนิ้วหรือปากกา</p>
        <canvas ref={canvas} width={WIDTH} height={HEIGHT} aria-label="พื้นที่เซ็นชื่อ" className="w-full max-w-[560px] rounded-xl border-2 border-dashed border-field-line bg-white touch-none" onPointerDown={start} onPointerMove={move} onPointerUp={stop} onPointerCancel={stop} onPointerLeave={stop} />
        <div className="flex flex-wrap gap-2"><button type="button" className="button secondary" onClick={wipe} disabled={!inked || pending}>ล้าง</button><button type="button" className="button" disabled={!inked || pending} aria-busy={pending} onClick={() => canvas.current && submit(canvas.current.toDataURL('image/png'))}>{pending ? 'กำลังบันทึก…' : 'บันทึกลายเซ็น'}</button></div></div>
      <label className="field">หรืออัปโหลดรูปลายเซ็น (PNG, JPG, WebP)<input className="input" type="file" accept="image/png,image/jpeg,image/webp" onChange={e => { upload(e.target.files?.[0]); e.target.value = ''; }} /></label></div>
    {message && <p className="notice" role="status">{message}</p>}{error && <p className="error" role="alert">{error}</p>}
  </div>;
}
