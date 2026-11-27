import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireAccess, canSupervise } from '@/lib/auth';
import { createClient } from '@/lib/supabase/server';
import { loadCatalog, loadTemplates, orderWarehouseIds } from '@/lib/purchase-order-data';
import { logUserMessage } from '@/lib/messages';
import { splitTemplateProducts } from '@/lib/purchase-orders';
import { PoTemplateEditor } from '@/components/po-template-editor';

export default async function PurchaseOrderTemplatePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ saved?: string }> }) {
  const { id } = await params;
  const query = await searchParams;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const access = await requireAccess();
  const client = await createClient();
  if (!client) return <p className="error" role="alert">ยังไม่ได้ตั้งค่าการเชื่อมต่อฐานข้อมูล</p>;
  const templates = await loadTemplates(client);
  if (templates.error || !templates.data) return <p className="error" role="alert">โหลด Template ไม่สำเร็จ: {logUserMessage('po-template', templates.error)}</p>;
  const template = templates.data.find(t => t.id === id);
  if (!template) notFound();
  const catalog = await loadCatalog(client, access, template.productIds);
  if (catalog.error || !catalog.data) return <p className="error" role="alert">โหลดรายการน้ำยาไม่สำเร็จ: {logUserMessage('po-template', catalog.error)}</p>;
  const writableWarehouses = orderWarehouseIds(access);
  const canManage = writableWarehouses.length > 0 && (template.created_by === access.userId || access.warehouses.some(w => canSupervise(w.role)));
  const { editableIds, readOnlyIds } = canManage ? splitTemplateProducts(template.productIds, catalog.data, writableWarehouses) : { editableIds: template.productIds, readOnlyIds: [] };
  return <main className="grid gap-4">
    <Link href="/purchase-orders/templates" className="text-sm min-h-11 inline-flex items-center w-fit">← Template ทั้งหมด</Link>
    <h2 className="font-bold text-lg">{canManage ? 'แก้ไข Template' : 'รายละเอียด Template'}</h2>
    {query.saved && <p className="notice" role="status">บันทึก Template แล้ว</p>}
    <PoTemplateEditor key={template.updated_at} templateId={template.id} initialName={template.name} initialProductIds={editableIds} readOnlyProductIds={readOnlyIds}
      updatedAt={template.updated_at} products={catalog.data} canManage={canManage} />
  </main>;
}
