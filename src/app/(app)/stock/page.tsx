import Link from 'next/link';
import { requireAccess } from '@/lib/auth';
import { searchGroupedStock } from '@/lib/unified-stock';
import { createClient } from '@/lib/supabase/server';
import { LiveSearchForm } from '@/components/live-search-form';
import { expiryBucket } from '@/lib/inventory-insights';
import { logUserMessage } from '@/lib/messages';

function expiryLabel(date:string) {
  const bucket=expiryBucket(date);
  if(bucket==='EXPIRED')return {text:'หมดอายุ',css:'bg-red-50 text-red-700'};
  if(bucket==='≤30')return {text:'ใกล้หมดอายุ ≤30 วัน',css:'bg-amber-100 text-amber-900'};
  if(bucket==='31–60'||bucket==='61–90')return {text:'เหลือ '+bucket+' วัน',css:'bg-amber-50 text-amber-800'};
  return {text:'ปกติ',css:'bg-emerald-50 text-emerald-700'};
}
function displayDate(iso:string) {
  const [year,month,day]=iso.split('-');
  return [day,month,year].join('/');
}

export default async function StockPage({ searchParams }: { searchParams: Promise<{ q?: string; page?: string }> }) {
  const params=await searchParams;
  const access=await requireAccess();
  const client=await createClient();
  if(!client)return <p className="error">ยังไม่ได้ตั้งค่า Supabase</p>;
  const q=(params.q??'').trim().slice(0,100);
  const page=Math.min(10000,Math.max(1,Number.parseInt(params.page??'1',10)||1));
  const result=await searchGroupedStock(client,access.warehouses.map(w=>Number(w.id)),q,page);
  const products=result.products;
  const query=new URLSearchParams({q});
  return <main className="grid gap-5 min-w-0">
    <header className="grid gap-2">
      <p className="eyebrow">Inventory · LOT-first</p>
      <h1 className="page-title">คงคลังน้ำยา</h1>
      <p className="muted text-sm">ดู LOT วันหมดอายุ และจำนวนคงเหลือก่อน · กดขยายเพื่อดูยอดแยกตำแหน่ง</p>
    </header>
    <LiveSearchForm ariaLabel="ค้นหา LOT และน้ำยา" className="surface p-4 grid gap-2">
      <label className="field">ค้นหาน้ำยา / REF / Barcode / LOT
        <input className="input" type="search" name="q" maxLength={100} defaultValue={q} placeholder="ชื่อ, รหัสน้ำยา, REF, Barcode หรือ LOT"/>
      </label>
    </LiveSearchForm>
    {result.error&&<p className="error" role="alert">อ่านยอดคงคลังไม่สำเร็จ: {logUserMessage('stock',result.error)}</p>}
    {!result.error&&<>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm muted">พบ <strong className="text-[var(--ink)]">{result.totalProducts.toLocaleString('th-TH')}</strong> น้ำยา · <strong className="text-[var(--ink)]">{result.totalLots.toLocaleString('th-TH')}</strong> LOT ที่มียอดคงเหลือ</p>
        <p className="text-xs muted">หน้า {page} จาก {Math.max(result.pageCount,1)} · เรียง LOT ตามวันหมดอายุ (FEFO)</p>
      </div>
      <section className="grid gap-3" aria-label="คงคลังแยกตามน้ำยาและ LOT">
        {products.map(product=><article key={product.id} className="surface p-4 sm:p-5 min-w-0 grid gap-3">
          <div className="flex justify-between gap-3 items-start">
            <div className="min-w-0">
              <Link href={`/products/${product.id}?tab=lots`} className="font-bold text-brand break-words">{product.code}</Link>
              <p className="font-semibold text-sm break-words mt-1">{product.name}</p>
              <p className="muted text-xs mt-1">{product.lots.length} LOT ที่มียอดคงเหลือ</p>
            </div>
            <div className="shrink-0 text-right rounded-xl bg-surface-2 px-3 py-2">
              <strong className="text-2xl tabular-nums">{product.balance.toLocaleString('th-TH')}</strong>
              <p className="muted text-xs">คงเหลือรวม</p>
            </div>
          </div>
          <div className="grid gap-2">
            {product.lots.map(lot=>{
              const status=expiryLabel(lot.expiry);
              return <div key={lot.id} className="rounded-xl border border-line px-3 py-3 grid gap-2">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 grid gap-1">
                    <strong className="text-sm break-all">LOT {lot.number}</strong>
                    <p className="text-sm">EXP <span className="font-semibold tabular-nums">{displayDate(lot.expiry)}</span></p>
                    <span className={`self-start text-xs font-semibold rounded-md px-2 py-1 ${status.css}`}>{status.text}</span>
                  </div>
                  <div className="text-right shrink-0">
                    <strong className="text-xl tabular-nums">{lot.balance.toLocaleString('th-TH')}</strong>
                    <p className="text-xs muted">คงเหลือ</p>
                  </div>
                </div>
                <details className="text-xs border-t border-line pt-2">
                  <summary className="cursor-pointer font-semibold text-brand min-h-9 flex items-center">ตำแหน่งจัดเก็บ ({lot.locations.length})</summary>
                  <div className="grid gap-2 pt-2">{lot.locations.map(location=>
                    <div key={location.id} className="flex justify-between gap-3 rounded-lg bg-surface-2 px-3 py-2">
                      <span className="break-words">{location.code}</span><strong className="tabular-nums">{location.balance.toLocaleString('th-TH')}</strong>
                    </div>)}</div>
                </details>
              </div>;
            })}
          </div>
          <Link href={`/products/${product.id}?tab=lots`} className="text-sm font-semibold text-brand justify-self-start">ดูรายละเอียดน้ำยา →</Link>
        </article>)}
        {!products.length&&<p className="surface p-6 muted text-sm">ไม่พบ LOT ที่มียอดคงเหลือตามเงื่อนไขที่ค้นหา</p>}
      </section>
      <nav aria-label="หน้าผลการค้นหา" className="flex gap-3 justify-between">
        {page>1?<Link className="button secondary" href={`/stock?${query}&page=${page-1}`}>← ก่อนหน้า</Link>:<span/>}
        {page<result.pageCount&&<Link className="button secondary" href={`/stock?${query}&page=${page+1}`}>ถัดไป →</Link>}
      </nav>
    </>}
  </main>;
}
