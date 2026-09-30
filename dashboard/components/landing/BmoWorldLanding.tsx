'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent as ReactPointerEvent, ReactElement } from 'react';
import { Tweet } from 'react-tweet';

import BmoPoster from './BmoPoster';
import {
  BMO_REPLIES,
  BRAIN_CAPABILITIES,
  COMPONENTS,
  FEATURES,
  GBRAIN_REPO_URL,
  MOMENTS,
  ORGAN_MAP,
  PROJECT_REPO_URL,
} from './bmoContent';
import type { MoodKey } from './bmoContent';
import styles from './BmoWorldLanding.module.css';
import { CHAPTERS, CHAPTER_LABELS } from './world/chapters';
import type { ChapterId, OrganId } from './world/chapters';
import type { FaceMood } from './world/faceRenderer';
import type { BmoWorld } from './world/scene';
import { createBleeper } from './world/sound';
import type { Bleeper } from './world/sound';

const TWEET_ID = '2061169600885395661';
const HOLD_MS = 380;
const DARK_CHAPTERS: ReadonlySet<ChapterId> = new Set(['demo', 'inside', 'brain']);
const ORGAN_IDS: readonly OrganId[] = ['tft', 'esp32', 'mic', 'speaker', 'touch', 'heart'];
const MOMENT_KEYS: ReadonlySet<string> = new Set(MOMENTS.map((m) => m.key));
const isMoodKey = (m: string): m is MoodKey => MOMENT_KEYS.has(m);

/** The copy names each organ; the 3D rig knows them by id. */
const ORGAN_BY_NAME: Readonly<Record<string, OrganId>> = {
  'Feeling Window': 'tft',
  'Pocket Brain': 'esp32',
  'Listening Sprout': 'mic',
  'Voice Star': 'speaker',
  'Kind Button': 'touch',
  'Wonder Heart': 'heart',
};

const NAV: ReadonlyArray<{ href: `#${string}`; label: string; chapter: ChapterId }> = [
  { href: '#world', label: 'Signals', chapter: 'world' },
  { href: '#demo', label: 'Demo', chapter: 'demo' },
  { href: '#features', label: 'Features', chapter: 'features' },
  { href: '#inside', label: 'Inside', chapter: 'inside' },
  { href: '#brain', label: 'Brain', chapter: 'brain' },
  { href: '#cad', label: 'Build', chapter: 'cad' },
];

const pad2 = (n: number): string => String(n).padStart(2, '0');

function refMap<K extends string, E extends HTMLElement>(
  keys: readonly K[],
  store: { current: Partial<Record<K, E>> },
): Record<K, (el: E | null) => void> {
  const map = {} as Record<K, (el: E | null) => void>;
  for (const key of keys) {
    map[key] = (el) => {
      if (el) store.current[key] = el;
      else delete store.current[key];
    };
  }
  return map;
}

interface BmoWorldLandingProps {
  /**
   * `--font-display` / `--font-pixel` variable classes. The fonts are declared
   * in the server page so their class names hydrate identically.
   */
  fontClassName: string;
}

export default function BmoWorldLanding({ fontClassName }: BmoWorldLandingProps): ReactElement {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const bubbleRef = useRef<HTMLDivElement>(null);
  const cadViewerRef = useRef<HTMLDivElement>(null);
  const sectionRefs = useRef<Partial<Record<ChapterId, HTMLElement>>>({});
  const labelRefs = useRef<Partial<Record<OrganId, HTMLElement>>>({});
  const rowRefs = useRef<Partial<Record<MoodKey, HTMLElement>>>({});
  const worldRef = useRef<BmoWorld | null>(null);
  const bleeperRef = useRef<Bleeper | null>(null);
  const posterTimers = useRef<number[]>([]);
  const holdStartRef = useRef<number | null>(null);
  const replyRef = useRef(0);
  const celebratedRef = useRef(false);

  const [live, setLive] = useState(false);
  const [chapter, setChapter] = useState<ChapterId>('hero');
  const [mood, setMood] = useState<FaceMood>('idle');
  const [discovered, setDiscovered] = useState<ReadonlySet<MoodKey>>(() => new Set());
  const [speech, setSpeech] = useState<string | null>(null);
  const [activeOrgan, setActiveOrgan] = useState<OrganId | null>(null);
  const [activeNode, setActiveNode] = useState<number | null>(null);
  const [cadOpen, setCadOpen] = useState(false);
  const [tweetNear, setTweetNear] = useState(false);
  const [scrolled, setScrolled] = useState(false);

  const sectionRef = useMemo(() => refMap(CHAPTERS, sectionRefs), []);
  const labelRef = useMemo(() => refMap(ORGAN_IDS, labelRefs), []);
  const rowRef = useMemo(
    () => refMap(MOMENTS.map((m) => m.key), rowRefs),
    [],
  );

  const applyMood = useCallback((next: FaceMood): void => {
    setMood(next);
    if (isMoodKey(next)) {
      setDiscovered((prev) => (prev.has(next) ? prev : new Set(prev).add(next)));
    }
  }, []);

  // --- 3D world: loaded after first paint, skipped for reduced motion -------
  useEffect(() => {
    const canvas = canvasRef.current;
    const backdrop = backdropRef.current;
    if (!canvas || !backdrop) return undefined;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return undefined;
    if (typeof window.WebGL2RenderingContext === 'undefined') return undefined;

    let cancelled = false;
    let world: BmoWorld | null = null;
    const start = (): void => {
      import('./world/scene')
        .then(({ createBmoWorld }) => {
          if (cancelled) return;
          const sections = CHAPTERS.map((id) => sectionRefs.current[id]).filter(
            (el): el is HTMLElement => el !== undefined,
          );
          world = createBmoWorld({
            canvas,
            backdrop,
            sections,
            labels: labelRefs.current,
            bubble: bubbleRef.current,
            replies: BMO_REPLIES,
            onReady: () => setLive(true),
            onError: () => setLive(false),
            onMood: applyMood,
            onSpeech: setSpeech,
            onCue: (cue, text) => bleeperRef.current?.play(cue, text),
          });
          worldRef.current = world;
        })
        .catch(() => {
          if (!cancelled) setLive(false);
        });
    };

    // Let hydration and the first paint finish before three.js spins up.
    const useIdle = typeof window.requestIdleCallback === 'function';
    const handle = useIdle
      ? window.requestIdleCallback(start, { timeout: 1200 })
      : window.setTimeout(start, 200);
    return () => {
      cancelled = true;
      if (useIdle) window.cancelIdleCallback(handle);
      else window.clearTimeout(handle);
      world?.dispose();
      worldRef.current = null;
    };
  }, [applyMood]);

  useEffect(() => {
    const bleeper = createBleeper();
    bleeperRef.current = bleeper;
    return () => {
      bleeper.dispose();
      bleeperRef.current = null;
    };
  }, []);

  useEffect(() => {
    const timers = posterTimers;
    return () => timers.current.forEach((id) => window.clearTimeout(id));
  }, []);

  // --- Scroll-driven UI state -------------------------------------------------
  useEffect(() => {
    const onScroll = (): void => setScrolled(window.scrollY > 12);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const id = (entry.target as HTMLElement).dataset.chapter;
          if (entry.isIntersecting && id && (CHAPTERS as readonly string[]).includes(id)) {
            setChapter(id as ChapterId);
          }
        }
      },
      { rootMargin: '-50% 0px -50% 0px' },
    );
    for (const id of CHAPTERS) {
      const el = sectionRefs.current[id];
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, []);

  // Scrolling through the Signals rows plays each mood on BMO.
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const key = (entry.target as HTMLElement).dataset.mood;
          if (!entry.isIntersecting || !key || !isMoodKey(key)) continue;
          if (worldRef.current) worldRef.current.setMood(key);
          else applyMood(key);
        }
      },
      { rootMargin: '-45% 0px -45% 0px' },
    );
    for (const moment of MOMENTS) {
      const el = rowRefs.current[moment.key];
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, [applyMood]);

  // The tweet embed (and its network requests) waits until the demo is near.
  useEffect(() => {
    const el = sectionRefs.current.demo;
    if (!el) return undefined;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          setTweetNear(true);
          observer.disconnect();
        }
      },
      { rootMargin: '900px 0px' },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // While the real CAD viewer (its own WebGL context) is on screen, pause ours.
  useEffect(() => {
    const el = cadViewerRef.current;
    if (!cadOpen || !el) return undefined;
    const observer = new IntersectionObserver(
      ([entry]) => worldRef.current?.setPaused(Boolean(entry?.isIntersecting)),
      { threshold: 0.35 },
    );
    observer.observe(el);
    return () => {
      observer.disconnect();
      worldRef.current?.setPaused(false);
    };
  }, [cadOpen]);

  useEffect(() => {
    if (discovered.size < MOMENTS.length || celebratedRef.current) return;
    celebratedRef.current = true;
    worldRef.current?.celebrate();
    bleeperRef.current?.play('quest');
  }, [discovered]);

  // --- Interactions ------------------------------------------------------------
  const clearPosterTimers = (): void => {
    posterTimers.current.forEach((id) => window.clearTimeout(id));
    posterTimers.current = [];
  };

  /** Fallback voice-loop pantomime for when the 3D world is not running. */
  const posterRelease = (heldMs: number): void => {
    clearPosterTimers();
    if (heldMs < HOLD_MS) {
      applyMood('touch');
      bleeperRef.current?.play('tap');
      posterTimers.current.push(window.setTimeout(() => applyMood('idle'), 1200));
      return;
    }
    applyMood('think');
    bleeperRef.current?.play('think');
    replyRef.current = (replyRef.current + 1) % BMO_REPLIES.length;
    const reply = BMO_REPLIES[replyRef.current] ?? BMO_REPLIES[0];
    const talkMs = Math.min(5200, Math.max(1800, 900 + reply.length * 55));
    posterTimers.current.push(
      window.setTimeout(() => {
        applyMood('talk');
        setSpeech(reply);
        bleeperRef.current?.play('talk', reply);
      }, 1100),
      window.setTimeout(() => {
        applyMood('idle');
        setSpeech(null);
      }, 1100 + talkMs),
    );
  };

  const pressBmo = (): void => {
    if (holdStartRef.current !== null) return;
    holdStartRef.current = performance.now();
    const world = worldRef.current;
    if (world) {
      world.press();
    } else {
      clearPosterTimers();
      setSpeech(null);
      posterTimers.current.push(
        window.setTimeout(() => {
          applyMood('listen');
          bleeperRef.current?.play('listen');
        }, HOLD_MS),
      );
    }
  };

  const releaseBmo = (): void => {
    const startedAt = holdStartRef.current;
    if (startedAt === null) return;
    holdStartRef.current = null;
    const world = worldRef.current;
    if (world) world.release();
    else posterRelease(performance.now() - startedAt);
  };

  const onHoldPointerDown = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    pressBmo();
  };
  const onHoldKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if ((event.key === ' ' || event.key === 'Enter') && !event.repeat) {
      event.preventDefault();
      pressBmo();
    }
  };
  const onHoldKeyUp = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (event.key === ' ' || event.key === 'Enter') {
      event.preventDefault();
      releaseBmo();
    }
  };

  const selectMood = (next: MoodKey): void => {
    clearPosterTimers();
    if (worldRef.current) worldRef.current.setMood(next);
    else applyMood(next);
    bleeperRef.current?.play('mood');
  };

  const focusOrgan = (id: OrganId | null): void => {
    setActiveOrgan(id);
    worldRef.current?.highlightOrgan(id);
  };
  const focusNode = (index: number | null): void => {
    setActiveNode(index);
    worldRef.current?.highlightNode(index);
  };

  const chapterIndex = Math.max(0, CHAPTERS.indexOf(chapter));
  const questDone = discovered.size === MOMENTS.length;

  return (
    <main
      className={`${styles.page} ${fontClassName} ${live ? styles.live : ''}`}
      data-tone={DARK_CHAPTERS.has(chapter) ? 'dark' : 'light'}
    >
      <div ref={backdropRef} className={styles.backdrop} aria-hidden="true" />
      <canvas ref={canvasRef} className={styles.stage} aria-hidden="true" />

      <div className={styles.labels} aria-hidden="true">
        {ORGAN_MAP.map((item) => {
          const id = ORGAN_BY_NAME[item.organ];
          if (!id) return null;
          return (
            <div
              key={id}
              ref={labelRef[id]}
              className={`${styles.organLabel} ${activeOrgan === id ? styles.organLabelActive : ''}`}
            >
              <span className={styles.organDot} />
              <span className={styles.organCard}>
                <b>{item.organ}</b>
                <em>{item.part}</em>
                <small>{item.purpose}</small>
              </span>
            </div>
          );
        })}
      </div>

      <div
        ref={bubbleRef}
        className={`${styles.bubbleAnchor} ${live ? '' : styles.bubbleAnchorStatic}`}
      >
        <div className={`${styles.bubble} ${speech ? styles.bubbleOn : ''}`} role="status">
          {speech ?? ''}
        </div>
      </div>

      <header className={`${styles.nav} ${scrolled ? styles.navScrolled : ''}`}>
        <a href="#top" className={styles.brand} aria-label="BMO, back to top">
          <span className={styles.brandFace} aria-hidden="true" />
          <span>BMO</span>
        </a>
        <nav className={styles.navLinks} aria-label="Sections">
          {NAV.map((item) => (
            <a
              key={item.href}
              href={item.href}
              aria-current={chapter === item.chapter ? 'location' : undefined}
            >
              {item.label}
            </a>
          ))}
          <Link href="/wiki">Wiki</Link>
        </nav>
      </header>

      <div className={styles.hud} aria-hidden="true">
        <span className={styles.hudCount}>
          {pad2(chapterIndex + 1)} / {pad2(CHAPTERS.length)}
        </span>
        <span className={styles.hudLabel}>{CHAPTER_LABELS[chapter]}</span>
        <span className={styles.hudTrack}>
          <span style={{ transform: `scaleX(${(chapterIndex + 1) / CHAPTERS.length})` }} />
        </span>
      </div>

      {/* 00 · Hello ---------------------------------------------------------- */}
      <section
        id="top"
        ref={sectionRef.hero}
        data-chapter="hero"
        className={`${styles.section} ${styles.hero}`}
        aria-labelledby="hero-title"
      >
        <h1 id="hero-title" className={styles.wordmark}>
          <span>B</span>
          <span>M</span>
          <span>O</span>
        </h1>

        <BmoPoster
          mood={mood}
          paused={live}
          className={styles.poster}
          faceClassName={styles.posterFace}
        />

        <div className={styles.heroBottom}>
          <div className={`${styles.panel} ${styles.heroIntro}`}>
            <p className={styles.kicker}>ESP32-C3 · open source · printable</p>
            <p className={styles.lede}>
              A tiny desk companion with a face, a voice, a memory core, and five
              little buttons that make the hardware feel alive.
            </p>
            <div className={styles.actions}>
              <a href="#cad" className={styles.primary}>
                Build your own
              </a>
              <a href="#demo" className={styles.ghost}>
                Watch it talk
              </a>
              <a href={PROJECT_REPO_URL} className={styles.ghost} target="_blank" rel="noreferrer">
                GitHub ↗
              </a>
            </div>
          </div>

          <div className={`${styles.panel} ${styles.dock}`}>
            <p className={styles.dockHint}>Tap BMO · hold it to act out the voice loop</p>
            <div className={styles.chips} role="group" aria-label="Try a mood">
              {MOMENTS.map((moment) => (
                <button
                  key={moment.key}
                  type="button"
                  className={styles.chip}
                  data-mood={moment.key}
                  aria-pressed={mood === moment.key}
                  onClick={() => selectMood(moment.key)}
                >
                  <span className={styles.chipDot} aria-hidden="true" />
                  {moment.label}
                </button>
              ))}
            </div>
            <div className={styles.dockRow}>
              <button
                type="button"
                className={styles.holdButton}
                onPointerDown={onHoldPointerDown}
                onPointerUp={releaseBmo}
                onPointerCancel={releaseBmo}
                onKeyDown={onHoldKeyDown}
                onKeyUp={onHoldKeyUp}
                onBlur={releaseBmo}
                onContextMenu={(event) => event.preventDefault()}
              >
                <span className={styles.holdCap} aria-hidden="true" />
                Hold to talk
              </button>
              <p className={styles.quest}>
                <span>{questDone ? 'All signals awake' : 'Signals awake'}</span>
                <strong>
                  {discovered.size}/{MOMENTS.length}
                </strong>
                <span className={styles.questDots} aria-hidden="true">
                  {MOMENTS.map((moment) => (
                    <i
                      key={moment.key}
                      className={discovered.has(moment.key) ? styles.questLit : undefined}
                    />
                  ))}
                </span>
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* 01 · Signals ---------------------------------------------------------- */}
      <section
        id="world"
        ref={sectionRef.world}
        data-chapter="world"
        className={`${styles.section} ${styles.signals}`}
        aria-labelledby="signals-title"
      >
        <div className={styles.signalsInner}>
          <header className={`${styles.panel} ${styles.sectionHead}`}>
            <p className={styles.kicker}>01 · Playable information</p>
            <h2 id="signals-title">Every button teaches one part of the build.</h2>
            <p>
              Scroll through the five signals and BMO acts each one out. The face
              is drawn by a port of the firmware renderer, at the device&apos;s real
              160 × 128 pixels.
            </p>
          </header>
          <ol className={styles.signalList}>
            {MOMENTS.map((moment, index) => (
              <li
                key={moment.key}
                ref={rowRef[moment.key]}
                data-mood={moment.key}
                className={`${styles.panel} ${styles.signalRow} ${mood === moment.key ? styles.signalRowActive : ''}`}
              >
                <button
                  type="button"
                  className={styles.signalButton}
                  aria-pressed={mood === moment.key}
                  onClick={() => selectMood(moment.key)}
                >
                  <span className={styles.signalIndex}>{pad2(index + 1)}</span>
                  <span className={styles.signalLabel}>{moment.label}</span>
                </button>
                <h3>{moment.title}</h3>
                <p>{moment.body}</p>
                <dl className={styles.specs}>
                  <div>
                    <dt>Signal</dt>
                    <dd>{moment.signal}</dd>
                  </div>
                  <div>
                    <dt>Face</dt>
                    <dd>{moment.animation}</dd>
                  </div>
                </dl>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* 02 · Demo ------------------------------------------------------------- */}
      <section
        id="demo"
        ref={sectionRef.demo}
        data-chapter="demo"
        className={`${styles.section} ${styles.dark} ${styles.demo}`}
        aria-labelledby="demo-title"
      >
        <div className={styles.demoGrid}>
          <header className={`${styles.panel} ${styles.sectionHead}`}>
            <p className={styles.kicker}>02 · See it in action</p>
            <h2 id="demo-title">BMO, listening and talking back.</h2>
            <p>
              A quick clip of the push-to-talk loop: hold the touch sensor, speak,
              release — and BMO answers out loud with a live lip-sync face.
            </p>
            <p className={styles.note}>
              On this page, hold BMO for half a second to act out the same faces.
              Nothing is recorded.
            </p>
          </header>
          <div className={`${styles.panel} ${styles.tweet}`} data-theme="dark">
            {tweetNear ? (
              <Tweet id={TWEET_ID} />
            ) : (
              <div className={styles.tweetPlaceholder}>Loading the clip…</div>
            )}
          </div>
        </div>
      </section>

      {/* 03 · Features --------------------------------------------------------- */}
      <section
        id="features"
        ref={sectionRef.features}
        data-chapter="features"
        className={`${styles.section} ${styles.features}`}
        aria-labelledby="features-title"
      >
        <div className={styles.featuresInner}>
          <header className={`${styles.panel} ${styles.sectionHead}`}>
            <p className={styles.kicker}>03 · Feature map</p>
            <h2 id="features-title">What the tiny toy actually does.</h2>
            <p>
              The landing is cute, but the build is practical: each interaction is
              a visible state backed by a real hardware or software role.
            </p>
          </header>
          <div className={`${styles.panel} ${styles.index}`}>
            {FEATURES.map((feature, index) => (
              <details key={feature.title} className={styles.indexRow} open={index === 0}>
                <summary>
                  <span className={styles.indexNum}>{pad2(index + 1)}</span>
                  <span className={styles.indexTitle}>{feature.title}</span>
                  <span className={styles.indexOwner}>{feature.owner}</span>
                  <span className={styles.indexToggle} aria-hidden="true" />
                </summary>
                <div className={styles.indexBody}>
                  <p>{feature.body}</p>
                  <dl className={styles.specs}>
                    <div>
                      <dt>User sees</dt>
                      <dd>{feature.visible}</dd>
                    </div>
                    <div>
                      <dt>How it works</dt>
                      <dd>{feature.implementation}</dd>
                    </div>
                  </dl>
                </div>
              </details>
            ))}
          </div>
        </div>
      </section>

      {/* 04 · Inside ------------------------------------------------------------ */}
      <section
        id="inside"
        ref={sectionRef.inside}
        data-chapter="inside"
        className={`${styles.section} ${styles.dark} ${styles.inside}`}
        aria-labelledby="inside-title"
      >
        <div className={styles.insideInner}>
          <header className={`${styles.panel} ${styles.sectionHead}`}>
            <p className={styles.kicker}>04 · Inside BMO</p>
            <h2 id="inside-title">Real hardware, cast as tiny organs.</h2>
            <p>
              The screen is the feeling window. The ESP32-C3 is the pocket brain.
              The mic, speaker, touch pad, and memory core each get a visible role,
              so the device reads as a character instead of a box of parts.
            </p>
          </header>
          <ul className={`${styles.panel} ${styles.parts}`} aria-label="Components needed">
            {COMPONENTS.map((part) => {
              const organ = ORGAN_BY_NAME[part.role] ?? null;
              return (
                <li
                  key={part.name}
                  onMouseEnter={() => focusOrgan(organ)}
                  onMouseLeave={() => focusOrgan(null)}
                  onFocus={() => focusOrgan(organ)}
                  onBlur={() => focusOrgan(null)}
                >
                  <details
                    className={`${styles.partRow} ${organ && activeOrgan === organ ? styles.partRowActive : ''}`}
                  >
                    <summary>
                      <span className={styles.partRole}>{part.role}</span>
                      <span className={styles.partName}>{part.name}</span>
                      <span className={styles.indexToggle} aria-hidden="true" />
                    </summary>
                    <div className={styles.partBody}>
                      <p>{part.why}</p>
                      <dl className={styles.specs}>
                        <div>
                          <dt>Need</dt>
                          <dd>{part.needed}</dd>
                        </div>
                        <div>
                          <dt>Wire / route</dt>
                          <dd>{part.connection}</dd>
                        </div>
                        <div>
                          <dt>Note</dt>
                          <dd>{part.note}</dd>
                        </div>
                      </dl>
                    </div>
                  </details>
                </li>
              );
            })}
          </ul>
          <Link href="/wiki" className={`${styles.panel} ${styles.textLink}`}>
            Read the build wiki →
          </Link>
        </div>
      </section>

      {/* 05 · Brain ------------------------------------------------------------- */}
      <section
        id="brain"
        ref={sectionRef.brain}
        data-chapter="brain"
        className={`${styles.section} ${styles.dark} ${styles.brain}`}
        aria-labelledby="brain-title"
      >
        <div className={styles.brainInner}>
          <header className={`${styles.panel} ${styles.sectionHead}`}>
            <p className={styles.kicker}>05 · Core brain</p>
            <h2 id="brain-title">Small enough for the desk, thoughtful enough to remember.</h2>
            <p>
              The project keeps the public magic playful while the memory idea nods
              to Garry Tan&apos;s GBrain: moments become preferences, synthesis, and
              useful gaps. Each star above BMO is one of them.
            </p>
          </header>
          <ol className={styles.brainList}>
            {BRAIN_CAPABILITIES.map((cap, index) => (
              <li
                key={cap.title}
                className={`${styles.panel} ${styles.brainCard} ${activeNode === index ? styles.brainCardActive : ''}`}
                onMouseEnter={() => focusNode(index)}
                onMouseLeave={() => focusNode(null)}
              >
                <span className={styles.brainChip}>{cap.gbrain}</span>
                <h3>{cap.title}</h3>
                <p>{cap.body}</p>
                <code>{cap.module}</code>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* 06 · Build ------------------------------------------------------------- */}
      <section
        id="cad"
        ref={sectionRef.cad}
        data-chapter="cad"
        className={`${styles.section} ${styles.cad}`}
        aria-labelledby="cad-title"
      >
        <div className={styles.cadInner}>
          <header className={`${styles.panel} ${styles.sectionHead}`}>
            <p className={styles.kicker}>06 · 3D preview · Bambu Lab A1</p>
            <h2 id="cad-title">See it in 3D. Then print your own.</h2>
            <p>
              BMO just laid its parts out on a print plate. The real, printable model
              is one click away, straight from the build files, sized for a Bambu
              Lab A1 (256 × 256 mm bed).
            </p>
          </header>
          <ol className={`${styles.panel} ${styles.steps}`}>
            <li>
              <b>Explore</b>
              <span>
                Open the CAD viewer below and spin the real model. Pick the Outside
                or Inside kit to see how it all packs in.
              </span>
            </li>
            <li>
              <b>Download</b>
              <span>
                Grab the A1-ready plates (.3mf), already laid out flat with zero
                overlap. STL is in the repo if you prefer.
              </span>
            </li>
            <li>
              <b>Print on your A1</b>
              <span>
                Open the .3mf in Bambu Studio, pick PLA, slice, and send it to your
                A1. About two plates, no supports for the body.
              </span>
            </li>
          </ol>
          <div className={`${styles.panel} ${styles.downloads}`}>
            <a className={styles.primary} href="/exports/bmo_compact_outside_kit.3mf" download>
              ⬇ Outside kit · A1 .3mf
            </a>
            <a className={styles.primary} href="/exports/bmo_compact_inside_kit.3mf" download>
              ⬇ Inside kit · A1 .3mf
            </a>
            <a className={styles.ghost} href={PROJECT_REPO_URL} target="_blank" rel="noreferrer">
              STL / STEP &amp; build files ↗
            </a>
          </div>
        </div>

        <div ref={cadViewerRef} className={`${styles.panel} ${styles.cadViewer}`}>
          {cadOpen ? (
            <iframe
              src="/cad-preview.html?model=compact&cb=42"
              className={styles.cadFrame}
              title="BMO 3D CAD preview"
            />
          ) : (
            <button type="button" className={styles.cadLaunch} onClick={() => setCadOpen(true)}>
              <span className={styles.cadLaunchTitle}>Open the real CAD viewer</span>
              <span className={styles.cadLaunchNote}>
                Loads three.js and about 5 MB of print meshes
              </span>
            </button>
          )}
        </div>
      </section>

      {/* 07 · Bye --------------------------------------------------------------- */}
      <footer
        ref={sectionRef.bye}
        data-chapter="bye"
        className={`${styles.section} ${styles.bye}`}
      >
        <div className={`${styles.panel} ${styles.byeInner}`}>
          <p className={styles.kicker}>07 · That&apos;s the tour</p>
          <h2>Go build a friend.</h2>
          <div className={styles.byeLinks}>
            <a href="#cad" className={styles.primary}>
              Print the kit
            </a>
            <Link href="/wiki" className={styles.ghost}>
              How it works wiki
            </Link>
            <a href={PROJECT_REPO_URL} className={styles.ghost} target="_blank" rel="noreferrer">
              BMO-ESP32 repo ↗
            </a>
            <a href={GBRAIN_REPO_URL} className={styles.ghost} target="_blank" rel="noreferrer">
              garrytan/gbrain ↗
            </a>
          </div>
          <p className={styles.fine}>
            Firmware, CAD, and the cloud brain are open source.
          </p>
        </div>
      </footer>
    </main>
  );
}
