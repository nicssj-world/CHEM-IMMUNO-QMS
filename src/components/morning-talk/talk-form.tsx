'use client';

import Link from 'next/link';
import { useMemo, useState, useTransition, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowDown, ArrowUp, Copy, Plus, Trash2 } from 'lucide-react';
import { saveMorningTalk } from '@/app/actions/morning-talk';
import { LIMITS, copyFromPrevious, scopeLabel, type ScopeMember, type TalkScope } from '@/lib/morning-talk';

export type FormChecklist = { key: string; id?: string; title: string; completed: boolean };
export type FormAction = { key: string; id?: string; expected_updated_at?: string; cancel?: boolean; title: string; owner_id: string; due_date: string; note: string };
export type TalkFormValue = { scope: TalkScope; talk_date: string; title: string; agenda: string; attendees: string[]; checklist: FormChecklist[]; actions: FormAction[] };
export type PreviousTalk = { agenda: string | null; checklist: { title: string }[] } | null;

type Props = {
  mode: 'create' | 'edit';
  scopes: TalkScope[];
  initial: TalkFormValue;
  membersByScope: Partial<Record<TalkScope, ScopeMember[]>>;
  previousByScope: Partial<Record<TalkScope, PreviousTalk>>;
  /** Existing attendees / owners who may no longer be in the member list still need a name. */
  knownNames: Record<string, string>;
  /** Attendees who already acknowledged: they cannot be removed. */
  lockedAttendees: string[];
  talkId?: string;
  expectedUpdatedAt?: string;
  cancelHref: string;
};

let counter = 0;
const nextKey = () => `k${++counter}`;
export const blankChecklist = (title = ''): FormChecklist => ({ key: nextKey(), title, completed: false });
export const blankAction = (): FormAction => ({ key: nextKey(), title: '', owner_id: '', due_date: '', note: '' });

export function TalkForm({ mode, scopes, initial, membersByScope, previousByScope, knownNames, lockedAttendees, talkId, expectedUpdatedAt, cancelHref }: Props) {
  const router = useRouter();
  const [value, setValue] = useState<TalkFormValue>(initial);
  const [search, setSearch] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [pending, startTransition] = useTransition();
  const set = <K extends keyof TalkFormValue>(field: K, next: TalkFormValue[K]) => setValue(current => ({ ...current, [field]: next }));
  const locked = useMemo(() => new Set(lockedAttendees), [lockedAttendees]);
  const members = useMemo(() => membersByScope[value.scope] ?? [], [membersByScope, value.scope]);
  // Pickers offer only people the database will accept; people already on the talk stay listed so an edit never silently drops them.
  const attendeeCandidates = useMemo(() => {
    const list = members.filter(member => member.attendee_eligible).map(member => ({ id: member.user_id, name: member.display_name, position: member.position_title }));
    for (const id of value.attendees) if (!list.some(item => item.id === id)) list.push({ id, name: knownNames[id] ?? 'ไม่ทราบชื่อ', position: null });
    return list;
  }, [members, value.attendees, knownNames]);
  const visibleCandidates = attendeeCandidates.filter(item => `${item.name} ${item.position ?? ''}`.toLowerCase().includes(search.trim().toLowerCase()));
  const owners = useMemo(() => {
    const list = members.filter(member => member.owner_eligible).map(member => ({ id: member.user_id, name: member.display_name }));
    for (const action of value.actions) if (action.owner_id && !list.some(item => item.id === action.owner_id)) list.push({ id: action.owner_id, name: knownNames[action.owner_id] ?? 'ไม่ทราบชื่อ' });
    return list;
  }, [members, value.actions, knownNames]);

  const changeScope = (scope: TalkScope) => setValue(current => ({ ...current, scope, attendees: [], actions: current.actions.map(action => ({ ...action, owner_id: '' })) }));
  const toggleAttendee = (id: string) => { if (locked.has(id)) return; set('attendees', value.attendees.includes(id) ? value.attendees.filter(item => item !== id) : [...value.attendees, id]); };
  const selectEveryone = () => set('attendees', [...new Set([...value.attendees, ...attendeeCandidates.map(item => item.id)])]);
  const clearAttendees = () => set('attendees', value.attendees.filter(id => locked.has(id)));

  const previous = previousByScope[value.scope] ?? null;
  const copyPrevious = () => {
    const copy = copyFromPrevious(previous);
    if (!copy) return;
    setValue(current => ({ ...current, agenda: copy.agenda, checklist: copy.checklist.map(item => blankChecklist(item.title)) }));
  };

  const moveItem = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= value.checklist.length) return;
    const next = [...value.checklist];
    [next[index], next[target]] = [next[target], next[index]];
    set('checklist', next);
  };
  const patchChecklist = (index: number, patch: Partial<FormChecklist>) => set('checklist', value.checklist.map((item, at) => (at === index ? { ...item, ...patch } : item)));
  const patchAction = (index: number, patch: Partial<FormAction>) => set('actions', value.actions.map((item, at) => (at === index ? { ...item, ...patch } : item)));

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setErrors({});
    const payload = {
      ...(mode === 'edit' ? { id: talkId, expected_updated_at: expectedUpdatedAt } : { scope: value.scope }),
      talk_date: value.talk_date || undefined, title: value.title, agenda: value.agenda, attendees: value.attendees,
      // No filtering: payload positions must match the rows on screen so a field error highlights the right row.
      checklist: value.checklist.map(item => ({ ...(item.id ? { id: item.id } : {}), title: item.title })),
      actions: value.actions.map(item => ({ ...(item.id ? { id: item.id, expected_updated_at: item.expected_updated_at } : {}), ...(item.cancel ? { cancel: true } : {}), title: item.title, owner_id: item.owner_id, due_date: item.due_date || null, note: item.note })),
    };
    startTransition(async () => {
      const result = await saveMorningTalk(payload);
      if (!result.ok) { setError(result.message); setErrors(result.errors ?? {}); return; }
      router.push(`/morning-talk/${result.id}?saved=${encodeURIComponent(mode === 'create' ? 'สร้าง Morning Talk แล้ว' : 'บันทึกการแก้ไขแล้ว')}&at=${Date.now().toString(36)}`);
      router.refresh();
    });
  }
  const fieldError = (path: string) => errors[path] ? <p id={`error-${path}`} className="text-sm text-[#8c2534]" role="alert">{errors[path]}</p> : null;
  const describe = (path: string) => (errors[path] ? { 'aria-invalid': true, 'aria-describedby': `error-${path}` } as const : {});

  return <form onSubmit={submit} className="grid gap-5" noValidate>
    <section className="surface p-5 sm:p-7 grid gap-4">
      <h2 className="font-bold text-lg">รายละเอียด</h2>
      <div className="grid sm:grid-cols-2 gap-4">
        <div className="grid gap-1"><label className="field" htmlFor="mt-scope">ขอบเขต
          {mode === 'create'
            ? <select id="mt-scope" className="input" value={value.scope} onChange={event => changeScope(event.target.value as TalkScope)}>{scopes.map(scope => <option key={scope} value={scope}>{scope === 'ALL' ? 'ทั้งสองคลัง (ALL)' : `${scopeLabel(scope)} (${scope})`}</option>)}</select>
            : <input id="mt-scope" className="input" value={`${scopeLabel(value.scope)} (${value.scope})`} readOnly />}
        </label>{mode === 'edit' && <p className="muted text-xs">เปลี่ยนขอบเขตหลังสร้างแล้วไม่ได้</p>}{fieldError('scope')}</div>
        <div className="grid gap-1"><label className="field" htmlFor="mt-date">วันที่
          <input id="mt-date" className="input" type="date" value={value.talk_date} onChange={event => set('talk_date', event.target.value)} {...describe('talk_date')} />
        </label>{fieldError('talk_date')}</div>
      </div>
      <div className="grid gap-1"><label className="field" htmlFor="mt-title">หัวข้อ
        <input id="mt-title" className="input" value={value.title} maxLength={LIMITS.title} onChange={event => set('title', event.target.value)} required placeholder="เช่น Morning Talk ประจำวัน" {...describe('title')} />
      </label>{fieldError('title')}</div>
      <div className="grid gap-1"><label className="field" htmlFor="mt-agenda">วาระ / เรื่องที่แจ้ง
        <textarea id="mt-agenda" className="input" rows={5} value={value.agenda} maxLength={LIMITS.agenda} onChange={event => set('agenda', event.target.value)} {...describe('agenda')} />
      </label>{fieldError('agenda')}</div>
      {mode === 'create' && <div className="grid gap-1"><button type="button" className="button secondary justify-self-start" onClick={copyPrevious} disabled={!previous}><Copy size={16} aria-hidden />คัดลอกหัวข้อจากครั้งก่อน</button>
        <p className="muted text-xs">{previous ? 'คัดลอกวาระและรายการตรวจสอบของครั้งล่าสุดในขอบเขตนี้ · ไม่คัดลอกผู้เข้าร่วม งาน หรือสถานะการทำเสร็จ' : 'ยังไม่มี Morning Talk ก่อนหน้าในขอบเขตนี้'}</p></div>}
    </section>

    <section className="surface p-5 sm:p-7 grid gap-3" aria-labelledby="mt-attendees-heading">
      <div className="flex flex-wrap items-center justify-between gap-2"><h2 id="mt-attendees-heading" className="font-bold text-lg">ผู้เข้าร่วม <span className="muted font-normal text-sm">{value.attendees.length}/{LIMITS.attendees}</span></h2>
        <div className="flex flex-wrap gap-2"><button type="button" className="button secondary" onClick={selectEveryone}>ทุกคนในขอบเขต</button><button type="button" className="button secondary" onClick={clearAttendees}>ล้างการเลือก</button></div></div>
      <label className="field">ค้นหาชื่อ<input className="input" type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder="พิมพ์ชื่อหรือตำแหน่ง" /></label>
      <ul className="grid gap-1.5 max-h-72 overflow-y-auto" aria-label="รายชื่อผู้เข้าร่วมที่เลือกได้">{visibleCandidates.map(item => <li key={item.id}>
        <label className="flex items-center gap-3 rounded-lg border border-line p-3 min-h-11 cursor-pointer"><input type="checkbox" className="h-5 w-5" checked={value.attendees.includes(item.id)} disabled={locked.has(item.id)} onChange={() => toggleAttendee(item.id)} />
          <span className="grid"><span>{item.name}</span>{item.position && <span className="muted text-xs">{item.position}</span>}</span>{locked.has(item.id) && <span className="badge ml-auto">รับทราบแล้ว</span>}</label></li>)}
        {visibleCandidates.length === 0 && <li className="muted text-sm">ไม่พบรายชื่อ</li>}</ul>
      {fieldError('attendees')}
    </section>

    <section className="surface p-5 sm:p-7 grid gap-3" aria-labelledby="mt-checklist-heading">
      <h2 id="mt-checklist-heading" className="font-bold text-lg">รายการตรวจสอบ <span className="muted font-normal text-sm">{value.checklist.length}/{LIMITS.checklist}</span></h2>
      <ul className="grid gap-2">{value.checklist.map((item, index) => <li key={item.key} className="grid grid-cols-[minmax(0,1fr)_auto] gap-2 items-start">
        <div className="grid gap-1"><input className="input" aria-label={`รายการตรวจสอบข้อ ${index + 1}`} value={item.title} maxLength={LIMITS.checklistTitle} onChange={event => patchChecklist(index, { title: event.target.value })} {...describe(`checklist.${index}.title`)} />{item.completed && <p className="muted text-xs">ทำเครื่องหมายเสร็จแล้ว · ลบไม่ได้</p>}{fieldError(`checklist.${index}.title`)}</div>
        <div className="flex gap-1">
          <button type="button" className="button secondary px-3" aria-label={`เลื่อนข้อ ${index + 1} ขึ้น`} onClick={() => moveItem(index, -1)} disabled={index === 0}><ArrowUp size={16} aria-hidden /></button>
          <button type="button" className="button secondary px-3" aria-label={`เลื่อนข้อ ${index + 1} ลง`} onClick={() => moveItem(index, 1)} disabled={index === value.checklist.length - 1}><ArrowDown size={16} aria-hidden /></button>
          <button type="button" className="button secondary px-3" aria-label={`ลบข้อ ${index + 1}`} onClick={() => set('checklist', value.checklist.filter((_, at) => at !== index))} disabled={item.completed}><Trash2 size={16} aria-hidden /></button>
        </div></li>)}</ul>
      <button type="button" className="button secondary justify-self-start" onClick={() => set('checklist', [...value.checklist, blankChecklist()])} disabled={value.checklist.length >= LIMITS.checklist}><Plus size={16} aria-hidden />เพิ่มรายการตรวจสอบ</button>
      {fieldError('checklist')}
    </section>

    <section className="surface p-5 sm:p-7 grid gap-3" aria-labelledby="mt-actions-heading">
      <h2 id="mt-actions-heading" className="font-bold text-lg">งานที่มอบหมาย <span className="muted font-normal text-sm">{value.actions.length}/{LIMITS.actions}</span></h2>
      <p className="muted text-xs">ผู้รับผิดชอบต้องเป็นเจ้าหน้าที่ขึ้นไปในขอบเขตนี้ · งานที่บันทึกแล้วจะถูกตั้งเป็น “ยกเลิก” เมื่อกดยกเลิก ไม่ถูกลบจริง</p>
      <ul className="grid gap-3">{value.actions.map((action, index) => action.cancel ? <li key={action.key} className="rounded-lg border border-line p-3 flex flex-wrap items-center justify-between gap-2">
        <span><span className="line-through muted">{action.title}</span> <span className="badge">จะยกเลิกเมื่อบันทึก</span></span>
        <button type="button" className="button secondary" onClick={() => patchAction(index, { cancel: false })}>ไม่ยกเลิก</button>
      </li> : <li key={action.key} className="rounded-lg border border-line p-3 grid gap-3">
        <div className="grid gap-1"><label className="field">งานที่ต้องทำ<input className="input" value={action.title} maxLength={LIMITS.actionTitle} onChange={event => patchAction(index, { title: event.target.value })} {...describe(`actions.${index}.title`)} /></label>{fieldError(`actions.${index}.title`)}</div>
        <div className="grid sm:grid-cols-2 gap-3">
          <div className="grid gap-1"><label className="field">ผู้รับผิดชอบ<select className="input" value={action.owner_id} onChange={event => patchAction(index, { owner_id: event.target.value })} {...describe(`actions.${index}.owner_id`)}><option value="">— เลือกผู้รับผิดชอบ —</option>{owners.map(owner => <option key={owner.id} value={owner.id}>{owner.name}</option>)}</select></label>{fieldError(`actions.${index}.owner_id`)}</div>
          <div className="grid gap-1"><label className="field">กำหนดส่ง<input className="input" type="date" value={action.due_date} onChange={event => patchAction(index, { due_date: event.target.value })} {...describe(`actions.${index}.due_date`)} /></label>{fieldError(`actions.${index}.due_date`)}</div>
        </div>
        <label className="field">หมายเหตุ<input className="input" value={action.note} maxLength={LIMITS.note} onChange={event => patchAction(index, { note: event.target.value })} /></label>
        <button type="button" className="button secondary justify-self-start" onClick={() => (action.id ? patchAction(index, { cancel: true }) : set('actions', value.actions.filter((_, at) => at !== index)))}><Trash2 size={16} aria-hidden />{action.id ? 'ยกเลิกงานนี้' : 'ลบ'}</button>
      </li>)}</ul>
      <button type="button" className="button secondary justify-self-start" onClick={() => set('actions', [...value.actions, blankAction()])} disabled={value.actions.length >= LIMITS.actions}><Plus size={16} aria-hidden />เพิ่มงาน</button>
      {fieldError('actions')}
    </section>

    {error && <p className="error" role="alert">{error}</p>}
    <div className="flex flex-wrap gap-3"><button className="button" type="submit" disabled={pending} aria-busy={pending}>{pending ? <><span className="spinner" aria-hidden="true" /><span role="status">กำลังบันทึก…</span></> : mode === 'create' ? 'สร้าง Morning Talk' : 'บันทึกการแก้ไข'}</button><Link className="button secondary" href={cancelHref}>ยกเลิก</Link></div>
  </form>;
}
