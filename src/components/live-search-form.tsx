'use client';

import { useEffect, useRef, useTransition, type FormEvent, type ReactNode } from 'react';
import { usePathname, useRouter } from 'next/navigation';

/** Updates server-rendered search results shortly after a query or filter changes. */
export function LiveSearchForm({ children, className = '', ariaLabel }: { children: ReactNode; className?: string; ariaLabel?: string }) {
  const pathname = usePathname();
  const router = useRouter();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const composing = useRef(false);
  const [pending, startTransition] = useTransition();

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  function updateResults(form: HTMLFormElement) {
    if (timer.current) clearTimeout(timer.current);
    const params = new URLSearchParams();
    new FormData(form).forEach((value, key) => {
      if (typeof value === 'string' && value.trim()) params.set(key, value);
    });
    params.delete('page');
    const query = params.toString();
    startTransition(() => router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false }));
  }

  function scheduleUpdate(form: HTMLFormElement) {
    if (composing.current) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => updateResults(form), 300);
  }

  function submitNow(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (composing.current) return;
    updateResults(event.currentTarget);
  }

  return <form method="get" role="search" aria-label={ariaLabel} aria-busy={pending} className={className}
    onChange={event => scheduleUpdate(event.currentTarget)}
    onCompositionStart={() => { composing.current = true; if (timer.current) clearTimeout(timer.current); }}
    onCompositionEnd={event => { composing.current = false; scheduleUpdate(event.currentTarget); }}
    onSubmit={submitNow}>
    {children}
  </form>;
}
