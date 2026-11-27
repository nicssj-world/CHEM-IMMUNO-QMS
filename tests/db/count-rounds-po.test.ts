import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { Client } from 'pg';

// DATABASE ISOLATION: PostgreSQL is loopback-only, disposable and never Production.
const root=process.env.CI_TEST_DATABASE_URL;
if(!root) throw new Error('Set CI_TEST_DATABASE_URL to a disposable loopback PostgreSQL /postgres');
const rootUrl=new URL(root);
if(!['localhost','127.0.0.1','::1'].includes(rootUrl.hostname) || rootUrl.pathname!=='/postgres')
  throw new Error('Only disposable loopback PostgreSQL /postgres is allowed');
const databaseName=`ci_rounds_po_${process.pid}_${Math.floor(Math.random()*100000)}`;
const databaseUrl=new URL(rootUrl); databaseUrl.pathname=`/${databaseName}`;
const ADMIN='11111111-1111-4111-8111-111111111111';
const STAFF='22222222-2222-4222-8222-222222222222';   // staff in both groups
const STAFF2='33333333-3333-4333-8333-333333333333';  // another staff in both groups
const CHE_ONLY='44444444-4444-4444-8444-444444444444'; // staff CHE only
const SUPER='55555555-5555-4555-8555-555555555555';    // supervisor both

async function owner<T>(fn:(client:Client)=>Promise<T>) {
  const client=new Client({connectionString:databaseUrl.toString()}); await client.connect();
  try{return await fn(client);}finally{await client.end();}
}
async function session(user:string) {
  const client=new Client({connectionString:databaseUrl.toString()}); await client.connect();
  await client.query('BEGIN');
  await client.query('SET LOCAL ROLE authenticated');
  await client.query("SELECT set_config('request.jwt.claim.sub',$1,true)",[user]);
  return client;
}
async function actor<T>(user:string,fn:(client:Client)=>Promise<T>) {
  const client=await session(user);
  try{ const value=await fn(client); await client.query('COMMIT'); return value; }
  catch(error){ await client.query('ROLLBACK'); throw error; }
  finally{ await client.end(); }
}
async function rpc<T>(user:string,name:string,values:unknown[],casts:string[]) {
  return actor(user,async client=>{
    const args=values.map((_,i)=>`$${i+1}::${casts[i]}`).join(',');
    const result=await client.query<{result:T}>(`SELECT public.${name}(${args}) result`,values.map((v,i)=>casts[i]==='jsonb'?JSON.stringify(v):v));
    return result.rows[0].result;
  });
}
const ledger=()=>owner(async c=>(await c.query<{n:string;s:string}>('SELECT count(*) n, coalesce(sum(quantity_delta),0)::text s FROM ci_stock_movement_lines')).rows[0]);
const balance=(lot:string,location:string)=>owner(async c=>Number((await c.query<{b:string}>('SELECT coalesce(sum(quantity_delta),0) b FROM ci_stock_movement_lines WHERE lot_id=$1 AND location_id=$2',[lot,location])).rows[0].b));

test('count rounds v2, issue balance evidence and purchase orders',{timeout:300000},async t=>{
  const admin=new Client({connectionString:rootUrl.toString()});await admin.connect();
  try{await admin.query(`CREATE DATABASE ${databaseName}`);}finally{await admin.end();}
  try{
    await owner(async client=>{
      await client.query(await readFile('tests/db/bootstrap.sql','utf8'));
      const filenames=(await readdir('supabase/migrations')).filter(file=>file.endsWith('.sql')).sort();
      for(const filename of filenames) await client.query(await readFile(path.join('supabase/migrations',filename),'utf8'));
      await client.query('INSERT INTO auth.users(id) VALUES ($1),($2),($3),($4),($5)',[ADMIN,STAFF,STAFF2,CHE_ONLY,SUPER]);
      await client.query(`INSERT INTO ci_user_profiles(user_id,ephis_id,display_name,active) VALUES
        ($1,'admin1','Admin',true),($2,'staff1','Staff',true),($3,'staff2','Staff 2',true),($4,'cheonly','CHE',true),($5,'super1','Super',true)`,[ADMIN,STAFF,STAFF2,CHE_ONLY,SUPER]);
      await client.query(`INSERT INTO ci_user_access(user_id,warehouse_id,role) VALUES
        ($1,1,'admin'),($1,2,'admin'),($2,1,'staff'),($2,2,'staff'),($3,1,'staff'),($3,2,'staff'),($4,1,'staff'),($5,1,'supervisor'),($5,2,'supervisor')`,[ADMIN,STAFF,STAFF2,CHE_ONLY,SUPER]);
    });

    const fridge=await rpc<string>(ADMIN,'ci_create_location_v2',[{warehouse_id:1,code:'FRIDGE-01',name:'Fridge',location_type:'refrigerator'}],['jsonb']);
    const shelf=await rpc<string>(ADMIN,'ci_create_location_v2',[{warehouse_id:1,code:'FRIDGE-01-S1',name:'Shelf',location_type:'shelf',parent_location_id:fridge}],['jsonb']);
    const cabinet=await rpc<string>(ADMIN,'ci_create_location_v2',[{warehouse_id:1,code:'CAB-01',name:'Cabinet',location_type:'cabinet'}],['jsonb']);
    const product=(wh:number,name:string)=>rpc<string>(ADMIN,'ci_create_product',[{warehouse_id:wh,product_type:'reagent',source_name:name,current_ref:'REF-'+name,manufacturer_barcode:'BC-'+name}],['jsonb']);
    const cheA=await product(1,'CHEA'); const cheB=await product(1,'CHEB'); const immA=await product(2,'IMMA');
    // Seed stock through the ledger (owner) so every scenario starts from known balances.
    const lots=await owner(async client=>{
      const ins=async(wh:number,p:string,lot:string)=>(await client.query<{id:string}>(
        "INSERT INTO ci_stock_lots(warehouse_id,product_id,lot_number,expiry_date) VALUES ($1,$2,$3,'2099-12-31') RETURNING id",[wh,p,lot])).rows[0].id;
      const a1=await ins(1,cheA,'A-1'); const b1=await ins(1,cheB,'B-1'); const i1=await ins(2,immA,'I-1');
      const tx=async(wh:number,key:string)=>(await client.query<{id:string}>(
        "INSERT INTO ci_stock_transactions(warehouse_id,kind,idempotency_key,request_hash,actor_id) VALUES ($1,'adjustment',$2,$2,$3) RETURNING id",[wh,key,ADMIN])).rows[0].id;
      const t1=await tx(1,'seed-che'); const t2=await tx(2,'seed-imm');
      await client.query(`INSERT INTO ci_stock_movement_lines(transaction_id,warehouse_id,lot_id,location_id,quantity_delta) VALUES
        ($1,1,$3,$5,10),($1,1,$3,$6,4),($1,1,$4,$7,6),($2,2,$8,$5,8)`,[t1,t2,a1,b1,fridge,shelf,cabinet,i1]);
      return {a1,b1,i1};
    });
    const create=(user:string,data:Record<string,unknown>)=>rpc<string>(user,'ci_create_stock_count_round',[{client_key:randomUUID(),...data}],['jsonb']);
    const linesOf=(round:string)=>owner(async c=>(await c.query<{id:string;count_id:string;lot_id:string;location_id:string;snapshot_quantity:string;counted_at:string|null;needs_recount:boolean}>(
      `SELECT l.* FROM ci_stock_count_lines l JOIN ci_unified_stock_counts b ON l.count_id IN (b.che_count_id,b.imm_count_id) WHERE b.id=$1 ORDER BY l.lot_id,l.location_id`,[round])).rows);
    const setLine=(user:string,countId:string,lineId:string,counted:boolean,qty:number|null)=>
      rpc<{counted:boolean}>(user,'ci_set_stock_count_line_state',[countId,lineId,counted,qty],['uuid','uuid','boolean','numeric']);
    const finalize=(user:string,round:string)=>rpc<{status:string;adjusted_lines?:number;recount_lines?:number;already?:boolean;partial?:boolean}>(user,'ci_finalize_stock_count_round',[round],['uuid']);
    const remove=(user:string,ids:string[])=>rpc<number>(user,'ci_delete_stock_count_rounds',[ids],['uuid[]']);

    await t.test('scopes: all, group, location (with child shelf) and selected products; empty scope refused',async()=>{
      const all=await create(ADMIN,{scope_type:'all'});
      assert.equal((await linesOf(all)).length,4);
      await assert.rejects(create(ADMIN,{scope_type:'group',scope:{warehouse_id:2}}),/CI_COUNT_OPEN_ROUND_EXISTS/);
      const group=await create(ADMIN,{scope_type:'group',scope:{warehouse_id:2},allow_parallel:true});
      const groupLines=await linesOf(group); assert.equal(groupLines.length,1); assert.equal(groupLines[0].lot_id,lots.i1);
      const byLocation=await create(ADMIN,{scope_type:'locations',scope:{location_ids:[fridge]},allow_parallel:true});
      assert.equal((await linesOf(byLocation)).length,3,'fridge includes its shelf, for both groups');
      const byProduct=await create(ADMIN,{scope_type:'products',scope:{product_ids:[cheB]},allow_parallel:true});
      const productLines=await linesOf(byProduct); assert.equal(productLines.length,1); assert.equal(productLines[0].lot_id,lots.b1);
      const emptyLocation=await rpc<string>(ADMIN,'ci_create_location_v2',[{warehouse_id:1,code:'EMPTY-01',name:'Empty',location_type:'shelf'}],['jsonb']);
      await assert.rejects(create(ADMIN,{scope_type:'locations',scope:{location_ids:[emptyLocation]},allow_parallel:true}),/CI_COUNT_NO_STOCK/);
      await assert.rejects(create(CHE_ONLY,{scope_type:'group',scope:{warehouse_id:2},allow_parallel:true}),/CI_ACCESS_DENIED/);
      assert.equal(await remove(ADMIN,[all,group,byLocation,byProduct]),4);
    });

    await t.test('same client key: retry and double submit return one round; changed payload is refused',async()=>{
      const key=randomUUID();
      const payload={client_key:key,scope_type:'all',note:'monthly'};
      const [a,b]=await Promise.all([rpc<string>(STAFF,'ci_create_stock_count_round',[payload],['jsonb']),rpc<string>(STAFF,'ci_create_stock_count_round',[payload],['jsonb'])]);
      assert.equal(a,b);
      assert.equal(await rpc<string>(STAFF,'ci_create_stock_count_round',[{...payload,allow_parallel:true}],['jsonb']),a,'intent flag is not part of identity');
      await assert.rejects(rpc<string>(STAFF,'ci_create_stock_count_round',[{...payload,note:'other'}],['jsonb']),/CI_IDEMPOTENCY_PAYLOAD_CONFLICT/);
      assert.equal(await owner(async c=>Number((await c.query('SELECT count(*) n FROM ci_unified_stock_counts')).rows[0].n)),1);
      assert.equal(await remove(STAFF,[a]),1,'creator deletes own round');
    });

    await t.test('checklist: count, undo and partial finalize adjust only counted lines with a difference',async()=>{
      const before=await ledger();
      const round=await create(STAFF,{scope_type:'all'});
      const lines=await linesOf(round);
      const [aFridge,iFridge,bCab,aShelf]=lines.sort((x,y)=>Number(y.snapshot_quantity)-Number(x.snapshot_quantity)); // 10,8,6,4
      assert.deepEqual([aFridge,iFridge,bCab,aShelf].map(x=>Number(x.snapshot_quantity)),[10,8,6,4]);
      void aShelf;
      await assert.rejects(finalize(SUPER,round),/CI_COUNT_NOTHING_COUNTED/);
      await setLine(STAFF,aFridge.count_id,aFridge.id,true,9);     // -1
      await setLine(STAFF,iFridge.count_id,iFridge.id,true,8);     // matches
      await setLine(STAFF2,bCab.count_id,bCab.id,true,0);          // zero is a real count
      await setLine(STAFF2,bCab.count_id,bCab.id,false,null);      // undo -> not counted again
      await assert.rejects(setLine(STAFF,aFridge.count_id,aFridge.id,true,-1),/CI_COUNT_LINE_INVALID/);
      await assert.rejects(setLine(STAFF,iFridge.count_id,aFridge.id,true,1),/CI_COUNT_LINE_NOT_FOUND/,'line must belong to the count');
      await assert.rejects(setLine(CHE_ONLY,iFridge.count_id,iFridge.id,true,1),/CI_ACCESS_DENIED/);
      const progress=await owner(async c=>(await c.query('SELECT sum(total_lines)::int t,sum(counted_lines)::int k,sum(variance_lines)::int v FROM ci_stock_count_progress')).rows[0]);
      assert.deepEqual(progress,{t:4,k:2,v:1});
      await assert.rejects(finalize(STAFF,round),/CI_ACCESS_DENIED/,'staff count; supervisors finalize');
      const result=await finalize(SUPER,round);
      assert.equal(result.status,'approved'); assert.equal(result.adjusted_lines,1); assert.equal(result.partial,true);
      const after=await ledger();
      assert.equal(Number(after.n),Number(before.n)+1,'one adjustment line only');
      assert.equal(Number(after.s),Number(before.s)-1);
      assert.equal(await balance(bCab.lot_id,bCab.location_id),6,'uncounted line keeps its balance (never set to 0)');
      assert.equal((await finalize(SUPER,round)).already,true,'second finalize is a no-op');
      assert.equal(Number((await ledger()).n),Number(after.n));
      await assert.rejects(remove(ADMIN,[round]),/CI_COUNT_ROUND_FINAL/,'adjusted round cannot be deleted');
      await assert.rejects(setLine(STAFF,aFridge.count_id,aFridge.id,true,5),/CI_COUNT_NOT_EDITABLE/);
    });

    await t.test('stock moved on a counted line reopens only that line; movement on an uncounted line does not block',async()=>{
      const round=await create(STAFF,{scope_type:'group',scope:{warehouse_id:1}});
      const lines=await linesOf(round);
      const counted=lines.find(l=>l.lot_id===lots.b1)!;
      const other=lines.find(l=>l.lot_id===lots.a1 && Number(l.snapshot_quantity)===4)!;
      const untouched=lines.find(l=>l.lot_id===lots.a1 && Number(l.snapshot_quantity)===9)!;
      await setLine(STAFF,counted.count_id,counted.id,true,5);
      await setLine(STAFF,untouched.count_id,untouched.id,true,9);
      // A real issue on the counted line and on an uncounted line while counting.
      await rpc(STAFF,'ci_issue_stock',[{product_id:cheB,lot_id:lots.b1,location_id:cabinet,quantity:1,purpose:'Routine',idempotency_key:'during-count-1'}],['jsonb']);
      await rpc(STAFF,'ci_issue_stock',[{product_id:cheA,lot_id:lots.a1,location_id:shelf,quantity:1,purpose:'Routine',idempotency_key:'during-count-2',override_reason:'test'}],['jsonb']);
      const ledgerBefore=await ledger();
      const result=await finalize(ADMIN,round);
      assert.deepEqual(result,{status:'recount',recount_lines:1});
      assert.deepEqual(await ledger(),ledgerBefore,'nothing adjusted while a counted line conflicts');
      const reopened=(await linesOf(round)).find(l=>l.id===counted.id)!;
      assert.equal(reopened.needs_recount,true); assert.equal(reopened.counted_at,null); assert.equal(Number(reopened.snapshot_quantity),5);
      assert.ok((await linesOf(round)).find(l=>l.id===untouched.id)!.counted_at,'other counted lines stay counted');
      await setLine(STAFF,counted.count_id,counted.id,true,5);
      const ok=await finalize(ADMIN,round);
      assert.equal(ok.status,'approved'); assert.equal(ok.adjusted_lines,0,'counts that match create no adjustment');
      assert.equal(await balance(lots.a1,shelf),3,'uncounted line moved freely and was not overwritten');
      void other;
    });

    await t.test('concurrent finalize adjusts once; delete waits for finalize and then refuses',async()=>{
      const round=await create(ADMIN,{scope_type:'products',scope:{product_ids:[immA]},allow_parallel:true});
      const [line]=await linesOf(round);
      await setLine(ADMIN,line.count_id,line.id,true,7);
      const first=await session(ADMIN); const second=await session(SUPER); const third=await session(ADMIN);
      try{
        await first.query('SELECT ci_finalize_stock_count_round($1)',[round]);
        let settled=false;
        const pending=second.query<{r:{status:string;already:boolean}}>('SELECT ci_finalize_stock_count_round($1) r',[round]).then(r=>{settled=true;return r;});
        const deleting=third.query('SELECT ci_delete_stock_count_rounds($1::uuid[])',[[round]]).then(()=>'deleted',(e:Error)=>e.message);
        await new Promise(resolve=>setTimeout(resolve,100));
        assert.equal(settled,false,'second finalize waits for the first');
        await first.query('COMMIT');
        assert.equal((await pending).rows[0].r.already,true);
        await second.query('COMMIT');
        assert.match(await deleting,/CI_COUNT_ROUND_FINAL/);
        await third.query('ROLLBACK');
      }finally{await first.end();await second.end();await third.end();}
      const adjustments=await owner(async c=>Number((await c.query("SELECT count(*) n FROM ci_stock_transactions WHERE kind='adjustment' AND idempotency_key LIKE 'count:%'")).rows[0].n));
      assert.equal(adjustments,2,'one adjustment per approved count with a difference, never doubled');
    });

    await t.test('delete permissions, bulk atomicity and no ledger or orphan side effects',async()=>{
      const mine=await create(STAFF,{scope_type:'all',allow_parallel:true});
      const theirs=await create(STAFF2,{scope_type:'all',allow_parallel:true});
      const [line]=await linesOf(theirs);
      await setLine(STAFF2,line.count_id,line.id,true,1); // partly counted is still deletable
      const before=await ledger();
      await assert.rejects(remove(STAFF,[theirs]),/CI_ACCESS_DENIED/,'staff cannot delete another person’s round');
      await assert.rejects(remove(STAFF,[mine,theirs]),/CI_ACCESS_DENIED/);
      assert.equal(await owner(async c=>Number((await c.query('SELECT count(*) n FROM ci_unified_stock_counts WHERE id=ANY($1)',[[mine,theirs]])).rows[0].n)),2,'failed bulk delete deletes nothing');
      assert.equal(await remove(ADMIN,[mine,theirs]),2,'admin deletes any unadjusted round');
      assert.deepEqual(await ledger(),before);
      const orphans=await owner(async c=>(await c.query(`SELECT
        (SELECT count(*) FROM ci_stock_count_lines l WHERE NOT EXISTS(SELECT 1 FROM ci_stock_counts c WHERE c.id=l.count_id))::int lines,
        (SELECT count(*) FROM ci_stock_counts c WHERE c.status='draft' AND NOT EXISTS(SELECT 1 FROM ci_unified_stock_counts b WHERE c.id IN (b.che_count_id,b.imm_count_id)))::int counts`)).rows[0]);
      assert.deepEqual(orphans,{lines:0,counts:0});
    });

    await t.test('legacy standalone count can be read through shared locations, finalized partially and deleted',async()=>{
      const legacy=await rpc<string>(ADMIN,'ci_create_stock_count',[{warehouse_id:1,note:'legacy',lines:[{lot_id:lots.b1,location_id:cabinet},{lot_id:lots.a1,location_id:fridge}]}],['jsonb']);
      const rows=await actor(STAFF,c=>c.query('SELECT l.id,l.location_id,loc.code FROM ci_stock_count_lines l JOIN ci_locations loc ON loc.id=l.location_id WHERE l.count_id=$1',[legacy]));
      assert.equal(rows.rowCount,2);
      const old=rows.rows[0].id as string;
      await rpc(STAFF,'ci_set_stock_count_line',[old,3],['uuid','numeric']);
      assert.ok((await owner(c=>c.query('SELECT counted_at FROM ci_stock_count_lines WHERE id=$1',[old]))).rows[0].counted_at,'previous RPC still works and marks counted');
      assert.equal(await remove(ADMIN,[legacy]),1);
    });

    await t.test('issue evidence records exact before / after balances for single and grouped issues',async()=>{
      const tx=await rpc<string>(STAFF,'ci_issue_stock',[{product_id:cheB,lot_id:lots.b1,location_id:cabinet,quantity:2,purpose:'QC',idempotency_key:'evidence-1'}],['jsonb']);
      const rows=await actor(STAFF,c=>c.query('SELECT quantity,lot_location_before,lot_location_after,product_after FROM ci_issue_balance_results WHERE transaction_id=$1',[tx]));
      assert.deepEqual(rows.rows.map(r=>[Number(r.quantity),Number(r.lot_location_before),Number(r.lot_location_after),Number(r.product_after)]),[[2,5,3,3]]);
      // Retrying the same key is idempotent and writes no second evidence row.
      assert.equal(await rpc<string>(STAFF,'ci_issue_stock',[{product_id:cheB,lot_id:lots.b1,location_id:cabinet,quantity:2,purpose:'QC',idempotency_key:'evidence-1'}],['jsonb']),tx);
      assert.equal((await owner(c=>c.query('SELECT count(*) n FROM ci_issue_balance_results WHERE transaction_id=$1',[tx]))).rows[0].n,'1');
      const group=await rpc<string>(STAFF,'ci_issue_group_now',[{client_key:randomUUID(),purpose:'Routine',lines:[
        {product_id:cheA,lot_id:lots.a1,location_id:fridge,quantity:2},{product_id:cheA,lot_id:lots.a1,location_id:shelf,quantity:3,override_reason:'same lot'},
        {product_id:cheB,lot_id:lots.b1,location_id:cabinet,quantity:3}]}],['jsonb']);
      const evidence=await actor(STAFF,c=>c.query(`SELECT r.lot_location_after,r.product_after,r.sequence,r.product_id FROM ci_issue_balance_results r
        JOIN ci_issue_group_transactions g ON g.transaction_id=r.transaction_id WHERE g.group_id=$1 ORDER BY r.sequence`,[group]));
      assert.equal(evidence.rowCount,3);
      const lastA=evidence.rows.filter(r=>r.product_id===cheA).at(-1)!;
      assert.equal(Number(lastA.product_after),await owner(async c=>Number((await c.query('SELECT sum(balance) b FROM ci_stock_balances WHERE product_id=$1',[cheA])).rows[0].b)));
      assert.ok(evidence.rows.some(r=>Number(r.lot_location_after)===0),'issuing a whole LOT/location shows 0 left');
      const hidden=await actor(CHE_ONLY,c=>c.query("SELECT count(*) n FROM ci_issue_balance_results WHERE warehouse_id=2"));
      assert.equal(hidden.rows[0].n,'0');
    });

    await t.test('purchase orders: templates, 30-day issues net of reversals, ROP default data, snapshots and numbering',async()=>{
      const stockBefore=await ledger();
      await assert.rejects(rpc(STAFF,'ci_save_purchase_order_template',[{name:'Dup',product_ids:[cheA,cheA]}],['jsonb']),/CI_PO_DUPLICATE_PRODUCT/);
      const template=await rpc<string>(STAFF,'ci_save_purchase_order_template',[{name:'น้ำยา Clinical Chemistry',product_ids:[cheB,cheA,immA]}],['jsonb']);
      await assert.rejects(rpc(STAFF2,'ci_save_purchase_order_template',[{name:'น้ำยา clinical chemistry ',product_ids:[]}],['jsonb']),/CI_PO_TEMPLATE_NAME_EXISTS/);
      await assert.rejects(rpc(STAFF2,'ci_save_purchase_order_template',[{id:template,name:'X',product_ids:[]}],['jsonb']),/CI_ACCESS_DENIED/);
      await rpc(STAFF,'ci_save_purchase_order_template',[{id:template,name:'น้ำยา Clinical Chemistry',product_ids:[cheA,cheB]}],['jsonb']);
      const tlines=await actor(STAFF,c=>c.query('SELECT product_id FROM ci_purchase_order_template_lines WHERE template_id=$1 ORDER BY display_order',[template]));
      assert.deepEqual(tlines.rows.map(r=>r.product_id),[cheA,cheB]);
      const cheOnlyView=await actor(CHE_ONLY,c=>c.query('SELECT product_id FROM ci_purchase_order_template_lines WHERE template_id=$1',[template]));
      assert.equal(cheOnlyView.rowCount,2);

      // A reversed issue in the window is excluded; an old issue outside the window is ignored.
      await owner(async c=>{
        const tx=(await c.query<{id:string}>("INSERT INTO ci_stock_transactions(warehouse_id,kind,idempotency_key,request_hash,actor_id,purpose,created_at) VALUES (1,'issue','old-issue','h',$1,'Routine',now()-interval '40 days') RETURNING id",[ADMIN])).rows[0].id;
        await c.query('INSERT INTO ci_stock_movement_lines(transaction_id,warehouse_id,lot_id,location_id,quantity_delta) VALUES ($1,1,$2,$3,-1)',[tx,lots.a1,fridge]);
      });
      const toReverse=await rpc<string>(STAFF,'ci_issue_stock',[{product_id:cheA,lot_id:lots.a1,location_id:fridge,quantity:2,purpose:'Routine',idempotency_key:'po-issue-reversed'}],['jsonb']);
      await rpc(SUPER,'ci_reverse_transaction',[toReverse,'mistake','rev-1'],['uuid','text','text']);
      const metrics=await actor(STAFF,c=>c.query('SELECT product_id,issued_30d,stock_balance,rop FROM ci_purchase_order_metrics($1::uuid[])',[[cheA,cheB,immA]]));
      const m=new Map(metrics.rows.map(r=>[r.product_id,r]));
      // cheA in window: 1 (during count) + 2 + 3 (group) = 6; reversed issue of 2 excluded; 40-day-old issue ignored.
      assert.equal(Number(m.get(cheA)!.issued_30d),6);
      assert.equal(m.get(cheA)!.rop,null,'no ROP is null, not 0');
      const cheOnlyMetrics=await actor(CHE_ONLY,c=>c.query('SELECT product_id FROM ci_purchase_order_metrics($1::uuid[])',[[cheA,immA]]));
      assert.deepEqual(cheOnlyMetrics.rows.map(r=>r.product_id),[cheA],'other group stays invisible');

      await rpc(ADMIN,'ci_save_reorder_settings',[cheB,{mode:'manual',manual_rop_packs:15}],['uuid','jsonb']);
      const key=randomUUID();
      const draft=await rpc<{id:string;status:string}>(STAFF,'ci_save_purchase_order',[{client_key:key,template_id:template,lines:[{product_id:cheA,order_quantity:0},{product_id:cheB,order_quantity:20}]}],['jsonb']);
      assert.equal(draft.status,'draft');
      await assert.rejects(rpc(STAFF,'ci_save_purchase_order',[{id:draft.id,lines:[{product_id:cheB,order_quantity:-1}]}],['jsonb']),/CI_PO_QUANTITY_INVALID/);
      await assert.rejects(rpc(STAFF2,'ci_save_purchase_order',[{id:draft.id,lines:[]}],['jsonb']),/CI_ACCESS_DENIED/);
      const tl2=await actor(STAFF,c=>c.query('SELECT count(*) n FROM ci_purchase_order_template_lines WHERE template_id=$1',[template]));
      assert.equal(tl2.rows[0].n,'2','editing an order never edits its template');
      // Two confirmations of the same draft at once: one number, one order.
      const confirmPayload={id:draft.id,confirm:true,template_id:template,lines:[{product_id:cheA,order_quantity:0},{product_id:cheB,order_quantity:20}]};
      const [c1,c2]=await Promise.all([rpc<{po_number:string}>(STAFF,'ci_save_purchase_order',[confirmPayload],['jsonb']),rpc<{po_number:string}>(STAFF,'ci_save_purchase_order',[confirmPayload],['jsonb'])]);
      assert.equal(c1.po_number,c2.po_number);
      assert.match(c1.po_number,/^PO-25\d\d-0001$/);
      // Concurrent confirmations of different orders get distinct numbers.
      const many=await Promise.all([STAFF,STAFF2,ADMIN,SUPER].map(u=>rpc<{po_number:string}>(u,'ci_save_purchase_order',[{client_key:randomUUID(),confirm:true,lines:[{product_id:cheB,order_quantity:1}]}],['jsonb'])));
      assert.equal(new Set(many.map(x=>x.po_number).concat(c1.po_number)).size,5);
      const snap=await actor(STAFF,c=>c.query('SELECT product_id,product_name_snapshot,rop_snapshot,order_quantity,stock_balance_snapshot FROM ci_purchase_order_lines WHERE purchase_order_id=$1 ORDER BY display_order',[draft.id]));
      assert.equal(Number(snap.rows[1].rop_snapshot),15); assert.equal(Number(snap.rows[1].order_quantity),20);
      // Later ROP / name changes do not change the saved order.
      await rpc(ADMIN,'ci_save_reorder_settings',[cheB,{mode:'manual',manual_rop_packs:99}],['uuid','jsonb']);
      const again=await actor(STAFF,c=>c.query('SELECT rop_snapshot FROM ci_purchase_order_lines WHERE purchase_order_id=$1 AND product_id=$2',[draft.id,cheB]));
      assert.equal(Number(again.rows[0].rop_snapshot),15);
      await assert.rejects(rpc(STAFF,'ci_save_purchase_order',[{id:draft.id,lines:[]}],['jsonb']),/CI_PO_NOT_EDITABLE/);
      await assert.rejects(rpc(STAFF,'ci_save_purchase_order',[{client_key:randomUUID(),confirm:true,lines:[{product_id:cheB,order_quantity:0}]}],['jsonb']),/CI_PO_EMPTY/);
      // RLS: CHE-only user cannot see an IMM-only order; nobody else sees someone's draft.
      const immOrder=await rpc<{id:string}>(ADMIN,'ci_save_purchase_order',[{client_key:randomUUID(),confirm:true,lines:[{product_id:immA,order_quantity:2}]}],['jsonb']);
      assert.equal((await actor(CHE_ONLY,c=>c.query('SELECT id FROM ci_purchase_orders WHERE id=$1',[immOrder.id]))).rowCount,0);
      const otherDraft=await rpc<{id:string}>(STAFF2,'ci_save_purchase_order',[{client_key:randomUUID(),lines:[{product_id:cheA,order_quantity:1}]}],['jsonb']);
      assert.equal((await actor(STAFF,c=>c.query('SELECT id FROM ci_purchase_orders WHERE id=$1',[otherDraft.id]))).rowCount,0);
      await assert.rejects(rpc(STAFF,'ci_cancel_purchase_order',[immOrder.id],['uuid']),/CI_ACCESS_DENIED/);
      await rpc(ADMIN,'ci_cancel_purchase_order',[immOrder.id],['uuid']);
      await rpc(STAFF2,'ci_delete_purchase_order_draft',[otherDraft.id],['uuid']);
      await rpc(STAFF,'ci_delete_purchase_order_template',[template],['uuid']);
      const kept=await actor(STAFF,c=>c.query('SELECT template_id,template_name_snapshot FROM ci_purchase_orders WHERE id=$1',[draft.id]));
      assert.deepEqual(kept.rows[0],{template_id:null,template_name_snapshot:'น้ำยา Clinical Chemistry'});
      // Orders never touch stock: only the issue + reversal made above changed the ledger.
      const after=await ledger();
      assert.equal(Number(after.s),Number(stockBefore.s)-1-2+2,'only the test issues changed stock');
    });
  }finally{
    const cleanup=new Client({connectionString:rootUrl.toString()});await cleanup.connect();
    try{await cleanup.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);}finally{await cleanup.end();}
  }
});
