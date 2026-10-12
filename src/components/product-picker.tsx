'use client';

import { useState } from 'react';
import { InvoiceReagentPicker } from './invoice-reagent-picker';

export type PickerProduct = { id: string; product_code: string; display_name: string };

/** A GET form: the searchable selection still submits the exact Product ID
 * as ?product=, so the existing server-side LOT loading and scan redirects
 * are unchanged. Nothing submits until a real reagent has been chosen.
 */
export function ProductPicker({ path, warehouseCode, products, selectedId, submitLabel = 'ดู LOT ของน้ำยานี้' }: {
  path: string; warehouseCode: string; products: PickerProduct[];
  selectedId?: string; submitLabel?: string;
}) {
  const [productId,setProductId]=useState(selectedId??'');
  return <form key={selectedId??'none'} method="get" action={path}
    className="surface p-5 sm:p-7 grid gap-4">
    <input type="hidden" name="warehouse" value={warehouseCode}/>
    <input type="hidden" name="product" value={productId}/>
    <InvoiceReagentPicker products={products} value={productId} onChange={setProductId}
      hint="พิมพ์รหัสหรือชื่อน้ำยาแล้วเลือกจากผลค้นหา · หรือใช้กล้องสแกนด้านบน"/>
    <div><button className="button" type="submit" disabled={!productId}>{submitLabel}</button></div>
  </form>;
}
