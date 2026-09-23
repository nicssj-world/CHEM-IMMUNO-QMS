import { requireAccess, canSupervise, canMutate } from '@/lib/auth';
import { selectedWarehouse } from '@/lib/warehouse';
import { createClient } from '@/lib/supabase/server';
import { WarehouseSwitch } from '@/components/warehouse-switch';
import { createVendorIssue, resolveVendorIssue, saveVendorEvaluation, advanceVendorEvaluation } from '@/app/actions/control';
import { fiscalYear, bangkokToday } from '@/lib/inventory-insights';

type Vendor={id:string;name:string};
type Issue={id:string;vendor_id:string;description:string;status:string;resolution:string|null;created_at:string};
type Evaluation={id:string;vendor_id:string;fiscal_year:number;status:string;score:number|null;decision:string|null;evidence:Record<string,unknown>;evaluator_id:string;reviewer_id:string|null;approver_id:string|null};
type Metric={vendor_id:string;fiscal_year:number;receipt_count:number;assessed_count:number;discrepancy_count:number;issue_count:number;open_issue_count:number};

export default async function VendorsPage({searchParams}:{searchParams:Promise<{warehouse?:string;error?:string;saved?:string}>}){
  const params=await searchParams;
  const access=await requireAccess();
  const warehouse=selectedWarehouse(access,params.warehouse);
  const client=await createClient();
  if(!client)return <p className="error">ยังไม่ได้ตั้งค่า Supabase</p>;
  const [vendorResult,issueResult,evaluationResult,metricResult,invoiceResult]=await Promise.all([
    client.from('ci_vendors').select('id,name').eq('active',true).order('name').limit(100),
    client.from('ci_vendor_issues').select('id,vendor_id,description,status,resolution,created_at').eq('warehouse_id',warehouse.id).order('created_at',{ascending:false}).limit(100),
    client.from('ci_vendor_evaluations').select('id,vendor_id,fiscal_year,status,score,decision,evidence,evaluator_id,reviewer_id,approver_id').eq('warehouse_id',warehouse.id).order('fiscal_year',{ascending:false}).limit(100),
    client.from('ci_vendor_metrics').select('vendor_id,fiscal_year,receipt_count,assessed_count,discrepancy_count,issue_count,open_issue_count').eq('warehouse_id',warehouse.id).limit(200),
    client.from('ci_invoices').select('id,invoice_number,vendor_id').order('created_at',{ascending:false}).limit(100),
  ]);
  const error=[vendorResult.error,issueResult.error,evaluationResult.error,metricResult.error,invoiceResult.error].find(Boolean);
  if(error)return <p role="alert" className="error">อ่านข้อมูลผู้ขายไม่สำเร็จ: {error.message}</p>;
  const vendors=(vendorResult.data??[]) as Vendor[];
  const vendorById=new Map(vendors.map(v=>[v.id,v]));
  const issues=(issueResult.data??[]) as Issue[];
  const evaluations=(evaluationResult.data??[]) as Evaluation[];
  const metrics=(metricResult.data??[]) as Metric[];
  const invoices=invoiceResult.data??[];
  const currentFiscal=fiscalYear(bangkokToday());
  return <main className="grid gap-6"><div><p className="eyebrow mb-2">Vendor evidence</p><h1 className="page-title">ผู้ขายและการประเมินประจำปี</h1><p className="muted text-sm">ปีงบประมาณ 1 ต.ค. – 30 ก.ย. · แสดงเฉพาะตัวเลขหลักฐาน ไม่มีคะแนนหรือเกณฑ์ตัดสินอัตโนมัติ</p></div><WarehouseSwitch warehouses={access.warehouses} selected={warehouse} path="/vendors"/>
    {params.error&&<p role="alert" className="error">{params.error}</p>}{params.saved&&<p role="status" className="notice">บันทึกแล้ว</p>}
    {canMutate(warehouse.role)&&<section className="surface p-5 grid gap-3"><h2 className="font-bold">บันทึกปัญหาผู้ขาย</h2><form action={createVendorIssue} className="grid sm:grid-cols-2 gap-3"><input type="hidden" name="warehouse" value={warehouse.code}/><input type="hidden" name="warehouse_id" value={warehouse.id}/><label className="field">ผู้ขาย<select className="input" name="vendor_id" required defaultValue=""><option value="">เลือก</option>{vendors.map(v=><option key={v.id} value={v.id}>{v.name}</option>)}</select></label><label className="field">Invoice (ถ้ามี)<select className="input" name="invoice_id" defaultValue=""><option value="">ไม่ระบุ</option>{invoices.map(i=><option key={i.id} value={i.id}>{i.invoice_number}</option>)}</select></label><label className="field sm:col-span-2">รายละเอียด<textarea className="input min-h-24" name="description" required/></label><button className="button" type="submit">บันทึกปัญหา</button></form></section>}
    <section className="surface p-5 grid gap-3"><h2 className="font-bold">ปัญหาที่บันทึก</h2>{issues.map(issue=><article key={issue.id} className="border rounded-xl p-3 grid gap-2"><strong>{vendorById.get(issue.vendor_id)?.name??'ผู้ขาย'} · {issue.status}</strong><p>{issue.description}</p><p className="muted text-xs">{issue.created_at}</p>{issue.resolution&&<p className="text-sm">ผลแก้ไข: {issue.resolution}</p>}{issue.status==='open'&&canSupervise(warehouse.role)&&<form action={resolveVendorIssue} className="flex flex-wrap gap-2"><input type="hidden" name="warehouse" value={warehouse.code}/><input type="hidden" name="issue_id" value={issue.id}/><label className="field flex-1 min-w-48">ผลแก้ไข<input className="input" name="resolution" required/></label><button className="button secondary self-end">ปิดปัญหา</button></form>}</article>)}{!issues.length&&<p className="muted">ยังไม่มีบันทึกปัญหา</p>}</section>
    <section className="surface p-5 grid gap-3"><h2 className="font-bold">ตัวชี้วัดจากหลักฐานจริง</h2>{metrics.map(metric=><article key={`${metric.vendor_id}:${metric.fiscal_year}`} className="border rounded-xl p-3"><strong>{vendorById.get(metric.vendor_id)?.name??'ผู้ขาย'} · FY {metric.fiscal_year}</strong><p className="muted text-sm">รับเข้า {metric.receipt_count} · ตรวจรับ {metric.assessed_count} · พบความคลาดเคลื่อน {metric.discrepancy_count} · ปัญหา {metric.issue_count} (ค้าง {metric.open_issue_count})</p></article>)}{!metrics.length&&<p className="muted">ยังไม่มีข้อมูลรับเข้าหรือปัญหาในคลังนี้</p>}</section>
    {canSupervise(warehouse.role)&&<section className="surface p-5 grid gap-3"><h2 className="font-bold">สร้าง/ปรับร่างประเมินประจำปี</h2><form action={saveVendorEvaluation} className="grid sm:grid-cols-2 gap-3"><input type="hidden" name="warehouse" value={warehouse.code}/><input type="hidden" name="warehouse_id" value={warehouse.id}/><label className="field">ผู้ขาย<select className="input" name="vendor_id" required defaultValue=""><option value="">เลือก</option>{vendors.map(v=><option key={v.id} value={v.id}>{v.name}</option>)}</select></label><label className="field">Fiscal year<input className="input" name="fiscal_year" type="number" min="2000" max="3000" defaultValue={currentFiscal}/></label><label className="field sm:col-span-2">บันทึกหลักฐานเพิ่มเติม<textarea className="input min-h-24" name="notes"/></label><p className="muted text-sm sm:col-span-2">ระบบเก็บตัวเลขหลักฐาน ณ เวลาบันทึก · Score และ Decision ยังว่างจนกว่าจะมีนโยบายอนุมัติ</p><button className="button">บันทึกร่าง</button></form></section>}
    <section className="surface p-5 grid gap-3"><h2 className="font-bold">รายการประเมิน</h2>{evaluations.map(item=><article key={item.id} className="border rounded-xl p-3 grid gap-2"><strong>{vendorById.get(item.vendor_id)?.name??'ผู้ขาย'} · FY {item.fiscal_year} · {item.status}</strong><p className="muted text-sm">Score: {item.score??'ยังไม่กำหนด'} · Decision: {item.decision??'ยังไม่กำหนด'}</p><p className="muted text-xs">Evaluator {item.evaluator_id} · Reviewer {item.reviewer_id??'—'} · Approver {item.approver_id??'—'}</p><pre className="text-xs whitespace-pre-wrap">{JSON.stringify(item.evidence,null,2)}</pre>{canSupervise(warehouse.role)&&item.status!=='approved'&&<form action={advanceVendorEvaluation}><input type="hidden" name="warehouse" value={warehouse.code}/><input type="hidden" name="evaluation_id" value={item.id}/><input type="hidden" name="step" value={item.status==='draft'?'review':'approve'}/><button className="button secondary">{item.status==='draft'?'บันทึกการทบทวน':'อนุมัติรายการหลักฐาน'}</button></form>}</article>)}{!evaluations.length&&<p className="muted">ยังไม่มีรายการประเมิน</p>}</section>
  </main>;
}
