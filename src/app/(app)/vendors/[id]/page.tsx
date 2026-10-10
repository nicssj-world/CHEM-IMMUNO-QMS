import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Pencil } from 'lucide-react';
import { requireAccess, canMutate, canSupervise } from '@/lib/auth';
import { createClient } from '@/lib/supabase/server';
import { VendorActiveControl } from '@/components/vendor-active-control';
import { VendorIssuePanel } from '@/components/vendor-issue-panel';
import { ReceiptAssessmentCard } from '@/components/receipt-assessment-card';
import { loadReceiptEvents } from '@/lib/receipt-events';
import { VendorPerformance, type TrendPoint } from '@/components/vendor-performance';
import { AnnualEvaluationPanel } from '@/components/annual-evaluation-panel';
import { UnifiedAnnualEvaluationPanel } from '@/components/unified-annual-evaluation-panel';
import { loadAnnualRevisions, type Snapshot } from '@/lib/vendor-evaluation';
import { combineVendorSnapshots } from '@/lib/unified-vendor';
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
  const warehouses = access.warehouses;
  const warehouseIds = warehouses.map(item => Number(item.id));
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
  const [issueResult, invoiceResult, invoiceCountResult, auditResult, performanceByScope, annualByScope, unifiedAnnualResult] = await Promise.all([
    client.from('ci_vendor_issues').select(ISSUE_COLUMNS,{count:'exact'}).eq('vendor_id',id).in('warehouse_id',warehouseIds).order('created_at',{ascending:false}).limit(200),
    client.from('ci_invoices').select('id,invoice_number,invoice_date').eq('vendor_id',id).order('created_at',{ascending:false}).limit(1000),
    client.from('ci_invoices').select('id',{count:'exact',head:true}).eq('vendor_id',id),
    canManage ? client.from('ci_audit_logs').select('id,action,reason,created_at,actor_id').eq('entity_table','ci_vendors').eq('entity_id',id).order('created_at',{ascending:false}).limit(50) : Promise.resolve({data:[],error:null}),
    Promise.all(warehouseIds.map(warehouseId=>Promise.all(trendYears.map(year=>client.rpc('ci_vendor_performance',{p_vendor_id:id,p_warehouse_id:warehouseId,p_fiscal_year:year}))))),
    Promise.all(warehouseIds.map(warehouseId=>loadAnnualRevisions(client,id,warehouseId))),
    client.from('ci_unified_vendor_reports').select('id,fiscal_year,revision_number,status,report_number,frozen_snapshot').eq('vendor_id',id).order('fiscal_year',{ascending:false}).order('revision_number',{ascending:false}).limit(100),
  ]);
  const issues = (issueResult.data ?? []) as VendorIssue[];
  const invoices = invoiceResult.data ?? [];
  const invoicesComplete = invoices.length === (invoiceCountResult.count ?? 0);
  const snapshots = trendYears.map((year,index)=>{
    const scoped = performanceByScope.map(group=>group[index].data as Snapshot|null).filter((row):row is Snapshot=>Boolean(row));
    const uniqueInvoices = invoices.filter(row=>fiscalYearBE(row.invoice_date)===year).length;
    return scoped.length===warehouseIds.length?combineVendorSnapshots(scoped,uniqueInvoices):null;
  });
  const snapshot = snapshots[snapshots.length-1];
  // Neither a mean nor a sum of previously signed scores is a valid combined score.
  const trend: TrendPoint[] = trendYears.map((year,index)=>({
    fiscalYear:year,receipts:snapshots[index]?.activity.receipts??0,
    issues:(snapshots[index]?.activity.openIssues??0)+(snapshots[index]?.activity.resolvedIssues??0),
    officialScore:null,
  }));
  const issueIds = issues.map(i => i.id);
  const { data: attachmentData } = issueIds.length ? await client.from('ci_vendor_issue_attachments').select('id,issue_id,file_name,size_bytes,uploaded_at').in('issue_id', issueIds) : { data: [] };
  const attachments = (attachmentData ?? []) as IssueAttachment[];
  const { events, groups: receiptGroups, error: eventError } = await loadReceiptEvents(client, { vendorId: id, limit: 200 });
  const audit = (auditResult.data ?? []) as AuditRow[];
  const actorIds = [...new Set(audit.map(a => a.actor_id).filter((a): a is string => Boolean(a)))];
  const { data: actorData } = actorIds.length ? await client.from('ci_user_profiles').select('user_id,display_name').in('user_id', actorIds) : { data: [] };
  const actors = new Map((actorData ?? []).map(a => [a.user_id as string, a.display_name as string]));
  const loadError = [issueResult.error, invoiceResult.error, invoiceCountResult.error, auditResult.error, unifiedAnnualResult.error,
    ...annualByScope.map(result=>result.error),...performanceByScope.flatMap(group=>group.map(result=>result.error)),
    !invoicesComplete?{message:'Invoice เกินขีดจำกัดของรายการสรุป'}:null,
    issues.length<(issueResult.count??0)?{message:'ปัญหาผู้ขายเกินขีดจำกัดของรายการสรุป'}:null,
  ].find(Boolean);

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

    <form method="get" className="flex flex-wrap items-end gap-3" aria-label="เลือกปีงบประมาณ">
      <label className="field">ปีงบประมาณ (พ.ศ.)<select className="input !w-40" name="fiscalYear" defaultValue={fy}>{Array.from({length:8},(_,i)=>currentFy+1-i).map(y=><option key={y} value={y}>{y}</option>)}</select></label>
      <button className="button secondary" type="submit">แสดง</button>
    </form>
    <section className="grid gap-3" aria-labelledby="vendor-performance">
      <h2 id="vendor-performance" className="font-bold text-lg">ผลงานผู้ขายรวม · ปีงบประมาณ {fy}</h2>
      {snapshot && invoicesComplete && !loadError ? <VendorPerformance snapshot={snapshot} trend={trend} hrefForYear={year=>`/vendors/${id}?fiscalYear=${year}`} officialScore={null}/> : <p className="error" role="alert">ไม่สามารถสรุปผลงานผู้ขายได้ครบถ้วน</p>}
    </section>
    {!unifiedAnnualResult.error && <UnifiedAnnualEvaluationPanel vendorId={id} fiscalYear={fy} revisions={(unifiedAnnualResult.data ?? []) as never[]} canManage={warehouses.length===2 && warehouses.every(item=>canSupervise(item.role))}/>} 
    <section className="surface p-5 grid gap-3" aria-labelledby="vendor-annual">
      <h2 id="vendor-annual" className="font-bold">เอกสารประเมินประจำปีเดิม</h2>
      <p className="muted text-sm">คงรายงานลงนามและคะแนนเดิมตามขอบเขตหลักฐาน ณ วันที่จัดทำ ไม่คำนวณคะแนนรวมจากการเฉลี่ยรายงานเก่า</p>
      {annualByScope.map((annual,index)=><div key={warehouses[index].id} className="grid gap-2 border-t border-line pt-3">
        <h3 className="font-semibold">รายงานเดิม · รหัส {warehouses[index].code}</h3>
        <AnnualEvaluationPanel revisions={annual.revisions} vendorId={id} warehouseId={Number(warehouses[index].id)} fiscalYear={fy} canManage={false} hasDraftForYear={null}/>
      </div>)}
    </section>
    <section className="surface p-5 grid gap-4" aria-labelledby="vendor-receipts">
      <h2 id="vendor-receipts" className="font-bold">ผลตรวจรับรายครั้ง · ทุกกลุ่มรหัสน้ำยา</h2>
      {eventError && <p className="error" role="alert">อ่านผลตรวจรับไม่สำเร็จ: {logUserMessage('vendor-receipts',eventError)}</p>}
      {receiptGroups.map(group => group.events.length === 1
        ? group.events.map(event => <ReceiptAssessmentCard key={event.id} eventNumber={event.event_number}
          invoiceNumber={event.invoice?.invoice_number??'—'} receivedAt={event.received_at}
          assessment={event.assessment} revisions={event.revisions}
          canRevise={warehouses.some(row=>Number(row.id)===event.warehouse_id&&canSupervise(row.role))}/>)
        : <article key={group.key} className="rounded-xl border border-line p-4 grid gap-3">
            <header className="grid gap-1">
              <strong>ใบรับเข้า {group.displayNumber ?? '—'} · Invoice {group.events[0].invoice?.invoice_number ?? '—'}</strong>
              <p className="muted text-sm">รับเข้าเมื่อ {formatDateTime(group.events[0].received_at)} · รับเข้าจากการยืนยันครั้งเดียว</p>
              <p className="muted text-xs">รหัสอ้างอิงเดิม {group.referenceNumbers.join(' / ')}</p>
            </header>
            <details className="border-t border-line pt-2">
              <summary className="cursor-pointer font-semibold min-h-11">ผลตรวจรับแยกตามหลักฐานเดิม ({group.events.length} รายการ)</summary>
              <div className="grid gap-3 pt-3">
                {group.events.map(event => <ReceiptAssessmentCard key={event.id} eventNumber={event.event_number}
                  invoiceNumber={event.invoice?.invoice_number??'—'} receivedAt={event.received_at}
                  assessment={event.assessment} revisions={event.revisions}
                  canRevise={warehouses.some(row=>Number(row.id)===event.warehouse_id&&canSupervise(row.role))}/>)}
              </div>
            </details>
          </article>)}
      {!events.length&&<p className="muted text-sm">ยังไม่มีการรับน้ำยาจากผู้ขายนี้</p>}
    </section>
    <section className="surface p-5 grid gap-3" aria-labelledby="vendor-issues">
      <h2 id="vendor-issues" className="font-bold">ปัญหาผู้ขาย · ทุกกลุ่มรหัสน้ำยา</h2>
      <VendorIssuePanel issues={issues} attachments={attachments} vendorId={id} warehouseId={warehouseIds[0]}
        scopeOptions={warehouses.map(item=>({id:Number(item.id),label:`${item.code}-*`}))}
        invoices={invoices.map(row=>({id:row.id,invoice_number:row.invoice_number}))}
        canOpen={warehouses.some(item=>canMutate(item.role))}
        canResolve={warehouses.some(item=>canSupervise(item.role))}
        canCancel={warehouses.some(item=>item.role==='admin')}
        emptyText="ยังไม่มีปัญหาผู้ขาย"/>
    </section>

    {canManage && <section className="surface p-5 grid gap-2" aria-labelledby="vendor-audit"><h2 id="vendor-audit" className="font-bold">ประวัติการแก้ไขข้อมูลผู้ขาย</h2>
      <ol className="grid gap-2">{audit.map(a => <li key={a.id} className="rounded-lg border border-line p-3 text-sm"><strong>{label(auditActionLabels, a.action)}</strong> · {formatDateTime(a.created_at)} · {a.actor_id ? actors.get(a.actor_id) ?? 'ผู้ใช้ในระบบ' : 'ระบบ'}{a.reason && <p className="muted mt-1">เหตุผล: {a.reason}</p>}</li>)}</ol>
      {!audit.length && <p className="muted text-sm">ยังไม่มีประวัติ</p>}
    </section>}
  </main>;
}
