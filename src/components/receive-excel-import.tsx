'use client';

import { useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { AlertCircle, CheckCircle2, FileSpreadsheet, Plus, Search } from 'lucide-react';
import { importSupplierExcelDraft, type SupplierExcelImportResult } from '@/app/actions/receiving-excel-import';
import { resolveSupplierExistingProduct, createSupplierExcelProduct } from '@/app/actions/supplier-product-resolution';
import type { SupplierProductMatch } from '@/lib/supplier-bill-import';
import type { UnmatchedSupplierProduct } from '@/lib/supplier-identifier';

type WarehouseOption = { id: number; code: string };
const PENDING_KEY = 'chem-immuno-supplier-bill-pending-v1';

export function ReceiveExcelImport({ vendorId, products, supervisedWarehouses }: {
  vendorId: string;
  products: SupplierProductMatch[];
  supervisedWarehouses: WarehouseOption[];
}) {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, startTransition] = useTransition();
  const [issues, setIssues] = useState<UnmatchedSupplierProduct[]>([]);
  const [invoice, setInvoice] = useState('');
  const [matchedRows, setMatchedRows] = useState(0);
  const [totalRows, setTotalRows] = useState(0);
  const [search, setSearch] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<Record<string, string>>({});
  const [creating, setCreating] = useState<string | null>(null);
  const [warehouse, setWarehouse] = useState<Record<string, number>>({});
  const [productType, setProductType] = useState<Record<string, 'reagent' | 'calibrator' | 'control' | 'consumable'>>({});
  const [description, setDescription] = useState<Record<string, string>>({});
  const [packingSize, setPackingSize] = useState<Record<string, string>>({});

  // Keep the pending file in this browser tab across refresh/navigation.
  // No inventory or unapproved product records are created by this local cache.
  useEffect(() => {
    try {
      const stored = sessionStorage.getItem(PENDING_KEY);
      if (!stored) return;
      const saved = JSON.parse(stored) as { vendorId: string; filename: string; content: string };
      if (saved.vendorId !== vendorId || !saved.content || !saved.filename) return;
      const binary = atob(saved.content);
      const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
      setFile(new File([bytes], saved.filename,
        { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
    } catch { /* Storage unavailable; selecting the original file still works. */ }
  }, [vendorId]);

  function cachePending(next: File | null) {
    if (!next) {
      try { sessionStorage.removeItem(PENDING_KEY); } catch { /* unavailable */ }
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const content = String(reader.result).split(',')[1];
        if (content && vendorId) sessionStorage.setItem(PENDING_KEY,
          JSON.stringify({ vendorId, filename: next.name, content }));
      } catch { /* Storage quota: retain file in memory; not a blocking error. */ }
    };
    reader.readAsDataURL(next);
  }

  function handleResult(result: SupplierExcelImportResult) {
    if (result.ok) {
      try { sessionStorage.removeItem(PENDING_KEY); } catch { /* unavailable */ }
      setIssues([]);
      router.replace('/receive?draft=' + encodeURIComponent(result.id));
      router.refresh();
    } else if ('needsResolution' in result && result.needsResolution) {
      setIssues(result.items);
      setInvoice(result.invoiceNumber);
      setMatchedRows(result.matchedRows);
      setTotalRows(result.totalRows);
      setError('');
      if (!notice) setNotice('พบรายการที่ยังจับคู่ไม่ได้ · เลือกสินค้าเดิมหรือเพิ่มใหม่ แล้วตรวจซ้ำได้โดยไม่อัปโหลดไฟล์อีก');
    } else {
      setError(result.message);
    }
  }

  function checkFile() {
    if (!vendorId) { setError('กรุณาเลือกผู้ขายด้านบนก่อน'); return; }
    if (!file) { setError('กรุณาเลือกไฟล์ Excel ของผู้ขาย'); return; }
    setError('');
    setNotice('');
    startTransition(async () => {
      try { handleResult(await importSupplierExcelDraft(vendorId, file)); }
      catch { setError('ตรวจสอบไฟล์ไม่สำเร็จ กรุณาลองใหม่'); }
    });
  }

  function resolveExisting(item: UnmatchedSupplierProduct) {
    const productId = selected[item.key];
    if (!productId) { setError('กรุณาเลือกสินค้าในทะเบียนก่อน'); return; }
    setError('');
    startTransition(async () => {
      try {
        const result = await resolveSupplierExistingProduct({
          productId, rdthCode: item.rdthCode, materialNo: item.materialNo,
        });
        if (!result.ok) { setError(result.message); return; }
        if (result.status === 'requested') {
          setNotice('ส่งรหัสเข้าคิวอนุมัติแล้ว · Supervisor/Admin อนุมัติได้ที่ สแกน > คิวอนุมัติ Barcode');
          return;
        }
        setNotice('ผูกรหัสกับทะเบียนเดิมแล้ว · กำลังตรวจสอบรายการที่เหลือ');
        if (file) handleResult(await importSupplierExcelDraft(vendorId, file));
      } catch { setError('ไม่สามารถบันทึกการจับคู่ได้'); }
    });
  }

  function createNew(item: UnmatchedSupplierProduct) {
    const warehouseId = warehouse[item.key] ?? supervisedWarehouses[0]?.id;
    if (!warehouseId) { setError('บัญชีนี้ไม่มีสิทธิ์เพิ่มสินค้า กรุณาแจ้งหัวหน้างาน'); return; }
    setError('');
    startTransition(async () => {
      try {
        const result = await createSupplierExcelProduct({
          warehouseId, productType: productType[item.key] ?? 'reagent',
          description: description[item.key] ?? item.description,
          packingSize: packingSize[item.key] ?? '',
          rdthCode: item.rdthCode, materialNo: item.materialNo,
        });
        if (!result.ok) { setError(result.message); return; }
        setCreating(null);
        setNotice('เพิ่มสินค้าใหม่แล้ว · กำลังตรวจสอบรายการที่เหลือ');
        if (file) handleResult(await importSupplierExcelDraft(vendorId, file));
        router.refresh();
      } catch { setError('เพิ่มสินค้าไม่สำเร็จ'); }
    });
  }

  return <section className="rounded-xl border border-line bg-surface-2 p-4 grid gap-3"
    aria-label="นำเข้า Excel จากผู้ขาย">
    <div className="flex items-start gap-3">
      <FileSpreadsheet size={24} className="shrink-0 text-[#087d78]" aria-hidden />
      <div className="grid gap-1">
        <h3 className="font-bold">รับเข้าจาก Excel ผู้ขาย · ไม่ต้องสแกน</h3>
        <p className="muted text-sm">
          เลือกผู้ขายด้านบน แล้วอัปโหลดไฟล์ Bill (.xlsx) ระบบจะจับคู่ทะเบียน
          และสร้าง Draft แยกตามสินค้า/LOT เมื่อรายการครบ
        </p>
      </div>
    </div>
    <label className="field min-w-0">
      <span>ไฟล์ Bill ของผู้ขาย</span>
      <input type="file" className="input min-w-0" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        onChange={event => {
          const next = event.target.files?.[0] ?? null;
          setFile(next); cachePending(next);
          setIssues([]); setError(''); setNotice('');
        }}
        disabled={busy} />
      {file && <span className="muted text-xs">ไฟล์ที่เลือก: {file.name} · เก็บไฟล์ค้างในแท็บนี้เพื่อกลับมาตรวจต่อได้</span>}
    </label>
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p className="muted text-xs">รองรับสินค้าเดียวกันหลาย LOT · จับคู่จาก RDTH Code และ Material No. · Draft ยังไม่เพิ่ม Stock</p>
      <button className="button min-h-11" type="button" disabled={busy || !file || !vendorId}
        onClick={checkFile}>{busy ? 'กำลังตรวจสอบ…' : issues.length ? 'ตรวจจับคู่อีกครั้ง' : 'Import และสร้าง Draft'}</button>
    </div>
    {error && <p role="alert" className="error text-sm">{error}</p>}
    {notice && <p role="status" className="notice text-sm">{notice}</p>}
    {issues.length > 0 && <section className="grid gap-3 rounded-xl border border-amber-300 bg-white p-3 sm:p-4"
      aria-label="รายการสินค้าที่ยังจับคู่ไม่ได้">
      <div className="grid gap-1">
        <div className="flex items-center gap-2"><AlertCircle size={19} className="text-amber-700" aria-hidden />
          <h4 className="font-bold">ต้องจับคู่สินค้าอีก {issues.length} รายการ</h4></div>
        <p className="muted text-sm">Invoice {invoice} · จับคู่แล้ว {matchedRows}/{totalRows} แถว
          · เมื่อครบทุกแถว ระบบจะเปิด Draft ให้อัตโนมัติ</p>
      </div>
      {issues.map(item => {
        const q = (search[item.key] ?? '').trim().toLocaleLowerCase();
        const choices = products.filter(p =>
          (p.product_code + ' ' + p.display_name).toLocaleLowerCase().includes(q)).slice(0, 35);
        if (selected[item.key] && !choices.some(p => p.id === selected[item.key])) {
          const picked = products.find(p => p.id === selected[item.key]);
          if (picked) choices.unshift(picked);
        }
        return <article className="grid gap-3 rounded-xl border border-line p-3"
          key={item.key}>
          <div className="grid gap-1">
            <strong className="break-words">{item.description}</strong>
            <span className="muted text-xs">Excel แถว {item.excelRows.join(', ')}
              · REF {item.rdthCode} · Material {item.materialNo}</span>
            {item.reason === 'conflict' && <p className="error text-sm">
              รหัสสองรายการนี้ชี้ไปคนละสินค้า / มีรหัสซ้ำในทะเบียน
              กรุณาตรวจแก้รหัสในทะเบียนก่อน Import (ไม่อนุญาตให้ผูกทับ)</p>}
          </div>
          {item.reason === 'missing' && <>
            <div className="grid gap-2">
              <label className="field"><span><Search size={14} className="inline" aria-hidden /> ค้นหาสินค้าในทะเบียน</span>
                <input className="input" value={search[item.key] ?? ''}
                  placeholder="ค้นจากรหัส CHE/IMM หรือชื่อสินค้า" disabled={busy}
                  onChange={event => setSearch(old => ({ ...old, [item.key]: event.target.value }))} /></label>
              <label className="field"><span>เลือกสินค้าเดิม</span>
                <select className="input" value={selected[item.key] ?? ''} disabled={busy}
                  onChange={event => setSelected(old => ({ ...old, [item.key]: event.target.value }))}>
                  <option value="">— เลือกสินค้าในทะเบียน —</option>
                  {choices.map(p => <option key={p.id} value={p.id}>
                    {p.product_code} · {p.display_name}
                  </option>)}
                </select></label>
              <div className="flex flex-wrap gap-2">
                <button type="button" className="button secondary" disabled={busy || !selected[item.key]}
                  onClick={() => resolveExisting(item)}>
                  <CheckCircle2 size={17} aria-hidden /> จับคู่กับสินค้าเดิม
                </button>
                {supervisedWarehouses.length > 0 && <button className="button secondary" type="button" disabled={busy}
                  onClick={() => setCreating(current => current === item.key ? null : item.key)}>
                  <Plus size={17} aria-hidden /> เพิ่มเป็นสินค้าใหม่
                </button>}
              </div>
              {supervisedWarehouses.length === 0 && <p className="muted text-xs">
                การผูกของเจ้าหน้าที่จะส่งให้หัวหน้างานอนุมัติ · <a href="/scan/review" className="underline">คิวอนุมัติรหัส</a>
              </p>}
            </div>
            {creating === item.key && supervisedWarehouses.length > 0 && <div className="grid gap-3 rounded-lg bg-surface-2 p-3">
              <strong>เพิ่มสินค้าใหม่จาก Excel</strong>
              <p className="muted text-xs">ระบบเติมชื่อและรหัสไว้แล้ว กรุณายืนยันคลังและประเภทสินค้าเพื่อป้องกันทะเบียนซ้ำ</p>
              <label className="field">คลังสินค้า
                <select className="input" value={warehouse[item.key] ?? supervisedWarehouses[0]?.id}
                  onChange={event => setWarehouse(old => ({ ...old, [item.key]: Number(event.target.value) }))}>
                  {supervisedWarehouses.map(w => <option key={w.id} value={w.id}>{w.code}</option>)}
                </select></label>
              <label className="field">ชื่อสินค้า
                <input className="input" maxLength={300} value={description[item.key] ?? item.description}
                  onChange={event => setDescription(old => ({ ...old, [item.key]: event.target.value }))}/></label>
              <label className="field">ประเภท
                <select className="input" value={productType[item.key] ?? 'reagent'}
                  onChange={event => setProductType(old => ({ ...old, [item.key]:
                    event.target.value as 'reagent' | 'calibrator' | 'control' | 'consumable' }))}>
                  <option value="reagent">Reagent</option><option value="calibrator">Calibrator</option>
                  <option value="control">Control</option><option value="consumable">Consumable</option>
                </select></label>
              <label className="field">ขนาดบรรจุ (ถ้ามี)
                <input className="input" maxLength={300} value={packingSize[item.key] ?? ''}
                  onChange={event => setPackingSize(old => ({ ...old, [item.key]: event.target.value }))}/></label>
              <div className="flex gap-2">
                <button className="button" type="button" disabled={busy}
                  onClick={() => createNew(item)}>ยืนยันเพิ่มสินค้าและตรวจต่อ</button>
                <button className="button secondary" type="button" disabled={busy}
                  onClick={() => setCreating(null)}>ยกเลิก</button>
              </div>
            </div>}
          </>}
        </article>;
      })}
      <p className="muted text-xs">เมื่อแก้ไขครบแล้วกด “ตรวจจับคู่อีกครั้ง” ได้ทันทีโดยไม่ต้องเลือกไฟล์ซ้ำ · ยังไม่เพิ่ม Stock</p>
    </section>}
  </section>;
}
