import type { Metadata } from 'next';

import BmoLandingExperience from '@/components/landing/BmoLandingExperience';

export const metadata: Metadata = {
  title: 'BMO - Tiny ESP32 Companion',
  description:
    'A tiny ESP32-C3 companion with expressive moods, touch, voice, memory, component details, and a public build wiki.',
};

export default function LandingPage(): React.ReactElement {
  return <BmoLandingExperience />;
}
