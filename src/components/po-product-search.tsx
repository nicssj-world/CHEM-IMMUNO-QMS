'use client';

import { useMemo, useState } from 'react';
import { Check, Plus } from 'lucide-react';
import { SearchInput } from './search-input';
import { matchesProduct, searchTemplateProducts, type PoProduct } from '@/lib/purchase-orders';
import { unitLabel } from '@/lib/units';

/** Filters the already-loaded catalog on every keystroke (no request per key). */
export function PoProductSearch({ products, chosen, onAdd, templateMode = false }: { products: PoProduct[]; chosen: ReadonlySet<string>; onAdd: (id: string) => void; templateMode?: boolean }) {
  const [query, setQuery] = useState('');
  const results = useMemo(() => templateMode ? searchTemplateProducts(products, chosen, query) : query.trim() ? products.filter(p => p.active && matchesProduct(p, query)).slice(0, 30) : [], [products, query, chosen, templateMode]);
  return <div className="grid gap-2">
    <SearchInput label="ค้นหาน้ำยาเพื่อเพิ่ม" placeholder="ชื่อหรือรหัสน้ำยา" value={query} onChange={setQuery} />
    {query.trim() && <ul className="grid gap-1 max-h-72 overflow-y-auto rounded-xl border border-line p-1 bg-white" aria-label="ผลการค้นหา">
      {results.map(product => {
        const added = chosen.has(product.id);
        return <li key={product.id}>
          <button type="button" disabled={added} onClick={() => onAdd(product.id)}
            className="w-full min-h-12 rounded-lg px-3 py-2 flex items-center gap-3 text-left hover:bg-surface-2 disabled:opacity-60">
            <span className="min-w-0 flex-1">
              <span className="block text-sm"><span className="muted tabular-nums">{product.product_code}</span> · {product.display_name}</span>
              <span className="block text-xs muted">{product.packing_size_raw ? `ขนาดบรรจุ ${product.packing_size_raw} · ` : ''}หน่วย {unitLabel(product.base_stock_unit)}</span>
            </span>
            <span className={'shrink-0 inline-flex items-center gap-1 text-sm ' + (added ? 'text-emerald-800' : 'text-[var(--blue)] font-semibold')}>
              {added ? <><Check size={16} aria-hidden /> เพิ่มแล้ว</> : <><Plus size={16} aria-hidden /> เพิ่ม</>}
            </span>
          </button>
        </li>;
      })}
      {!results.length && <li className="muted text-sm p-3">{templateMode ? 'ไม่พบน้ำยาที่ยังไม่ได้เพิ่ม' : 'ไม่พบน้ำยาที่ค้นหา'}</li>}
    </ul>}
  </div>;
}
