export type PickerProduct = { id: string; product_code: string; display_name: string };

/** A plain GET form: choosing a product reloads the page with `?product=` so the server can load that product's LOTs. */
export function ProductPicker({ path, warehouseCode, products, selectedId, submitLabel = 'ดู LOT ของสินค้านี้' }: { path: string; warehouseCode: string; products: PickerProduct[]; selectedId?: string; submitLabel?: string }) {
  return <form key={selectedId ?? 'none'} method="get" action={path} className="surface p-5 sm:p-7 grid gap-4">
    <input type="hidden" name="warehouse" value={warehouseCode}/>
    <label className="field">สินค้า<select className="input" name="product" defaultValue={selectedId ?? ''} required><option value="">เลือกสินค้า</option>{products.map(p => <option key={p.id} value={p.id}>{p.product_code} · {p.display_name}</option>)}</select></label>
    <div><button className="button" type="submit">{submitLabel}</button></div>
  </form>;
}
