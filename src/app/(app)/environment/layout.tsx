import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';

// Keep the module and its data in place, but make every environment URL unavailable while it is paused.
export default function PausedEnvironmentLayout({ children }: { children: ReactNode }): never {
  void children;
  notFound();
}
