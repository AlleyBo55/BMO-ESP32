import { headers } from 'next/headers';
import type { Metadata } from 'next';

import MobileTopBar from '@/components/MobileTopBar';
import Sidebar from '@/components/Sidebar';

export const metadata: Metadata = {
  robots: {
    index: false,
    follow: false,
    googleBot: {
      index: false,
      follow: false,
    },
  },
};

/**
 * Admin shell layout.
 *
 * Server component. Reads the `x-bmo-username` request header set by the
 * Next.js middleware (`app/middleware.ts`) when a valid session cookie is
 * present, and passes the username to {@link Sidebar} for display.
 *
 * Two layouts in one shell:
 *   - **Mobile (< md)**: a sticky top bar with a hamburger; the sidebar is
 *     an off-canvas drawer.
 *   - **Desktop (≥ md)**: the sidebar is fixed at 240 px on the left and
 *     content reserves that width via `md:pl-60`.
 *
 * Content padding scales: tighter horizontal gutters and smaller vertical
 * rhythm on phones, more breathing room on desktop.
 */
export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}): Promise<React.ReactElement> {
  const headerList = await headers();
  const username = headerList.get('x-bmo-username');

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <MobileTopBar />
      <Sidebar username={username} />
      <main className="md:pl-60 min-h-screen">
        <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6 md:px-8 md:py-8">
          {children}
        </div>
      </main>
    </div>
  );
}
