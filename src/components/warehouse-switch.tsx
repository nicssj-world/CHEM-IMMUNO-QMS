'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import type { Warehouse } from '@/lib/auth';

// Filters and search carry over to the other warehouse; ids that belong to one warehouse (product, LOT) and one-off notices do not.
const dropOnSwitch = ['warehouse', 'page', 'product', 'lot', 'error', 'saved', 'at'];

export function WarehouseSwitch({ warehouses, selected, path = '/' }: { warehouses: Warehouse[]; selected: Warehouse; path?: string }) {
  const params = useSearchParams();
  const hrefFor = (code: string) => {
    const query = new URLSearchParams([...params.entries()].filter(([key, value]) => !dropOnSwitch.includes(key) && value !== ''));
    query.set('warehouse', code);
    return `${path}?${query}`;
  };
  return <nav aria-label="เลือกคลัง" className="grid grid-cols-2 gap-2 p-1.5 bg-track rounded-xl w-full max-w-[560px]">
    {(['CHE', 'IMM'] as const).map((code) => {
      const item = warehouses.find((w) => w.code === code);
      const label = code === 'CHE' ? 'CLINICAL CHEMISTRY' : 'IMMUNOLOGY';
      return item ? <Link key={code} href={hrefFor(code)} aria-current={selected.code === code ? 'page' : undefined} className={`min-h-11 flex items-center justify-center rounded-[9px] px-2 text-center text-[.72rem] sm:text-sm font-extrabold no-underline ${selected.code === code ? 'bg-white text-[#095d79] shadow-sm' : 'text-[#455e6d]'}`}>{label}</Link>
        : <span key={code} aria-disabled title="บัญชีนี้ไม่มีสิทธิ์ในคลังนี้" className="min-h-11 flex flex-col items-center justify-center rounded-[9px] px-2 text-center text-[.72rem] sm:text-sm font-bold text-[#5f7480]">{label}<span className="text-[.65rem] font-normal">ไม่มีสิทธิ์</span></span>;
    })}
  </nav>;
}
