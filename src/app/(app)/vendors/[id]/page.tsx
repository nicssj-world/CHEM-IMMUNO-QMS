import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Pencil } from 'lucide-react';
import { requireAccess, canMutate, canSupervise } from '@/lib/auth';
import { selectedWarehouse } from '@/lib/warehouse';
import { createClient } from '@/lib/supabase/server';
import { WarehouseSwitch } from '@/components/warehouse-switch';
import { VendorActiveControl } from '@/components/vendor-active-control';
import { VendorIssuePanel } from '@/components/vendor-issue-panel';
import { ReceiptAssessmentCard } from '@/components/receipt-assessment-card';
import { loadReceiptEvents } from '@/lib/receipt-events';
import { VendorPerformance, type TrendPoint } from '@/components/vendor-performance';
import { AnnualEvaluationPanel } from '@/components/annual-evaluation-panel';
import { isOfficial, loadAnnualRevisions, type Snapshot } from '@/lib/vendor-evaluation';
import { bangkokToday, fiscalYearBE } from '@/lib/inventory-insights';
import { ISSUE_COLUMNS, type IssueAttachment, type VendorIssue } from '@/lib/vendor-issues';
import { VENDOR_COLUMNS, canManageVendors, formatTaxBranch, formatTaxId, vendorStatusLabel, type VendorRecord } from '@/lib/vendors';
import { auditActionLabels, label } from '@/lib/labels';
import { formatDateTime } from '@/lib/format';
import { logUserMessage, savedNotice } from '@/lib/messages';

type AuditRow = { id: number; action: string; reason: string | null; created_at: string; actor_id: string | null };

function Fact({ term, children }: { term: string; children: React.ReactNode }) {
  return <div className="grid gap-0.5"><dt className="muted text-xs">{term}</dt><dd className="break-words">{children || <span className="muted">ไม่ระบุ</span>}</dd></div>;
}

export default async function VendorDetailPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ warehouse?: string; fiscalYear?: string; error?: string; saved?: string }> }) {
  const { id } = await params;
  const query = await searchParams;
  const access = await requireAccess();
  const warehouse = selectedWarehouse(access, query.warehouse);
  const client = await createClient();
  if (!client || !/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const { data: vendorData, error: vendorError } = await client.from('ci_vendors').select(VENDOR_COLUMNS).eq('id', id).maybeSingle();
  if (vendorError) return <main className="grid gap-4"><h1 className="page-title">ผู้ขาย</h1><p className="error" role="alert">อ่านข้อมูลผู้ขายไม่สำเร็จ: {logUserMessage('vendor', vendorError)}</p></main>;
  if (!vendorData) notFound();
  const vendor = vendorData as VendorRecord;
  const canManage = canManageVendors(access.warehouses);
  const currentFy = fiscalYearBE(bangkokToday());
  const requestedFy = Number.parseInt(query.fiscalYear ?? '', 10);
  const fy = requestedFy >= 2500 && requestedFy <= 3000 ? requestedFy : currentFy;
  const trendYears = [fy - 4, fy - 3, fy - 2, fy - 1, fy];
  const [issueResult, invoiceResult, auditResult, performanceResults, annual] = await Promise.all([
    client.from('ci_vendor_issues').select(ISSUE_COLUMNS).eq('vendor_id', id).eq('warehouse_id', warehouse.id).order('created_at', { ascending: false }).limit(200),
    client.from('ci_invoices').select('id,invoice_number').eq('vendor_id', id).order('created_at', { ascending: false }).limit(100),
    canManage ? client.from('ci_audit_logs').select('id,action,reason,created_at,actor_id').eq('entity_table', 'ci_vendors').eq('entity_id', id).order('created_at', { ascending: false }).limit(50) : Promise.resolve({ data: [], error: null }),
    Promise.all(trendYears.map(year => client.rpc('ci_vendor_performance', { p_vendor_id: id, p_warehouse_id: Number(warehouse.id), p_fiscal_year: year }))),
    loadAnnualRevisions(client, id, Number(warehouse.id)),
  ]);
  const issues = (issueResult.data ?? []) as VendorIssue[];
  const snapshots = performanceResults.map(r => (r.data ?? null) as Snapshot | null);
  const snapshot = snapshots[snapshots.length - 1];
  const officialFor = (year: number) => annual.revisions.find(r => r.ci_vendor_annual_evaluations.fiscal_year === year && isOfficial(r))?.frozen_snapshot ?? null;
  const trend: TrendPoint[] = trendYears.map((year, i) => ({ fiscalYear: year, receipts: snapshots[i]?.activity.receipts ?? 0, issues: (snapshots[i]?.activity.openIssues ?? 0) + (snapshots[i]?.activity.resolvedIssues ?? 0), officialScore: officialFor(year)?.score ?? null }));
  const official = officialFor(fy);
  const draftForYear = annual.revisions.find(r => r.ci_vendor_annual_evaluations.fiscal_year === fy && r.status === 'draft')?.id ?? null;
  const yearRevisions = annual.revisions;
  const invoices = invoiceResult.data ?? [];
  const issueIds = issues.map(i => i.id);
  const { data: attachmentData } = issueIds.length ? await client.from('ci_vendor_issue_attachments').select('id,issue_id,file_name,size_bytes,uploaded_at').in('issue_id', issueIds) : { data: [] };
  const attachments = (attachmentData ?? []) as IssueAttachment[];
  const { events, error: eventError } = await loadReceiptEvents(client, { vendorId: id, warehouseId: Number(warehouse.id), limit: 50 });
  const audit = (auditResult.data ?? []) as AuditRow[];
  const actorIds = [...new Set(audit.map(a => a.actor_id).filter((a): a is string => Boolean(a)))];
  const { data: actorData } = actorIds.length ? await client.from('ci_user_profiles').select('user_id,display_name').in('user_id', actorIds) : { data: [] };
  const actors = new Map((actorData ?? []).map(a => [a.user_id as string, a.display_name as string]));
  const loadError = [issueResult.error, invoiceResult.error, auditResult.error, annual.error, ...performanceResults.map(r => r.error)].find(Boolean);

  return <main className="grid gap-6">
    <div><Link href="/vendors" className="text-sm">← รายชื่อผู้ขาย</Link></div>
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0"><p className="eyebrow mb-2 flex items-center gap-2"><span className="font-mono">{vendor.vendor_code}</span><span className="badge">{vendorStatusLabel(vendor.active)}</span></p><h1 className="page-title">{vendor.name}</h1>{vendor.legal_name && vendor.legal_name !== vendor.name && <p className="muted mt-1">{vendor.legal_name}</p>}</div>
      {canManage && <div className="flex flex-wrap gap-2 items-start"><Link className="button secondary" href={`/vendors/${id}/edit`}><Pencil size={16} aria-hidden />แก้ไขข้อมูล</Link><VendorActiveControl vendorId={id} active={vendor.active} /></div>}
    </header>
    {query.error && <p className="error" role="alert">{query.error}</p>}{query.saved && <p className="notice" role="status">{savedNotice(query.saved, 'บันทึกแล้ว')}</p>}{loadError && <p className="error" role="alert">อ่านข้อมูลบางส่วนไม่สำเร็จ: {logUserMessage('vendor', loadError)}</p>}

    <section className="surface p-5 sm:p-6" aria-labelledby="vendor-identity"><h2 id="vendor-identity" className="font-bold mb-4">ข้อมูลผู้ขาย</h2>
      <dl className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
        <Fact term="เลขประจำตัวผู้เสียภาษี">{vendor.tax_id && <><span className="font-mono">{formatTaxId(vendor.tax_id)}</span> · {formatTaxBranch(vendor.tax_branch_code)}</>}</Fact>
        <Fact term="ผู้ติดต่อ">{vendor.contact_person}</Fact>
        <Fact term="โทรศัพท์">{vendor.phone}</Fact>
        <Fact term="อีเมล">{vendor.email}</Fact>
        <Fact term="ที่อยู่">{vendor.address}</Fact>
        <Fact term="แก้ไขล่าสุด">{formatDateTime(vendor.updated_at)}</Fact>
        {vendor.note && <div className="sm:col-span-2 lg:col-span-3"><Fact term="หมายเหตุ">{vendor.note}</Fact></div>}
      </dl>
    </section>

    <div className="grid gap-2"><h2 className="font-bold text-lg">ผลงานรายคลัง</h2><WarehouseSwitch warehouses={access.warehouses} selected={warehouse} path={`/vendors/${id}`} /></div>

    <form method="get" className="flex flex-wrap items-end gap-3" aria-label="เลือกปีงบประมาณ"><input type="hidden" name="warehouse" value={warehouse.code} />
      <label className="field">ปีงบประมาณ (พ.ศ.)<select className="input !w-40" name="fiscalYear" defaultValue={fy}>{Array.from({ length: 8 }, (_, i) => currentFy + 1 - i).map(y => <option key={y} value={y}>{y}</option>)}</select></label><button className="button secondary" type="submit">แสดง</button></form>

    <section className="grid gap-3" aria-labelledby="vendor-performance"><h2 id="vendor-performance" className="font-bold text-lg">ผลงานผู้ขาย · {warehouse.name} · ปีงบประมาณ {fy}</h2>
      {snapshot ? <VendorPerformance snapshot={snapshot} trend={trend} hrefForYear={y => `/vendors/${id}?warehouse=${warehouse.code}&fiscalYear=${y}`} officialScore={official ? { score: official.score, result: official.result } : null} /> : <p className="error" role="alert">อ่านผลงานผู้ขายไม่สำเร็จ</p>}
    </section>

    <section className="surface p-5 grid gap-3" aria-labelledby="vendor-annual"><h2 id="vendor-annual" className="font-bold">รายงานประเมินประจำปี · {warehouse.name}</h2>
      <AnnualEvaluationPanel revisions={yearRevisions} vendorId={id} warehouseId={Number(warehouse.id)} fiscalYear={fy} canManage={canSupervise(warehouse.role)} hasDraftForYear={draftForYear} />
    </section>

    <section className="surface p-5 grid gap-4" aria-labelledby="vendor-receipts"><h2 id="vendor-receipts" className="font-bold">ผลตรวจรับรายครั้ง · {warehouse.name}</h2>
      {eventError && <p className="error" role="alert">อ่านผลตรวจรับไม่สำเร็จ: {logUserMessage('vendor-receipts', eventError)}</p>}
      {events.map(e => <ReceiptAssessmentCard key={e.id} eventNumber={e.event_number} invoiceNumber={e.invoice?.invoice_number ?? '—'} receivedAt={e.received_at} assessment={e.assessment} revisions={e.revisions} canRevise={canSupervise(warehouse.role)} />)}
      {!events.length && <p className="muted text-sm">ยังไม่มีการรับสินค้าจากผู้ขายนี้ในคลังนี้</p>}
    </section>

    <section className="surface p-5 grid gap-3" aria-labelledby="vendor-issues"><h2 id="vendor-issues" className="font-bold">ปัญหาผู้ขาย · {warehouse.name}</h2>
      <VendorIssuePanel issues={issues} attachments={attachments} vendorId={id} warehouseId={Number(warehouse.id)} invoices={invoices.map(i => ({ id: i.id as string, invoice_number: i.invoice_number as string }))} canOpen={canMutate(warehouse.role)} canResolve={canSupervise(warehouse.role)} canCancel={warehouse.role === 'admin'} emptyText="ยังไม่มีบันทึกปัญหาของผู้ขายนี้ในคลังนี้" />
    </section>

    {canManage && <section className="surface p-5 grid gap-2" aria-labelledby="vendor-audit"><h2 id="vendor-audit" className="font-bold">ประวัติการแก้ไขข้อมูลผู้ขาย</h2>
      <ol className="grid gap-2">{audit.map(a => <li key={a.id} className="rounded-lg border border-line p-3 text-sm"><strong>{label(auditActionLabels, a.action)}</strong> · {formatDateTime(a.created_at)} · {a.actor_id ? actors.get(a.actor_id) ?? 'ผู้ใช้ในระบบ' : 'ระบบ'}{a.reason && <p className="muted mt-1">เหตุผล: {a.reason}</p>}</li>)}</ol>
      {!audit.length && <p className="muted text-sm">ยังไม่มีประวัติ</p>}
    </section>}
  </main>;
}
