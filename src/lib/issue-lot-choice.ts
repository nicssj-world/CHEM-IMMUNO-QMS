/** Presentation-only issue rules; the ci_issue_stock RPC stays authoritative. */
export type IssueLotOption={
  lot_id:string;lot_number:string;expiry_date:string;location_id:string;
  location_code:string;balance:number;
};
export function scannedIssueLotIndex(rows:readonly IssueLotOption[],barcodeLot:string) {
  if(!barcodeLot.trim())return -1;
  const candidates=rows.flatMap((row,index)=>
    row.lot_number.trim().toLocaleUpperCase()===barcodeLot.trim().toLocaleUpperCase()?[index]:[]);
  // A printed LOT can exist in multiple locations: don't guess which one.
  return candidates.length===1?candidates[0]:-1;
}
export function scannedIssueLotStatus(rows:readonly IssueLotOption[],barcodeLot:string) {
  if(!barcodeLot.trim())return 'none' as const;
  const count=rows.filter(row=>
    row.lot_number.trim().toLocaleUpperCase()===barcodeLot.trim().toLocaleUpperCase()).length;
  return count===1?'unique' as const:count>1?'ambiguous' as const:'missing' as const;
}
export function issueBalanceAfter(balance:number,quantity:string) {
  const count=Number(quantity);
  return Number.isSafeInteger(count)&&count>0&&count<=balance?balance-count:null;
}
export function isFefoLot(rows:readonly IssueLotOption[],lotId:string) {
  return Boolean(rows[0]&&rows[0].lot_id===lotId);
}
