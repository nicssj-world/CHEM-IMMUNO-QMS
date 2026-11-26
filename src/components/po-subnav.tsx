'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { FilePlus2, History, LayoutList } from 'lucide-react';

const items = [
  { href: '/purchase-orders', label: 'สร้างใบสั่งซื้อ', icon: FilePlus2, match: (p: string) => p === '/purchase-orders' || (/^\/purchase-orders\/[0-9a-f-]{36}$/i.test(p)) },
  { href: '/purchase-orders/history', label: 'ประวัติใบสั่งซื้อ', icon: History, match: (p: string) => p.startsWith('/purchase-orders/history') },
  { href: '/purchase-orders/templates', label: 'จัดการ Template', icon: LayoutList, match: (p: string) => p.startsWith('/purchase-orders/templates') },
];

export function PoSubnav() {
  const pathname = usePathname();
  return <nav aria-label="เมนูใบสั่งซื้อ" className="print-hide grid grid-cols-3 gap-2">
    {items.map(item => {
      const active = item.match(pathname);
      const Icon = item.icon;
      return <Link key={item.href} href={item.href} aria-current={active ? 'page' : undefined}
        className={'button min-h-12 px-2 text-xs sm:text-sm text-center ' + (active ? '' : 'secondary')}>
        <Icon size={17} aria-hidden className="hidden sm:inline" /> {item.label}
      </Link>;
    })}
  </nav>;
}
