'use client';

import Image from 'next/image';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import type { CSSProperties, ReactElement } from 'react';

import {
  COMPONENTS,
  FEATURES,
  GBRAIN_REPO_URL,
  MOMENTS,
  ORGAN_MAP,
  PROJECT_REPO_URL,
  type MoodKey,
} from './bmoContent';
import styles from './BmoLandingExperience.module.css';

const moodClassNames: Record<MoodKey, string> = {
  touch: styles.moodTouch ?? '',
  listen: styles.moodListen ?? '',
  think: styles.moodThink ?? '',
  talk: styles.moodTalk ?? '',
  bashful: styles.moodBashful ?? '',
};

const sceneClassNames: Record<MoodKey, string> = {
  touch: styles.sceneTouch ?? '',
  listen: styles.sceneListen ?? '',
  think: styles.sceneThink ?? '',
  talk: styles.sceneTalk ?? '',
  bashful: styles.sceneBashful ?? '',
};

function getNextMood(current: MoodKey): MoodKey {
  const index = MOMENTS.findIndex((moment) => moment.key === current);
  return MOMENTS[(index + 1) % MOMENTS.length]?.key ?? 'touch';
}

export default function BmoLandingExperience(): ReactElement {
  const [activeMood, setActiveMood] = useState<MoodKey>('listen');
  const [isScrolled, setIsScrolled] = useState(false);
  const [discoveredMoods, setDiscoveredMoods] = useState<ReadonlySet<MoodKey>>(
    () => new Set(['listen']),
  );
  const questComplete = discoveredMoods.size === MOMENTS.length;

  useEffect(() => {
    function updateHeader(): void {
      setIsScrolled(window.scrollY > 12);
    }

    updateHeader();
    window.addEventListener('scroll', updateHeader, { passive: true });
    return () => window.removeEventListener('scroll', updateHeader);
  }, []);

  function activateMood(mood: MoodKey): void {
    setActiveMood(mood);
    setDiscoveredMoods((current) => {
      if (current.has(mood)) {
        return current;
      }

      return new Set(current).add(mood);
    });
  }

  return (
    <main className={`${styles.page} ${sceneClassNames[activeMood]}`}>
      <header
        className={`${styles.topbar} ${isScrolled ? styles.topbarScrolled : ''}`}
      >
        <Link href="/" className={styles.brand} aria-label="BMO home">
          <span className={styles.brandFace} aria-hidden="true">
            <span />
          </span>
          <span>BMO</span>
        </Link>

        <nav className={styles.navLinks} aria-label="Landing navigation">
          <a href="#world">Signals</a>
          <a href="#features">Features</a>
          <a href="#inside">Inside</a>
          <Link href="/wiki">Wiki</Link>
        </nav>
      </header>

      <section className={styles.hero} aria-labelledby="landing-title">
        <div className={styles.heroCopy}>
          <h1 id="landing-title">BMO</h1>
          <p>
            A tiny desk companion with a face, a voice, a memory core, and five
            little buttons that make the hardware feel alive.
          </p>

          <div className={styles.heroActions}>
            <button
              type="button"
              className={styles.primaryAction}
              onClick={() => activateMood(getNextMood(activeMood))}
            >
              Press a mood
            </button>
            <a
              href={PROJECT_REPO_URL}
              className={styles.secondaryAction}
              target="_blank"
              rel="noreferrer"
            >
              View repo
            </a>
          </div>
        </div>

        <div className={styles.toyStage}>
          <div className={styles.stageGlow} aria-hidden="true" />
          <BmoFace mood={activeMood} />

          <div className={styles.buttonDeck} aria-label="BMO mood buttons">
            {MOMENTS.map((moment) => {
              const isActive = moment.key === activeMood;
              const isAwake = discoveredMoods.has(moment.key);

              return (
                <button
                  key={moment.key}
                  type="button"
                  data-mood={moment.key}
                  className={`${styles.moodButton} ${
                    isActive ? styles.moodButtonActive : ''
                  } ${isAwake ? styles.moodButtonAwake : ''}`}
                  onClick={() => activateMood(moment.key)}
                  onFocus={() => activateMood(moment.key)}
                  aria-pressed={isActive}
                >
                  <span aria-hidden="true" />
                  {moment.label}
                </button>
              );
            })}
          </div>
        </div>

        <div className={styles.questStrip} aria-label="Signal quest progress">
          <span>{questComplete ? 'All signals awake' : 'Signal quest'}</span>
          <strong>
            {discoveredMoods.size}/{MOMENTS.length}
          </strong>
          <div aria-hidden="true">
            {MOMENTS.map((moment) => (
              <i
                key={moment.key}
                className={discoveredMoods.has(moment.key) ? styles.dotLit : ''}
              />
            ))}
          </div>
        </div>
      </section>

      <section id="world" className={styles.signalSection}>
        <div className={styles.signalArt}>
          <Image
            src="/landing/bmo-bright-playfield.webp"
            alt="A bright circuit-board meadow with button flowers and glowing solder pads."
            fill
            sizes="(max-width: 900px) 100vw, 58vw"
          />
        </div>

        <div className={styles.signalCopy}>
          <p className={styles.microcopy}>Playable information</p>
          <h2>Every button teaches one part of the build.</h2>
          <p>
            Touch the controls, watch the face answer, then scroll into the
            little body to see which organ does the work.
          </p>

          <div className={styles.signalList}>
            {MOMENTS.map((moment, index) => (
              <button
                key={moment.key}
                type="button"
                className={`${styles.signalRow} ${
                  moment.key === activeMood ? styles.signalRowActive : ''
                }`}
                onClick={() => activateMood(moment.key)}
              >
                <span>{String(index + 1).padStart(2, '0')}</span>
                <strong>{moment.label}</strong>
                <small>{moment.signal}</small>
              </button>
            ))}
          </div>
        </div>
      </section>

      <section id="features" className={styles.detailSection}>
        <div className={styles.detailHeader}>
          <p className={styles.microcopy}>Feature map</p>
          <h2>What the tiny toy actually does.</h2>
          <p>
            The landing is cute, but the build is practical: each interaction is
            a visible state backed by a real hardware or software role.
          </p>
        </div>

        <div className={styles.featureGrid}>
          {FEATURES.map((feature) => (
            <article className={styles.featureCard} key={feature.title}>
              <span>{feature.owner}</span>
              <h3>{feature.title}</h3>
              <p>{feature.body}</p>
              <dl>
                <div>
                  <dt>User sees</dt>
                  <dd>{feature.visible}</dd>
                </div>
                <div>
                  <dt>How it works</dt>
                  <dd>{feature.implementation}</dd>
                </div>
              </dl>
            </article>
          ))}
        </div>
      </section>

      <section id="inside" className={styles.insideSection}>
        <div className={styles.insideCopy}>
          <p className={styles.microcopy}>Inside BMO</p>
          <h2>Real hardware, cast as tiny organs.</h2>
          <p>
            The screen is the feeling window. The ESP32-C3 is the pocket brain.
            The mic, speaker, touch pad, and memory core each get a visible
            role, so the device reads as a character instead of a box of parts.
          </p>
          <Link href="/wiki" className={styles.textLink}>
            Read the build wiki
          </Link>
        </div>

        <div className={styles.anatomyScene}>
          <Image
            src="/landing/bmo-anatomy-organ-map-v2.webp"
            alt="A mint-green open console showing whimsical hardware organs inside."
            width={1600}
            height={900}
            sizes="(max-width: 900px) 100vw, 760px"
          />
          {ORGAN_MAP.map((item) => (
            <span
              key={item.organ}
              className={styles.organCallout}
              style={
                {
                  '--organ-x': item.x,
                  '--organ-y': item.y,
                } as CSSProperties
              }
            >
              <b>{item.organ}</b>
              <em>{item.part}</em>
              <small>{item.purpose}</small>
            </span>
          ))}
        </div>
      </section>

      <section className={styles.componentSection} aria-labelledby="parts-title">
        <div className={styles.detailHeader}>
          <p className={styles.microcopy}>Components needed</p>
          <h2 id="parts-title">The build checklist.</h2>
        </div>

        <div className={styles.componentList}>
          {COMPONENTS.map((component) => (
            <article className={styles.componentRow} key={component.name}>
              <span>{component.role}</span>
              <div className={styles.componentMain}>
                <h3>{component.name}</h3>
                <p>{component.why}</p>
              </div>
              <dl className={styles.componentSpecs}>
                <div>
                  <dt>Need</dt>
                  <dd>{component.needed}</dd>
                </div>
                <div>
                  <dt>Wire / route</dt>
                  <dd>{component.connection}</dd>
                </div>
                <div>
                  <dt>Note</dt>
                  <dd>{component.note}</dd>
                </div>
              </dl>
            </article>
          ))}
        </div>
      </section>

      <section id="brain" className={styles.brainSection}>
        <div>
          <p className={styles.microcopy}>Core brain</p>
          <h2>Small enough for the desk, thoughtful enough to remember.</h2>
          <p>
            The project keeps the public magic playful while the memory idea
            nods to Garry Tan&apos;s GBrain: moments become preferences,
            synthesis, and useful gaps.
          </p>
        </div>

        <div className={styles.repoPanel}>
          <Link href="/wiki">How it works wiki</Link>
          <a href={PROJECT_REPO_URL} target="_blank" rel="noreferrer">
            BMO-ESP32 repo
          </a>
          <a href={GBRAIN_REPO_URL} target="_blank" rel="noreferrer">
            garrytan/gbrain
          </a>
        </div>
      </section>
    </main>
  );
}

function BmoFace({ mood }: { mood: MoodKey }): ReactElement {
  return (
    <div className={`${styles.bmoUnit} ${moodClassNames[mood]}`}>
      <div className={styles.bmoAntenna} />
      <div className={styles.bmoBody}>
        <div className={styles.screen}>
          <span className={`${styles.eye} ${styles.leftEye}`} />
          <span className={`${styles.eye} ${styles.rightEye}`} />
          <span className={styles.mouth}>
            <span />
          </span>
          <span className={`${styles.cheek} ${styles.leftCheek}`} />
          <span className={`${styles.cheek} ${styles.rightCheek}`} />
          <span className={styles.thoughtOne} />
          <span className={styles.thoughtTwo} />
        </div>

        <div className={styles.controls}>
          <span className={styles.dpad} />
          <span className={styles.blueButton} />
          <span className={styles.greenButton} />
          <span className={styles.redButton} />
        </div>
      </div>
    </div>
  );
}
