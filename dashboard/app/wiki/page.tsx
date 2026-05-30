import type { Metadata } from 'next';
import Link from 'next/link';

import {
  BRAIN_CAPABILITIES,
  COMPONENTS,
  FEATURES,
  GBRAIN_REPO_URL,
  MOMENTS,
  PROJECT_REPO_URL,
  VOICE_PIPELINE,
} from '@/components/landing/bmoContent';

import styles from './wiki.module.css';

export const metadata: Metadata = {
  title: 'BMO Wiki - How the ESP32 Companion Works',
  description:
    'A public wiki for the BMO ESP32-C3 companion: features, components, signal flow, animation states, voice, and memory.',
};

const FLOW = [
  {
    title: 'Gesture or voice starts it',
    body: 'The TTP223 touch line or microphone capture creates a small event: tap, hold, long-hold, or speech audio.',
  },
  {
    title: 'Firmware turns it into state',
    body: 'The ESP32-C3 maps the event to a readable mood state so the screen changes immediately.',
  },
  {
    title: 'The face explains the wait',
    body: 'Listening, thinking, and talking states are separate, so the device never looks frozen during network work.',
  },
  {
    title: 'The brain answers',
    body: 'For conversation, firmware sends captured audio to the brain route with its fingerprint header.',
  },
  {
    title: 'Audio and memory complete the loop',
    body: 'The reply streams back as voice while useful facts can be recalled or written into the memory layer.',
  },
] as const;

const BUILD_NOTES = [
  {
    title: 'Firmware target',
    body: 'PlatformIO builds the ESP32-C3 Super Mini firmware. The live target is the esp32c3_supermini environment.',
  },
  {
    title: 'Display budget',
    body: 'The face renders into a 160x128 RGB565 buffer, roughly 40 KB, then flushes over hardware SPI.',
  },
  {
    title: 'Voice budget',
    body: 'Use tiny baked clips for instant reactions and streamed PCM16 for generated replies, so the ESP32 does not store big audio.',
  },
  {
    title: 'Secrets',
    body: 'Wi-Fi, deployed origin, and the plaintext device fingerprint stay in the gitignored firmware secrets file.',
  },
  {
    title: 'Public/private split',
    body: 'The landing and wiki are public. Operator controls stay unlisted, login-protected, and outside the sitemap.',
  },
] as const;

export default function WikiPage(): React.ReactElement {
  return (
    <main className={styles.page}>
      <header className={styles.hero}>
        <nav className={styles.nav} aria-label="Wiki navigation">
          <Link href="/">BMO home</Link>
          <a href="#components">Components</a>
          <a href="#voice">Voice</a>
          <a href="#brain">Brain</a>
          <a href="#flow">Flow</a>
          <a href="#states">States</a>
        </nav>

        <h1>BMO Wiki</h1>
        <p>
          How the tiny ESP32 companion works: what each feature does, which
          component owns it, and how touch or voice turns into a visible BMO
          reaction.
        </p>
      </header>

      <section className={styles.section} aria-labelledby="features-title">
        <div className={styles.sectionIntro}>
          <p className={styles.microcopy}>Features</p>
          <h2 id="features-title">What the project supports.</h2>
          <p>
            Each feature has a visible behavior, a hardware or software owner,
            and one implementation rule that keeps the tiny device believable.
          </p>
        </div>

        <div className={styles.cardGrid}>
          {FEATURES.map((feature) => (
            <article className={styles.card} key={feature.title}>
              <span>{feature.owner}</span>
              <h3>{feature.title}</h3>
              <p>{feature.body}</p>
              <dl>
                <div>
                  <dt>User sees</dt>
                  <dd>{feature.visible}</dd>
                </div>
                <div>
                  <dt>Implementation</dt>
                  <dd>{feature.implementation}</dd>
                </div>
              </dl>
            </article>
          ))}
        </div>
      </section>

      <section
        id="components"
        className={styles.section}
        aria-labelledby="components-title"
      >
        <div className={styles.sectionIntro}>
          <p className={styles.microcopy}>Components needed</p>
          <h2 id="components-title">Hardware and software roles.</h2>
        </div>

        <div className={styles.table}>
          {COMPONENTS.map((component) => (
            <article className={styles.tableRow} key={component.name}>
              <span>{component.role}</span>
              <div>
                <h3>{component.name}</h3>
                <p>{component.why}</p>
              </div>
              <dl>
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

      <section id="voice" className={styles.section} aria-labelledby="voice-title">
        <div className={styles.sectionIntro}>
          <p className={styles.microcopy}>Voice pipeline</p>
          <h2 id="voice-title">How a spoken question becomes a spoken answer.</h2>
          <p>
            Hold the touch pad, speak, and let go. Six stages turn your voice
            into BMO&apos;s voice — each one has a visible behavior and one
            implementation detail that keeps it reliable on tiny hardware.
          </p>
        </div>

        <div className={styles.table}>
          {VOICE_PIPELINE.map((stage, index) => (
            <article className={styles.tableRow} key={stage.step}>
              <span>
                {String(index + 1).padStart(2, '0')} · {stage.step}
              </span>
              <div>
                <h3>{stage.title}</h3>
                <p>{stage.body}</p>
              </div>
              <dl>
                <div>
                  <dt>Under the hood</dt>
                  <dd>{stage.detail}</dd>
                </div>
              </dl>
            </article>
          ))}
        </div>

        <div className={styles.notesGrid} style={{ marginTop: '14px' }}>
          <article className={styles.noteCard}>
            <h3>Why BMO reads the reply exactly</h3>
            <p>
              The voice model is a chat-audio model, not a plain read-aloud
              engine. Given a persona and a message it tends to answer in
              character instead of reading the text — so BMO could say something
              other than the logged reply. The fix sends the reply wrapped as a
              strict &quot;read this verbatim&quot; script, so the spoken audio
              always matches the reply text.
            </p>
          </article>
          <article className={styles.noteCard}>
            <h3>Why the mic data pin matters</h3>
            <p>
              The microphone data line must avoid the ESP32-C3 boot strapping
              pins (GP8 / GP9). On a strapping pin the input reads stuck-high, so
              capture is pure silence and speech-to-text returns nothing. The mic
              SD pin lives on GP5, a free pin, so audio is captured cleanly.
            </p>
          </article>
        </div>
      </section>

      <section id="brain" className={styles.section} aria-labelledby="brain-title">
        <div className={styles.sectionIntro}>
          <p className={styles.microcopy}>Core brain (gbrain-inspired)</p>
          <h2 id="brain-title">What BMO adopted from gbrain.</h2>
          <p>
            BMO reproduces the load-bearing ideas of Garry Tan&apos;s GBrain as
            real code on its own stack (Supabase pgvector + OpenRouter), not as
            inert skill files. Each capability below is a working module, with
            the file that implements it.
          </p>
        </div>

        <div className={styles.cardGrid}>
          {BRAIN_CAPABILITIES.map((cap) => (
            <article className={styles.card} key={cap.title}>
              <span>{cap.gbrain}</span>
              <h3>{cap.title}</h3>
              <p>{cap.body}</p>
              <dl>
                <div>
                  <dt>Module</dt>
                  <dd>{cap.module}</dd>
                </div>
              </dl>
            </article>
          ))}
        </div>
      </section>

      <section id="flow" className={styles.section} aria-labelledby="flow-title">
        <div className={styles.sectionIntro}>
          <p className={styles.microcopy}>Signal flow</p>
          <h2 id="flow-title">From input to personality.</h2>
        </div>

        <div className={styles.flow}>
          {FLOW.map((step, index) => (
            <article className={styles.flowStep} key={step.title}>
              <span>{String(index + 1).padStart(2, '0')}</span>
              <h3>{step.title}</h3>
              <p>{step.body}</p>
            </article>
          ))}
        </div>
      </section>

      <section
        id="states"
        className={styles.section}
        aria-labelledby="states-title"
      >
        <div className={styles.sectionIntro}>
          <p className={styles.microcopy}>Expression states</p>
          <h2 id="states-title">The face is the status light.</h2>
        </div>

        <div className={styles.stateList}>
          {MOMENTS.map((moment) => (
            <article className={styles.stateRow} key={moment.key}>
              <span>{moment.label}</span>
              <h3>{moment.title}</h3>
              <p>{moment.body}</p>
              <em>{moment.animation}</em>
              <small>{moment.signal}</small>
            </article>
          ))}
        </div>
      </section>

      <section className={styles.section} aria-labelledby="notes-title">
        <div className={styles.sectionIntro}>
          <p className={styles.microcopy}>Build notes</p>
          <h2 id="notes-title">The rules that keep BMO small.</h2>
        </div>

        <div className={styles.notesGrid}>
          {BUILD_NOTES.map((note) => (
            <article className={styles.noteCard} key={note.title}>
              <h3>{note.title}</h3>
              <p>{note.body}</p>
            </article>
          ))}
        </div>
      </section>

      <section className={styles.repoSection} aria-labelledby="repo-title">
        <div>
          <p className={styles.microcopy}>References</p>
          <h2 id="repo-title">Code and memory inspiration.</h2>
          <p>
            The project repo is the source of truth for this build. GBrain is
            referenced as inspiration for the memory-shaped brain idea.
          </p>
        </div>

        <div className={styles.repoLinks}>
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
