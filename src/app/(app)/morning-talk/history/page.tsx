import Link from 'next/link';
import { Ban } from 'lucide-react';
import { requireAccess } from '@/lib/auth';
import { createClient } from '@/lib/supabase/server';
import { formatDate } from '@/lib/format';
import { logUserMessage } from '@/lib/messages';
import { acknowledgement, checklistProgress, isDateOnly, isTalkScope, scopeLabel, searchTerm, TALK_SCOPES, type TalkRow } from '@/lib/morning-talk';
import { TALK_COLUMNS, attachChildren } from '@/lib/morning-talk-data';
import { ScopeBadge } from '@/components/morning-talk/talk-card';

const PAGE_SIZE = 20;
type Params = { q?: string; scope?: string; from?: string; to?: string; page?: string };

function hrefFor(params: Params, page: number) {
  const query = new URLSearchParams();
  for (const key of ['q', 'scope', 'from', 'to'] as const) if (params[key]) query.set(key, params[key]!);
  if (page > 1) query.set('page', String(page));
  const text = query.toString();
  return `/morning-talk/history${text ? `?${text}` : ''}`;
}

// History across every scope the user can read (row-level security decides which). Search is a case-insensitive match on title or agenda.
export default async function MorningTalkHistoryPage({ searchParams }: { searchParams: Promise<Params> }) {
  const params = await searchParams;
  await requireAccess();
  const client = await createClient();
  if (!client) return <main className="grid gap-4"><h1 className="page-title">ประวัติ Morning Talk</h1><p className="error" role="alert">ยังไม่ได้ตั้งค่าการเชื่อมต่อฐานข้อมูล</p></main>;
  const q = searchTerm(params.q);
  const scope = isTalkScope(params.scope) ? params.scope : '';
  const from = isDateOnly(params.from) ? params.from : '';
  const to = isDateOnly(params.to) ? params.to : '';
  const page = Math.max(1, Math.min(10000, Number.parseInt(params.page ?? '1', 10) || 1));
  let query = client.from('ci_morning_talks').select(TALK_COLUMNS, { count: 'exact' }).order('talk_date', { ascending: false }).order('created_at', { ascending: false });
  if (q) query = query.or(`title.ilike.%${q}%,agenda.ilike.%${q}%`);
  if (scope) query = query.eq('scope', scope);
  if (from) query = query.gte('talk_date', from);
  if (to) query = query.lte('talk_date', to);
  const result = await query.range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1);
  if (result.error) return <main className="grid gap-4"><h1 className="page-title">ประวัติ Morning Talk</h1><p className="error" role="alert">อ่านข้อมูลไม่สำเร็จ: {logUserMessage('morning-talk-history', result.error)}</p></main>;
  const detail = await attachChildren(client, (result.data ?? []) as TalkRow[]);
  if (detail.error) return <main className="grid gap-4"><h1 className="page-title">ประวัติ Morning Talk</h1><p className="error" role="alert">อ่านข้อมูลไม่สำเร็จ: {logUserMessage('morning-talk-history', detail.error)}</p></main>;
  const total = result.count ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const current = { q, scope, from, to };
  return <main className="grid gap-5 max-w-[980px]">
    <div><p className="eyebrow mb-2">Morning Talk</p><h1 className="page-title">ประวัติ Morning Talk</h1><p className="muted mt-2 text-sm">ทุกครั้งที่คุณมีสิทธิ์ดู · {total} รายการ</p></div>
    <form method="get" className="surface p-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-[1fr_180px_160px_160px_auto] items-end" aria-label="ค้นหาประวัติ">
      <label className="field">ค้นหา<input className="input" type="search" name="q" defaultValue={q} maxLength={80} placeholder="หัวข้อหรือวาระ" /></label>
      <label className="field">ขอบเขต<select className="input" name="scope" defaultValue={scope}><option value="">ทั้งหมด</option>{TALK_SCOPES.map(item => <option key={item} value={item}>{item === 'ALL' ? 'ทั้งสองคลัง (ALL)' : `${scopeLabel(item)} (${item})`}</option>)}</select></label>
      <label className="field">ตั้งแต่<input className="input" type="date" name="from" defaultValue={from} /></label>
      <label className="field">ถึง<input className="input" type="date" name="to" defaultValue={to} /></label>
      <div className="flex gap-2"><button className="button">ค้นหา</button>{(q || scope || from || to) && <Link className="button secondary" href="/morning-talk/history">ล้าง</Link>}</div>
    </form>
    <section aria-label="รายการ Morning Talk" className="grid gap-3">
      {detail.data.map(talk => { const ack = acknowledgement(talk.attendees); const progress = checklistProgress(talk.checklist); return <Link key={talk.id} href={`/morning-talk/${talk.id}`} className="surface p-4 grid gap-1.5 no-underline text-[var(--ink)]">
        <span className="flex flex-wrap items-center gap-2"><ScopeBadge scope={talk.scope} />{talk.status === 'cancelled' && <span className="badge" style={{ background: '#fff1f2', color: '#8c2534' }}><Ban size={13} aria-hidden className="mr-1" />ยกเลิกแล้ว</span>}<span className="muted text-sm">{formatDate(talk.talk_date)}</span></span>
        <strong>{talk.title}</strong>
        <span className="muted text-sm">รับทราบ {ack.done}/{ack.total} · รายการตรวจสอบ {progress.done}/{progress.total} · งาน {talk.actions.length}</span>
      </Link>; })}
      {detail.data.length === 0 && <p className="surface p-6 muted">ไม่พบ Morning Talk ตามเงื่อนไขที่เลือก</p>}
    </section>
    {pages > 1 && <nav aria-label="หน้า" className="flex flex-wrap items-center justify-between gap-3 print-hide">
      {page > 1 ? <Link className="button secondary" href={hrefFor(current, page - 1)}>← ก่อนหน้า</Link> : <span />}
      <span className="muted text-sm">หน้า {page} / {pages}</span>
      {page < pages ? <Link className="button secondary" href={hrefFor(current, page + 1)}>ถัดไป →</Link> : <span />}
    </nav>}
  </main>;
}
