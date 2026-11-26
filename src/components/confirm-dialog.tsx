'use client';

import { useEffect, useId, useRef, type ReactNode } from 'react';

/** One-step confirmation in a native <dialog>: focus is trapped, Escape cancels, and the action shows its own progress. */
export function ConfirmDialog({ open, title, children, confirmLabel, pendingLabel = 'กำลังดำเนินการ…', cancelLabel = 'ยกเลิก', danger = false, pending = false, error, onConfirm, onClose }: {
  open: boolean; title: string; children?: ReactNode; confirmLabel: string; pendingLabel?: string; cancelLabel?: string;
  danger?: boolean; pending?: boolean; error?: string; onConfirm: () => void; onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);
  return <dialog ref={ref} className="dialog" aria-labelledby={titleId}
    onCancel={event => { event.preventDefault(); if (!pending) onClose(); }}>
    <div className="grid gap-4">
      <h2 id={titleId} className="font-bold text-lg">{title}</h2>
      {children && <div className="text-sm grid gap-2">{children}</div>}
      {error && <p className="error text-sm" role="alert">{error}</p>}
      <div className="grid grid-cols-2 gap-3">
        <button type="button" className="button secondary" onClick={onClose} disabled={pending}>{cancelLabel}</button>
        <button type="button" className={'button' + (danger ? ' danger' : '')} onClick={onConfirm} disabled={pending} aria-busy={pending}>
          {pending ? <><span className="spinner" aria-hidden="true" /><span role="status">{pendingLabel}</span></> : confirmLabel}
        </button>
      </div>
    </div>
  </dialog>;
}
