'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * Reusable "copy to clipboard" button.
 *
 * Click to copy `text` to the user's clipboard via the async Clipboard API.
 * The button label briefly switches to "Copied!" for 2 seconds, then resets.
 * Falls back to a hidden `<textarea>` + `document.execCommand('copy')` on
 * browsers without `navigator.clipboard`.
 */

interface CopyButtonProps {
  text: string;
  /** Default button label. */
  label?: string;
  /** Confirmation label shown briefly after a successful copy. */
  copiedLabel?: string;
  className?: string;
}

const RESET_AFTER_MS = 2000;

async function copyToClipboard(text: string): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.clipboard !== undefined) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall through to the legacy fallback.
    }
  }
  if (typeof document === 'undefined') return false;
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  document.body.removeChild(textarea);
  return ok;
}

export default function CopyButton({
  text,
  label = 'Copy',
  copiedLabel = 'Copied!',
  className = '',
}: CopyButtonProps): React.ReactElement {
  const [copied, setCopied] = useState<boolean>(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, []);

  const handleClick = async (): Promise<void> => {
    const ok = await copyToClipboard(text);
    if (!ok) return;
    setCopied(true);
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
    }
    timerRef.current = setTimeout(() => {
      setCopied(false);
      timerRef.current = null;
    }, RESET_AFTER_MS);
  };

  const baseClass =
    'inline-flex items-center justify-center rounded border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-xs font-medium text-zinc-200 hover:border-sky-500 hover:text-sky-400 transition-colors disabled:opacity-50';

  return (
    <button
      type="button"
      onClick={() => {
        void handleClick();
      }}
      className={className.length > 0 ? className : baseClass}
      aria-live="polite"
    >
      {copied ? copiedLabel : label}
    </button>
  );
}
