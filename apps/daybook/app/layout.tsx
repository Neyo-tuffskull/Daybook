import type { ReactNode } from 'react';
import type { Metadata } from 'next';
import '@daybook/ui/tokens.css';
import './globals.css';

export const metadata: Metadata = {
  title: 'Daybook',
  description: 'Plan the day, then live it.',
};

export const viewport = {
  width: 'device-width',
  initialScale: 1,
  // The workout logger and the timeline are touch targets first. Letting the
  // page zoom is an accessibility requirement, not a nicety.
  maximumScale: 5,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en-GB">
      <body>{children}</body>
    </html>
  );
}
