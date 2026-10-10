'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { BarcodeScanner, type ScanFeedback } from '@/components/barcode-scanner';
import { resolveEnvironmentToken } from '@/app/actions/environment';
import { parseEnvironmentQr } from '@/lib/environment';

export function EnvironmentQrScanner() {
  const router = useRouter();
  const [feedback, setFeedback] = useState<ScanFeedback | null>(null);
  const [detail, setDetail] = useState<string | null>(null);
  async function onScan(raw: string) {
    setDetail(null);
    const token = parseEnvironmentQr(raw);
    if (!token) { setFeedback({ id: Date.now(), tone: 'error', title: 'QR นี้ไม่ใช่ QR ตำแหน่งจัดเก็บ' }); return; }
    const result = await resolveEnvironmentToken(token);
    if (result.ok) { router.push(result.path); return; }
    setFeedback({ id: Date.now(), tone: 'warn', title: result.message });
    setDetail(result.path ?? null);
  }
  return <div className="grid gap-3"><BarcodeScanner onScan={onScan} formats={['QR_CODE']} autoStart feedback={feedback}/>
    {detail && <Link href={detail} className="button secondary justify-self-start">ดูรายละเอียดตำแหน่ง</Link>}
  </div>;
}
