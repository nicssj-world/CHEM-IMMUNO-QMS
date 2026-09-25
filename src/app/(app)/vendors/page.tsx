import Link from 'next/link';
import { Plus } from 'lucide-react';
import { requireAccess } from '@/lib/auth';
import { createClient } from '@/lib/supabase/server';
import { logUserMessage, savedNotice } from '@/lib/messages';
import { VENDOR_COLUMNS, canManageVendors, formatTaxBranch, formatTaxId, vendorStatusLabel, type VendorRecord } from '@/lib/vendors';

const PAGE_SIZE = 25;

// Vendor list, as LABCBH-Stock app/(protected)/vendors/page.tsx: search by code, name or tax ID, filter by status, paginate.
export default async function VendorsPage({ searchParams }: { searchParams: Promise<{ q?: string; status?: string; page?: string; error?: string; saved?: string }> }) {
  const params = await searchParams;
  const access = await requireAccess();
  const client = await createClient();
  if (!client) return <main className="grid gap-4"><h1 className="page-title">ผู้ขาย</h1><p className="error" role="alert">ยังไม่ได้ตั้งค่าการเชื่อมต่อฐานข้อมูล</p></main>;
  const q = (params.q ?? '').trim().slice(0, 80).replace(/[(),.%*\\]/g, ' ').trim();
  const status = ['active', 'inactive', 'all'].includes(params.status ?? '') ? params.status! : 'active';
  const page = Math.min(200, Math.max(1, Number.parseInt(params.page ?? '1', 10) || 1));
  const from = (page - 1) * PAGE_SIZE;
  let query = client.from('ci_vendors').select(VENDOR_COLUMNS, { count: 'exact' }).order('name').range(from, from + PAGE_SIZE - 1);
  if (status !== 'all') query = query.eq('active', status === 'active');
  // A tax ID is matched only when the search is all digits (dashes allowed), so "V-0001" does not pull in every tax ID containing 0001.
  const taxDigits = q.replace(/[\s-]/g, '');
  if (q) query = query.or(`vendor_code.ilike.%${q}%,name.ilike.%${q}%,legal_name.ilike.%${q}%${/^\d+$/.test(taxDigits) ? `,tax_id.ilike.%${taxDigits}%` : ''}`);
  const { data, error, count } = await query;
  const vendors = (data ?? []) as VendorRecord[];
  const total = count ?? 0;
  const pageHref = (n: number) => `/vendors?${new URLSearchParams({ q, status, page: String(n) })}`;
  const canManage = canManageVendors(access.warehouses);
  const canPolicy = access.warehouses.some(w => w.code === 'CHE' && w.role === 'admin') && access.warehouses.some(w => w.code === 'IMM' && w.role === 'admin');
  return <main className="grid gap-6">
    <div className="flex flex-wrap items-end justify-between gap-4"><div><p className="eyebrow mb-2">Vendor master</p><h1 className="page-title">ผู้ขาย</h1><p className="muted mt-2 text-sm">ข้อมูลผู้ขายใช้ร่วมกันทั้งสองคลัง · ผลตรวจรับ ปัญหา และการประเมินประจำปีดูได้ในหน้าผู้ขายแต่ละราย</p></div>
      <div className="flex flex-wrap gap-2">{canPolicy && <Link className="button secondary" href="/vendors/evaluation-policy">นโยบายประเมินผู้ขาย</Link>}{canManage && <Link className="button" href="/vendors/new"><Plus size={18} aria-hidden />เพิ่มผู้ขาย</Link>}</div></div>
    {params.error && <p className="error" role="alert">{params.error}</p>}{params.saved && <p className="notice" role="status">{savedNotice(params.saved, 'บันทึกแล้ว')}</p>}
    <form method="get" className="surface p-4 grid sm:grid-cols-[1fr_200px_auto] gap-3 items-end"><label className="field">ค้นหา<input className="input" name="q" defaultValue={q} placeholder="รหัส ชื่อ หรือเลขประจำตัวผู้เสียภาษี" /></label><label className="field">สถานะ<select className="input" name="status" defaultValue={status}><option value="active">ใช้งาน</option><option value="inactive">ปิดการใช้งาน</option><option value="all">ทั้งหมด</option></select></label><button className="button" type="submit">ค้นหา</button></form>
    {error ? <p className="error" role="alert">อ่านข้อมูลผู้ขายไม่สำเร็จ: {logUserMessage('vendors', error)}</p> : <section className="surface overflow-hidden">
      <div className="px-5 py-4 flex justify-between gap-3"><h2 className="font-bold">รายชื่อผู้ขาย</h2><span className="muted text-sm">{total} ราย</span></div>
      <div className="desktop-table table-wrap"><table className="data-table"><thead><tr><th>รหัส</th><th>ชื่อผู้ขาย</th><th>เลขประจำตัวผู้เสียภาษี</th><th>ผู้ติดต่อ</th><th>สถานะ</th></tr></thead><tbody>{vendors.map(v => <tr key={v.id}>
        <td className="font-mono text-sm">{v.vendor_code}</td>
        <td><Link className="font-bold text-brand" href={`/vendors/${v.id}`}>{v.name}</Link>{v.legal_name && v.legal_name !== v.name && <small className="block muted">{v.legal_name}</small>}</td>
        <td><span className="font-mono text-sm">{formatTaxId(v.tax_id)}</span>{v.tax_id && <small className="block muted">{formatTaxBranch(v.tax_branch_code)}</small>}</td>
        <td>{v.contact_person || v.phone ? <>{v.contact_person && <span>{v.contact_person}</span>}{v.phone && <small className="block muted">{v.phone}</small>}</> : <span className="muted">ไม่ระบุ</span>}</td>
        <td><span className="badge">{vendorStatusLabel(v.active)}</span></td>
      </tr>)}</tbody></table></div>
      <div className="mobile-card-list px-4 pb-4">{vendors.map(v => <Link key={v.id} href={`/vendors/${v.id}`} className="rounded-xl border border-line p-4 no-underline text-[var(--ink)]"><div className="flex justify-between gap-2"><span className="font-mono text-sm muted">{v.vendor_code}</span><span className="badge">{vendorStatusLabel(v.active)}</span></div><p className="font-bold mt-1">{v.name}</p><p className="muted text-sm">{formatTaxId(v.tax_id)}{v.contact_person ? ` · ${v.contact_person}` : ''}</p></Link>)}</div>
      {vendors.length === 0 && <p className="muted px-5 pb-5">ไม่พบผู้ขายตามเงื่อนไขที่เลือก</p>}
    </section>}
    {total > PAGE_SIZE && <nav aria-label="หน้ารายชื่อผู้ขาย" className="flex items-center gap-3">{page > 1 && <Link className="button secondary" href={pageHref(page - 1)}>ก่อนหน้า</Link>}<span className="muted text-sm">หน้า {page} จาก {Math.ceil(total / PAGE_SIZE)}</span>{from + PAGE_SIZE < total && <Link className="button secondary" href={pageHref(page + 1)}>ถัดไป</Link>}</nav>}
  </main>;
}
