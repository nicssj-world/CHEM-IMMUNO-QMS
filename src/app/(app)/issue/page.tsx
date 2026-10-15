import Link from 'next/link';
import { randomUUID } from 'node:crypto';
import { requireAccess, canMutate } from '@/lib/auth';
import { createClient } from '@/lib/supabase/server';
import { IssueForm } from '@/components/issue-form';
import { IssueScan } from '@/components/issue-scan';
import { ProductPicker } from '@/components/product-picker';
import { userMessage } from '@/lib/messages';
import { loadMovementDetails, type MovementDetail, type MovementDetailLine, type MovementTransaction } from '@/lib/stock-history';
import { unitLabel } from '@/lib/units';
import { formatDateTimeBE } from '@/lib/format';

type Product = { id: string; warehouse_id: number; product_code: string; display_name: string };
type Candidate = { lot_id: string; lot_number: string; expiry_date: string; location_id: string; balance: number };
type Location = { id: string; code: string };

export default async function IssuePage({ searchParams }: { searchParams: Promise<{ warehouse?: string; product?: string; lot?: string; error?: string; saved?: string; tx?: string }> }) {
  const params = await searchParams;
  const access = await requireAccess();
  const scopeIds = access.warehouses.map(item => Number(item.id));
  const client = await createClient();
  const [productsResult,locationsResult] = client ? await Promise.all([
    client.from('ci_products').select('id,warehouse_id,product_code,display_name').in('warehouse_id',scopeIds).eq('active',true).order('product_code').limit(1000),
    client.from('ci_locations').select('id,code').order('code'),
  ]) : [{ data: [] },{ data: [] }];
  const products = (productsResult.data ?? []) as Product[];
  const locations = new Map(((locationsResult.data ?? []) as Location[]).map(l => [l.id,l.code]));
  const product = products.find(p => p.id === params.product);
  const warehouse = access.warehouses.find(item => Number(item.id) === product?.warehouse_id) ?? access.warehouses[0];
  const { data: candidateData, error } = product && client ? await client.from('ci_fefo_candidates').select('lot_id,lot_number,expiry_date,location_id,balance').eq('warehouse_id',product.warehouse_id).eq('product_id',product.id).order('expiry_date').order('lot_number') : { data: [], error: null };
  const candidates = ((candidateData ?? []) as Candidate[]).map(c => ({...c,location_code: locations.get(c.location_id) ?? '—'}));
  const scannedLot = (params.lot ?? '').trim().slice(0,80);
  const lotMissing = Boolean(product && scannedLot && candidates.length && !candidates.some(c => c.lot_number.trim().toUpperCase() === scannedLot.toUpperCase()));
  const canIssue = product ? canMutate(warehouse.role) : access.warehouses.some(w => canMutate(w.role));
  let successReceipt: { transaction: MovementDetail; line: MovementDetailLine; stockTotal: number } | null = null;
  let receiptProblem = '';
  // Show a persisted success receipt only after re-reading the committed transaction and balances.
  if (params.tx && /^[0-9a-f-]{36}$/i.test(params.tx) && client) {
    const lookup = await client.from('ci_stock_transactions')
      .select('id,warehouse_id,kind,created_at,purpose,reason,actor_id,source_transaction_id')
      .eq('id',params.tx).eq('kind','issue').eq('actor_id',access.userId).maybeSingle();
    if (lookup.error || !lookup.data) receiptProblem = 'ไม่สามารถตรวจสอบหลักฐานการเบิกได้';
    else {
      try {
        const transactions = await loadMovementDetails(client,[lookup.data as MovementTransaction],access);
        const transaction = transactions[0];
        const line = transaction?.lines[0];
        if (!line || !line.productId || transaction.lines.length !== 1) {
          receiptProblem = 'รายการเบิกสำเร็จ แต่ไม่พบรายละเอียด LOT ครบถ้วน';
        } else {
          const stockResult = await client.from('ci_stock_balances')
            .select('balance',{count:'exact'}).eq('product_id',line.productId)
            .eq('warehouse_id',transaction.warehouse_id).limit(2000);
          if (stockResult.error || (stockResult.count??0) > (stockResult.data?.length??0)) {
            receiptProblem = 'รายการเบิกสำเร็จ แต่ยังอ่านยอดคงเหลือในคลังได้ไม่ครบ';
          } else {
            const stockTotal = (stockResult.data??[]).reduce((sum,row)=>sum+Number(row.balance),0);
            successReceipt = {transaction,line,stockTotal};
          }
        }
      } catch {
        receiptProblem = 'รายการเบิกสำเร็จ แต่ยังอ่านข้อมูลยืนยันหลังเบิกไม่ครบ';
      }
    }
  } else if (params.tx) receiptProblem = 'รหัสหลักฐานการเบิกไม่ถูกต้อง';

  return <main className="grid gap-6 max-w-[900px]"><div><p className="eyebrow mb-2">Issue / Consumption</p><h1 className="page-title">เบิกใช้น้ำยา</h1><p className="muted mt-2 text-sm">ค้นหาหรือสแกนน้ำยา แล้วเลือก LOT ตาม FEFO และระบุจำนวนที่เบิกได้ทันที</p></div>{canIssue && <IssueScan/>}{params.error && <p className="error" role="alert">{params.error}</p>}
    {receiptProblem && <p className="notice" role="alert">{receiptProblem} · <Link href="/movements">ตรวจสอบประวัติการเคลื่อนไหว</Link></p>}
    {successReceipt && <section className="surface p-4 sm:p-6 grid gap-3" aria-label="ผลการเบิกออกสำเร็จ" role="status">
      <h2 className="text-xl font-extrabold text-emerald-800">✓ เบิกออกสำเร็จ</h2>
      <div>
        <p className="font-bold">{successReceipt.line.productName}</p>
        <p className="muted text-sm">{successReceipt.line.productCode}{successReceipt.line.ref ? ' · REF ' + successReceipt.line.ref : ''}</p>
        <p className="text-sm mt-1">LOT {successReceipt.line.lotNumber} · {successReceipt.line.location}</p>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
        <div className="rounded-lg bg-surface-2 p-3"><p className="muted text-xs">เบิกออก</p><strong className="text-xl tabular-nums">{Math.abs(successReceipt.line.delta).toLocaleString('th-TH')} {unitLabel(successReceipt.line.unit)}</strong></div>
        <div className="rounded-lg bg-surface-2 p-3"><p className="muted text-xs">คงเหลือในคลัง (ทุก LOT)</p><strong className="text-xl tabular-nums">{successReceipt.stockTotal.toLocaleString('th-TH')} {unitLabel(successReceipt.line.unit)}</strong></div>
        <div className="rounded-lg bg-surface-2 p-3 col-span-2 sm:col-span-1"><p className="muted text-xs">LOT/ตำแหน่งที่เบิกคงเหลือ</p><strong className="text-xl tabular-nums">{successReceipt.line.currentLotLocationBalance?.toLocaleString('th-TH') ?? '—'} {unitLabel(successReceipt.line.unit)}</strong></div>
      </div>
      <p className="text-sm">ผู้เบิก: <strong>{successReceipt.transaction.actorName ?? access.displayName}</strong></p>
      <p className="muted text-xs">{formatDateTimeBE(successReceipt.transaction.created_at)} · คงเหลือเป็นยอดปัจจุบันที่อ่านใหม่หลังยืนยัน</p>
    </section>}
    {error && <p className="error" role="alert">อ่าน LOT ไม่สำเร็จ: {userMessage(error)}</p>
    <ProductPicker key={product?.id??'unselected'} path="/issue" warehouseCode={warehouse.code} products={products} selectedId={product?.id}/>
    {lotMissing && <p className="notice" role="status">LOT {scannedLot} จาก Barcode ไม่มียอดคงเหลือในคลังนี้ · เลือก LOT ที่มีอยู่ด้านล่าง</p>}{product && !error && (candidates.length ? canIssue ? <IssueForm key={`${product.id}:${scannedLot}`} productId={product.id} productCode={product.product_code} warehouseCode={warehouse.code} candidates={candidates} preferredLot={scannedLot} submissionKey={randomUUID()}/> : <p className="error">คุณมีสิทธิ์ดูอย่างเดียวในคลังนี้</p> : <p className="notice">ไม่มี LOT ที่ยังไม่หมดอายุและมียอดคงเหลือสำหรับน้ำยานี้</p>)}
  </main>;
}
