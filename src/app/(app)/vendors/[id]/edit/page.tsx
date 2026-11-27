import { notFound, redirect } from 'next/navigation';
import { requireAccess } from '@/lib/auth';
import { createClient } from '@/lib/supabase/server';
import { VENDOR_COLUMNS, canManageVendors, toVendorInput, type VendorRecord } from '@/lib/vendors';
import { VendorForm } from '@/components/vendor-form';

export default async function EditVendorPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const access = await requireAccess();
  if (!canManageVendors(access.warehouses)) redirect(`/vendors/${id}?error=` + encodeURIComponent('แก้ไขผู้ขายได้เฉพาะหัวหน้างานหรือผู้ดูแลระบบ'));
  const client = await createClient();
  const { data } = client && /^[0-9a-f-]{36}$/i.test(id) ? await client.from('ci_vendors').select(VENDOR_COLUMNS).eq('id', id).maybeSingle() : { data: null };
  if (!data) notFound();
  const vendor = data as VendorRecord;
  return <main className="grid gap-6 max-w-[860px]"><div><p className="eyebrow mb-2">Vendor master</p><h1 className="page-title">แก้ไขผู้ขาย</h1><p className="muted mt-2 text-sm">{vendor.vendor_code} · {vendor.name}</p></div>
    <VendorForm mode="edit" initial={toVendorInput(vendor)} vendorId={vendor.id} updatedAt={vendor.updated_at} />
  </main>;
}
