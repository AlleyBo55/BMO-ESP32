import type { Metadata } from 'next';
import { Bricolage_Grotesque, Silkscreen } from 'next/font/google';

import BmoWorldLanding from '@/components/landing/BmoWorldLanding';

// Landing-only faces: a characterful display grotesk and a pixel face for HUD
// details that echo the 160×128 screen. Declared in this server component (not
// the client landing) so the generated class names match between the SSR HTML
// and the client bundle; declaring them in a 'use client' module hashes them
// differently per build layer and breaks hydration.
const display = Bricolage_Grotesque({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-display',
});
const pixel = Silkscreen({
  subsets: ['latin'],
  weight: '400',
  display: 'swap',
  variable: '--font-pixel',
});

export const metadata: Metadata = {
  title: 'BMO - Tiny ESP32 Companion',
  description:
    'A tiny ESP32-C3 companion with expressive moods, touch, voice, memory, component details, and a public build wiki.',
};

export default function LandingPage(): React.ReactElement {
  return <BmoWorldLanding fontClassName={`${display.variable} ${pixel.variable}`} />;
}
