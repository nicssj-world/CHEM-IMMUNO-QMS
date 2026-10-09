'use client';

import { IntegerQuantityInput } from './integer-quantity-input';
import type { ReceiptPackage } from '@/lib/receipt-workbench';

type InvoiceLine = { invoice_line_id: string; product_id: string; warehouse_id: number };
type Product = { id: string; product_code: string; display_name: string };
type Location = { id: string; code: string; name: string; warehouse_id: number; parent_code?: string | null };

export function ReceiptPackageReview({
  packages, lines, products, locations, onChange, onRemove, onAddLot,
}: {
  packages: ReceiptPackage[];
  lines: InvoiceLine[];
  products: Product[];
  locations: Location[];
  onChange: (id: string, patch: Partial<ReceiptPackage>) => void;
  onRemove: (id: string) => void;
  onAddLot: (invoiceLineId: string) => void;
}) {
  const lineById = new Map(lines.map(line => [line.invoice_line_id,line]));
  const productById = new Map(products.map(product => [product.id,product]));
  const locationById = new Map(locations.map(location => [location.id,location]));
  const groups = new Map<string,ReceiptPackage[]>();
  for (const item of packages) groups.set(item.invoiceLineId,[...(groups.get(item.invoiceLineId) ?? []),item]);
  const locationOptions = (lineId: string) => {
    const warehouse = lineById.get(lineId)?.warehouse_id;
    return locations.filter(location => Number(location.warehouse_id) === Number(warehouse));
  };

  if (!packages.length) return <p className="rounded-lg border border-dashed border-line p-4 text-sm muted">
    ยังไม่มีรายการในร่าง · สแกน Data Matrix หรือเลือกน้ำยาเพื่อเพิ่ม LOT
  </p>;

  return <div className="grid gap-4">
    {[...groups].map(([lineId, group]) => {
      const line = lineById.get(lineId);
      const product = productById.get(line?.product_id ?? '');
      const units = group.reduce((sum,item) => sum + (Number(item.quantity) || 0),0);
      const options = locationOptions(lineId);
      return <section key={lineId} className="rounded-xl border border-line overflow-hidden">
        <div className="bg-surface-2 p-3 flex flex-wrap gap-2 items-start justify-between">
          <div className="min-w-0 flex-1">
            <p className="font-bold text-sm break-words">{product?.product_code ?? 'Product'} · {product?.display_name ?? 'น้ำยาใน Invoice'}</p>
            <p className="muted text-xs mt-1">{group.length} LOT/ตำแหน่ง · รวม {units.toLocaleString('th-TH')} หน่วย</p>
          </div>
          <button className="button secondary min-h-10 shrink-0" type="button" onClick={() => onAddLot(lineId)}>+ เพิ่ม LOT</button>
        </div>

        {/* Phone: collapsed one-line lots; editing stays full-width with 44px+ targets. */}
        <div className="md:hidden divide-y divide-[var(--line)]">
          {group.map(item => {
            const location = locationById.get(item.locationId);
            return <details key={item.id} className="group">
              <summary className="cursor-pointer list-none p-3 min-h-16 flex items-center justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <p className="font-semibold text-sm break-all">LOT {item.lot || 'ยังไม่ระบุ'}</p>
                  <p className="muted text-xs mt-1">{item.expiry || 'ยังไม่ระบุวันหมดอายุ'} · {location?.code ?? 'ยังไม่เลือกตำแหน่ง'}</p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span className="font-bold tabular-nums">× {item.quantity}</span>
                  <span aria-hidden className="text-xs muted group-open:rotate-180 transition-transform">▾</span>
                </div>
              </summary>
              <div className="border-t border-line p-3 grid grid-cols-2 gap-3">
                <label className="field">LOT
                  <input className="input min-h-11" value={item.lot} onChange={e=>onChange(item.id,{lot:e.target.value})} autoCapitalize="characters" autoCorrect="off" />
                </label>
                <label className="field">จำนวน
                  <IntegerQuantityInput className="input min-h-11" min="1" value={item.quantity} onChange={e=>onChange(item.id,{quantity:e.target.value})} />
                </label>
                <label className="field col-span-2">วันหมดอายุ
                  <input className="input min-h-11" type="date" value={item.expiry} onChange={e=>onChange(item.id,{expiry:e.target.value})} />
                </label>
                <label className="field col-span-2">ตำแหน่งจัดเก็บ
                  <select className="input min-h-11" value={item.locationId} onChange={e=>onChange(item.id,{locationId:e.target.value})}>
                    <option value="">เลือกตำแหน่ง</option>
                    {options.map(loc=><option key={loc.id} value={loc.id}>{loc.parent_code ? loc.parent_code+' › ' : ''}{loc.code} · {loc.name}</option>)}
                  </select>
                </label>
                <div className="col-span-2 flex justify-end">
                  <button className="button secondary min-h-11" type="button" onClick={()=>onRemove(item.id)}>ลบรายการนี้</button>
                </div>
              </div>
            </details>;
          })}
        </div>

        {/* Desktop: compact editable table, shared mutations and validation with Mobile. */}
        <div className="hidden md:block overflow-x-auto">
          <table className="w-full text-sm min-w-[760px]">
            <thead><tr className="text-left border-b border-line">
              <th className="px-3 py-2 font-semibold">LOT</th>
              <th className="px-2 py-2 font-semibold w-[90px]">จำนวน</th>
              <th className="px-2 py-2 font-semibold w-[180px]">หมดอายุ</th>
              <th className="px-2 py-2 font-semibold">ตำแหน่งจัดเก็บ</th>
              <th className="px-3 py-2 font-semibold w-[64px]">ลบ</th>
            </tr></thead>
            <tbody className="divide-y divide-[var(--line)]">
              {group.map(item => <tr key={item.id}>
                <td className="p-2 pl-3"><input className="input min-w-[120px]" aria-label="เลข LOT" value={item.lot} onChange={e=>onChange(item.id,{lot:e.target.value})} /></td>
                <td className="p-2"><IntegerQuantityInput className="input w-full" aria-label="จำนวนรับเข้า" min="1" value={item.quantity} onChange={e=>onChange(item.id,{quantity:e.target.value})} /></td>
                <td className="p-2"><input className="input w-full" aria-label="วันหมดอายุ" type="date" value={item.expiry} onChange={e=>onChange(item.id,{expiry:e.target.value})} /></td>
                <td className="p-2"><select className="input w-full" aria-label="ตำแหน่งจัดเก็บ" value={item.locationId} onChange={e=>onChange(item.id,{locationId:e.target.value})}>
                  <option value="">เลือกตำแหน่ง</option>
                  {options.map(loc=><option key={loc.id} value={loc.id}>{loc.parent_code ? loc.parent_code+' › ' : ''}{loc.code} · {loc.name}</option>)}
                </select></td>
                <td className="p-2 pr-3"><button className="button secondary min-h-10" type="button" aria-label={`ลบ LOT ${item.lot}`} onClick={()=>onRemove(item.id)}>ลบ</button></td>
              </tr>)}
            </tbody>
          </table>
        </div>
      </section>;
    })}
  </div>;
}
