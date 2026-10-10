import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';

// Keep the module and its data in place, but make every Morning Talk URL unavailable while it is paused.
export default function PausedMorningTalkLayout({ children }: { children: ReactNode }): never {
  void children;
  notFound();
}
