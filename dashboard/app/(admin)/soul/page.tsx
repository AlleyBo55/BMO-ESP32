import SoulEditor from '@/components/SoulEditor';
import { getConfig } from '@/lib/config';

/**
 * Soul editor page.
 *
 * Server component. Reads the singleton `config.soul_md` value and hands it
 * to {@link SoulEditor} as `initialContent`. The editor (a client component)
 * owns dirty-tracking, the 64 KiB visualizer, and the Save button.
 */

export const dynamic = 'force-dynamic';

export default async function SoulPage(): Promise<React.ReactElement> {
  const config = await getConfig();

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold text-zinc-100">Soul</h1>
        <p className="mt-1 text-sm text-zinc-400">
          The system prompt that defines BMO&rsquo;s personality. Markdown is
          allowed and used verbatim.
        </p>
      </header>

      <SoulEditor initialContent={config.soul_md} updatedAt={config.updated_at} />
    </div>
  );
}
