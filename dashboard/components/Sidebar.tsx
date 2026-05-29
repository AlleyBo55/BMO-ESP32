'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';

import { logout } from '@/app/(admin)/actions';

/**
 * Admin sidebar.
 *
 * Two layouts in one component, switched by a CSS breakpoint:
 *
 *   - Mobile (< md, 768px): an off-canvas drawer behind a translucent
 *     overlay. The hamburger button in `<MobileTopBar />` toggles a global
 *     `bmo:sidebar` event that this component listens for. Tapping a nav
 *     link or pressing Escape closes the drawer; route changes auto-close
 *     so the user doesn't have to dismiss it manually.
 *   - Desktop (≥ md): a static sidebar pinned to the left at 240px wide,
 *     same as before.
 *
 * Logout is a `<form action={logout}>` so it works without client JS even
 * on mobile.
 */

interface NavItem {
  label: string;
  href:
    | '/'
    | '/soul'
    | '/skills'
    | '/songs'
    | '/providers'
    | '/fingerprint'
    | '/activity';
}

const NAV_ITEMS: ReadonlyArray<NavItem> = [
  { label: 'Home', href: '/' },
  { label: 'Soul', href: '/soul' },
  { label: 'Skills', href: '/skills' },
  { label: 'Songs', href: '/songs' },
  { label: 'Providers', href: '/providers' },
  { label: 'Fingerprint', href: '/fingerprint' },
  { label: 'Activity', href: '/activity' },
];

interface SidebarProps {
  username: string | null;
}

export default function Sidebar({ username }: SidebarProps): React.ReactElement {
  const displayName = username !== null && username.length > 0 ? username : 'admin';
  const [open, setOpen] = useState<boolean>(false);
  const pathname = usePathname();

  // Listen for the global open/close events fired by the mobile top-bar.
  useEffect(() => {
    function onOpen(): void {
      setOpen(true);
    }
    function onClose(): void {
      setOpen(false);
    }
    window.addEventListener('bmo:sidebar:open', onOpen);
    window.addEventListener('bmo:sidebar:close', onClose);
    return () => {
      window.removeEventListener('bmo:sidebar:open', onOpen);
      window.removeEventListener('bmo:sidebar:close', onClose);
    };
  }, []);

  // Close the drawer whenever the route changes (user tapped a nav link).
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  // Close on Escape and freeze body scroll while the drawer is open.
  useEffect(() => {
    if (!open) return;
    function onKey(event: KeyboardEvent): void {
      if (event.key === 'Escape') setOpen(false);
    }
    window.addEventListener('keydown', onKey);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [open]);

  const navList = (
    <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto">
      {NAV_ITEMS.map((item) => {
        const active = pathname === item.href;
        return (
          <Link
            key={item.href}
            href={item.href}
            className={`block rounded px-3 py-2 text-sm transition-colors ${
              active
                ? 'bg-zinc-800 text-sky-400'
                : 'text-zinc-300 hover:bg-zinc-800 hover:text-sky-400'
            }`}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );

  const userPanel = (
    <div className="border-t border-zinc-800 px-4 py-4">
      <div className="text-xs text-zinc-500">Signed in as</div>
      <div
        className="mt-0.5 text-sm font-medium text-zinc-100 truncate"
        title={displayName}
      >
        {displayName}
      </div>
      <form action={logout} className="mt-3">
        <button
          type="submit"
          className="w-full rounded border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-xs font-medium text-zinc-200 hover:border-sky-500 hover:text-sky-400 transition-colors"
        >
          Log out
        </button>
      </form>
    </div>
  );

  const header = (
    <div className="px-5 py-6 border-b border-zinc-800 flex items-center justify-between">
      <div>
        <div className="text-lg font-semibold text-zinc-100">BMO</div>
        <div className="mt-1 text-xs text-zinc-500">Dashboard</div>
      </div>
      {/* Close button is only useful on mobile; hide on desktop. */}
      <button
        type="button"
        onClick={() => setOpen(false)}
        className="md:hidden -mr-1 rounded p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
        aria-label="Close navigation"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 20 20"
          fill="currentColor"
          className="h-5 w-5"
          aria-hidden="true"
        >
          <path
            fillRule="evenodd"
            d="M4.28 4.28a.75.75 0 011.06 0L10 8.94l4.66-4.66a.75.75 0 111.06 1.06L11.06 10l4.66 4.66a.75.75 0 11-1.06 1.06L10 11.06l-4.66 4.66a.75.75 0 11-1.06-1.06L8.94 10 4.28 5.34a.75.75 0 010-1.06z"
            clipRule="evenodd"
          />
        </svg>
      </button>
    </div>
  );

  return (
    <>
      {/* Desktop static sidebar — visible at md and up. */}
      <aside className="hidden md:flex fixed left-0 top-0 h-screen w-60 border-r border-zinc-800 bg-zinc-900 flex-col">
        {header}
        {navList}
        {userPanel}
      </aside>

      {/* Mobile drawer overlay. */}
      <div
        className={`md:hidden fixed inset-0 z-40 bg-black/60 backdrop-blur-sm transition-opacity duration-200 ${
          open ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'
        }`}
        onClick={() => setOpen(false)}
        aria-hidden="true"
      />

      {/* Mobile drawer panel. */}
      <aside
        className={`md:hidden fixed left-0 top-0 z-50 h-screen w-72 max-w-[85vw] border-r border-zinc-800 bg-zinc-900 flex flex-col transform transition-transform duration-200 ${
          open ? 'translate-x-0' : '-translate-x-full'
        }`}
        role="dialog"
        aria-modal="true"
        aria-label="Navigation"
      >
        {header}
        {navList}
        {userPanel}
      </aside>
    </>
  );
}
