/** Presentation-only grouping over user-visible signed-ledger balances.
 * Identity is product_id + lot_id, never merely the printed LOT number.
 * No inventory mutation and no received-invoice quantities are used here.
 */
export type StockBalanceEntry = {
  product_id: string; product_code: string; display_name: string;
  lot_id: string; lot_number: string; expiry_date: string;
  location_id: string; location_code: string; balance: number;
};
export type LotBalance = {
  id: string; number: string; expiry: string; balance: number;
  locations: {id:string; code:string; balance:number}[];
};
export type ProductBalance = {
  id: string; code: string; name: string; balance: number; lots: LotBalance[];
};
export function groupStockByProduct(rows: readonly StockBalanceEntry[]): ProductBalance[] {
  const products = new Map<string, ProductBalance>();
  const lots = new Map<string, LotBalance>();
  for(const row of rows) {
    const count=Number(row.balance);
    if(!Number.isFinite(count) || count <= 0)continue;
    let product=products.get(row.product_id);
    if(!product){
      product={id:row.product_id,code:row.product_code,name:row.display_name,balance:0,lots:[]};
      products.set(row.product_id,product);
    }
    const key=JSON.stringify([row.product_id,row.lot_id]);
    let lot=lots.get(key);
    if(!lot){
      lot={id:row.lot_id,number:row.lot_number,expiry:row.expiry_date,balance:0,locations:[]};
      lots.set(key,lot);
      product.lots.push(lot);
    }
    lot.balance+=count;
    product.balance+=count;
    const position=lot.locations.findIndex(location=>location.id===row.location_id);
    if(position>=0)lot.locations[position].balance+=count;
    else lot.locations.push({id:row.location_id,code:row.location_code,balance:count});
  }
  const grouped=[...products.values()];
  grouped.forEach(product=>product.lots.sort((a,b)=>
    a.expiry.localeCompare(b.expiry)||a.number.localeCompare(b.number)||a.id.localeCompare(b.id)));
  grouped.sort((a,b)=>a.code.localeCompare(b.code)||a.name.localeCompare(b.name)||a.id.localeCompare(b.id));
  return grouped;
}
