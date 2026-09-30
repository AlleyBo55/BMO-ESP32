'use client';

import { useEffect, useRef } from 'react';
import type { ReactElement } from 'react';

import { FACE_H, FACE_W, FaceRenderer, talkEnvelope } from './world/faceRenderer';
import type { FaceMood } from './world/faceRenderer';

interface BmoPosterProps {
  mood: FaceMood;
  /** Stop animating (the 3D world has taken over). */
  paused: boolean;
  // CSS-module lookups are typed `string | undefined` under noUncheckedIndexedAccess.
  className?: string | undefined;
  faceClassName?: string | undefined;
}

/**
 * Flat SVG BMO with a live 2D-canvas face. It is the first paint, the
 * no-WebGL / reduced-motion fallback, and the frame the 3D BMO fades in over.
 * The face uses the same firmware port as the 3D screen, so it is never a
 * static picture. Geometry mirrors world/model.ts at 20 px per cm.
 */
export default function BmoPoster({
  mood,
  paused,
  className,
  faceClassName,
}: BmoPosterProps): ReactElement {
  const faceRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (paused) return undefined;
    const ctx = faceRef.current?.getContext('2d');
    if (!ctx) return undefined;
    const face = new FaceRenderer();
    const image = new ImageData(new Uint8ClampedArray(face.pixels.buffer), FACE_W, FACE_H);
    const started = performance.now();
    const draw = (now: number): void => {
      face.render({
        mood,
        now,
        lookX: 0,
        lookY: 0,
        talkLevel: mood === 'talk' ? talkEnvelope(now - started) : 0,
        boot: 1,
        sparkle: false,
      });
      ctx.putImageData(image, 0, 0);
    };

    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      draw(started); // one still frame per mood
      return undefined;
    }
    let raf = 0;
    let last = 0;
    const loop = (now: number): void => {
      if (now - last >= 33) {
        last = now;
        draw(now);
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [mood, paused]);

  return (
    <div className={className} aria-hidden="true">
      <svg viewBox="-24 0 248 264" width="100%" height="100%" focusable="false">
        <defs>
          <linearGradient id="bmo-poster-shell" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#7fdcc7" />
            <stop offset="0.55" stopColor="#63cdb5" />
            <stop offset="1" stopColor="#4fb8a2" />
          </linearGradient>
        </defs>
        <ellipse cx="100" cy="254" rx="70" ry="7" fill="rgba(10,38,32,0.16)" />
        <g fill="none" stroke="#55c4ad" strokeWidth="8.4" strokeLinecap="round">
          <path d="M22 98 C 6 103, -4 118, -8 146" />
          <path d="M178 98 C 194 103, 204 118, 208 146" />
          <path d="M68 206 L 68 240" />
          <path d="M132 206 L 132 240" />
        </g>
        <g fill="#55c4ad">
          <circle cx="-8" cy="147" r="7.2" />
          <circle cx="208" cy="147" r="7.2" />
          <ellipse cx="68" cy="246" rx="11" ry="6" />
          <ellipse cx="132" cy="246" rx="11" ry="6" />
        </g>
        <rect x="20" y="10" width="160" height="200" rx="18" fill="url(#bmo-poster-shell)" />
        <rect x="37" y="16" width="126" height="104" rx="8" fill="#3fa894" />
        <rect x="45" y="24" width="110" height="88" rx="7" fill="#0f2c2a" />
        <g fill="#ffd23f">
          <rect x="38" y="150" width="44" height="14.4" rx="3.2" />
          <rect x="52.8" y="135" width="14.4" height="44" rx="3.2" />
        </g>
        <path d="M111 141 L 100.6 160 L 121.4 160 Z" fill="#3f8cff" stroke="#3f8cff" strokeWidth="3" strokeLinejoin="round" />
        <circle cx="147" cy="149" r="8.4" fill="#52d17c" />
        <circle cx="131" cy="181" r="14.4" fill="#ff5a5f" />
        <circle cx="147" cy="130" r="4.4" fill="#1f4f96" />
        <g stroke="#1f4f96" strokeWidth="6.4" strokeLinecap="round">
          <path d="M44 194 L 54 194" />
          <path d="M66 194 L 76 194" />
        </g>
      </svg>
      <canvas ref={faceRef} className={faceClassName} width={FACE_W} height={FACE_H} />
    </div>
  );
}
