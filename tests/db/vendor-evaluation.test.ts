import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { Client } from 'pg';

// Vendor evaluation ported from LABCBH-Stock. Same harness as phase2.test.ts.
const ADMIN='11111111-1111-4111-8111-111111111111';
const STAFF='22222222-2222-4222-8222-222222222222';
const SUPERVISOR='33333333-3333-4333-8333-333333333333';
const IMM_VIEWER='44444444-4444-4444-8444-444444444444';
const root=process.env.CI_TEST_DATABASE_URL;
if(!root)throw new Error('Set CI_TEST_DATABASE_URL via scripts/db/test.ps1');
const adminUrl=new URL(root);
if(!['127.0.0.1','localhost','::1'].includes(adminUrl.hostname)||adminUrl.pathname!=='/postgres')throw new Error('Disposable loopback PostgreSQL required');
const bangkok=new Date(Date.now()+7*3600*1000);
const FY=bangkok.getUTCFullYear()+543+(bangkok.getUTCMonth()>=9?1:0);
const dbName=`ci_vendor_eval_${process.pid}_${Math.floor(Math.random()*1000000)}`;
const testUrl=new URL(adminUrl);testUrl.pathname=`/${dbName}`;
async function connect(url=testUrl.toString()){const client=new Client({connectionString:url});await client.connect();return client;}
async function asUser<T>(id:string,fn:(c:Client)=>Promise<T>):Promise<T>{const c=await connect();try{await c.query('begin');await c.query('set local role authenticated');await c.query("select set_config('request.jwt.claim.sub',$1,true)",[id]);const result=await fn(c);await c.query('commit');return result;}catch(error){await c.query('rollback');throw error;}finally{await c.end();}}
async function rpc<T>(id:string,name:string,args:unknown[],casts:string[]):Promise<T>{return asUser(id,async c=>{const p=args.map((_,i)=>`$${i+1}::${casts[i]}`).join(',');const result=await c.query<{result:T}>(`select public.${name}(${p}) result`,args.map((arg,i)=>casts[i]==='jsonb'?JSON.stringify(arg):arg));return result.rows[0].result;});}
async function setup(){const owner=await connect(adminUrl.toString());try{await owner.query(`create database ${dbName}`);}finally{await owner.end();}const c=await connect();try{const migrations=(await readdir(path.join(process.cwd(),'supabase/migrations'))).filter(f=>f.endsWith('.sql')).sort();for(const file of ['tests/db/bootstrap.sql',...migrations.map(f=>`supabase/migrations/${f}`)])await c.query(await readFile(path.join(process.cwd(),file),'utf8'));await c.query('insert into auth.users(id) values ($1),($2),($3),($4)',[ADMIN,STAFF,SUPERVISOR,IMM_VIEWER]);await c.query("insert into public.ci_user_profiles(user_id,ephis_id,display_name) values ($1,'admin','Admin'),($2,'staff','Staff'),($3,'supervisor','Supervisor'),($4,'viewer','Viewer')",[ADMIN,STAFF,SUPERVISOR,IMM_VIEWER]);await c.query("insert into public.ci_user_access(user_id,warehouse_id,role) values ($1,1,'admin'),($1,2,'admin'),($2,1,'staff'),($3,1,'supervisor'),($4,2,'viewer')",[ADMIN,STAFF,SUPERVISOR,IMM_VIEWER]);}finally{await c.end();}}
async function cleanup(){const c=await connect(adminUrl.toString());try{await c.query(`drop database ${dbName} with (force)`);}finally{await c.end();}}

test('Vendor evaluation (LABCBH port): master data, short close',{timeout:180000},async t=>{
  await setup();try{
    const vendor=await rpc<string>(SUPERVISOR,'ci_create_vendor',[{vendorCode:'V-001',name:'Alpha Diagnostics',taxId:'0105551234567',contactPerson:'K. A'}],['jsonb']);

    await t.test('vendor master: supervisor or admin writes, uniqueness is case-insensitive, staff and viewer cannot',async()=>{
      await assert.rejects(rpc(STAFF,'ci_create_vendor',[{vendorCode:'V-X',name:'X'}],['jsonb']),/CI_ACCESS_DENIED/);
      await assert.rejects(rpc(IMM_VIEWER,'ci_create_vendor',[{vendorCode:'V-X',name:'X'}],['jsonb']),/CI_ACCESS_DENIED/);
      await assert.rejects(rpc(ADMIN,'ci_create_vendor',[{vendorCode:'v-001 ',name:'Other'}],['jsonb']),/CI_VENDOR_CODE_TAKEN/);
      await assert.rejects(rpc(ADMIN,'ci_create_vendor',[{vendorCode:'V-002',name:'alpha diagnostics'}],['jsonb']),/CI_VENDOR_NAME_TAKEN/);
      await assert.rejects(rpc(ADMIN,'ci_create_vendor',[{vendorCode:'V-003',name:'Beta',taxId:'0105551234567'}],['jsonb']),/CI_VENDOR_TAX_TAKEN/);
      await assert.rejects(rpc(ADMIN,'ci_create_vendor',[{vendorCode:'V-004',name:'Gamma',taxId:'123'}],['jsonb']),/ci_vendors_tax_id_check/);
      await assert.rejects(rpc(ADMIN,'ci_create_vendor',[{vendorCode:'V-005',name:'Delta',hack:true}],['jsonb']),/CI_VENDOR_FIELD_INVALID/);
    });

    await t.test('vendor update is an optimistic partial patch; deactivation needs a note',async()=>{
      const before=await asUser(ADMIN,c=>c.query<{updated_at:string}>('select updated_at::text updated_at from public.ci_vendors where id=$1',[vendor]));
      await rpc(ADMIN,'ci_update_vendor',[vendor,{phone:'038-000000',contactPerson:''},before.rows[0].updated_at],['uuid','jsonb','timestamptz']);
      const after=await asUser(ADMIN,c=>c.query('select phone,contact_person,tax_id,updated_at from public.ci_vendors where id=$1',[vendor]));
      assert.equal(after.rows[0].phone,'038-000000');assert.equal(after.rows[0].contact_person,null);assert.equal(after.rows[0].tax_id,'0105551234567');
      await assert.rejects(rpc(ADMIN,'ci_update_vendor',[vendor,{phone:'1'},before.rows[0].updated_at],['uuid','jsonb','timestamptz']),/CI_STALE_DATA/);
      await assert.rejects(rpc(ADMIN,'ci_set_vendor_active',[vendor,false,' '],['uuid','boolean','text']),/CI_REASON_REQUIRED/);
      await rpc(ADMIN,'ci_set_vendor_active',[vendor,false,'Contract ended'],['uuid','boolean','text']);
      await rpc(ADMIN,'ci_set_vendor_active',[vendor,true,null],['uuid','boolean','text']);
      const audit=await asUser(ADMIN,c=>c.query("select action from public.ci_audit_logs where entity_table='ci_vendors' and entity_id=$1 order by id",[vendor]));
      assert.deepEqual(audit.rows.map(r=>r.action),['CREATE','UPDATE','DEACTIVATE','ACTIVATE']);
    });

    const product=await rpc<string>(ADMIN,'ci_create_product',[{warehouse_id:1,product_type:'reagent',source_name:'A',current_ref:'0001',manufacturer_barcode:'A-1'}],['jsonb']);
    const location=await rpc<string>(ADMIN,'ci_create_location',[1,'A','A'],['smallint','text','text']);
    const invoice=await rpc<string>(ADMIN,'ci_create_invoice',[{vendor_id:vendor,invoice_number:'INV-1',invoice_date:'2026-09-24',lines:[{product_id:product,quantity:10}]}],['jsonb']);

    await t.test('an invoice with goods still outstanding can be closed short by a supervisor, with a reason',async()=>{
      const line=await asUser(ADMIN,c=>c.query<{id:string}>('select id from public.ci_invoice_lines where invoice_id=$1',[invoice]));
      await rpc(ADMIN,'ci_confirm_receipt',[invoice,[{invoice_line_id:line.rows[0].id,quantity:6,lot_number:'L1',expiry_date:'2027-01-01',location_id:location}],'short-1'],['uuid','jsonb','text']);
      await assert.rejects(rpc(STAFF,'ci_close_invoice_short',[invoice,'Vendor out of stock'],['uuid','text']),/CI_ACCESS_DENIED/);
      await assert.rejects(rpc(IMM_VIEWER,'ci_close_invoice_short',['99999999-9999-4999-8999-999999999999','probe'],['uuid','text']),/CI_ACCESS_DENIED/,'callers without a role learn nothing about invoices');
      await assert.rejects(rpc(SUPERVISOR,'ci_close_invoice_short',[invoice,''],['uuid','text']),/CI_REASON_REQUIRED/);
      await rpc(SUPERVISOR,'ci_close_invoice_short',[invoice,'Vendor out of stock'],['uuid','text']);
      const row=await asUser(ADMIN,c=>c.query('select status,closed_short_reason,closed_short_by from public.ci_invoices where id=$1',[invoice]));
      assert.equal(row.rows[0].status,'closed_short');assert.equal(row.rows[0].closed_short_by,SUPERVISOR);
      await assert.rejects(rpc(SUPERVISOR,'ci_close_invoice_short',[invoice,'again'],['uuid','text']),/CI_INVOICE_NOT_OPEN/);
    });

    await t.test('closing short opens one quantity issue per outstanding line; reversing the receipt reopens the invoice and cancels it',async()=>{
      const open=await asUser(ADMIN,c=>c.query("select issue_type,status,description,warehouse_id from public.ci_vendor_issues where invoice_id=$1 and source_kind='invoice_closure'",[invoice]));
      assert.equal(open.rowCount,1);assert.equal(open.rows[0].issue_type,'quantity_discrepancy');assert.equal(open.rows[0].status,'open');assert.match(open.rows[0].description,/ค้าง 4/);assert.equal(open.rows[0].warehouse_id,1);
      const tx=await asUser(ADMIN,c=>c.query<{id:string}>("select t.id from public.ci_stock_transactions t join public.ci_receipts r on r.id=t.receipt_id where r.invoice_id=$1 and t.kind='receive'",[invoice]));
      await rpc(SUPERVISOR,'ci_reverse_transaction',[tx.rows[0].id,'Wrong delivery','rev-inv1'],['uuid','text','text']);
      const inv=await asUser(ADMIN,c=>c.query('select status,closed_short_at from public.ci_invoices where id=$1',[invoice]));
      assert.equal(inv.rows[0].status,'open');assert.equal(inv.rows[0].closed_short_at,null);
      const cancelled=await asUser(ADMIN,c=>c.query('select status,cancelled_reason from public.ci_vendor_issues where invoice_id=$1 and source_kind=$2',[invoice,'invoice_closure']));
      assert.equal(cancelled.rows[0].status,'cancelled');assert.equal(cancelled.rows[0].cancelled_reason,'invoice_reopened');
    });

    const invoice2=await rpc<string>(ADMIN,'ci_create_invoice',[{vendor_id:vendor,invoice_number:'INV-2',invoice_date:'2026-09-25',lines:[{product_id:product,quantity:10}]}],['jsonb']);
    const line2=(await asUser(ADMIN,c=>c.query<{id:string}>('select id from public.ci_invoice_lines where invoice_id=$1',[invoice2]))).rows[0].id;
    const answers={delivery_discrepancy:false,correct_product:true,correct_quantity:true,packaging_ok:true,temperature_required:false,temperature_ok:null,shelf_life_ok:null,documentation_complete:true,has_complaint:false,reason_codes:[] as string[],other_reason_detail:null,notes:null};
    let assessmentId='';let receiptId='';

    await t.test('assessed receipt: event number, LABCBH answer rules enforced by the database, expired LOT and problems open issues',async()=>{
      const receive=(assessment:object,key:string,lot='L2',expiry='2020-01-01')=>rpc(STAFF,'ci_confirm_receipt_assessed',[invoice2,[{invoice_line_id:line2,quantity:3,lot_number:lot,expiry_date:expiry,location_id:location}],key,assessment],['uuid','jsonb','text','jsonb']);
      await assert.rejects(receive({...answers,packaging_ok:false},'a1'),/CI_RECEIPT_REASON_REQUIRED/);
      await assert.rejects(receive({...answers,packaging_ok:false,reason_codes:['urgent_need']},'a2'),/CI_RECEIPT_NOTE_REQUIRED/);
      await assert.rejects(receive({...answers,reason_codes:['urgent_need']},'a3'),/CI_RECEIPT_REASON_NOT_ALLOWED/);
      await assert.rejects(receive({...answers,packaging_ok:false,reason_codes:['other'],notes:'x'},'a4'),/CI_RECEIPT_OTHER_REASON_REQUIRED/);
      await assert.rejects(receive({...answers,packaging_ok:false,reason_codes:['nope'],notes:'x'},'a5'),/CI_RECEIPT_REASON_INVALID/);
      await assert.rejects(receive({...answers,temperature_required:true},'a6'),/CI_RECEIPT_ASSESSMENT_REQUIRED/);
      const stock=await asUser(ADMIN,c=>c.query('select count(*)::int n from public.ci_receipts where invoice_id=$1',[invoice2]));
      assert.equal(stock.rows[0].n,0,'a rejected assessment must roll the receipt back');
      await receive({...answers,packaging_ok:false,has_complaint:true,reason_codes:['vendor_will_correct'],notes:'กล่องบุบและมีข้อร้องเรียน'},'a7');
      const row=await asUser(ADMIN,c=>c.query('select a.id,a.receipt_id,a.delivery_discrepancy,a.has_complaint,a.reason_codes,e.event_number from public.ci_receipt_assessments a join public.ci_receipt_event_numbers e on e.receipt_id=a.receipt_id where a.receipt_id in (select id from public.ci_receipts where invoice_id=$1)',[invoice2]));
      assessmentId=row.rows[0].id;receiptId=row.rows[0].receipt_id;
      assert.equal(row.rows[0].delivery_discrepancy,true);assert.deepEqual(row.rows[0].reason_codes,['vendor_will_correct']);assert.match(row.rows[0].event_number,new RegExp(`^RC-${FY}-\\d{4}$`));
      const issues=await asUser(ADMIN,c=>c.query("select issue_type,source_kind,status from public.ci_vendor_issues where receipt_id=$1 order by issue_type",[receiptId]));
      assert.deepEqual(issues.rows.map(r=>r.issue_type),['complaint','expiry_non_compliant','packaging_damage']);
      assert.ok(issues.rows.every(r=>r.status==='open'));
      assert.equal(issues.rows.find(r=>r.issue_type==='expiry_non_compliant')!.source_kind,'receipt_line');
    });

    await t.test('event numbers are gap-free per fiscal year and unique',async()=>{
      const rows=await asUser(ADMIN,c=>c.query('select sequence_number from public.ci_receipt_event_numbers order by sequence_number'));
      assert.deepEqual(rows.rows.map(r=>r.sequence_number),rows.rows.map((_,i)=>i+1));
    });

    await t.test('revising an assessment: supervisor or admin only, recorded as a revision, issues follow the new answers',async()=>{
      const fixed={...answers};
      await assert.rejects(rpc(STAFF,'ci_update_receipt_assessment',[assessmentId,fixed],['uuid','jsonb']),/CI_ACCESS_DENIED/);
      await assert.rejects(rpc(IMM_VIEWER,'ci_update_receipt_assessment',[assessmentId,fixed],['uuid','jsonb']),/CI_ACCESS_DENIED/);
      await rpc(SUPERVISOR,'ci_update_receipt_assessment',[assessmentId,fixed],['uuid','jsonb']);
      await assert.rejects(rpc(SUPERVISOR,'ci_update_receipt_assessment',[assessmentId,fixed],['uuid','jsonb']),/CI_RECEIPT_ASSESSMENT_UNCHANGED/);
      const rev=await asUser(SUPERVISOR,c=>c.query("select revision_number,before_state->>'packaging_ok' before_ok,after_state->>'packaging_ok' after_ok,changed_by from public.ci_receipt_assessment_revisions where assessment_id=$1",[assessmentId]));
      assert.equal(rev.rowCount,1);assert.equal(rev.rows[0].before_ok,'false');assert.equal(rev.rows[0].after_ok,'true');assert.equal(rev.rows[0].changed_by,SUPERVISOR);
      const issues=await asUser(ADMIN,c=>c.query("select issue_type,status,cancelled_reason from public.ci_vendor_issues where receipt_id=$1 order by issue_type",[receiptId]));
      assert.deepEqual(issues.rows.map(r=>[r.issue_type,r.status,r.cancelled_reason]),[['complaint','cancelled','assessment_corrected'],['expiry_non_compliant','open',null],['packaging_damage','cancelled','assessment_corrected']]);
      const flag=await asUser(ADMIN,c=>c.query('select delivery_discrepancy,has_complaint from public.ci_receipt_assessments where id=$1',[assessmentId]));
      assert.equal(flag.rows[0].delivery_discrepancy,false);assert.equal(flag.rows[0].has_complaint,false);
      await rpc(SUPERVISOR,'ci_update_receipt_assessment',[assessmentId,{...answers,packaging_ok:false,reason_codes:['no_alternative'],notes:'ตรวจซ้ำพบบรรจุภัณฑ์เสียหาย'}],['uuid','jsonb']);
      const again=await asUser(ADMIN,c=>c.query("select status from public.ci_vendor_issues where receipt_id=$1 and issue_type='packaging_damage' order by created_at",[receiptId]));
      assert.deepEqual(again.rows.map(r=>r.status),['cancelled','open']);
    });

    await t.test('issue lifecycle: manual open, resolve with action+note, admin-only cancel, evidence attachments',async()=>{
      await assert.rejects(rpc(IMM_VIEWER,'ci_open_vendor_issue',[vendor,2,'other','x',null],['uuid','smallint','text','text','uuid']),/CI_ACCESS_DENIED/);
      await assert.rejects(rpc(STAFF,'ci_open_vendor_issue',[vendor,1,'other','  ',null],['uuid','smallint','text','text','uuid']),/CI_ISSUE_DESCRIPTION_REQUIRED/);
      await assert.rejects(rpc(STAFF,'ci_open_vendor_issue',[vendor,1,'made_up','x',null],['uuid','smallint','text','text','uuid']),/ci_vendor_issues_type_check/);
      const issue=await rpc<string>(STAFF,'ci_open_vendor_issue',[vendor,1,'complaint','ผู้ขายส่งของผิดรุ่น',invoice2],['uuid','smallint','text','text','uuid']);
      await assert.rejects(rpc(STAFF,'ci_resolve_vendor_issue',[issue,'vendor_warned','แจ้งแล้ว'],['uuid','text','text']),/CI_ACCESS_DENIED/);
      await assert.rejects(rpc(SUPERVISOR,'ci_resolve_vendor_issue',[issue,'vendor_warned',' '],['uuid','text','text']),/CI_ISSUE_RESOLUTION_REQUIRED/);
      const att=await rpc<{attachment_id:string;object_key:string}>(STAFF,'ci_register_vendor_issue_attachment',[issue,'evidence.jpg','image/jpeg',2048],['uuid','text','text','bigint']);
      assert.ok(att.object_key.startsWith(`${issue}/`));
      await assert.rejects(rpc(STAFF,'ci_register_vendor_issue_attachment',[issue,'evil.exe','application/x-msdownload',10],['uuid','text','text','bigint']),/mime_type_check/);
      await assert.rejects(rpc(STAFF,'ci_register_vendor_issue_attachment',[issue,'big.pdf','application/pdf',20000000],['uuid','text','text','bigint']),/size_bytes_check/);
      await rpc(SUPERVISOR,'ci_resolve_vendor_issue',[issue,'vendor_replaced_goods','ผู้ขายเปลี่ยนสินค้าแล้ว'],['uuid','text','text']);
      await assert.rejects(rpc(STAFF,'ci_register_vendor_issue_attachment',[issue,'late.jpg','image/jpeg',10],['uuid','text','text','bigint']),/CI_ISSUE_NOT_OPEN/);
      await assert.rejects(rpc(SUPERVISOR,'ci_resolve_vendor_issue',[issue,'vendor_warned','again'],['uuid','text','text']),/CI_ISSUE_NOT_OPEN/);
      await assert.rejects(rpc(STAFF,'ci_remove_vendor_issue_attachment',[att.attachment_id],['uuid']),/CI_ISSUE_NOT_OPEN/);
      await assert.rejects(rpc(SUPERVISOR,'ci_cancel_vendor_issue',[issue,'duplicate',null],['uuid','text','text']),/CI_ACCESS_DENIED/);
      await assert.rejects(rpc(ADMIN,'ci_cancel_vendor_issue',[issue,'other',null],['uuid','text','text']),/CI_ISSUE_CANCEL_NOTE_REQUIRED/);
      await assert.rejects(rpc(ADMIN,'ci_cancel_vendor_issue',[issue,'assessment_corrected',null],['uuid','text','text']),/CI_ISSUE_CANCEL_REASON_INVALID/);
      await rpc(ADMIN,'ci_cancel_vendor_issue',[issue,'opened_in_error',null],['uuid','text','text']);
      await assert.rejects(rpc(ADMIN,'ci_cancel_vendor_issue',[issue,'duplicate',null],['uuid','text','text']),/CI_ISSUE_ALREADY_CANCELLED/);
      const row=await asUser(ADMIN,c=>c.query('select status,resolution_action,cancelled_reason from public.ci_vendor_issues where id=$1',[issue]));
      assert.equal(row.rows[0].status,'cancelled');assert.equal(row.rows[0].resolution_action,'vendor_replaced_goods');assert.equal(row.rows[0].cancelled_reason,'opened_in_error');
      const hidden=await asUser(IMM_VIEWER,c=>c.query('select count(*)::int n from public.ci_vendor_issue_attachments'));
      assert.equal(hidden.rows[0].n,0,'the IMM viewer must not see CHE evidence');
    });

    await t.test('vendor metrics count live work only: cancelled issues drop out',async()=>{
      const m=await asUser(ADMIN,c=>c.query('select issue_count,open_issue_count from public.ci_vendor_metrics where vendor_id=$1 and warehouse_id=1',[vendor]));
      assert.equal(Number(m.rows[0].open_issue_count),2);assert.equal(Number(m.rows[0].issue_count),2);
    });

    const CRITERIA=['delivery_completeness','shelf_life','product_packaging','documentation','item_correctness','cold_chain','complaint_performance','corrective_action'];
    const weights=(w:number[])=>CRITERIA.map((criterionCode,i)=>({criterionCode,weight:w[i]}));
    const policyInput=(version:string,from=FY,to:number|null=FY+5)=>({version,effectiveFromFiscalYear:from,effectiveToFiscalYear:to,passThreshold:80,minimumCoveragePercent:70,coverageStartDate:'2026-09-25',note:'QP'});
    let policyId='';

    await t.test('policy: seeded V1 carries the LABCBH-Stock numbers but is still an unapproved proposal',async()=>{
      const v1=await asUser(ADMIN,c=>c.query("select id,status,pass_threshold,minimum_coverage_percent,effective_from_fiscal_year,effective_to_fiscal_year,coverage_start_date::text d,approved_by from public.ci_vendor_evaluation_policies where version='VE-POLICY-V1'"));
      assert.equal(v1.rows[0].status,'proposed');assert.equal(v1.rows[0].approved_by,null);
      assert.equal(Number(v1.rows[0].pass_threshold),80);assert.equal(Number(v1.rows[0].minimum_coverage_percent),80);
      assert.equal(v1.rows[0].effective_from_fiscal_year,2569);assert.equal(v1.rows[0].effective_to_fiscal_year,null);assert.equal(v1.rows[0].d,'2026-09-23');
      const crit=await asUser(ADMIN,c=>c.query('select criterion_code,weight from public.ci_vendor_evaluation_policy_criteria where policy_id=$1 order by display_order',[v1.rows[0].id]));
      assert.deepEqual(crit.rows.map(r=>Number(r.weight)),[20,15,10,10,15,15,10,5]);
      await assert.rejects(rpc(SUPERVISOR,'ci_approve_vendor_evaluation_policy',[v1.rows[0].id],['uuid']),/CI_ACCESS_DENIED/);
    });

    await t.test('policy: only an admin of every warehouse may propose or approve; weights must total 100 over the 8 criteria',async()=>{
      const good=weights([15,10,15,15,15,10,10,10]);
      await assert.rejects(rpc(SUPERVISOR,'ci_save_vendor_evaluation_policy_proposal',[null,policyInput('QP-1'),good],['uuid','jsonb','jsonb']),/CI_ACCESS_DENIED/);
      await assert.rejects(rpc(STAFF,'ci_save_vendor_evaluation_policy_proposal',[null,policyInput('QP-1'),good],['uuid','jsonb','jsonb']),/CI_ACCESS_DENIED/);
      await assert.rejects(rpc(ADMIN,'ci_save_vendor_evaluation_policy_proposal',[null,policyInput('QP-1'),weights([15,10,15,15,15,10,10,9])],['uuid','jsonb','jsonb']),/CI_POLICY_WEIGHT_TOTAL/);
      await assert.rejects(rpc(ADMIN,'ci_save_vendor_evaluation_policy_proposal',[null,policyInput('QP-1'),good.slice(0,7)],['uuid','jsonb','jsonb']),/CI_POLICY_CRITERIA_INCOMPLETE/);
      await assert.rejects(rpc(ADMIN,'ci_save_vendor_evaluation_policy_proposal',[null,policyInput('QP-1'),[...good.slice(0,7),{criterionCode:'shelf_life',weight:10}]],['uuid','jsonb','jsonb']),/CI_POLICY_CRITERIA_INCOMPLETE/);
      await assert.rejects(rpc(ADMIN,'ci_save_vendor_evaluation_policy_proposal',[null,{...policyInput('QP-1'),hack:1},good],['uuid','jsonb','jsonb']),/CI_POLICY_INPUT_INVALID/);
      // New proposals take their definitions from the seed policy even after someone renames it.
      const renamer=await connect();
      try{await renamer.query("update public.ci_vendor_evaluation_policies set version='V1-RENAMED' where version='VE-POLICY-V1'");}finally{await renamer.end();}
      policyId=await rpc<string>(ADMIN,'ci_save_vendor_evaluation_policy_proposal',[null,policyInput('QP-1'),good],['uuid','jsonb','jsonb']);
      const edited=await rpc<string>(ADMIN,'ci_save_vendor_evaluation_policy_proposal',[policyId,{...policyInput('QP-1'),passThreshold:75},weights([20,10,10,15,15,10,10,10])],['uuid','jsonb','jsonb']);
      assert.equal(edited,policyId);
      const row=await asUser(ADMIN,c=>c.query('select pass_threshold from public.ci_vendor_evaluation_policies where id=$1',[policyId]));
      assert.equal(Number(row.rows[0].pass_threshold),75);
      const copied=await asUser(ADMIN,c=>c.query("select label,evidence_definition,weight from public.ci_vendor_evaluation_policy_criteria where policy_id=$1 and criterion_code='delivery_completeness'",[policyId]));
      assert.equal(Number(copied.rows[0].weight),20);assert.match(copied.rows[0].evidence_definition,/Invoice/);
    });

    await t.test('policy: approval stamps the approver, freezes the policy and its criteria, and refuses overlapping years',async()=>{
      await assert.rejects(rpc(SUPERVISOR,'ci_approve_vendor_evaluation_policy',[policyId],['uuid']),/CI_ACCESS_DENIED/);
      await rpc(ADMIN,'ci_approve_vendor_evaluation_policy',[policyId],['uuid']);
      const row=await asUser(ADMIN,c=>c.query('select status,approved_by,approved_by_name_snapshot from public.ci_vendor_evaluation_policies where id=$1',[policyId]));
      assert.equal(row.rows[0].status,'approved');assert.equal(row.rows[0].approved_by,ADMIN);assert.equal(row.rows[0].approved_by_name_snapshot,'Admin');
      await assert.rejects(rpc(ADMIN,'ci_save_vendor_evaluation_policy_proposal',[policyId,policyInput('QP-1'),weights([15,10,15,15,15,10,10,10])],['uuid','jsonb','jsonb']),/CI_POLICY_FROZEN/);
      await assert.rejects(rpc(ADMIN,'ci_approve_vendor_evaluation_policy',[policyId],['uuid']),/CI_POLICY_NOT_PROPOSED/);
      const owner=await connect();
      try{
        await assert.rejects(owner.query("update public.ci_vendor_evaluation_policy_criteria set weight=1 where policy_id=$1 and criterion_code='shelf_life'",[policyId]),/CI_POLICY_FROZEN/);
        await assert.rejects(owner.query('delete from public.ci_vendor_evaluation_policies where id=$1',[policyId]),/CI_POLICY_FROZEN/);
      }finally{await owner.end();}
      // Starting no later than an approved policy's first year cannot take over from it: that is an overlap, not a succession.
      const overlap=await rpc<string>(ADMIN,'ci_save_vendor_evaluation_policy_proposal',[null,policyInput('QP-2',FY,null),weights([15,10,15,15,15,10,10,10])],['uuid','jsonb','jsonb']);
      await assert.rejects(rpc(ADMIN,'ci_approve_vendor_evaluation_policy',[overlap],['uuid']),/CI_POLICY_OVERLAP/);
      const fine=await rpc<string>(ADMIN,'ci_save_vendor_evaluation_policy_proposal',[overlap,policyInput('QP-2',FY,null),weights([15,10,15,15,15,10,10,10])],['uuid','jsonb','jsonb']);
      assert.equal(fine,overlap);
    });

    const PNG='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    let revisionId='';

    await t.test('signers: positions are self-service or admin-set, signatures are private PNG data URLs',async()=>{
      await assert.rejects(rpc(SUPERVISOR,'ci_set_user_position',[STAFF,'เจ้าหน้าที่'],['uuid','text']),/CI_ACCESS_DENIED/);
      await rpc(ADMIN,'ci_set_user_position',[STAFF,'นักเทคนิคการแพทย์'],['uuid','text']);
      await rpc(SUPERVISOR,'ci_set_user_position',[SUPERVISOR,'นักเทคนิคการแพทย์ชำนาญการ'],['uuid','text']);
      await rpc(ADMIN,'ci_set_user_position',[ADMIN,'หัวหน้ากลุ่มงานเทคนิคการแพทย์'],['uuid','text']);
      await assert.rejects(rpc(SUPERVISOR,'ci_save_my_signature',['not-a-png'],['text']),/CI_SIGNATURE_INVALID/);
      await assert.rejects(rpc(SUPERVISOR,'ci_save_my_signature',['data:image/png;base64,'+'A'.repeat(400001)],['text']),/CI_SIGNATURE_INVALID/);
      await rpc(SUPERVISOR,'ci_save_my_signature',[PNG],['text']);
      const others=await asUser(ADMIN,c=>c.query('select count(*)::int n from public.ci_user_signatures'));
      assert.equal(others.rows[0].n,0,'an admin must not read another person\'s signature');
      const own=await asUser(SUPERVISOR,c=>c.query('select count(*)::int n from public.ci_user_signatures'));
      assert.equal(own.rows[0].n,1);
      await assert.rejects(rpc(STAFF,'ci_list_evaluation_signers',[],[]),/CI_ACCESS_DENIED/);
      const list=await rpc<{id:string;position:string;hasSignature:boolean}[]>(SUPERVISOR,'ci_list_evaluation_signers',[],[]);
      assert.equal(list.length,3);assert.equal(list.find(s=>s.id===SUPERVISOR)!.hasSignature,true);assert.equal(list.find(s=>s.id===ADMIN)!.hasSignature,false);
    });

    await t.test('draft: role-bound, one open draft per vendor+warehouse+year, snapshot of the 8 criteria, policy picked by year',async()=>{
      await assert.rejects(rpc(STAFF,'ci_create_vendor_annual_evaluation_draft',[vendor,1,FY],['uuid','smallint','integer']),/CI_ACCESS_DENIED/);
      await assert.rejects(rpc(SUPERVISOR,'ci_create_vendor_annual_evaluation_draft',[vendor,2,FY],['uuid','smallint','integer']),/CI_ACCESS_DENIED/);
      await assert.rejects(rpc(SUPERVISOR,'ci_create_vendor_annual_evaluation_draft',[vendor,1,1999],['uuid','smallint','integer']),/CI_FISCAL_YEAR_INVALID/);
      revisionId=await rpc<string>(SUPERVISOR,'ci_create_vendor_annual_evaluation_draft',[vendor,1,FY],['uuid','smallint','integer']);
      assert.equal(await rpc<string>(SUPERVISOR,'ci_create_vendor_annual_evaluation_draft',[vendor,1,FY],['uuid','smallint','integer']),revisionId);
      const row=await asUser(SUPERVISOR,c=>c.query('select r.status,r.revision_number,r.evidence_snapshot,p.version from public.ci_vendor_annual_evaluation_revisions r join public.ci_vendor_evaluation_policies p on p.id=r.policy_id where r.id=$1',[revisionId]));
      assert.equal(row.rows[0].status,'draft');assert.equal(row.rows[0].revision_number,1);assert.equal(row.rows[0].version,'QP-1');
      assert.equal(row.rows[0].evidence_snapshot.criteria.length,8);assert.equal(row.rows[0].evidence_snapshot.fiscalYear,FY);
      const hidden=await asUser(IMM_VIEWER,c=>c.query('select count(*)::int n from public.ci_vendor_annual_evaluation_revisions'));
      assert.equal(hidden.rows[0].n,0,'IMM users must not see CHE evaluations');
    });

    await t.test('finalize: every precondition is enforced, evidence must be current, then score and report number are computed',async()=>{
      await assert.rejects(rpc(SUPERVISOR,'ci_finalize_vendor_annual_evaluation',[revisionId],['uuid']),/CI_ANNUAL_TEXT_REQUIRED/);
      const text={summary:'สรุปผล',strengths:'ส่งของตรงเวลา',risksConcerns:'บรรจุภัณฑ์บุบบางครั้ง',recommendations:'ติดตามต่อ'};
      await assert.rejects(rpc(SUPERVISOR,'ci_save_vendor_annual_evaluation_draft',[revisionId,{...text,hack:1}],['uuid','jsonb']),/CI_ANNUAL_INPUT_INVALID/);
      await rpc(SUPERVISOR,'ci_save_vendor_annual_evaluation_draft',[revisionId,text],['uuid','jsonb']);
      await assert.rejects(rpc(SUPERVISOR,'ci_finalize_vendor_annual_evaluation',[revisionId],['uuid']),/CI_ANNUAL_SIGNERS_REQUIRED/);
      const noPosition='55555555-5555-4555-8555-555555555555';
      const owner=await connect();
      try{await owner.query("insert into auth.users(id) values ($1)",[noPosition]);await owner.query("insert into public.ci_user_profiles(user_id,ephis_id,display_name) values ($1,'nopos','No Position')",[noPosition]);}finally{await owner.end();}
      await assert.rejects(rpc(SUPERVISOR,'ci_save_vendor_annual_evaluation_draft',[revisionId,{...text,evaluatorId:noPosition}],['uuid','jsonb']),/CI_SIGNER_POSITION_REQUIRED/);
      const signers={evaluatorId:SUPERVISOR,reviewerId:STAFF,approverId:ADMIN};
      await rpc(SUPERVISOR,'ci_save_vendor_annual_evaluation_draft',[revisionId,{...text,...signers}],['uuid','jsonb']);
      await assert.rejects(rpc(SUPERVISOR,'ci_finalize_vendor_annual_evaluation',[revisionId],['uuid']),/CI_ANNUAL_SIGNATURE_MISSING/);
      await rpc(STAFF,'ci_save_my_signature',[PNG],['text']);await rpc(ADMIN,'ci_save_my_signature',[PNG],['text']);
      // Evidence changes after the draft was captured: finalizing on stale numbers must fail until refreshed.
      await rpc(SUPERVISOR,'ci_open_vendor_issue',[vendor,1,'complaint','ข้อร้องเรียนหลังร่าง',null],['uuid','smallint','text','text','uuid']);
      await assert.rejects(rpc(SUPERVISOR,'ci_finalize_vendor_annual_evaluation',[revisionId],['uuid']),/CI_ANNUAL_EVIDENCE_STALE/);
      await rpc(SUPERVISOR,'ci_refresh_vendor_annual_evaluation_draft',[revisionId],['uuid']);
      const number=await rpc<string>(SUPERVISOR,'ci_finalize_vendor_annual_evaluation',[revisionId],['uuid']);
      assert.equal(number,`VE-${FY}-0001`);
      const row=await asUser(ADMIN,c=>c.query('select status,report_number,frozen_snapshot,evaluator_signature,approver_position_snapshot from public.ci_vendor_annual_evaluation_revisions where id=$1',[revisionId]));
      assert.equal(row.rows[0].status,'final');assert.equal(row.rows[0].approver_position_snapshot,'หัวหน้ากลุ่มงานเทคนิคการแพทย์');assert.equal(row.rows[0].evaluator_signature,PNG);
      const f=row.rows[0].frozen_snapshot as {score:number;result:string;policy:{version:string;passThreshold:string|number};criteria:{applicable:boolean;numerator:number;denominator:number;weight:string|number;weightedScore:number|null}[]};
      const applicable=f.criteria.filter(c=>c.applicable);const totalWeight=applicable.reduce((s,c)=>s+Number(c.weight),0);
      const expected=applicable.reduce((s,c)=>s+(c.numerator/c.denominator)*Number(c.weight)/totalWeight*100,0);
      assert.ok(Math.abs(Number(f.score)-expected)<0.01,`score ${f.score} should equal weighted share ${expected}`);
      assert.ok(f.criteria.some(c=>!c.applicable),'a criterion without data (cold chain) drops out and its weight is redistributed');
      assert.equal(f.result,Number(f.score)>=Number(f.policy.passThreshold)?'pass':'fail');assert.equal(f.policy.version,'QP-1');
    });

    await t.test('final reports are records: no edit, no delete, no refinalize; a new draft is revision 2 that supersedes and keeps the wording',async()=>{
      await assert.rejects(rpc(SUPERVISOR,'ci_save_vendor_annual_evaluation_draft',[revisionId,{summary:'x'}],['uuid','jsonb']),/CI_ANNUAL_REVISION_IMMUTABLE/);
      await assert.rejects(rpc(SUPERVISOR,'ci_finalize_vendor_annual_evaluation',[revisionId],['uuid']),/CI_ANNUAL_REVISION_IMMUTABLE/);
      const owner=await connect();
      try{
        await assert.rejects(owner.query("update public.ci_vendor_annual_evaluation_revisions set judgment_summary='tampered' where id=$1",[revisionId]),/CI_ANNUAL_REVISION_IMMUTABLE/);
        await assert.rejects(owner.query('delete from public.ci_vendor_annual_evaluation_revisions where id=$1',[revisionId]),/CI_ANNUAL_REVISION_IMMUTABLE/);
      }finally{await owner.end();}
      const second=await rpc<string>(SUPERVISOR,'ci_create_vendor_annual_evaluation_draft',[vendor,1,FY],['uuid','smallint','integer']);
      assert.notEqual(second,revisionId);
      const row=await asUser(SUPERVISOR,c=>c.query('select revision_number,supersedes_revision_id,judgment_summary,evaluator_id,evaluator_signature from public.ci_vendor_annual_evaluation_revisions where id=$1',[second]));
      assert.equal(row.rows[0].revision_number,2);assert.equal(row.rows[0].supersedes_revision_id,revisionId);assert.equal(row.rows[0].judgment_summary,'สรุปผล');assert.equal(row.rows[0].evaluator_id,SUPERVISOR);assert.equal(row.rows[0].evaluator_signature,null);
      await rpc(SUPERVISOR,'ci_finalize_vendor_annual_evaluation',[second],['uuid']);
      const numbers=await asUser(ADMIN,c=>c.query('select report_number from public.ci_vendor_annual_evaluation_revisions where status=$1 order by report_sequence',['final']));
      assert.deepEqual(numbers.rows.map(r=>r.report_number),[`VE-${FY}-0001`,`VE-${FY}-0002`]);
      const current=await asUser(SUPERVISOR,c=>c.query('select current_final_revision_id from public.ci_vendor_annual_evaluations where vendor_id=$1 and warehouse_id=1 and fiscal_year=$2',[vendor,FY]));
      assert.equal(current.rows[0].current_final_revision_id,second);
    });

    await t.test('finalize refuses an unapproved policy and a warehouse with no data to score',async()=>{
      await assert.rejects(rpc(ADMIN,'ci_create_vendor_annual_evaluation_draft',[vendor,1,FY-1],['uuid','smallint','integer']),/CI_POLICY_NOT_FOUND/);
      const next=await rpc<string>(ADMIN,'ci_create_vendor_annual_evaluation_draft',[vendor,1,FY+6],['uuid','smallint','integer']);
      const usedPolicy=await asUser(ADMIN,c=>c.query('select p.version,p.status from public.ci_vendor_annual_evaluation_revisions r join public.ci_vendor_evaluation_policies p on p.id=r.policy_id where r.id=$1',[next]));
      assert.equal(usedPolicy.rows[0].status,'proposed');
      await assert.rejects(rpc(ADMIN,'ci_finalize_vendor_annual_evaluation',[next],['uuid']),/CI_POLICY_NOT_APPROVED/);
      // Once an approved policy covers that year, refreshing moves the draft onto it instead of leaving it stuck on the proposal.
      const qp3=await rpc<string>(ADMIN,'ci_save_vendor_evaluation_policy_proposal',[null,policyInput('QP-3',FY+6,FY+8),weights([15,10,15,15,15,10,10,10])],['uuid','jsonb','jsonb']);
      await rpc(ADMIN,'ci_approve_vendor_evaluation_policy',[qp3],['uuid']);
      await rpc(ADMIN,'ci_refresh_vendor_annual_evaluation_draft',[next],['uuid']);
      const moved=await asUser(ADMIN,c=>c.query('select p.version,p.status from public.ci_vendor_annual_evaluation_revisions r join public.ci_vendor_evaluation_policies p on p.id=r.policy_id where r.id=$1',[next]));
      assert.equal(moved.rows[0].version,'QP-3');assert.equal(moved.rows[0].status,'approved');
      await assert.rejects(rpc(ADMIN,'ci_finalize_vendor_annual_evaluation',[next],['uuid']),/CI_ANNUAL_TEXT_REQUIRED/);
      await assert.rejects(rpc(ADMIN,'ci_create_vendor_annual_evaluation_draft',['99999999-9999-4999-8999-999999999999',1,FY],['uuid','smallint','integer']),/CI_VENDOR_NOT_FOUND/);
      // A newer QP takes over: approving QP-4 from FY+8 ends QP-3 at FY+7; nothing else about QP-3 may change.
      const qp4=await rpc<string>(ADMIN,'ci_save_vendor_evaluation_policy_proposal',[null,policyInput('QP-4',FY+8,null),weights([15,10,15,15,15,10,10,10])],['uuid','jsonb','jsonb']);
      await rpc(ADMIN,'ci_approve_vendor_evaluation_policy',[qp4],['uuid']);
      const ended=await asUser(ADMIN,c=>c.query('select effective_from_fiscal_year f,effective_to_fiscal_year t,status from public.ci_vendor_evaluation_policies where id=$1',[qp3]));
      assert.equal(ended.rows[0].t,FY+7);assert.equal(ended.rows[0].status,'approved');
      const guard=await connect();
      try{await assert.rejects(guard.query('update public.ci_vendor_evaluation_policies set pass_threshold=1 where id=$1',[qp3]),/CI_POLICY_FROZEN/);await assert.rejects(guard.query('update public.ci_vendor_evaluation_policies set effective_to_fiscal_year=null where id=$1',[qp3]),/CI_POLICY_FROZEN/);}finally{await guard.end();}
      const imm=await rpc<string>(ADMIN,'ci_create_vendor_annual_evaluation_draft',[vendor,2,FY],['uuid','smallint','integer']);
      await rpc(ADMIN,'ci_save_vendor_annual_evaluation_draft',[imm,{summary:'a',strengths:'b',risksConcerns:'c',recommendations:'d',evaluatorId:ADMIN,reviewerId:ADMIN,approverId:ADMIN}],['uuid','jsonb']);
      await assert.rejects(rpc(ADMIN,'ci_finalize_vendor_annual_evaluation',[imm],['uuid']),/CI_ANNUAL_NO_APPLICABLE_CRITERIA/);
    });

    await t.test('fiscal year in Buddhist era turns over on 1 October',async()=>{
      const fy=await asUser(ADMIN,c=>c.query("select ci_private.fiscal_year_be('2026-09-30') a, ci_private.fiscal_year_be('2026-10-01') b"));
      assert.equal(fy.rows[0].a,2569);assert.equal(fy.rows[0].b,2570);
    });
  }finally{await cleanup();}
});
