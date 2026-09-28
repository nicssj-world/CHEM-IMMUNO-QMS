import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';

export default function PausedEnvironmentReportLayout({ children }: { children: ReactNode }): never {
  void children;
  notFound();
}
