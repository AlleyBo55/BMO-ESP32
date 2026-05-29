import SongsManager from '@/components/SongsManager';
import { listSongs } from '@/lib/songs';

/**
 * Songs page.
 *
 * Server component. Reads the full songs catalog from Supabase and hands
 * it to the client {@link SongsManager} island. The island renders the
 * add-song form and the existing-songs list, calling server actions in
 * `./actions.ts` for mutations.
 */

export const dynamic = 'force-dynamic';

export default async function SongsPage(): Promise<React.ReactElement> {
  const songs = await listSongs();

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold text-zinc-100">Songs</h1>
        <p className="mt-1 max-w-2xl text-sm text-zinc-400">
          BMO can play any song whose audio file you upload to a public
          HTTPS URL. Cloudflare R2, S3, GitHub Releases, plain static
          hosting all work. The dashboard fetches the file, transcodes it
          to PCM16 24 kHz mono with ffmpeg, and streams it to the device
          in the same wire format the TTS endpoint already uses. MP3, OGG,
          WAV, FLAC, and AAC sources are all supported.
        </p>
        <div className="mt-3 max-w-2xl rounded border border-amber-900/60 bg-amber-950/30 px-3 py-2 text-xs text-amber-200">
          <strong className="font-semibold">Hosting limit:</strong> Vercel
          serverless functions cap each request at 60 seconds, so songs
          longer than ~60s will be cut off. Short jingles, theme songs,
          and lullabies are fine. For full-length tracks, host this
          dashboard on a VPS (Contabo, Fly, Hetzner) where there is no
          per-request limit.
        </div>
      </header>

      <SongsManager initialSongs={songs} />
    </div>
  );
}
