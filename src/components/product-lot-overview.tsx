import { expiryBucket } from '@/lib/inventory-insights';
import { groupStockByProduct } from '@/lib/stock-lot-view';

type Balance = {lot_id:string;lot_number:string;expiry_date:string;location_id:string;balance:number};
type Location = {id:string;code:string;name:string};

export function ProductLotOverview({product,balances,locations}:{
  product:{id:string;product_code:string;display_name:string};
  balances:readonly Balance[];
  locations:readonly Location[];
}){
  const names=new Map(locations.map(loc=>[loc.id,loc]));
  const grouped=groupStockByProduct(balances.map(item=>({
    product_id:product.id,product_code:product.product_code,display_name:product.display_name,
    lot_id:item.lot_id,lot_number:item.lot_number,expiry_date:item.expiry_date,
    location_id:item.location_id,location_code:names.get(item.location_id)?.code??'ไม่พบตำแหน่ง',
    balance:Number(item.balance),
  })))[0];
  const lots=grouped?.lots??[];
  const balance=grouped?.balance??0;
  const usable=lots.filter(lot=>expiryBucket(lot.expiry)!=='EXPIRED').reduce((sum,lot)=>sum+lot.balance,0);
  const warning=lots.filter(lot=>['≤30','31–60','61–90'].includes(expiryBucket(lot.expiry))).length;
  return <section className="grid gap-4" aria-label="ภาพรวม LOT และ Stock">
    <div className="grid grid-cols-3 gap-2">
      {[{name:'คงเหลือรวม',value:balance},{name:'ยังไม่หมดอายุ',value:usable},{name:'LOT ที่มีของ',value:lots.length}].map(card=>
        <div key={card.name} className="rounded-xl bg-surface-2 p-3 min-w-0 text-center">
          <strong className="text-xl sm:text-2xl tabular-nums block">{card.value.toLocaleString('th-TH')}</strong>
          <span className="muted text-xs block mt-1">{card.name}</span>
        </div>)}
    </div>
    {warning>0&&<p className="text-sm rounded-lg bg-amber-50 text-amber-900 px-3 py-2">มี {warning} LOT ใกล้หมดอายุใน 90 วัน</p>}
    <div className="grid gap-3">
      {lots.map(lot=>{
        const expiry=expiryBucket(lot.expiry);
        const status=expiry==='EXPIRED'?'หมดอายุ':expiry==='≤30'?'ใกล้หมดอายุ ≤30 วัน':expiry==='31–60'||expiry==='61–90'?expiry+' วัน':'ปกติ';
        const tone=expiry==='EXPIRED'?'bg-red-50 text-red-700':expiry==='>90'?'bg-emerald-50 text-emerald-700':'bg-amber-50 text-amber-800';
        const [year,month,day]=lot.expiry.split('-');
        return <article key={lot.id} className="rounded-xl border border-line p-3 sm:p-4 grid gap-3">
          <div className="flex justify-between items-start gap-3">
            <div className="min-w-0 grid gap-1">
              <strong className="break-all">LOT {lot.number}</strong>
              <span className="text-sm">EXP <strong className="tabular-nums">{day}/{month}/{year}</strong></span>
              <span className={`text-xs font-semibold rounded-md px-2 py-1 self-start ${tone}`}>{status}</span>
            </div>
            <div className="shrink-0 text-right">
              <strong className="text-2xl tabular-nums">{lot.balance.toLocaleString('th-TH')}</strong>
              <p className="muted text-xs">คงเหลือ</p>
            </div>
          </div>
          <details className="border-t border-line pt-2 text-sm">
            <summary className="cursor-pointer text-brand font-semibold min-h-9 flex items-center">ตำแหน่งจัดเก็บ ({lot.locations.length})</summary>
            <div className="grid gap-2 pt-2">{lot.locations.map(location=>
              <div key={location.id} className="flex justify-between gap-3 bg-surface-2 rounded-lg px-3 py-2">
                <span className="min-w-0 break-words">{location.code}{names.get(location.id)?' · '+names.get(location.id)!.name:''}</span>
                <strong className="tabular-nums shrink-0">{location.balance.toLocaleString('th-TH')}</strong>
              </div>)}</div>
          </details>
        </article>;
      })}
      {!lots.length&&<p className="muted text-sm bg-surface-2 rounded-lg p-4">ยังไม่มี LOT ที่มียอดคงเหลือ</p>}
    </div>
  </section>;
}
