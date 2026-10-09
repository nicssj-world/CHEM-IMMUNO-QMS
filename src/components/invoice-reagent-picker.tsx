'use client';

import { useId, useMemo, useState } from 'react';
import { Search, X } from 'lucide-react';
import { searchReagents, type SearchableReagent } from '@/lib/reagent-search';

const MAX_RESULTS = 12;

export function InvoiceReagentPicker({ products, value, onChange }: {
  products: SearchableReagent[];
  value: string;
  onChange: (productId: string) => void;
}) {
  const id = useId();
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState(false);
  const [highlighted, setHighlighted] = useState(0);
  const selected = useMemo(() => products.find(p => p.id === value), [products, value]);
  const matches = useMemo(() => searchReagents(products, query), [products, query]);
  const options = matches.slice(0, MAX_RESULTS);
  const showResults = expanded && query.trim().length > 0;

  function choose(id: string) {
    onChange(id);
    setQuery('');
    setHighlighted(0);
    setExpanded(false);
  }

  return <div className="grid gap-2 min-w-0">
    <label className="field" htmlFor={id}>น้ำยา <span className="text-[#b42318]" aria-hidden="true">*</span></label>
    {selected && <div className="flex items-center justify-between gap-2 rounded-lg border border-field-line bg-surface-2 p-3">
      <div className="min-w-0">
        <strong className="block text-sm break-words">{selected.product_code}</strong>
        <span className="block text-sm muted break-words">{selected.display_name}</span>
      </div>
      <button type="button" className="button secondary shrink-0 min-h-11" onClick={() => {
        onChange('');
        setQuery('');
        setExpanded(true);
        setHighlighted(0);
      }}>เปลี่ยน</button>
    </div>}
    <div className="relative min-w-0" onBlur={event => {
      if (!event.currentTarget.contains(event.relatedTarget)) setExpanded(false);
    }}>
      <div className="relative flex items-center">
        <Search size={18} aria-hidden className="absolute left-3 muted pointer-events-none"/>
        <input id={id} type="search" role="combobox" aria-autocomplete="list"
          aria-expanded={showResults} aria-controls={id + '-options'}
          aria-activedescendant={showResults && options[highlighted] ? id + '-option-' + highlighted : undefined}
          className="input min-h-12 w-full pl-10 pr-10" placeholder="พิมพ์รหัสหรือชื่อน้ำยา เช่น 002, TSH"
          value={query} autoComplete="off" autoCapitalize="off" autoCorrect="off" spellCheck={false}
          onFocus={() => setExpanded(true)}
          onChange={event => {
            setQuery(event.target.value);
            setHighlighted(0);
            setExpanded(true);
            if (value) onChange('');
          }}
          onKeyDown={event => {
            if (event.key === 'Escape') { setExpanded(false); return; }
            if (event.key === 'ArrowDown' && options.length) {
              event.preventDefault();
              setExpanded(true);
              setHighlighted(index => (index + 1) % options.length);
            } else if (event.key === 'ArrowUp' && options.length) {
              event.preventDefault();
              setExpanded(true);
              setHighlighted(index => (index - 1 + options.length) % options.length);
            } else if (event.key === 'Enter') {
              event.preventDefault();
              if (showResults && options[highlighted]) choose(options[highlighted].id);
            }
          }}/>
        {query && <button className="absolute right-1 grid place-items-center min-h-11 min-w-11 cursor-pointer"
          type="button" aria-label="ล้างคำค้นหา" onClick={() => {setQuery(''); setHighlighted(0);setExpanded(true);}}>
          <X size={18} aria-hidden />
        </button>}
      </div>
      {showResults && <div id={id + '-options'} role="listbox" aria-label="ผลค้นหาน้ำยา"
        className="mt-1 max-h-72 overflow-y-auto overscroll-contain rounded-xl border border-field-line bg-white shadow-md">
        {options.map((product,index) => <button id={id + '-option-' + index} role="option"
          aria-selected={index === highlighted} type="button" key={product.id}
          className={`w-full min-h-12 cursor-pointer border-b border-line px-3 py-3 text-left last:border-b-0 ${index === highlighted ? 'bg-surface-2' : 'bg-white'}`}
          onMouseEnter={() => setHighlighted(index)}
          onClick={() => choose(product.id)}>
          <strong className="block text-sm break-words">{product.product_code}</strong>
          <span className="block text-sm muted break-words">{product.display_name}</span>
        </button>)}
        {matches.length === 0 && <p className="p-3 text-sm muted">ไม่พบน้ำยาที่ตรงกับคำค้นหาในรายการ</p>}
        {matches.length > MAX_RESULTS && <p className="p-3 text-xs muted">พบ {matches.length} รายการ · แสดง {MAX_RESULTS} รายการแรก พิมพ์เพิ่มเพื่อกรองให้แคบลง</p>}
      </div>}
    </div>
    <p className="muted text-xs">ค้นหาแบบบางส่วนได้ทันที ไม่ต้องพิมพ์เต็มรหัสหรือชื่อ · เลือกผลลัพธ์เพื่อเพิ่มน้ำยา</p>
  </div>;
}
