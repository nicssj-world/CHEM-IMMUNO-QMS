import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'CHEM-IMMUNO CBH', template: '%s | CHEM-IMMUNO CBH' },
  description: 'Clinical Chemistry and Immunology inventory',
  applicationName: 'CHEM-IMMUNO CBH',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="th"><body>{children}</body></html>;
}
