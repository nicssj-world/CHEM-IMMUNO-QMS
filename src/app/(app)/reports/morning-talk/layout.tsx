import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';

export default function PausedMorningTalkReportLayout({ children }: { children: ReactNode }): never {
  void children;
  notFound();
}
