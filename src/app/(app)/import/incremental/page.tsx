import Link from 'next/link';
import { FileSpreadsheet, LockKeyhole } from 'lucide-react';
import { SubmitButton } from '@/components/submit-button';
import { applyIncrementalImport, stageIncrementalWorkbook } from '@/app/actions/incremental-import';
import { requireAccess } from '@/lib/auth';
import { createClient } from '@/lib/supabase/server';

type Batch = {
  id: string;
  status: 'preview' | 'applied';
  source_filename: string;
  source_sha256: string;
  row_count: number;
  staged_at: string;
  applied_at: string | null;
};

type Change = { field: string; current: unknown; imported: unknown };
type ImportRow = {
  id: string;
  source_sheet: string;
  source_row: number;
  disposition: 'New' | 'Existing' | 'Update' | 'Conflict' | 'Duplicate in file';
  product_id: string | null;
  match_method: string | null;
  candidate: { warehouse_code: string; source_name: string; ref_current: string };
  changes: Change[];
  details: string | null;
};

const dispositions = ['New', 'Existing', 'Update', 'Conflict', 'Duplicate in file'] as const;
const dispositionLabel: Record<ImportRow['disposition'], string> = {
  New: 'New · สร้างใหม่',
  Existing: 'Existing · Skip',
  Update: 'Update · แก้ Product เดิม',
  Conflict: 'Conflict · ต้องจัดการแยก',
  'Duplicate in file': 'Duplicate in file · REF ซ้ำในไฟล์',
};
const errorText: Record<string, string> = {
  permission: 'ต้องมีสิทธิ์ Admin ทั้งคลัง CHE และ IMM',
  configuration: 'ยังไม่ได้ตั้งค่าการเชื่อมต่อ Supabase',
  master: 'อ่าน Product Master และ identifier ไม่ครบ จึงยังสร้าง Preview ไม่ได้',
  file: 'กรุณาเลือกไฟล์ Excel ขนาดไม่เกิน 1 MB',
  source: 'โครงสร้าง workbook ไม่ตรงกับตาราง Product ของ CHE/IMM',
  'no-delta': 'ไม่พบแถวที่เพิ่มหรือเปลี่ยนจาก Product Master ปัจจุบัน',
  stage: 'บันทึก Preview ไม่สำเร็จ กรุณาตรวจสิทธิ์และการเชื่อมต่อ',
  batch: 'รหัสชุด Preview ไม่ถูกต้อง',
  apply: 'Apply ไม่สำเร็จ หรือข้อมูล Product เปลี่ยนหลังสร้าง Preview กรุณาสร้าง Preview ใหม่',
};

function valueText(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (Array.isArray(value)) return value.map(valueText).join(' · ') || '—';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

export default async function IncrementalImportPage({ searchParams }: {
  searchParams: Promise<{ batch?: string; error?: string; staged?: string; applied?: string }>;
}) {
  const params = await searchParams;
  const access = await requireAccess();
  const isAdminBoth = ['CHE', 'IMM'].every(code => access.warehouses.some(item => item.code === code && item.role === 'admin'));
  if (!isAdminBoth) return <main className="grid gap-5">
    <div><p className="eyebrow">Product master · incremental</p><h1 className="page-title mt-2">นำเข้า Product เพิ่มเติม</h1></div>
    <p className="notice flex items-center gap-2"><LockKeyhole size={18} /> ต้องมีสิทธิ์ Admin ทั้งคลัง CHE และ IMM</p>
  </main>;

  const client = await createClient();
  const { data: batchData, error: batchError } = client
    ? await client.from('ci_incremental_product_import_batches')
        .select('id,status,source_filename,source_sha256,row_count,staged_at,applied_at')
        .order('staged_at', { ascending: false }).limit(20)
    : { data: null, error: null };
  const batches = (batchData ?? []) as Batch[];
  const current = batches.find(item => item.id === params.batch) ?? batches[0];
  const { data: rowData, error: rowsError } = current && client
    ? await client.from('ci_incremental_product_import_rows')
        .select('id,source_sheet,source_row,disposition,product_id,match_method,candidate,changes,details')
        .eq('batch_id', current.id).order('source_sheet').order('source_row')
    : { data: null, error: null };
  const rows = (rowData ?? []) as ImportRow[];
  const counts = Object.fromEntries(dispositions.map(disposition => [
    disposition, rows.filter(row => row.disposition === disposition).length,
  ])) as Record<ImportRow['disposition'], number>;
  const safeCount = counts.New + counts.Update + counts.Existing;
  const formatDate = (value: string) => new Intl.DateTimeFormat('th-TH', {
    dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Bangkok',
  }).format(new Date(value));

  return <main className="grid gap-6">
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div><p className="eyebrow mb-2">Product master · separate import flow</p>
        <h1 className="page-title">นำเข้า Product เพิ่มเติม</h1>
        <p className="muted mt-2 text-sm">Preview → Review → Apply · คง Product ID และ Product Code เมื่อแก้ข้อมูลเดิม</p>
      </div>
      <Link href="/import" className="button secondary">เปิด Initial Importer</Link>
    </div>
    {params.error && <p className="error" role="alert">{errorText[params.error] ?? 'ไม่สามารถทำรายการได้'}</p>}
    {params.staged && <p className="notice" role="status">สร้าง Preview แล้ว ตรวจทุกแถวก่อน Apply</p>}
    {params.applied && <p className="notice" role="status">Apply ชุดนำเข้าเสร็จแล้ว</p>}
    {!client && <p className="error">ยังไม่ได้ตั้งค่าการเชื่อมต่อ Supabase</p>}
    {batchError && <p className="error">โหลดชุด Preview ไม่สำเร็จ</p>}
    <section className="surface grid gap-4 p-5" aria-labelledby="upload-heading">
      <div className="flex items-center gap-3"><FileSpreadsheet className="text-[var(--teal)]" aria-hidden />
        <div><h2 id="upload-heading" className="font-bold">ไฟล์ Product ฉบับล่าสุด</h2>
          <p className="muted text-sm">ระบบอ่านเฉพาะโครงสร้าง CHE/IMM ที่กำหนด และซ่อนแถวเดิมที่ไม่เปลี่ยนจาก Initial Import</p></div>
      </div>
      <form action={stageIncrementalWorkbook} className="grid gap-3 sm:flex sm:items-end">
        <label className="field min-w-0 flex-1">เลือก workbook (.xlsx)
          <input className="input h-auto" type="file" name="workbook" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" required />
        </label>
        <SubmitButton className="button" label="สร้าง Preview" pendingLabel="กำลังเปรียบเทียบ…" />
      </form>
    </section>
    {batches.length > 0 && <section className="grid gap-3" aria-labelledby="batch-list-heading">
      <h2 id="batch-list-heading" className="font-bold">Preview ล่าสุด</h2>
      <div className="flex flex-wrap gap-2">{batches.map(batch => <Link key={batch.id}
        href={`/import/incremental?batch=${batch.id}`}
        className={`min-h-11 rounded-xl border px-4 py-3 text-sm no-underline ${current?.id === batch.id ? 'border-[var(--teal)] bg-tint text-[var(--ink)]' : 'border-[var(--line)] bg-white text-[var(--ink)]'}`}>
        <strong>{batch.status === 'applied' ? 'Applied' : 'Preview'}</strong>
        <span className="muted ml-2">{formatDate(batch.staged_at)}</span>
      </Link>)}</div>
    </section>}
    {current && <>
      <section className="surface grid gap-4 p-5" aria-labelledby="preview-heading">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div><p className="eyebrow">Import batch</p><h2 id="preview-heading" className="font-bold break-all">{current.source_filename}</h2>
            <p className="muted mt-1 text-xs break-all">SHA-256 {current.source_sha256}</p></div>
          <span className="badge">{current.status === 'applied' ? 'Applied' : 'Awaiting Review'}</span>
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
          {dispositions.map(disposition => <div key={disposition} className="rounded-xl bg-surface-2 p-3">
            <p className="muted text-xs">{disposition}</p><p className="text-xl font-bold">{counts[disposition]}</p>
          </div>)}
        </div>
        <p className="muted text-sm">ตรวจ {rows.length} แถว · Product ที่ไม่เปลี่ยนจาก Initial Import ไม่ถูกรวมใน batch นี้ · Existing เป็น no-op</p>
        {current.status === 'preview' && <div className="flex flex-wrap items-center gap-3">
          <form action={applyIncrementalImport}>
            <input type="hidden" name="batchId" value={current.id} />
            <SubmitButton className="button" label="Apply รายการที่ปลอดภัย" pendingLabel="กำลัง Apply…"
              disabled={safeCount === 0 || !!rowsError || !!batchError} />
          </form>
          <p className="muted text-xs">Apply จะสร้าง New, อัปเดต Update และข้าม Existing; Conflict/Duplicate จะไม่ถูกเปลี่ยน</p>
        </div>}
      </section>
      {rowsError && <p className="error">โหลดแถว Preview ไม่สำเร็จ</p>}
      <section className="grid gap-3" aria-labelledby="rows-heading">
        <div><p className="eyebrow mb-1">Review</p><h2 id="rows-heading" className="text-xl font-bold">รายการสร้าง ข้าม แก้ไข และ Conflict</h2></div>
        <div className="surface overflow-x-auto">
          <table className="w-full min-w-[850px] border-collapse text-left text-sm">
            <thead><tr className="border-b border-[var(--line)] bg-surface-2">
              <th className="p-3">Product / REF</th><th className="p-3">Field</th><th className="p-3">Current</th><th className="p-3">Import</th><th className="p-3">Action / Source</th>
            </tr></thead>
            <tbody>{rows.map(row => {
              const changes = row.changes.length ? row.changes : [{ field: '—', current: '—', imported: '—' }];
              return changes.map((change, index) => <tr key={`${row.id}-${index}`} className="border-b border-[var(--line)] align-top last:border-0">
                <td className="p-3"><strong>{row.candidate.source_name}</strong><div className="muted mt-1 font-mono text-xs">{row.candidate.ref_current} · {row.candidate.warehouse_code}</div>
                  {row.details && <p className="mt-1 max-w-xs text-xs text-[#8c4d1f]">{row.details}</p>}</td>
                <td className="p-3">{change.field}</td><td className="p-3">{valueText(change.current)}</td><td className="p-3">{valueText(change.imported)}</td>
                <td className="p-3"><strong>{dispositionLabel[row.disposition]}</strong>
                  <div className="muted mt-1 text-xs">{row.source_sheet}!{row.source_row}{row.match_method ? ` · ${row.match_method}` : ''}</div>
                </td>
              </tr>);
            })}</tbody>
          </table>
          {rows.length === 0 && <p className="p-5 muted">ยังไม่มี Preview ใน batch นี้</p>}
        </div>
      </section>
    </>}
    {current && rows.length === 0 && rowsError === null && <p className="notice">ยังไม่มี batch หรือไม่พบแถวเปลี่ยนแปลง</p>}
    {current && <p className="muted text-xs">Staged {formatDate(current.staged_at)} · batch {current.id}</p>}
  </main>;
}
