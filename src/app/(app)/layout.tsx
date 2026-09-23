import { requireAccess } from '@/lib/auth';
import { AppShell } from '@/components/app-shell';

export const dynamic = 'force-dynamic';

export default async function ProtectedLayout({ children }: { children: React.ReactNode }) {
  const access = await requireAccess();
  return <AppShell access={access}>{children}</AppShell>;
}
