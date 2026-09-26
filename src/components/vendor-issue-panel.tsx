'use client';

import { useState, useTransition, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@supabase/supabase-js';
import { cancelVendorIssueAction, finishIssueAttachment, openVendorIssue, prepareIssueAttachment, removeIssueAttachment, resolveVendorIssueAction } from '@/app/actions/vendors';
import { formatDateTime } from '@/lib/format';
import {
  ISSUE_CANCEL_REASON_LABELS, ISSUE_FILE_MAX_BYTES, ISSUE_FILE_TYPES, ISSUE_MANUAL_CANCEL_REASONS, ISSUE_RESOLUTION_ACTIONS, ISSUE_RESOLUTION_LABELS, ISSUE_SOURCE_LABELS,
  ISSUE_STATUS_LABELS, ISSUE_TYPE_LABELS, VENDOR_ISSUE_BUCKET, VENDOR_ISSUE_TYPES, type IssueAttachment, type VendorIssue,
} from '@/lib/vendor-issues';

let storageClient: ReturnType<typeof createClient> | undefined;
function storage() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL; const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) throw new Error('ยังไม่ได้ตั้งค่าการเชื่อมต่อระบบจัดเก็บไฟล์');
  storageClient ??= createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
  return storageClient;
}

const tone: Record<string, string> = { open: 'is-open', resolved: 'is-resolved', cancelled: 'is-cancelled' };

/**
 * LABCBH-Stock VendorIssuePanel: list, act (resolve / attach evidence / cancel) and open manual issues.
 * The workbench offers only what the database accepts: resolving needs an open issue, cancelling one not yet cancelled.
 */
export function VendorIssuePanel({ issues, attachments, vendorId, warehouseId, invoices, canOpen, canResolve, canCancel, emptyText = 'ยังไม่มีปัญหาผู้ขาย' }: {
  issues: VendorIssue[]; attachments: IssueAttachment[]; vendorId: string; warehouseId: number; invoices: { id: string; invoice_number: string }[];
  canOpen: boolean; canResolve: boolean; canCancel: boolean; emptyText?: string;
}) {
  const router = useRouter();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [action, setAction] = useState<string>('verified_no_impact');
  const [note, setNote] = useState('');
  const [cancelReason, setCancelReason] = useState<string>('duplicate');
  const [cancelNote, setCancelNote] = useState('');
  const [type, setType] = useState<string>('other');
  const [description, setDescription] = useState('');
  const [invoiceId, setInvoiceId] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const selected = issues.find(i => i.id === selectedId) ?? null;
  const filesOf = (id: string) => attachments.filter(a => a.issue_id === id);

  function run(work: () => Promise<{ ok: boolean; message?: string }>, after?: () => void) {
    setError(null); setMessage(null);
    startTransition(async () => {
      try {
        const result = await work();
        if (!result.ok) { setError(result.message ?? 'ทำรายการไม่สำเร็จ'); return; }
        after?.(); router.refresh();
      } catch (caught) { setError(caught instanceof Error ? caught.message : 'ทำรายการไม่สำเร็จ'); }
    });
  }
  const submitResolve = (event: FormEvent) => { event.preventDefault(); if (selected) run(() => resolveVendorIssueAction(selected.id, action, note), () => { setSelectedId(null); setNote(''); setMessage('บันทึกการแก้ไขแล้ว'); }); };
  const submitManual = (event: FormEvent) => { event.preventDefault(); run(() => openVendorIssue({ vendorId, warehouseId, issueType: type, description, invoiceId: invoiceId || null }), () => { setDescription(''); setMessage('บันทึกปัญหาแล้ว'); }); };
  const submitCancel = () => { if (selected) run(() => cancelVendorIssueAction(selected.id, cancelReason, cancelNote), () => { setSelectedId(null); setCancelNote(''); setMessage('ยกเลิกปัญหาแล้ว'); }); };

  function upload() {
    if (!selected || !file) return;
    const issue = selected;
    setError(null); setMessage(null);
    startTransition(async () => {
      let attachmentId = '';
      try {
        const prepared = await prepareIssueAttachment(issue.id, { name: file.name, type: file.type, size: file.size });
        if (!prepared.ok) { setError(prepared.message); return; }
        attachmentId = prepared.data.attachmentId;
        const stored = await storage().storage.from(VENDOR_ISSUE_BUCKET).uploadToSignedUrl(prepared.data.path, prepared.data.token, file, { contentType: file.type });
        if (stored.error) throw new Error('อัปโหลดหลักฐานไม่สำเร็จ กรุณาลองใหม่');
        await finishIssueAttachment();
        setFile(null); setMessage('แนบหลักฐานแล้ว'); router.refresh();
      } catch (caught) {
        if (attachmentId) await removeIssueAttachment(attachmentId);
        setError(caught instanceof Error ? caught.message : 'อัปโหลดหลักฐานไม่สำเร็จ');
      }
    });
  }

  const canActOn = (issue: VendorIssue) => canResolve || (canCancel && issue.status !== 'cancelled');
  return <div className="grid gap-4">
    {issues.length === 0 ? <p className="muted text-sm">{emptyText}</p> : <ul className="grid gap-2">{issues.map(issue => {
      const files = filesOf(issue.id);
      return <li key={issue.id} className={`vendor-issue ${tone[issue.status] ?? ''} ${selectedId === issue.id ? 'is-selected' : ''}`}>
        <div className="min-w-0 grid gap-1">
          <div className="flex flex-wrap items-center gap-2"><strong>{ISSUE_TYPE_LABELS[issue.issue_type] ?? issue.issue_type}</strong><span className="badge">{ISSUE_STATUS_LABELS[issue.status] ?? issue.status}</span></div>
          <p className="muted text-xs">{ISSUE_SOURCE_LABELS[issue.source_kind] ?? issue.source_kind} · เปิดเมื่อ {formatDateTime(issue.created_at)}</p>
          <p className="text-sm break-words">{issue.description}</p>
          {issue.status === 'resolved' && issue.resolution_action && <p className="text-sm"><strong>{ISSUE_RESOLUTION_LABELS[issue.resolution_action] ?? issue.resolution_action}</strong>{issue.resolution_note ? ` — ${issue.resolution_note}` : ''}</p>}
          {issue.status === 'cancelled' && issue.cancelled_reason && <p className="muted text-sm">ยกเลิก: {ISSUE_CANCEL_REASON_LABELS[issue.cancelled_reason] ?? issue.cancelled_reason}{issue.cancelled_note ? ` — ${issue.cancelled_note}` : ''}</p>}
          {files.length > 0 && <ul className="flex flex-wrap gap-2 text-sm">{files.map(f => <li key={f.id}><a href={`/attachments/issue/${f.id}`} target="_blank" rel="noopener noreferrer">หลักฐาน: {f.file_name}</a></li>)}</ul>}
        </div>
        {canActOn(issue) && <button type="button" className="button secondary shrink-0" aria-expanded={selectedId === issue.id} onClick={() => setSelectedId(selectedId === issue.id ? null : issue.id)}>{selectedId === issue.id ? 'ปิด' : 'ดำเนินการ'}</button>}
      </li>;
    })}</ul>}

    {selected && <div className="surface p-4 grid gap-4" role="group" aria-label={`ดำเนินการกับปัญหา ${ISSUE_TYPE_LABELS[selected.issue_type] ?? ''}`}>
      {canResolve && selected.status === 'open' && <form onSubmit={submitResolve} className="grid gap-3"><h3 className="font-bold">บันทึกการแก้ไขปัญหา</h3>
        <label className="field">วิธีดำเนินการ<select className="input" value={action} onChange={e => setAction(e.target.value)}>{ISSUE_RESOLUTION_ACTIONS.map(a => <option key={a} value={a}>{ISSUE_RESOLUTION_LABELS[a]}</option>)}</select></label>
        <label className="field">รายละเอียดการแก้ไข<textarea className="input min-h-20" required value={note} onChange={e => setNote(e.target.value)} maxLength={2000} /></label>
        <div><button type="submit" className="button" disabled={pending || !note.trim()}>ยืนยันว่าแก้ไขแล้ว</button></div></form>}
      {canResolve && selected.status === 'open' && <div className="grid gap-2"><h3 className="font-bold">หลักฐานประกอบ (ไม่บังคับ)</h3>
        <input type="file" className="input" accept={ISSUE_FILE_TYPES.join(',')} onChange={e => {
          const next = e.target.files?.[0] ?? null;
          if (next && next.size > ISSUE_FILE_MAX_BYTES) { setFile(null); setError('ไฟล์หลักฐานต้องมีขนาดไม่เกิน 10 MB'); e.target.value = ''; return; }
          setError(null); setFile(next);
        }} />
        <small className="muted">รองรับ PDF, JPG, PNG และ WebP ขนาดไม่เกิน 10 MB</small>
        <div><button type="button" className="button secondary" disabled={pending || !file} onClick={upload}>แนบหลักฐาน</button></div></div>}
      {canCancel && selected.status !== 'cancelled' && <div className="grid gap-3"><h3 className="font-bold">ยกเลิกปัญหา <small className="muted font-normal">(ผู้ดูแลระบบ)</small></h3>
        <label className="field">เหตุผล<select className="input" value={cancelReason} onChange={e => setCancelReason(e.target.value)}>{ISSUE_MANUAL_CANCEL_REASONS.map(r => <option key={r} value={r}>{ISSUE_CANCEL_REASON_LABELS[r]}</option>)}</select></label>
        {cancelReason === 'other' && <label className="field">ระบุเหตุผลอื่น<textarea className="input min-h-20" value={cancelNote} onChange={e => setCancelNote(e.target.value)} /></label>}
        <div><button type="button" className="button danger" disabled={pending || (cancelReason === 'other' && !cancelNote.trim())} onClick={() => { if (window.confirm('ยืนยันยกเลิกปัญหานี้? การยกเลิกย้อนกลับไม่ได้')) submitCancel(); }}>ยืนยันยกเลิกปัญหา</button></div></div>}
    </div>}

    {canOpen && <form onSubmit={submitManual} className="grid gap-3 border-t border-line pt-4"><h3 className="font-bold">บันทึกปัญหาเพิ่มเติม</h3>
      <div className="grid sm:grid-cols-2 gap-3">
        <label className="field">ประเภทปัญหา<select className="input" value={type} onChange={e => setType(e.target.value)}>{VENDOR_ISSUE_TYPES.map(t => <option key={t} value={t}>{ISSUE_TYPE_LABELS[t]}</option>)}</select></label>
        <label className="field">Invoice (ถ้ามี)<select className="input" value={invoiceId} onChange={e => setInvoiceId(e.target.value)}><option value="">ไม่ระบุ</option>{invoices.map(i => <option key={i.id} value={i.id}>{i.invoice_number}</option>)}</select></label>
      </div>
      <label className="field">รายละเอียด<textarea className="input min-h-20" required value={description} onChange={e => setDescription(e.target.value)} maxLength={2000} /></label>
      <div><button type="submit" className="button secondary" disabled={pending || !description.trim()}>เปิดปัญหา</button></div></form>}
    {message && <p className="notice" role="status">{message}</p>}
    {error && <p className="error" role="alert">{error}</p>}
  </div>;
}
