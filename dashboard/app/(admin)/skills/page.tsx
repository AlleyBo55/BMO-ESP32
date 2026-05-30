import { saveSkillParamsForm, toggleSkillForm } from '@/app/(admin)/skills/actions';
import { getConfig } from '@/lib/config';
import type { SkillName, SkillState } from '@/lib/types';

/**
 * Skills page.
 *
 * Server component. Renders one card per skill with:
 *
 *   - name + one-line description (hardcoded mapping below),
 *   - enabled toggle implemented as a checkbox + submit form so the page
 *     keeps working without client JS,
 *   - collapsible JSON params editor (server form posts the new bag).
 *
 * Both controls submit to server actions in `./actions.ts`. Each action
 * calls `updateConfig({ skills })` and revalidates this path.
 */

export const dynamic = 'force-dynamic';

interface SkillMeta {
  name: SkillName;
  label: string;
  description: string;
}

const SKILLS: ReadonlyArray<SkillMeta> = [
  {
    name: 'web_search',
    label: 'Web search',
    description: 'Look up current information on the open web.',
  },
  {
    name: 'sing',
    label: 'Sing',
    description: 'Sing a short, original song in BMO\u2019s voice.',
  },
  {
    name: 'play_music',
    label: 'Play music',
    description: 'Play instrumental background music on demand.',
  },
  {
    name: 'story',
    label: 'Tell a story',
    description: 'Tell short, friendly stories suitable for kids.',
  },
  {
    name: 'comfort',
    label: 'Comfort',
    description: 'Offer a kind word when someone seems sad.',
  },
  {
    name: 'play_pretend',
    label: 'Play pretend',
    description: 'Invent and run small imaginary games together.',
  },
  {
    name: 'memory',
    label: 'Memory (brain)',
    description:
      'Remember past conversations and recall them before answering. The brain grows the more BMO is used.',
  },
  {
    name: 'random_thoughts',
    label: 'Random thoughts',
    description:
      'Every few minutes when idle, BMO thinks out loud: it recalls what it knows, muses a short thought in its own voice, and remembers the thought \u2014 a self-feeding inner life (gbrain/OpenClaw style).',
  },
];

function paramsToJson(state: SkillState): string {
  if (state.params === undefined) return '{}';
  try {
    return JSON.stringify(state.params, null, 2);
  } catch {
    return '{}';
  }
}

interface SkillCardProps {
  meta: SkillMeta;
  state: SkillState;
}

function SkillCard({ meta, state }: SkillCardProps): React.ReactElement {
  const enabled = state.enabled;
  // The toggle form submits the *next* desired state, so when the checkbox
  // is currently checked we send "false" (and vice versa). This avoids the
  // classic HTML form gotcha where unchecked checkboxes don't submit at all.
  const nextEnabled = !enabled;

  return (
    <article className="rounded-lg border border-zinc-800 bg-zinc-900 p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-base font-semibold text-zinc-100">{meta.label}</h3>
          <p className="mt-1 text-xs text-zinc-400">{meta.description}</p>
          <p className="mt-1 font-mono text-[11px] text-zinc-600">{meta.name}</p>
        </div>
        <form action={toggleSkillForm} className="shrink-0">
          <input type="hidden" name="name" value={meta.name} />
          <input type="hidden" name="enabled" value={nextEnabled ? 'true' : 'false'} />
          <button
            type="submit"
            className={`rounded px-3 py-1.5 text-xs font-medium transition-colors ${
              enabled
                ? 'bg-emerald-500/15 text-emerald-400 hover:bg-emerald-500/25'
                : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700'
            }`}
            aria-pressed={enabled}
          >
            {enabled ? 'Enabled' : 'Disabled'}
          </button>
        </form>
      </div>

      <details className="mt-4 group">
        <summary className="cursor-pointer text-xs text-zinc-500 hover:text-sky-400 select-none">
          Parameters (JSON)
        </summary>
        <form action={saveSkillParamsForm} className="mt-3 space-y-2">
          <input type="hidden" name="name" value={meta.name} />
          <textarea
            name="params"
            defaultValue={paramsToJson(state)}
            spellCheck={false}
            rows={5}
            className="block w-full rounded border border-zinc-800 bg-zinc-950 p-3 font-mono text-xs leading-5 text-zinc-100 outline-none focus:border-sky-500 focus:ring-1 focus:ring-sky-500"
          />
          <div className="flex justify-end">
            <button
              type="submit"
              className="rounded border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-xs font-medium text-zinc-200 hover:border-sky-500 hover:text-sky-400"
            >
              Save params
            </button>
          </div>
        </form>
      </details>
    </article>
  );
}

export default async function SkillsPage(): Promise<React.ReactElement> {
  const config = await getConfig();

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold text-zinc-100">Skills</h1>
        <p className="mt-1 text-sm text-zinc-400">
          Toggle which capabilities BMO can use during a conversation.
          Disabled skills are unreachable from the LLM.
        </p>
      </header>

      <div className="grid gap-4 md:grid-cols-2">
        {SKILLS.map((meta) => {
          const state: SkillState = config.skills[meta.name] ?? { enabled: false };
          return <SkillCard key={meta.name} meta={meta} state={state} />;
        })}
      </div>
    </div>
  );
}
