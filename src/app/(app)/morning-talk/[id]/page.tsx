import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireAccess } from '@/lib/auth';
import { createClient } from '@/lib/supabase/server';
import { bangkokToday } from '@/lib/inventory-insights';
import { cancelMorningTalk } from '@/app/actions/morning-talk';
import { ConfirmForm } from '@/components/confirm-form';
import { logUserMessage, savedNotice } from '@/lib/messages';
import { canManageTalk, type TalkRow } from '@/lib/morning-talk';
import { TALK_COLUMNS, attachChildren, loadManageableScopes, loadNames, userIdsOf } from '@/lib/morning-talk-data';
import { TalkCard } from '@/components/morning-talk/talk-card';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The deep link Attention and the history list point at. A talk that does not exist and one the user cannot read look the same.
export default async function MorningTalkDetailPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ saved?: string; error?: string }> }) {
  const { id } = await params;
  const query = await searchParams;
  const access = await requireAccess();
  const client = await createClient();
  if (!client || !uuid.test(id)) notFound();
  const { data, error } = await client.from('ci_morning_talks').select(TALK_COLUMNS).eq('id', id).maybeSingle();
  if (error) return <main className="grid gap-4"><h1 className="page-title">Morning Talk</h1><p className="error" role="alert">อ่านข้อมูลไม่สำเร็จ: {logUserMessage('morning-talk-detail', error)}</p></main>;
  if (!data) notFound();
  const [detail, manageable] = await Promise.all([attachChildren(client, [data as TalkRow]), loadManageableScopes(client)]);
  if (detail.error) return <main className="grid gap-4"><h1 className="page-title">Morning Talk</h1><p className="error" role="alert">อ่านข้อมูลไม่สำเร็จ: {logUserMessage('morning-talk-detail', detail.error)}</p></main>;
  const talk = detail.data[0];
  const names = await loadNames(client, userIdsOf(detail.data));
  const viewer = { userId: access.userId, warehouses: access.warehouses, manageable };
  return <main className="grid gap-5 max-w-[980px]">
    <div className="print-hide"><Link href="/morning-talk/history">← ประวัติ Morning Talk</Link></div>
    {query.error && <p className="error" role="alert">{query.error}</p>}{query.saved && <p className="notice" role="status">{savedNotice(query.saved, 'บันทึกแล้ว')}</p>}
    <TalkCard talk={talk} names={names} viewer={viewer} today={bangkokToday()} showAck heading="h1" />
    {canManageTalk(manageable, talk.scope) && talk.status === 'active' && <section className="surface p-5 grid gap-3 print-hide" aria-labelledby="cancel-heading"><h2 id="cancel-heading" className="font-bold">ยกเลิก Morning Talk นี้</h2>
      <ConfirmForm action={cancelMorningTalk} className="grid gap-3 sm:grid-cols-[1fr_auto] items-end" message={`ยกเลิก “${talk.title}”? การยกเลิกแล้วแก้ไขหรือรับทราบเพิ่มไม่ได้ · ข้อมูลเดิมยังอยู่เป็นหลักฐาน`}>
        <input type="hidden" name="id" value={talk.id} />
        <label className="field">เหตุผลที่ยกเลิก<input className="input" name="reason" required maxLength={500} placeholder="เช่น จัดผิดวัน หรือรวมกับการประชุมอื่น" /></label>
        <button className="button danger">ยกเลิก Morning Talk</button>
        <p className="muted text-xs sm:col-span-2">ไม่มีการลบจริง · งานที่มอบหมายยังคงค้างอยู่จนกว่าจะเสร็จหรือถูกยกเลิก</p>
      </ConfirmForm></section>}
  </main>;
}
