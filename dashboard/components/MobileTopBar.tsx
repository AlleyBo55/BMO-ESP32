'use client';

/**
 * Mobile-only top bar that hosts the hamburger button which opens the
 * sidebar drawer.
 *
 * Hidden at `md` and up since the desktop sidebar is permanently visible.
 * Sticky at the top so the menu trigger is always reachable while the
 * content scrolls underneath.
 */
export default function MobileTopBar(): React.ReactElement {
  function openSidebar(): void {
    if (typeof window === 'undefined') return;
    window.dispatchEvent(new CustomEvent('bmo:sidebar:open'));
  }

  return (
    <header className="md:hidden sticky top-0 z-30 flex items-center gap-3 border-b border-zinc-800 bg-zinc-950/95 px-4 py-3 backdrop-blur">
      <button
        type="button"
        onClick={openSidebar}
        aria-label="Open navigation"
        className="-ml-1 rounded p-2 text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100"
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
            d="M2.5 5.25A.75.75 0 013.25 4.5h13.5a.75.75 0 010 1.5H3.25a.75.75 0 01-.75-.75zM2.5 10A.75.75 0 013.25 9.25h13.5a.75.75 0 010 1.5H3.25A.75.75 0 012.5 10zm.75 4.25a.75.75 0 000 1.5h13.5a.75.75 0 000-1.5H3.25z"
            clipRule="evenodd"
          />
        </svg>
      </button>
      <span className="text-sm font-semibold text-zinc-100">BMO Dashboard</span>
    </header>
  );
}
