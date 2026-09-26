import Link from 'next/link';
import { redirect } from 'next/navigation';
import { requireAccess } from '@/lib/auth';
import { createClient } from '@/lib/supabase/server';
import { isLocationQrToken } from '@/lib/location-qr';

/**
 * Landing route for a printed Location QR. The scan works like any deep link: an unauthenticated visitor is sent to the login
 * page and returned here afterwards, and the token is looked up through row-level security as the signed-in user. A malformed,
 * rotated, unknown or other-warehouse token all end on the same page, so the response never says which one it was.
 */
export default async function LocationQrLanding({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const access = await requireAccess();
  if (isLocationQrToken(token)) {
    const client = await createClient();
    const { data } = client ? await client.from('ci_locations').select('id,warehouse_id').eq('qr_token', token).maybeSingle() : { data: null };
    const warehouse = data && access.warehouses.find(item => Number(item.id) === data.warehouse_id);
    if (data && warehouse) redirect(`/locations/${data.id}?warehouse=${warehouse.code}`);
  }
  return <main className="grid gap-4 max-w-[560px]"><h1 className="page-title">ไม่พบตำแหน่งนี้</h1>
    <p className="notice" role="status">ไม่พบตำแหน่งนี้ หรือคุณไม่มีสิทธิ์เข้าถึง · QR อาจถูกยกเลิกแล้ว · ขอให้หัวหน้างานพิมพ์ป้ายใหม่ หรือค้นหาตำแหน่งจากรายการ</p>
    <div className="flex flex-wrap gap-3"><Link className="button" href="/locations">ไปที่รายการตำแหน่ง</Link><Link className="button secondary" href="/">กลับหน้าภาพรวม</Link></div></main>;
}
