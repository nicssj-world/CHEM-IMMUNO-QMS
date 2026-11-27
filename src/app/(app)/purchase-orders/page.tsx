import Link from 'next/link';
import { requireAccess, canSupervise } from '@/lib/auth';
import { createClient } from '@/lib/supabase/server';
import { loadCatalog, loadMetrics, loadTemplates, orderWarehouseIds, ORDER_COLUMNS, type OrderHeader } from '@/lib/purchase-order-data';
import { logUserMessage } from '@/lib/messages';
import { formatThaiDateTime } from '@/lib/format';
import { PoEditor } from '@/components/po-editor';

export default async function PurchaseOrderCreatePage({ searchParams }: { searchParams: Promise<{ template?: string; deleted?: string }> }) {
  const params = await searchParams;
  const access = await requireAccess();
  const client = await createClient();
  if (!client) return <p className="error" role="alert">ยังไม่ได้ตั้งค่าการเชื่อมต่อฐานข้อมูล</p>;
  if (!orderWarehouseIds(access).length) return <p className="notice">บัญชีนี้ดูข้อมูลได้อย่างเดียว จึงสร้างใบสั่งซื้อไม่ได้</p>;
  const [catalog, templates, drafts] = await Promise.all([
    loadCatalog(client, access),
    loadTemplates(client),
    client.from('ci_purchase_orders').select(ORDER_COLUMNS).eq('status', 'draft').eq('created_by', access.userId).order('updated_at', { ascending: false }).limit(20),
  ]);
  const metrics = catalog.data ? await loadMetrics(client, catalog.data.map(p => p.id)) : { data: null, error: null };
  const error = catalog.error ?? templates.error ?? drafts.error ?? metrics.error;
  if (error || !catalog.data || !templates.data || !metrics.data) return <p className="error" role="alert">โหลดข้อมูลใบสั่งซื้อไม่สำเร็จ: {logUserMessage('po-create', error)} · โหลดหน้าใหม่อีกครั้ง</p>;
  const template = templates.data.find(t => t.id === params.template) ?? null;
  const draftRows = (drafts.data ?? []) as OrderHeader[];
  return <main className="grid gap-5">
    {params.deleted && <p className="notice" role="status">ลบฉบับร่างแล้ว</p>}
    <PoEditor key={template?.id ?? 'blank'} orderId={null} products={catalog.data} metrics={metrics.data.metrics} templates={templates.data}
      initialTemplateId={template?.id ?? null} initialLines={(template?.productIds ?? []).map(productId => ({ productId, quantity: '' }))}
      metricsAtText={formatThaiDateTime(metrics.data.usageEnd ?? new Date())} canManageTemplate={access.warehouses.some(w => canSupervise(w.role))} currentUserId={access.userId} />
    {draftRows.length > 0 && <section className="surface p-4 sm:p-5 grid gap-2">
      <h2 className="font-bold">ฉบับร่างของฉัน</h2>
      <ul className="grid gap-2">{draftRows.map(draft => <li key={draft.id}>
        <Link href={`/purchase-orders/${draft.id}`} className="rounded-xl border border-line p-3 min-h-12 flex justify-between gap-3 no-underline text-[var(--ink)] hover:bg-surface-2">
          <span>{draft.template_name_snapshot ?? 'ไม่ใช้ Template'}<span className="muted text-sm block">แก้ไขล่าสุด {formatThaiDateTime(draft.updated_at)}</span></span>
          <span className="badge h-fit">ฉบับร่าง</span>
        </Link></li>)}</ul>
    </section>}
  </main>;
}
