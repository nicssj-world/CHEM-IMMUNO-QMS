import Link from 'next/link';
import { Plus } from 'lucide-react';
import { requireAccess } from '@/lib/auth';
import { createClient } from '@/lib/supabase/server';
import { bangkokToday } from '@/lib/inventory-insights';
import { formatDate } from '@/lib/format';
import { logUserMessage, savedNotice } from '@/lib/messages';
import { creatableScopes, type TalkRow } from '@/lib/morning-talk';
import { TALK_COLUMNS, attachChildren, loadManageableScopes, loadNames, userIdsOf } from '@/lib/morning-talk-data';
import { AckButton } from '@/components/morning-talk/ack-button';
import { ScopeBadge, TalkCard } from '@/components/morning-talk/talk-card';

// Today: the talks visible to me for today's Bangkok date, with a prominent acknowledge card first when I still have to acknowledge.
export default async function MorningTalkTodayPage({ searchParams }: { searchParams: Promise<{ saved?: string; error?: string }> }) {
  const query = await searchParams;
  const access = await requireAccess();
  const client = await createClient();
  if (!client) return <main className="grid gap-4"><h1 className="page-title">Morning Talk</h1><p className="error" role="alert">ยังไม่ได้ตั้งค่าการเชื่อมต่อฐานข้อมูล</p></main>;
  const today = bangkokToday();
  const [talkResult, manageable] = await Promise.all([
    client.from('ci_morning_talks').select(TALK_COLUMNS).eq('talk_date', today).order('created_at').limit(50),
    loadManageableScopes(client),
  ]);
  if (talkResult.error) return <main className="grid gap-4"><h1 className="page-title">Morning Talk</h1><p className="error" role="alert">อ่านข้อมูลไม่สำเร็จ: {logUserMessage('morning-talk-today', talkResult.error)}</p></main>;
  const detail = await attachChildren(client, (talkResult.data ?? []) as TalkRow[]);
  if (detail.error) return <main className="grid gap-4"><h1 className="page-title">Morning Talk</h1><p className="error" role="alert">อ่านข้อมูลไม่สำเร็จ: {logUserMessage('morning-talk-today', detail.error)}</p></main>;
  const talks = detail.data;
  const names = await loadNames(client, userIdsOf(talks));
  const viewer = { userId: access.userId, warehouses: access.warehouses, manageable };
  const pending = talks.filter(talk => talk.status === 'active').flatMap(talk => {
    const mine = talk.attendees.find(item => item.user_id === access.userId);
    return mine && !mine.acknowledged_at ? [talk] : [];
  });
  return <main className="grid gap-6 max-w-[980px]">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><p className="eyebrow mb-2">Morning Talk</p><h1 className="page-title">Morning Talk วันนี้</h1><p className="muted mt-2 text-sm">{formatDate(today)} · เวลา Asia/Bangkok</p></div>
      {creatableScopes(manageable).length > 0 && <Link className="button" href="/morning-talk/new"><Plus size={16} aria-hidden />สร้าง Morning Talk</Link>}</div>
    {query.error && <p className="error" role="alert">{query.error}</p>}{query.saved && <p className="notice" role="status">{savedNotice(query.saved, 'บันทึกแล้ว')}</p>}
    {pending.length > 0 && <section className="surface p-5 grid gap-4" aria-labelledby="ack-heading" style={{ borderColor: '#0b6f8f', borderWidth: 2 }}>
      <div><h2 id="ack-heading" className="text-xl font-bold">รอให้คุณรับทราบ ({pending.length})</h2><p className="muted text-sm">กด “รับทราบ” เมื่อรับฟังการแจ้งแล้ว · เป็นการยืนยันว่าคุณได้รับทราบ ไม่ใช่การลงนาม</p></div>
      <ul className="grid gap-3">{pending.map(talk => <li key={talk.id} className="grid gap-2 sm:grid-cols-[1fr_220px] items-center rounded-lg border border-line p-3">
        <div className="grid gap-1"><span className="flex flex-wrap items-center gap-2"><ScopeBadge scope={talk.scope} /><Link href={`/morning-talk/${talk.id}`} className="font-bold">{talk.title}</Link></span>{talk.agenda && <p className="muted text-sm line-clamp-2">{talk.agenda}</p>}</div>
        <AckButton talkId={talk.id} acknowledgedAt={null} />
      </li>)}</ul>
    </section>}
    {talks.length === 0 && <section className="surface p-6 grid gap-2"><h2 className="font-bold">ยังไม่มี Morning Talk วันนี้</h2><p className="muted text-sm">เมื่อหัวหน้างานสร้างและเพิ่มชื่อคุณเป็นผู้เข้าร่วม จะแสดงที่นี่</p><div className="flex flex-wrap gap-2"><Link className="button secondary" href="/morning-talk/history">ดูประวัติ</Link><Link className="button secondary" href="/morning-talk/actions">งานค้าง</Link></div></section>}
    {talks.map(talk => <TalkCard key={talk.id} talk={talk} names={names} viewer={viewer} today={bangkokToday()} href={`/morning-talk/${talk.id}`} />)}
  </main>;
}
