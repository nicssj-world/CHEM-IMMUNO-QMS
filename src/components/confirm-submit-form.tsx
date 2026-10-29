'use client';

import type { FormEvent } from 'react';
import { SubmitButton } from '@/components/submit-button';

export function ConfirmSubmitForm({
  action,
  confirmation,
  fieldName,
  fieldValue,
  label,
  pendingLabel,
}: {
  action: (formData: FormData) => void | Promise<void>;
  confirmation: string;
  fieldName: string;
  fieldValue: string;
  label: string;
  pendingLabel: string;
}) {
  function confirmSubmission(event: FormEvent<HTMLFormElement>) {
    if (!window.confirm(confirmation)) event.preventDefault();
  }

  return <form action={action} onSubmit={confirmSubmission}>
    <input type="hidden" name={fieldName} value={fieldValue} />
    <SubmitButton className="button secondary" label={label} pendingLabel={pendingLabel} />
  </form>;
}
