import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'CHEM-IMMUNO CBH', template: '%s | CHEM-IMMUNO CBH' },
  description: 'Clinical Chemistry and Immunology inventory',
  applicationName: 'CHEM-IMMUNO CBH',
  manifest: '/manifest.webmanifest',
  appleWebApp: { capable: true, title: 'CHEM-IMMUNO', statusBarStyle: 'default' },
  icons: { icon: [{ url: '/icon-192.png', sizes: '192x192', type: 'image/png' }], apple: '/apple-touch-icon.png' },
};

export const viewport: Viewport = { themeColor: '#0d3857' };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="th"><body>{children}</body></html>;
}
