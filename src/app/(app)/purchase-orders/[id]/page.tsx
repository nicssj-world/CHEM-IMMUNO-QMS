import { notFound } from 'next/navigation';
import { requireAccess, canSupervise } from '@/lib/auth';
import { createClient } from '@/lib/supabase/server';
import { loadCatalog, loadMetrics, loadOrder, loadTemplates } from '@/lib/purchase-order-data';
import { logUserMessage } from '@/lib/messages';
import { formatThaiDateTime } from '@/lib/format';
import { PoEditor } from '@/components/po-editor';
import { PoDocument } from '@/components/po-document';

export default async function PurchaseOrderPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ created?: string }> }) {
  const { id } = await params;
  const query = await searchParams;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const access = await requireAccess();
  const client = await createClient();
  if (!client) return <p className="error" role="alert">ยังไม่ได้ตั้งค่าการเชื่อมต่อฐานข้อมูล</p>;
  const order = await loadOrder(client, id);
  if (order.error) return <p className="error" role="alert">โหลดใบสั่งซื้อไม่สำเร็จ: {logUserMessage('po-detail', order.error)} · โหลดหน้าใหม่อีกครั้ง</p>;
  if (!order.data) notFound();
  const { header, lines } = order.data;
  if (header.status !== 'draft') {
    // A confirmed order always shows its saved snapshot, never today's stock or ROP.
    const canCancel = header.status === 'ordered' && (header.created_by === access.userId
      || [...new Set(lines.map(l => Number(l.warehouse_id)))].every(wh => access.warehouses.some(w => Number(w.id) === wh && canSupervise(w.role))));
    return <PoDocument header={header} lines={lines} created={Boolean(query.created)} canCancel={canCancel} />;
  }
  const [catalog, templates] = await Promise.all([loadCatalog(client, access, lines.map(l => l.product_id)), loadTemplates(client)]);
  const metrics = catalog.data ? await loadMetrics(client, catalog.data.map(p => p.id)) : { data: null, error: null };
  const error = catalog.error ?? templates.error ?? metrics.error;
  if (error || !catalog.data || !templates.data || !metrics.data) return <p className="error" role="alert">โหลดข้อมูลใบสั่งซื้อไม่สำเร็จ: {logUserMessage('po-draft', error)} · โหลดหน้าใหม่อีกครั้ง</p>;
  return <main className="grid gap-4">
    <p className="muted text-sm">ฉบับร่าง · สร้างเมื่อ {formatThaiDateTime(header.created_at)} · แก้ไขล่าสุด {formatThaiDateTime(header.updated_at)}</p>
    <PoEditor orderId={header.id} products={catalog.data} metrics={metrics.data.metrics} templates={templates.data}
      initialTemplateId={header.template_id} initialLines={lines.map(l => ({ productId: l.product_id, quantity: String(Number(l.order_quantity)) }))}
      metricsAtText={formatThaiDateTime(metrics.data.usageEnd ?? new Date())} canManageTemplate={access.warehouses.some(w => canSupervise(w.role))} currentUserId={access.userId} />
  </main>;
}
