'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { FileSpreadsheet } from 'lucide-react';
import { importSupplierExcelDraft } from '@/app/actions/receiving-excel-import';

export function ReceiveExcelImport({ vendorId }: { vendorId: string }) {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState('');
  const [busy, startTransition] = useTransition();

  function importFile() {
    if (!vendorId) { setError('กรุณาเลือกผู้ขายด้านบนก่อน'); return; }
    if (!file) { setError('กรุณาเลือกไฟล์ Excel ของผู้ขาย'); return; }
    setError('');
    startTransition(async () => {
      try {
        const result = await importSupplierExcelDraft(vendorId, file);
        if (!result.ok) { setError(result.message); return; }
        router.replace('/receive?draft=' + encodeURIComponent(result.id));
        router.refresh();
      } catch {
        setError('Import ไม่สำเร็จ กรุณาตรวจสอบไฟล์และลองใหม่');
      }
    });
  }

  return <section className="rounded-xl border border-line bg-surface-2 p-4 grid gap-3"
    aria-label="นำเข้า Excel จากผู้ขาย">
    <div className="flex items-start gap-3">
      <FileSpreadsheet size={24} className="shrink-0 text-[#087d78]" aria-hidden />
      <div className="grid gap-1">
        <h3 className="font-bold">รับเข้าจาก Excel ผู้ขาย · ไม่ต้องสแกน</h3>
        <p className="muted text-sm">
          เลือกผู้ขายด้านบนเพียงครั้งเดียว แล้วอัปโหลดไฟล์ Bill (.xlsx)
          ระบบจะอ่าน Invoice, จับคู่สินค้า, สร้าง LOT แยก และเปิด Draft สำหรับ Checklist
        </p>
      </div>
    </div>
    <label className="field min-w-0">
      <span>ไฟล์ Bill ของผู้ขาย</span>
      <input type="file" className="input min-w-0" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        onChange={event => { setFile(event.target.files?.[0] ?? null); setError(''); }}
        disabled={busy} />
    </label>
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p className="muted text-xs">รองรับสินค้าเดียวกันหลาย LOT · จับคู่จาก RDTH Code และ Material No. · Draft ยังไม่เพิ่ม Stock</p>
      <button className="button min-h-11" type="button" disabled={busy || !file || !vendorId}
        onClick={importFile}>{busy ? 'กำลังอ่านและสร้าง Draft…' : 'Import และสร้าง Draft'}</button>
    </div>
    {error && <p role="alert" className="error text-sm">{error}</p>}
  </section>;
}
