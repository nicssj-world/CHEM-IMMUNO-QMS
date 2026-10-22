import { redirect } from 'next/navigation';
import { requireAccess } from '@/lib/auth';
import { safeReturnPath } from '@/lib/return-path';
import { canManageVendors, toVendorInput } from '@/lib/vendors';
import { VendorForm } from '@/components/vendor-form';

export default async function NewVendorPage({ searchParams }: { searchParams: Promise<{ return?: string }> }) {
  const access = await requireAccess();
  if (!canManageVendors(access.warehouses)) redirect('/vendors?error=' + encodeURIComponent('เพิ่มผู้ขายได้เฉพาะหัวหน้างานหรือผู้ดูแลระบบ'));
  const returnTo = safeReturnPath((await searchParams).return);
  return <main className="grid gap-6 max-w-[860px]"><div><p className="eyebrow mb-2">Vendor master</p><h1 className="page-title">เพิ่มผู้ขาย</h1><p className="muted mt-2 text-sm">ช่องที่มี * ต้องกรอก · ข้อมูลใช้ร่วมกันทั้งสองคลัง</p></div>
    {returnTo && <p className="notice text-sm">เปิดมาจากหน้ารับเข้า · เพิ่มผู้ขายแล้วระบบจะพากลับไปที่เดิม</p>}
    <VendorForm mode="create" initial={toVendorInput()} returnTo={returnTo} />
  </main>;
}
