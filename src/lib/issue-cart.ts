export type IssueCartLine={
 product_id:string;product_code:string;product_name:string;
 lot_id:string;lot_number:string;location_id:string;location_code:string;
 expiry_date:string;quantity:number;balance:number;warehouse_id:number;override_reason:string;
};
export function mergeIssueLine(lines:IssueCartLine[], item:IssueCartLine):IssueCartLine[] {
 if (!Number.isSafeInteger(item.quantity)||item.quantity<1) throw new Error('จำนวนต้องเป็นจำนวนเต็มบวก');
 const idx=lines.findIndex(x=>x.lot_id===item.lot_id&&x.location_id===item.location_id);
 const total=item.quantity+(idx<0?0:lines[idx].quantity);
 if (total>item.balance) throw new Error('จำนวนรวมเกินยอดคงเหลือของ LOT และตำแหน่งนี้');
 if (idx<0) return [...lines,item];
 return lines.map((line,i)=>i===idx?{...line,quantity:total,override_reason:item.override_reason||line.override_reason}:line);
}
export function matchesPickingQuery(x:{product_name:string;product_code:string;lot_number:string},query:string) {
 const q=query.trim().toLocaleLowerCase();
 return !q||[x.product_name,x.product_code,x.lot_number].some(s=>s.toLocaleLowerCase().includes(q));
}
