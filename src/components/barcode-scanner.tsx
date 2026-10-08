'use client';

import { useEffect, useRef, useState } from 'react';
import type { IScannerControls } from '@zxing/browser';
import { AlertTriangle, CheckCircle2, ImagePlus, Maximize2, Minimize2, X, XCircle } from 'lucide-react';
import { playScanTone, primeScanTone } from '@/lib/scan-tone';

/** A new `id` shows the result again, even when the text is the same as the last scan. */
export type ScanFeedback = { id: number; tone: 'ok' | 'warn' | 'error'; title: string; detail?: string };

const toneStyle = { ok: 'bg-emerald-700 text-white', warn: 'bg-amber-400 text-[#3b2a00]', error: 'bg-rose-700 text-white' } as const;
const toneIcon = { ok: CheckCircle2, warn: AlertTriangle, error: XCircle } as const;

function FeedbackCard({ feedback, className = '' }: { feedback: ScanFeedback; className?: string }) {
  const Icon = toneIcon[feedback.tone];
  return <div aria-hidden className={`flex items-start gap-2 rounded-lg px-3 py-2 shadow-lg ${toneStyle[feedback.tone]} ${className}`}>
    <Icon size={20} className="mt-0.5 shrink-0" />
    <div className="min-w-0"><p className="font-bold text-sm leading-snug break-words">{feedback.title}</p>{feedback.detail && <p className="text-xs leading-snug opacity-90 break-words">{feedback.detail}</p>}</div>
  </div>;
}

/**
 * The continuous prop keeps the camera open across scans; a code held in view counts once, and counts again only after it left the frame.
 * With `dock`, the camera strip, the latest result and `summary` stay pinned to the top while the list below scrolls.
 */
export function BarcodeScanner({ onScan, continuous = false, dock = false, feedback, summary, formats, autoStart = false }: { onScan: (raw: string, symbology: string) => Promise<void> | void; continuous?: boolean; dock?: boolean; feedback?: ScanFeedback | null; summary?: React.ReactNode; formats?: Array<'QR_CODE' | 'DATA_MATRIX' | 'CODE_128'>; autoStart?: boolean }) {
  const isQr = formats?.length === 1 && formats[0] === 'QR_CODE';
  const codeLabel = isQr ? 'QR' : 'Barcode';
  const video = useRef<HTMLVideoElement>(null);
  const controls = useRef<IScannerControls | null>(null);
  const last = useRef<{ raw: string; at: number } | null>(null);
  const manualInput = useRef<HTMLInputElement>(null);
  const photoInput = useRef<HTMLInputElement>(null);
  const photoBusyRef = useRef(false);
  const [active, setActive] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [photoBusy, setPhotoBusy] = useState(false);
  const [manual, setManual] = useState('');
  const [status, setStatus] = useState(`กล้องยังไม่เปิด · พิมพ์หรือวาง ${codeLabel} ได้`);

  useEffect(() => () => controls.current?.stop(), []);
  useEffect(() => { if (feedback) playScanTone(feedback.tone === 'ok'); }, [feedback]);

  function stop() {
    controls.current?.stop();
    controls.current = null;
    setActive(false);
  }

  async function accept(raw: string, symbology: string, fromCamera = false) {
    if (!raw.trim()) return;
    const now = Date.now();
    const previous = last.current;
    if (continuous) {
      // Every frame that still shows the same code refreshes the timestamp, so only a code that left the view can count again.
      if (fromCamera && previous?.raw === raw && now - previous.at < 1500) { previous.at = now; return; }
      last.current = { raw, at: now };
      navigator.vibrate?.(60);
      setStatus('อ่านแล้ว · สแกนชิ้นถัดไปได้เลย');
      await onScan(raw, symbology);
      return;
    }
    if (previous?.raw === raw && now - previous.at < 2500) { setStatus('สแกนซ้ำเร็วเกินไป · ตรวจรายการก่อนสแกนอีกครั้ง'); return; }
    last.current = { raw, at: now };
    stop();
    setStatus(isQr ? 'อ่าน QR แล้ว · กำลังเปิดตำแหน่ง' : 'อ่าน Barcode แล้ว · ตรวจ Product, LOT และวันหมดอายุก่อนบันทึก');
    await onScan(raw, symbology);
  }

  async function decodePhoto(file?: File) {
    if (!file || photoBusyRef.current) return;
    if (!file.type.startsWith('image/')) {
      setStatus('กรุณาเลือกรูปภาพ Data Matrix เท่านั้น');
      return;
    }
    photoBusyRef.current = true;
    setPhotoBusy(true);
    setStatus('กำลังอ่าน Data Matrix จากภาพบนอุปกรณ์…');
    // This function works entirely inside the browser: no file bytes are uploaded.
    const objectUrl = URL.createObjectURL(file);
    try {
      const [{ BrowserMultiFormatReader }, { BarcodeFormat, DecodeHintType }] = await Promise.all([
        import('@zxing/browser'),
        import('@zxing/library'),
      ]);
      const hints = new Map<import('@zxing/library').DecodeHintType, boolean | import('@zxing/library').BarcodeFormat[]>();
      hints.set(DecodeHintType.POSSIBLE_FORMATS, formats
        ? formats.map(format => BarcodeFormat[format])
        : [BarcodeFormat.DATA_MATRIX, BarcodeFormat.CODE_128]);
      hints.set(DecodeHintType.TRY_HARDER, true);
      const reader = new BrowserMultiFormatReader(hints);
      const image = new window.Image();
      image.src = objectUrl;
      await new Promise<void>((resolve, reject) => {
        if (image.complete && image.naturalWidth > 0) { resolve(); return; }
        image.onload = () => resolve();
        image.onerror = () => reject(new Error('IMAGE_LOAD_FAILED'));
      });
      // First use the full-resolution still image. A centered crop is a fallback
      // for photos with a relatively small symbol and distracting background.
      let result: Awaited<ReturnType<typeof reader.decodeFromImageElement>> | undefined;
      try {
        result = await reader.decodeFromImageElement(image);
      } catch {
        const canvas = document.createElement('canvas');
        const side = Math.min(image.naturalWidth, image.naturalHeight);
        const crop = side * 0.7;
        const size = Math.min(1600, Math.ceil(crop));
        canvas.width = size;
        canvas.height = size;
        const context = canvas.getContext('2d');
        if (!context) throw new Error('CANVAS_UNAVAILABLE');
        context.drawImage(image, (image.naturalWidth - crop) / 2, (image.naturalHeight - crop) / 2, crop, crop, 0, 0, size, size);
        const croppedImage = new window.Image();
        croppedImage.src = canvas.toDataURL('image/png');
        await new Promise<void>((resolve, reject) => {
          croppedImage.onload = () => resolve();
          croppedImage.onerror = () => reject(new Error('CROP_LOAD_FAILED'));
        });
        result = await reader.decodeFromImageElement(croppedImage);
        croppedImage.removeAttribute('src');
        canvas.width = 0;
        canvas.height = 0;
      }
      if (!result) throw new Error('DECODE_EMPTY');
      setStatus('อ่าน Data Matrix จากภาพสำเร็จ · ไม่ได้อัปโหลดรูป');
      await accept(result.getText(), BarcodeFormat[result.getBarcodeFormat()] ?? 'image');
    } catch {
      setStatus('อ่าน Data Matrix จากภาพไม่สำเร็จ · ถ่ายให้คมชัด อยู่ห่างพอให้โฟกัสได้ และวางรหัสใกล้กลางภาพ');
    } finally {
      URL.revokeObjectURL(objectUrl);
      photoBusyRef.current = false;
      setPhotoBusy(false);
      if (photoInput.current) photoInput.current.value = '';
    }
  }

  async function start() {
    if (!window.isSecureContext) { setStatus('กล้องต้องใช้ HTTPS; ใช้ช่องพิมพ์แทน'); return; }
    primeScanTone();
    setStatus('กำลังเปิดกล้องหลัง…');
    setActive(true);
    try {
      const [{ BrowserMultiFormatReader }, { BarcodeFormat, DecodeHintType }] = await Promise.all([import('@zxing/browser'), import('@zxing/library')]);
      const hints = new Map<import('@zxing/library').DecodeHintType, boolean | import('@zxing/library').BarcodeFormat[]>();
      hints.set(DecodeHintType.POSSIBLE_FORMATS, formats ? formats.map(format => BarcodeFormat[format]) : [BarcodeFormat.DATA_MATRIX, BarcodeFormat.CODE_128]);
      hints.set(DecodeHintType.TRY_HARDER, true);
      const reader = new BrowserMultiFormatReader(hints);
      controls.current = await reader.decodeFromConstraints({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } } }, video.current!, (result) => {
        if (result) void accept(result.getText(), BarcodeFormat[result.getBarcodeFormat()] ?? 'camera', true);
      });
      setStatus(continuous ? `เล็ง ${codeLabel} ทีละชิ้น · กล้องเปิดค้างไว้ต่อเนื่อง` : `เล็ง ${codeLabel} ให้อยู่ในกรอบ`);
    } catch {
      setActive(false);
      setStatus('เปิดกล้องไม่สำเร็จ · ตรวจสิทธิ์กล้องหรือใช้ช่องพิมพ์');
    }
  }

  useEffect(() => {
    if (!autoStart) return;
    const timer = window.setTimeout(() => void start(), 0);
    return () => window.clearTimeout(timer);
    // Scanner starts once per page instance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoStart]);

  const iconButton = 'grid place-items-center size-11 rounded-full bg-black/55 text-white backdrop-blur-sm';
  // Sticky is bounded by its parent box; `contents` lets the dock stay pinned across the list that follows the scanner.
  return <section className={dock ? 'contents' : 'grid gap-3'} aria-label={`สแกน ${codeLabel}`}>
    <div className={`grid gap-2 ${dock && active ? 'scan-dock' : ''}`}>
      {!active && <div className="flex flex-wrap gap-2"><button type="button" className="button min-h-12" onClick={() => void start()}>{continuous ? 'เปิดกล้องสแกนต่อเนื่อง' : isQr ? 'สแกน QR / เปิดกล้อง' : 'สแกนอีกครั้ง / เปิดกล้อง'}</button></div>}
      {!isQr && <div className="flex flex-wrap gap-2">
        <input ref={photoInput} className="sr-only" type="file" accept="image/*" aria-label="เลือกภาพ Data Matrix จากกล้องหรือคลังรูป" onChange={event => void decodePhoto(event.currentTarget.files?.[0])} />
        <button type="button" className="button secondary min-h-12" disabled={photoBusy} onClick={() => photoInput.current?.click()}>
          <ImagePlus size={18} aria-hidden /> {photoBusy ? 'กำลังถอดรหัส…' : 'ถ่ายภาพ / เลือกรูป Data Matrix'}
        </button>
        <p className="muted text-xs basis-full">เลือกถ่ายภาพด้วยกล้องหรือใช้รูปในเครื่อง · ถอดรหัสบนอุปกรณ์ ไม่อัปโหลดภาพ · วาง Data Matrix ใกล้กึ่งกลางภาพ</p>
      </div>}
      <div className={`relative w-full max-w-lg overflow-hidden rounded-xl bg-slate-900 ${active ? '' : 'hidden'}`}>
        <video ref={video} muted playsInline className={`block w-full object-cover ${expanded ? 'h-[min(70dvh,600px)]' : 'h-[clamp(260px,42dvh,360px)]'}`} aria-label={`ภาพจากกล้องเพื่อสแกน ${codeLabel}`}/>
        <div aria-hidden className="pointer-events-none absolute inset-0 m-auto aspect-square h-[62%] rounded-xl border-2 border-white/85 shadow-[0_0_0_9999px_rgba(0,0,0,.28)]" />
        {feedback ? <FeedbackCard key={feedback.id} feedback={feedback} className="scan-toast absolute inset-x-2 top-2" /> : <p aria-hidden className="absolute left-3 top-2 rounded-full bg-black/55 px-2.5 py-1 text-xs text-white">เล็ง {codeLabel} ในกรอบ</p>}
        <div className="absolute bottom-2 right-2 flex gap-2">
          <button type="button" className={iconButton} onClick={() => setExpanded(value => !value)} aria-label={expanded ? 'ย่อกล้อง' : 'ขยายกล้อง'} aria-pressed={expanded}>{expanded ? <Minimize2 size={18} aria-hidden /> : <Maximize2 size={18} aria-hidden />}</button>
          <button type="button" className={iconButton} onClick={stop} aria-label="หยุดกล้อง"><X size={20} aria-hidden /></button>
        </div>
      </div>
      {!active && feedback && <FeedbackCard feedback={feedback} />}
      {summary}
    </div>
    <p className="sr-only" aria-live="polite">{feedback ? `${feedback.title}${feedback.detail ? ` · ${feedback.detail}` : ''}` : ''}</p>
    <p className="muted text-sm" role="status">{status}</p>
    {!isQr && <p className="muted text-xs">รองรับ GS1 Data Matrix และ Code 128 · ใช้กล้องอ่านข้อมูล LOT/Expiry อัตโนมัติ</p>}
    <form className="flex flex-wrap gap-2" onSubmit={event => { event.preventDefault(); void accept(manual, 'manual'); setManual(''); manualInput.current?.focus(); }}><label className="field flex-1 min-w-48">พิมพ์หรือวาง {codeLabel}<input ref={manualInput} className="input" value={manual} onChange={event => setManual(event.target.value)} autoCapitalize="off" autoComplete="off"/></label><button className="button secondary self-end" type="submit">ตรวจ {codeLabel}</button></form>
  </section>;
}
