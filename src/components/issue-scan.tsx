'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { BarcodeScanner } from './barcode-scanner';
import { resolveProductScan } from '@/app/actions/scanner';
import { userMessage } from '@/lib/messages';
import { scanBatchFields } from '@/lib/barcode';

/** Scanning only picks the Product (and LOT); the quantity and confirmation still happen in the issue form. */
export function IssueScan() {
  const router = useRouter();
  const [message, setMessage] = useState('');
  const [failed, setFailed] = useState(false);
  const [locationPath, setLocationPath] = useState<string | null>(null);

  async function onScan(raw: string, symbology: string) {
    setFailed(false);
    setLocationPath(null);
    setMessage('กำลังตรวจ Barcode…');
    try {
      const result = await resolveProductScan(raw, symbology);
      if (result.locationQr) { setFailed(true); setLocationPath(result.locationQr.path); setMessage(result.message ?? ''); return; }
      if (!result.product) {
        setFailed(true);
        setMessage(result.message ?? 'ไม่พบน้ำยาที่ตรงกับ Barcode · เลือกน้ำยาเอง');
        return;
      }
      // A Barcode with parse warnings can carry a wrong LOT, so only trust it when clean.
      const lot = scanBatchFields(result.parsed).lot;
      const query = new URLSearchParams({ product: result.product.id });
      if (lot) query.set('lot', lot);
      setMessage(`พบ ${result.product.code}${lot ? ` · LOT ${lot}` : ' · Barcode ไม่มี LOT ให้เลือก LOT เอง'}`);
      router.push(`/issue?${query}`);
    } catch (error) {
      setFailed(true);
      setMessage(userMessage(error instanceof Error ? error.message : null, 'อ่าน Barcode ไม่สำเร็จ'));
    }
  }

  return <section className="surface p-5 sm:p-7 grid gap-3"><div><h2 className="font-bold text-lg">สแกนน้ำยาที่จะเบิก</h2><p className="muted text-sm">สแกนแล้วระบบเลือกน้ำยาและ LOT ให้ · การสแกนยังไม่ตัด Stock</p></div>
    <BarcodeScanner onScan={onScan}/>
    {message && <p role={failed ? 'alert' : 'status'} className={failed ? 'error' : 'notice'}>{message}</p>}
    {locationPath && <Link className="button secondary" href={locationPath}>เปิดตำแหน่งนี้</Link>}
  </section>;
}
