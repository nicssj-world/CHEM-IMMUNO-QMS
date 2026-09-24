'use client';

import { useFormStatus } from 'react-dom';

/** `pending` overrides the form status for forms submitted through a client handler instead of an action. */
export function SubmitButton({ label, pendingLabel, pending: pendingOverride, disabled, form }: { label: string; pendingLabel: string; pending?: boolean; disabled?: boolean; form?: string }) {
  const status = useFormStatus();
  const pending = pendingOverride ?? status.pending;
  return <button className="button w-full" type="submit" form={form} disabled={pending || disabled} aria-busy={pending}>
    {pending ? <><span className="spinner" aria-hidden="true" /><span role="status">{pendingLabel}</span></> : label}
  </button>;
}
