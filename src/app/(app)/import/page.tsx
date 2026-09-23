import Link from 'next/link';
import { FileSpreadsheet, LockKeyhole, ShieldCheck, TriangleAlert } from 'lucide-react';
import { applyApprovedImport, stageApprovedWorkbook } from '@/app/actions/import';
import { ReviewResolutionForm } from './review-resolution-form';
import { requireAccess } from '@/lib/auth';
import { APPROVED_WORKBOOK_FILENAME, APPROVED_WORKBOOK_SHA256 } from '@/lib/import/approved-workbook';
import type { ImportResolutionEntry, ImportStagePayload, ProductType } from '@/lib/import/types';
import { createClient } from '@/lib/supabase/server';

type Batch = {
  id: string; status: string; source_filename: string; source_sha256: string;
  staged_at: string; applied_at: string | null; payload: ImportStagePayload;
};
type Review = {
  id: string; review_id: string; source_sheet: string; source_row: number; source_product_ref: string; raw_source_value: string | number | null; kind: string;
  source_text: string | null; details: string; critical: boolean; status: string;
  resolution_note: string | null; resolution_type: string | null; resolved_at: string | null;
};

const typeLabels: Record<ProductType, string> = {
  reagent: 'Reagent', calibrator: 'Calibrator', control: 'Control', consumable: 'Consumable',
};

function rawValueText(value: string | number | null): string {
  return value === null ? 'ว่างใน workbook' : String(value);
}

function approvedDecisionText(entry: ImportResolutionEntry, payload: ImportStagePayload): string {
  const decision = entry.approved_decision;
  if (decision.kind === 'product_relationship') {
    const source = payload.products.find((product) => product.ref_current === decision.source_ref_current);
    const target = payload.products.find((product) => product.ref_current === decision.target_ref_current);
    return `${source?.source_name ?? decision.source_ref_current} (${decision.source_ref_current}) → ${decision.relation_type} → ${target?.source_name ?? decision.target_ref_current} (${decision.target_ref_current})`;
  }
  if (decision.kind === 'unassigned') return 'คงความสัมพันธ์ Product และ Platform เป็น unassigned';
  if (decision.kind === 'product_data_correction') return decision.approved_value;
  if (decision.kind === 'product_type_override') return typeLabels[decision.approved_value];
  if (decision.kind === 'product_platform_override') return `${decision.target_platform_keys.join(' + ')} เท่านั้น (ไม่ผูก c703 หรือ ISE)`;
  return `ยืนยันประเภท ${typeLabels[decision.approved_value]} โดยไม่เปลี่ยนค่า catalog`;
}

function sourceFieldLabel(field: string): string {
  if (field === 'used_with') return 'Used with';
  if (field === 'packing_size') return 'Packing Size';
  if (field === 'type') return 'Type';
  return 'ค่าจากแถวต้นทาง';
}

const errorText: Record<string, string> = {
  permission: 'ต้องมีสิทธิ์ Admin ทั้งสองคลังเพื่อจัดการชุดนำเข้า',
  configuration: 'ยังไม่ได้ตั้งค่าการเชื่อมต่อ Supabase',
  file: 'กรุณาเลือกไฟล์ Excel ที่มีขนาดไม่เกิน 1 MB',
  source: 'ไฟล์ไม่ตรงกับ workbook ที่อนุมัติ (ชื่อไฟล์หรือ SHA-256 ไม่ตรง)',
  stage: 'บันทึกชุดตรวจทานไม่สำเร็จ กรุณาตรวจสิทธิ์และการเชื่อมต่อ',
  batch: 'รหัสชุดนำเข้าไม่ถูกต้อง',
  apply: 'ยังเปิดใช้ชุดนำเข้าไม่ได้ ตรวจ review ที่ค้างและผลตรวจฐานข้อมูล',
  'review-input': 'ข้อมูลผลตรวจไม่ครบหรือ REF/เครื่องที่เลือกไม่ตรงกับชุดนำเข้า',
  'review-state': 'รายการตรวจทานไม่อยู่ในสถานะที่แก้ไขได้',
  review: 'บันทึกผลตรวจไม่สำเร็จ กรุณาตรวจข้อกำหนดในฐานข้อมูล',
};

export default async function ImportPage({ searchParams }: {
  searchParams: Promise<{ batch?: string; error?: string; staged?: string; reviewed?: string; applied?: string }>;
}) {
  const params = await searchParams;
  const access = await requireAccess();
  const isAdminBoth = ['CHE', 'IMM'].every((code) => access.warehouses.some((warehouse) => warehouse.code === code && warehouse.role === 'admin'));
  if (!isAdminBoth) return <main className="grid gap-5"><div><p className="eyebrow">Product master</p><h1 className="page-title mt-2">นำเข้าสินค้า</h1></div><p className="notice flex items-center gap-2"><LockKeyhole size={18} /> ต้องมีสิทธิ์ Admin ทั้งสองคลังเพื่อจัดการการนำเข้า</p></main>;
  const client = await createClient();
  const { data: batchData, error: batchesError } = client
    ? await client.from('ci_import_batches').select('id,status,source_filename,source_sha256,staged_at,applied_at,payload').order('staged_at', { ascending: false }).limit(10)
    : { data: null, error: null };
  const batches = (batchData ?? []) as Batch[];
  const current = batches.find((batch) => batch.id === params.batch) ?? batches[0];
  const { data: reviewData, error: reviewsError } = current && client
    ? await client.from('ci_import_review_items').select('id,review_id,source_sheet,source_row,source_product_ref,raw_source_value,kind,source_text,details,critical,status,resolution_note,resolution_type,resolved_at').eq('batch_id', current.id).order('source_sheet').order('source_row').order('review_id')
    : { data: null, error: null };
  const reviews = (reviewData ?? []) as Review[];
  const openCount = reviews.filter((review) => review.status === 'open' && review.critical).length;
  const payload = current?.payload;
  const sourceTypeCounts = payload?.products.reduce((counts, product) => {
    counts[product.source_product_type]++;
    return counts;
  }, { reagent: 0, calibrator: 0, control: 0, consumable: 0 } satisfies Record<ProductType, number>);
  const approvedTypeCounts = payload?.products.reduce((counts, product) => {
    counts[product.product_type]++;
    return counts;
  }, { reagent: 0, calibrator: 0, control: 0, consumable: 0 } satisfies Record<ProductType, number>);
  const formatDate = (value: string) => new Intl.DateTimeFormat('th-TH', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Bangkok' }).format(new Date(value));
  return <main className="grid gap-6">
    <div><p className="eyebrow mb-2">Product master · source control</p><h1 className="page-title">นำเข้าสินค้าและตรวจความสัมพันธ์</h1><p className="muted mt-2 text-sm">ตรวจไฟล์ต้นทาง บันทึกชุดตรวจทาน แล้วอนุมัติทุกข้อค้างก่อนเปิดใช้สินค้า</p></div>
    {params.error && <p className="error" role="alert">{errorText[params.error] ?? 'ไม่สามารถทำรายการได้'}</p>}
    {params.staged && <p className="notice" role="status">บันทึกชุดตรวจทานแล้ว ยังไม่มีการเปิดใช้สินค้า</p>}
    {params.reviewed && <p className="notice" role="status">บันทึกผลตรวจแล้ว</p>}
    {params.applied && <p className="notice" role="status">เปิดใช้ Product Master สำเร็จแล้ว</p>}
    {!client && <p className="error">ยังไม่ได้ตั้งค่าการเชื่อมต่อ Supabase</p>}
    {batchesError && <p className="error">โหลดชุดนำเข้าไม่สำเร็จ: {batchesError.message}</p>}
    <section className="surface p-5 grid gap-4" aria-labelledby="source-heading">
      <div className="flex items-center gap-3"><FileSpreadsheet className="text-[var(--teal)]" aria-hidden /><div><h2 id="source-heading" className="font-bold">ไฟล์ต้นทางที่อนุมัติ</h2><p className="muted text-sm break-all">{APPROVED_WORKBOOK_FILENAME}</p></div></div>
      <p className="text-xs muted break-all">SHA-256 {APPROVED_WORKBOOK_SHA256}</p>
      <form action={stageApprovedWorkbook} className="grid gap-3 sm:flex sm:items-end">
        <label className="field min-w-0 flex-1">เลือกไฟล์เพื่อสร้างชุดตรวจทาน
          <input className="input h-auto" type="file" name="workbook" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" required />
        </label>
        <button className="button" type="submit"><ShieldCheck size={18} />ตรวจและบันทึกชุด</button>
      </form>
      <p className="muted text-xs">การบันทึกชุดนี้ไม่เพิ่มสินค้าเข้าคลัง ระบบจะตรวจชื่อไฟล์และ SHA-256 บนเซิร์ฟเวอร์ก่อนรับข้อมูล</p>
    </section>
    {batches.length > 0 && <section className="grid gap-3" aria-labelledby="batches-heading"><h2 id="batches-heading" className="font-bold">ชุดนำเข้าล่าสุด</h2><div className="flex flex-wrap gap-2">{batches.map((batch) => <Link key={batch.id} href={`/import?batch=${batch.id}`} className={`min-h-11 rounded-xl border px-4 py-3 text-sm no-underline ${current?.id === batch.id ? 'border-[var(--teal)] bg-[#e7f4f3] text-[var(--ink)]' : 'border-[var(--line)] bg-white text-[var(--ink)]'}`}><strong>{batch.status === 'applied' ? 'เปิดใช้แล้ว' : 'รอตรวจทาน'}</strong><span className="muted ml-2">{formatDate(batch.staged_at)}</span></Link>)}</div></section>}
    {current && payload && <>
      <section className="surface p-5 grid gap-4" aria-labelledby="batch-heading"><div className="flex flex-wrap items-center justify-between gap-2"><div><p className="eyebrow">Import batch</p><h2 id="batch-heading" className="font-bold break-all">{current.id}</h2></div><span className="badge">{current.status === 'applied' ? 'เปิดใช้แล้ว' : 'รอตรวจทาน'}</span></div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div className="rounded-xl bg-[#f1f7f7] p-3"><p className="muted text-xs">สินค้า</p><p className="text-xl font-bold">{payload.products.length}</p></div>
          <div className="rounded-xl bg-[#f1f7f7] p-3"><p className="muted text-xs">Product → Product</p><p className="text-sm font-bold">90 source + 10 owner = 100</p></div>
          <div className="rounded-xl bg-[#f1f7f7] p-3"><p className="muted text-xs">Product → Platform</p><p className="text-sm font-bold">27 source rows · 28 active maps</p></div>
          <div className="rounded-xl bg-[#fff3eb] p-3"><p className="muted text-xs">ข้อค้างที่สำคัญ</p><p className="text-xl font-bold">{openCount}</p></div>
        </div>
        <p className="muted text-sm">CHE {payload.products.filter((product) => product.warehouse_code === 'CHE').length} · IMM {payload.products.filter((product) => product.warehouse_code === 'IMM').length} · Used with source rows 12 · resolution evidence {payload.resolution_manifest.entries.length} รายการ</p>
        {sourceTypeCounts && approvedTypeCounts && <div className="grid gap-2 rounded-xl bg-[#f4f8f8] p-4 text-sm sm:grid-cols-2">
          <p><strong>Workbook classification:</strong> Reagent {sourceTypeCounts.reagent} · Calibrator {sourceTypeCounts.calibrator} · Control {sourceTypeCounts.control} · Consumable {sourceTypeCounts.consumable}</p>
          <p><strong>Approved active catalog:</strong> Reagent {approvedTypeCounts.reagent} · Calibrator {approvedTypeCounts.calibrator} · Control {approvedTypeCounts.control} · Consumable {approvedTypeCounts.consumable}</p>
        </div>}
        {current.status === 'staged' && <div className="flex flex-wrap items-center gap-3">
          <form action={applyApprovedImport}><input type="hidden" name="batchId" value={current.id} /><button className="button" disabled={openCount > 0 || !!reviewsError}>เปิดใช้ Product Master</button></form>
          {openCount > 0 && <p className="text-sm text-[#8c4d1f] flex items-center gap-2"><TriangleAlert size={17} /> ต้องปิดข้อค้าง {openCount} รายการก่อน</p>}
        </div>}
      </section>
      <section className="grid gap-3" aria-labelledby="review-heading"><div><p className="eyebrow mb-1">Source review</p><h2 id="review-heading" className="text-xl font-bold">รายการที่ต้องตรวจ</h2></div>
        {reviewsError && <p className="error">โหลดรายการตรวจทานไม่สำเร็จ: {reviewsError.message}</p>}
        {!reviewsError && reviews.length === 0 && <p className="notice">ไม่มีรายการที่ต้องตรวจ</p>}
        {!reviewsError && reviews.map((review) => {
          const product = payload.products.find((candidate) => candidate.source_sheet === review.source_sheet && candidate.source_row === review.source_row);
          const resolution = payload.resolution_manifest.entries.find((entry) => entry.review_id === review.review_id);
          const reagentOptions = payload.products.filter((candidate) => candidate.product_type === 'reagent' && candidate.warehouse_code === product?.warehouse_code).map((candidate) => ({ ref: candidate.ref_current, name: candidate.source_name }));
          return <details className="surface p-5 group" key={review.id}><summary className="flex min-h-11 cursor-pointer list-none flex-wrap items-center justify-between gap-2"><div><span className="badge">{review.review_id} · {review.kind === 'used_with' ? 'Used with' : 'ข้อมูลต้นทาง'}</span><h3 className="font-bold mt-2">{product?.source_name ?? 'ไม่พบสินค้าในชุด'}</h3><p className="muted text-xs mt-1">{review.source_sheet} · แถว Excel {review.source_row} · REF {review.source_product_ref}</p></div><span className={review.status === 'open' ? 'text-[#9b4d20] font-bold text-sm' : 'text-[#0b716e] font-bold text-sm'}>{review.status === 'open' ? 'รอตรวจ · เปิดดู' : 'ตัดสินแล้ว · เปิดดู'}</span></summary>
            {review.source_text && <p className="mt-3 rounded-lg bg-[#f3f7f8] p-3 text-sm break-words">ต้นทาง: {review.source_text}</p>}
            <p className="muted text-sm mt-3">{review.details}</p>
            {resolution && <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <div className="rounded-xl bg-[#f4f8f8] p-4"><p className="muted text-xs">Workbook said · {sourceFieldLabel(resolution.source_field)}</p><p className="mt-1 break-words text-sm font-semibold">{rawValueText(resolution.raw_source_value)}</p></div>
              <div className="rounded-xl bg-[#e7f4f3] p-4"><p className="muted text-xs">Owner approved · {resolution.resolution_type}</p><p className="mt-1 break-words text-sm font-semibold">{approvedDecisionText(resolution, payload)}</p></div>
            </div>}
            {review.status !== 'open' && <p className="notice mt-3 text-sm">{review.resolution_note} · บันทึก {review.resolved_at ? formatDate(review.resolved_at) : 'แล้ว'}</p>}
            {review.status === 'open' && current.status === 'staged' && product && <ReviewResolutionForm itemId={review.id} kind={review.kind} warehouseCode={product.warehouse_code} reagentOptions={reagentOptions} />}
          </details>;
        })}
      </section>
    </>}
  </main>;
}
