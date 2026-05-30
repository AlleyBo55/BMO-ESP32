import type { Metadata } from 'next';
import { Inter } from 'next/font/google';

import './globals.css';

const inter = Inter({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-inter',
});

export const metadata: Metadata = {
  title: 'BMO',
  description: 'A tiny ESP32-C3 companion with touch, voice, moods, and memory.',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <html lang="en" className={`dark ${inter.variable}`}>
      <body className="bg-zinc-950 text-zinc-100 font-sans antialiased min-h-screen">
        {children}
      </body>
    </html>
  );
}
