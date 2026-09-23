import Link from 'next/link';
import { FileSpreadsheet, LockKeyhole, ShieldCheck, TriangleAlert } from 'lucide-react';
import { applyApprovedImport, stageApprovedWorkbook } from '@/app/actions/import';
import { ReviewResolutionForm } from './review-resolution-form';
import { requireAccess } from '@/lib/auth';
import { APPROVED_WORKBOOK_FILENAME, APPROVED_WORKBOOK_SHA256 } from '@/lib/import/approved-workbook';
import type { ImportStagePayload } from '@/lib/import/types';
import { createClient } from '@/lib/supabase/server';

type Batch = {
  id: string; status: string; source_filename: string; source_sha256: string;
  staged_at: string; applied_at: string | null; payload: ImportStagePayload;
};
type Review = {
  id: string; source_sheet: string; source_row: number; kind: string;
  source_text: string | null; details: string; critical: boolean; status: string;
  resolution_note: string | null;
};

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
    ? await client.from('ci_import_review_items').select('id,source_sheet,source_row,kind,source_text,details,critical,status,resolution_note').eq('batch_id', current.id).order('source_sheet').order('source_row')
    : { data: null, error: null };
  const reviews = (reviewData ?? []) as Review[];
  const openCount = reviews.filter((review) => review.status === 'open' && review.critical).length;
  const payload = current?.payload;
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
          <div className="rounded-xl bg-[#f1f7f7] p-3"><p className="muted text-xs">Product links</p><p className="text-xl font-bold">{payload.product_relations.length}</p></div>
          <div className="rounded-xl bg-[#f1f7f7] p-3"><p className="muted text-xs">Platform rows</p><p className="text-xl font-bold">{payload.platform_relations.length}</p></div>
          <div className="rounded-xl bg-[#fff3eb] p-3"><p className="muted text-xs">ข้อค้างที่สำคัญ</p><p className="text-xl font-bold">{openCount}</p></div>
        </div>
        <p className="muted text-sm">CHE {payload.products.filter((product) => product.warehouse_code === 'CHE').length} · IMM {payload.products.filter((product) => product.warehouse_code === 'IMM').length} · Used with รอตรวจ {payload.review_items.filter((item) => item.kind === 'used_with').length} แถว</p>
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
          const reagentOptions = payload.products.filter((candidate) => candidate.product_type === 'reagent' && candidate.warehouse_code === product?.warehouse_code).map((candidate) => ({ ref: candidate.ref_current, name: candidate.source_name }));
          return <details className="surface p-5 group" key={review.id}><summary className="flex min-h-11 cursor-pointer list-none flex-wrap items-center justify-between gap-2"><div><span className="badge">{review.kind === 'used_with' ? 'Used with' : 'ข้อมูลต้นทาง'}</span><h3 className="font-bold mt-2">{product?.source_name ?? 'ไม่พบสินค้าในชุด'}</h3><p className="muted text-xs mt-1">{review.source_sheet} · แถว Excel {review.source_row} · REF {product?.ref_current ?? '—'}</p></div><span className={review.status === 'open' ? 'text-[#9b4d20] font-bold text-sm' : 'text-[#0b716e] font-bold text-sm'}>{review.status === 'open' ? 'รอตรวจ · เปิดดู' : 'ตรวจแล้ว · เปิดดู'}</span></summary>
            {review.source_text && <p className="mt-3 rounded-lg bg-[#f3f7f8] p-3 text-sm break-words">ต้นทาง: {review.source_text}</p>}
            <p className="muted text-sm mt-3">{review.details}</p>
            {review.status !== 'open' && <p className="notice mt-3 text-sm">ผลตรวจ: {review.status} · {review.resolution_note}</p>}
            {review.status === 'open' && current.status === 'staged' && product && <ReviewResolutionForm itemId={review.id} kind={review.kind} warehouseCode={product.warehouse_code} reagentOptions={reagentOptions} />}
          </details>;
        })}
      </section>
    </>}
  </main>;
}
