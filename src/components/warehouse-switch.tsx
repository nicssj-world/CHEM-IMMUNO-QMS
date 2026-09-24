import Link from 'next/link';
import type { Warehouse } from '@/lib/auth';

export function WarehouseSwitch({ warehouses, selected, path = '/' }: { warehouses: Warehouse[]; selected: Warehouse; path?: string }) {
  return <nav aria-label="เลือกคลัง" className="grid grid-cols-2 gap-2 p-1.5 bg-[#e5eff1] rounded-xl w-full max-w-[560px]">
    {(['CHE', 'IMM'] as const).map((code) => {
      const item = warehouses.find((w) => w.code === code);
      const label = code === 'CHE' ? 'CLINICAL CHEMISTRY' : 'IMMUNOLOGY';
      return item ? <Link key={code} href={`${path}?warehouse=${code}`} aria-current={selected.code === code ? 'page' : undefined} className={`min-h-11 flex items-center justify-center rounded-[9px] px-2 text-center text-[.72rem] sm:text-sm font-extrabold no-underline ${selected.code === code ? 'bg-white text-[#095d79] shadow-sm' : 'text-[#455e6d]'}`}>{label}</Link> : <span key={code} aria-disabled className="min-h-11 flex items-center justify-center rounded-[9px] px-2 text-center text-[.72rem] sm:text-sm font-bold text-[#93a5ad]">{label}</span>;
    })}
  </nav>;
}
