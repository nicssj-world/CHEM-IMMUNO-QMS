import Link from 'next/link';
import { ChevronRight, Pencil } from 'lucide-react';
import { requireAccess, canSupervise } from '@/lib/auth';
import { createClient } from '@/lib/supabase/server';
import { loadCatalog, loadTemplates, orderWarehouseIds } from '@/lib/purchase-order-data';
import { logUserMessage } from '@/lib/messages';
import { formatThaiDateTime } from '@/lib/format';
import { PoTemplateEditor } from '@/components/po-template-editor';

export default async function PurchaseOrderTemplatesPage({ searchParams }: { searchParams: Promise<{ deleted?: string }> }) {
  const params = await searchParams;
  const access = await requireAccess();
  const client = await createClient();
  if (!client) return <p className="error" role="alert">ยังไม่ได้ตั้งค่าการเชื่อมต่อฐานข้อมูล</p>;
  const [templates, catalog] = await Promise.all([loadTemplates(client), loadCatalog(client, access)]);
  const error = templates.error ?? catalog.error;
  if (error || !templates.data || !catalog.data) return <p className="error" role="alert">โหลด Template ไม่สำเร็จ: {logUserMessage('po-templates', error)} · โหลดหน้าใหม่อีกครั้ง</p>;
  return <main className="grid gap-5">
    {params.deleted && <p className="notice" role="status">ลบ Template แล้ว</p>}
    <section className="surface p-4 sm:p-5 grid gap-2">
      <h2 className="font-bold text-lg">Template ทั้งหมด ({templates.data.length})</h2>
      <ul className="grid gap-2">{templates.data.map(t => <li key={t.id}>
        <Link href={`/purchase-orders/templates/${t.id}`} className="rounded-xl border border-line p-3 min-h-12 flex items-center gap-3 no-underline text-[var(--ink)] hover:bg-surface-2">
          <span className="flex-1 min-w-0"><span className="font-semibold">{t.name}</span><span className="muted text-sm block">{t.productIds.length} รายการ · แก้ไขล่าสุด {formatThaiDateTime(t.updated_at)}</span></span>
          {orderWarehouseIds(access).length > 0 && (t.created_by === access.userId || access.warehouses.some(w => canSupervise(w.role))) ? <span className="shrink-0 inline-flex items-center gap-1 text-sm font-semibold text-[var(--blue)]"><Pencil size={16} aria-hidden /> แก้ไข</span> : <span className="muted shrink-0 inline-flex items-center gap-1 text-sm">ดูรายละเอียด <ChevronRight size={18} aria-hidden /></span>}
        </Link></li>)}</ul>
      {!templates.data.length && <p className="muted text-sm">ยังไม่มี Template</p>}
    </section>
    {orderWarehouseIds(access).length > 0 && <>
      <h2 className="font-bold text-lg">สร้าง Template ใหม่</h2>
      <PoTemplateEditor templateId={null} initialName="" initialProductIds={[]} updatedAt={null} products={catalog.data} canManage />
    </>}
  </main>;
}
