/** Build a Product → LOT / Expiry / Location view from historical receipt events.
 *
 * This is NOT current inventory stock. Only receipt rows belonging to the
 * selected Invoice are passed in, and reversed receipts are excluded from the
 * active totals while remaining available in the separate audit history.
 *
 * Crucially, the grouping key starts with the *Invoice line ID* so identical
 * printed LOT numbers on different Product lines can never be mixed.
 */
export type InvoiceReceiptLotRow = {
  id: string;
  invoiceLineId: string;
  receiptId: string;
  lotNumber: string | null;
  expiryDate: string | null;
  locationId: string;
  quantity: number;
};

export type InvoiceLotGroup = {
  key: string;
  lotNumber: string | null;
  expiryDate: string | null;
  locationId: string;
  quantity: number;
};

export function groupInvoiceReceiptLots(
  rows: readonly InvoiceReceiptLotRow[],
  reversedReceiptIds: ReadonlySet<string>,
): Map<string, InvoiceLotGroup[]> {
  const groups=new Map<string,Map<string,InvoiceLotGroup>>();
  for(const row of rows) {
    if(reversedReceiptIds.has(row.receiptId))continue;
    if(!Number.isSafeInteger(row.quantity)||row.quantity<=0)continue;
    const byLot=groups.get(row.invoiceLineId)??new Map<string,InvoiceLotGroup>();
    if(!groups.has(row.invoiceLineId))groups.set(row.invoiceLineId,byLot);
    // Incomplete historical lot references must never merge unrelated rows.
    const key=JSON.stringify([row.invoiceLineId,row.lotNumber,row.expiryDate,row.locationId,
      row.lotNumber&&row.expiryDate?null:row.id]);
    const current=byLot.get(key);
    if(current)current.quantity+=row.quantity;
    else byLot.set(key,{key,lotNumber:row.lotNumber,expiryDate:row.expiryDate,
      locationId:row.locationId,quantity:row.quantity});
  }
  return new Map([...groups].map(([lineId,byLot])=>[lineId,[...byLot.values()].sort((a,b)=>
    (a.expiryDate??'9999-12-31').localeCompare(b.expiryDate??'9999-12-31')||
    (a.lotNumber??'').localeCompare(b.lotNumber??'')||
    a.locationId.localeCompare(b.locationId)
  )]));
}
