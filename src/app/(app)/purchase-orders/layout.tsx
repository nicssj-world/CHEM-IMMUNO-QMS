import { PoSubnav } from '@/components/po-subnav';

export default function PurchaseOrdersLayout({ children }: { children: React.ReactNode }) {
  return <div className="grid gap-5 max-w-[1100px]">
    <div className="print-hide grid gap-3">
      <h1 className="page-title">ใบสั่งซื้อ</h1>
      <PoSubnav />
    </div>
    {children}
  </div>;
}
