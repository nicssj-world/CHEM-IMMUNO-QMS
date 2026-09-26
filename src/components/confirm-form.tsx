'use client';

/** `message` may be built from the form's current values, so the prompt can name exactly what is about to change. */
export function ConfirmForm({ action, message, children, className = '' }: { action: (formData: FormData) => void; message: string | ((data: FormData) => string); children: React.ReactNode; className?: string }) {
  return <form action={action} className={className} onSubmit={(event) => {
    const text = typeof message === 'function' ? message(new FormData(event.currentTarget)) : message;
    if (!window.confirm(text)) event.preventDefault();
  }}>{children}</form>;
}
