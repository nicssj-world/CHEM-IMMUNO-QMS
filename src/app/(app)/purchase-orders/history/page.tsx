import { requireAccess } from '@/lib/auth';
import { createClient } from '@/lib/supabase/server';
import { ORDER_COLUMNS, type OrderHeader } from '@/lib/purchase-order-data';
import { readAll, readByIds } from '@/lib/stock-count-data';
import { logUserMessage } from '@/lib/messages';
import { formatDateBE, formatThaiDateTime } from '@/lib/format';
import { PoHistoryList } from '@/components/po-history-list';

export default async function PurchaseOrderHistoryPage() {
  await requireAccess();
  const client = await createClient();
  if (!client) return <p className="error" role="alert">ยังไม่ได้ตั้งค่าการเชื่อมต่อฐานข้อมูล</p>;
  const orders = await readAll<OrderHeader>((from, to) => client.from('ci_purchase_orders').select(ORDER_COLUMNS, { count: 'exact' })
    .order('created_at', { ascending: false }).range(from, to));
  const counts = orders.data ? await readByIds<{ purchase_order_id: string; order_quantity: number | string }>(orders.data.map(o => o.id),
    chunk => client.from('ci_purchase_order_lines').select('purchase_order_id,order_quantity').in('purchase_order_id', chunk).limit(10000)) : { data: null, error: null };
  const error = orders.error ?? counts.error;
  if (error || !orders.data || !counts.data) return <p className="error" role="alert">โหลดประวัติใบสั่งซื้อไม่สำเร็จ: {logUserMessage('po-history', error)} · โหลดหน้าใหม่อีกครั้ง</p>;
  const items = new Map<string, number>();
  for (const line of counts.data) if (Number(line.order_quantity) > 0) items.set(line.purchase_order_id, (items.get(line.purchase_order_id) ?? 0) + 1);
  return <PoHistoryList rows={orders.data.map(order => ({
    id: order.id, poNumber: order.po_number, status: order.status, templateName: order.template_name_snapshot,
    dateText: order.confirmed_at ? formatDateBE(order.confirmed_at) : `ร่าง · ${formatThaiDateTime(order.updated_at)}`,
    itemCount: items.get(order.id) ?? 0, createdByName: order.created_by_name,
    acknowledgedByName: order.acknowledged_by_name, acknowledgedDateText: order.acknowledged_at ? formatThaiDateTime(order.acknowledged_at) : null,
  }))} />;
}
