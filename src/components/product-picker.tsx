'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { InvoiceReagentPicker } from './invoice-reagent-picker';

export type PickerProduct = { id: string; product_code: string; display_name: string };

/** Choosing a reagent navigates to its available LOTs immediately.
 * Server pages still verify warehouse access, available stock and FEFO.
 * No mutation happens from selecting a Product or browsing LOTs.
 */
export function ProductPicker({ path, warehouseCode, products, selectedId }: {
  path: string; warehouseCode: string; products: PickerProduct[]; selectedId?: string;
}) {
  const router=useRouter();
  const [productId,setProductId]=useState(selectedId??'');
  const [pending,startTransition]=useTransition();

  function choose(nextId:string) {
    setProductId(nextId);
    if(!nextId)return;
    const params=new URLSearchParams({warehouse:warehouseCode,product:nextId});
    startTransition(()=>router.replace(`${path}?${params.toString()}`,{scroll:false}));
  }

  return <section className="surface p-4 sm:p-6 grid gap-3" aria-label="เลือกน้ำยาที่ต้องการ">
    <InvoiceReagentPicker products={products} value={productId} onChange={choose} disabled={pending}
      label="เลือกน้ำยา"
      hint="พิมพ์รหัสหรือชื่อน้ำยา แล้วแตะผลค้นหา · ระบบแสดง LOT ที่เบิกหรือย้ายได้ทันที"/>
    {pending&&<p role="status" className="muted text-sm">กำลังโหลด LOT และยอดคงเหลือ…</p>}
  </section>;
}
