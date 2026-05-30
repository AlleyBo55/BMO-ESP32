import BrainStatus from '@/components/BrainStatus';
import Simulator from '@/components/Simulator';

/**
 * Simulator page.
 *
 * Server component shell around the {@link Simulator} client component. Runs
 * the full STT → LLM → TTS round-trip from the browser so the operator can
 * test the whole pipeline (including the brain/memory layer) without the
 * physical ESP32 device. Each stage shows a live ok/error indicator with
 * latency. The {@link BrainStatus} panel shows the gbrain-style brain health
 * (doctor) and what BMO has learned about the child.
 */

export const dynamic = 'force-dynamic';

export default function SimulatorPage(): React.ReactElement {
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold text-zinc-100">Simulator</h1>
        <p className="mt-1 text-sm text-zinc-400">
          Run the full device pipeline from your browser: record or type, watch
          speech-to-text, the brain, and text-to-speech each report in, then
          hear BMO reply. No ESP32 required.
        </p>
      </header>
      <Simulator />
      <BrainStatus />
    </div>
  );
}
