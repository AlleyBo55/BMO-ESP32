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
  title: 'BMO Wiki - Zero to Live ESP32 Companion Guide',
  description:
    'A public wiki for taking the BMO ESP32-C3 companion from zero setup to a live deployed build with firmware, voice, memory, and smoke tests.',
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

const ENV_VARS = [
  {
    name: 'NEXT_PUBLIC_SUPABASE_URL',
    source: 'Supabase project URL',
    safety: 'public',
  },
  {
    name: 'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY',
    source: 'Supabase publishable key',
    safety: 'public',
  },
  {
    name: 'SUPABASE_SECRET_KEY',
    source: 'Supabase secret key',
    safety: 'server only',
  },
  {
    name: 'OPENROUTER_API_KEY',
    source: 'OpenRouter API key',
    safety: 'server only',
  },
  {
    name: 'AUTH_SESSION_SECRET',
    source: 'openssl rand -hex 32',
    safety: 'server only',
  },
] as const;

const LAUNCH_GUIDE = [
  {
    phase: '00',
    title: 'Open the workbench',
    goal: 'Start with the repo, tools, and one scratch buffer for values you will paste later.',
    tasks: [
      'Clone the BMO-ESP32 repo.',
      'Install Node.js 20.18 or newer for the web app.',
      'Install PlatformIO for the ESP32-C3 firmware.',
      'Install Python 3.10+ and ffmpeg if you plan to regenerate voice clips.',
    ],
    command: `git clone https://github.com/AlleyBo55/BMO-ESP32.git
cd BMO
cd dashboard
npm install`,
    proof: 'The dashboard dependencies install, and PlatformIO can see the esp32c3_supermini environment.',
  },
  {
    phase: '01',
    title: 'Gather BMO parts',
    goal: 'Build the physical cast before the cloud brain enters the story.',
    tasks: [
      'ESP32-C3 Super Mini board.',
      'ST7735 1.8 inch 160x128 TFT display.',
      'INMP441 I2S microphone.',
      'MAX98357A I2S amp plus 8 ohm 1 W speaker.',
      'TTP223 capacitive touch sensor, USB-C data cable, jumpers, and stable power.',
    ],
    proof: 'You can flash a tiny firmware sketch and open the serial monitor without driver problems.',
  },
  {
    phase: '02',
    title: 'Create the memory room',
    goal: 'Supabase stores admin state, config, activity logs, auth attempts, and BMO memory.',
    tasks: [
      'Create a Supabase project close to your deploy region.',
      'Run dashboard/supabase/schema.sql in the SQL editor.',
      'Run dashboard/supabase/seed.sql after the schema succeeds.',
      'Copy the project URL, publishable key, and secret key.',
    ],
    command: `# Run these files in Supabase SQL Editor
dashboard/supabase/schema.sql
dashboard/supabase/seed.sql`,
    proof: 'The admin, config, activity_log, and auth_attempts tables exist with row-level security enabled.',
  },
  {
    phase: '03',
    title: 'Light the web portal',
    goal: 'Deploy the Next.js app as the public landing, wiki, and private operator console.',
    tasks: [
      'Import the GitHub repo into Vercel.',
      'Set the Vercel root directory to dashboard.',
      'Add the five environment variables below for Production, Preview, and Development.',
      'Mark every server-only value as sensitive.',
    ],
    command: `openssl rand -hex 32
# paste that value into AUTH_SESSION_SECRET`,
    proof: 'The first Vercel deploy builds green and the production URL loads.',
  },
  {
    phase: '04',
    title: 'Onboard the operator',
    goal: 'Create the first admin and generate the one-time device fingerprint.',
    tasks: [
      'Visit the production URL.',
      'Complete the onboarding form with a username and strong password.',
      'Leave fingerprint blank unless you already have a high-entropy value.',
      'Copy the plaintext fingerprint immediately; it is shown once.',
    ],
    proof: 'Login works, and your scratch buffer has the production URL plus plaintext fingerprint.',
  },
  {
    phase: '05',
    title: 'Pair the tiny brain',
    goal: 'Give the ESP32-C3 Wi-Fi, the deployed origin, and its rotatable fingerprint.',
    tasks: [
      'Copy the firmware secrets template.',
      'Fill Wi-Fi SSID, Wi-Fi password, deployed origin, and BMO fingerprint.',
      'Flash the firmware to the ESP32-C3.',
      'Open the serial monitor and watch for Wi-Fi plus brain readiness.',
    ],
    command: `cd firmware/bmo_face_anim
cp include/secrets.h.in include/secrets.h
$EDITOR include/secrets.h
pio run -e esp32c3_supermini -t upload
pio device monitor -e esp32c3_supermini`,
    proof: 'Serial output shows Wi-Fi connected and the brain client ready.',
  },
  {
    phase: '06',
    title: 'Prove the bridge',
    goal: 'Confirm the paired device can reach the cloud and random callers cannot.',
    tasks: [
      'Call the credits endpoint with the fingerprint header.',
      'Call the same endpoint without the header.',
      'Keep the 200 and 401 results as your first launch proof.',
    ],
    command: `curl -i \\
  -H "X-BMO-Fingerprint: <paste-the-fingerprint>" \\
  https://your-bmo-site.vercel.app/api/openrouter/credits

curl -i https://your-bmo-site.vercel.app/api/openrouter/credits`,
    proof: 'The authenticated request returns 200; the request without the fingerprint returns 401.',
  },
  {
    phase: '07',
    title: 'Run the voice smoke test',
    goal: 'Exercise the whole loop: touch, mic, cloud brain, memory, voice, speaker, activity log.',
    tasks: [
      'Hold the touch button and say: tell me a story.',
      'Release the button and watch the face move listening to thinking to talking.',
      'Confirm audio plays from the speaker.',
      'Check the activity log for input_text, reply_text, status ok, and total timing.',
    ],
    proof: 'BMO answers out loud, the mouth moves with the audio, and the activity row records the exchange.',
  },
] as const;

const LIVE_CHECKS = [
  'Public homepage loads at the production URL.',
  'Wiki is reachable at /wiki and is listed in sitemap.xml.',
  'Private operator controls are not linked from public nav and are not in sitemap.xml.',
  'Supabase anon role cannot read private tables directly.',
  'Server-only env vars are marked sensitive in Vercel.',
  'include/secrets.h is still gitignored and never appears in git status.',
  'Old fingerprint fails after rotation; new fingerprint works after re-flash.',
] as const;

export default function WikiPage(): React.ReactElement {
  return (
    <main className={styles.page}>
      <header className={styles.hero}>
        <nav className={styles.nav} aria-label="Wiki navigation">
          <Link href="/">BMO home</Link>
          <a href="#launch">Launch</a>
          <a href="#components">Components</a>
          <a href="#voice">Voice</a>
          <a href="#brain">Brain</a>
          <a href="#flow">Flow</a>
        </nav>

        <h1>BMO Wiki</h1>
        <p>
          Start from an empty desk and end with a live ESP32 companion: public
          landing, build wiki, private operator controls, Supabase memory,
          Vercel deploy, firmware pairing, voice, and smoke tests.
        </p>
        <div className={styles.heroActions}>
          <a href="#launch">Start the launch quest</a>
          <a href={PROJECT_REPO_URL} target="_blank" rel="noreferrer">
            Open the repo
          </a>
        </div>
        <div className={styles.heroStats} aria-label="Launch guide summary">
          <span>
            <strong>{LAUNCH_GUIDE.length}</strong>
            launch phases
          </span>
          <span>
            <strong>{ENV_VARS.length}</strong>
            env vars
          </span>
          <span>
            <strong>1</strong>
            device fingerprint
          </span>
        </div>
      </header>

      <section
        id="launch"
        className={`${styles.section} ${styles.launchSection}`}
        aria-labelledby="launch-title"
      >
        <div className={styles.sectionIntro}>
          <p className={styles.microcopy}>Zero to live</p>
          <h2 id="launch-title">The complete BMO launch quest.</h2>
          <p>
            Follow these phases in order. Each one ends with a proof check, so
            you always know whether the build is ready for the next door.
          </p>
        </div>

        <div className={styles.envDeck} aria-label="Required environment variables">
          {ENV_VARS.map((envVar) => (
            <article key={envVar.name}>
              <code>{envVar.name}</code>
              <span>{envVar.source}</span>
              <b>{envVar.safety}</b>
            </article>
          ))}
        </div>

        <div className={styles.launchMap}>
          {LAUNCH_GUIDE.map((stage) => (
            <article className={styles.launchCard} key={stage.phase}>
              <div className={styles.launchNumber}>{stage.phase}</div>
              <div className={styles.launchBody}>
                <h3>{stage.title}</h3>
                <p>{stage.goal}</p>
                <ul>
                  {stage.tasks.map((task) => (
                    <li key={task}>{task}</li>
                  ))}
                </ul>
                {'command' in stage ? (
                  <pre>
                    <code>{stage.command}</code>
                  </pre>
                ) : null}
                <div className={styles.proofBox}>
                  <span>Save point</span>
                  <p>{stage.proof}</p>
                </div>
              </div>
            </article>
          ))}
        </div>

        <div className={styles.liveChecklist} aria-labelledby="live-checks-title">
          <h3 id="live-checks-title">Before you call it live.</h3>
          <div>
            {LIVE_CHECKS.map((check) => (
              <span key={check}>{check}</span>
            ))}
          </div>
        </div>
      </section>

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
