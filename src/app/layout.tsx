import type { Metadata, Viewport } from 'next';
import { IBM_Plex_Sans_Thai } from 'next/font/google';
import './globals.css';

// Arial has no Thai glyphs, so Thai text fell back to a different system font per device; one self-hosted face covers both scripts.
const sans = IBM_Plex_Sans_Thai({ subsets: ['thai', 'latin'], weight: ['400', '500', '600', '700'], display: 'swap', variable: '--font-plex' });

export const metadata: Metadata = {
  title: { default: 'CHEM-IMMUNO CBH', template: '%s | CHEM-IMMUNO CBH' },
  description: 'Clinical Chemistry and Immunology inventory',
  applicationName: 'CHEM-IMMUNO CBH',
  manifest: '/manifest.webmanifest',
  appleWebApp: { capable: true, title: 'CHEM-IMMUNO CBH', statusBarStyle: 'default' },
  icons: {
    icon: [
      { url: '/favicon.ico', sizes: '16x16 32x32 48x48 64x64', type: 'image/x-icon' },
      { url: '/favicon-64.png', sizes: '64x64', type: 'image/png' },
      { url: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { url: '/icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
    apple: [{ url: '/apple-touch-icon.png', sizes: '180x180', type: 'image/png' }],
  },
};

// viewport-fit lets the safe-area padding in globals.css reach the iPhone home bar; navy stays the brand colour for the browser bar.
export const viewport: Viewport = { themeColor: '#0d3857', viewportFit: 'cover', colorScheme: 'only light' };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="th" className={sans.variable}><body>{children}</body></html>;
}
