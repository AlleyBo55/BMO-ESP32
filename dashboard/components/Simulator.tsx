'use client';

import { useCallback, useRef, useState } from 'react';

/**
 * End-to-end pipeline simulator with full debugging.
 *
 * Reproduces the full device round-trip from the browser so you can test the
 * whole chain without the ESP32:
 *
 *   1. STT  — record from the mic (MediaRecorder) OR type text directly,
 *             POST the audio to /api/sim/stt, get a transcript back.
 *   2. LLM  — POST the transcript to /api/sim/brain, get BMO's reply text
 *             plus any recalled memories (the gbrain layer).
 *   3. TTS  — POST the reply to /api/sim/tts, get a playable WAV, autoplay it.
 *
 * Each stage owns a live status chip (idle → running → ok / error) with
 * latency. A stage failing does not wipe earlier results, so you see exactly
 * where the pipeline broke.
 *
 * Debugging: every stage records its raw request + response into a timestamped
 * event log, and the brain stage exposes the EXACT system prompt sent to the
 * LLM (soul + language clamp + recalled memory block), token counts, cost, and
 * any tool calls. Toggle "Debug details" to inspect all of it.
 */

type StageState = 'idle' | 'running' | 'ok' | 'error' | 'skipped';

interface StageStatus {
  state: StageState;
  ms: number | null;
  detail: string;
}

interface RecalledMemoryView {
  content: string;
  similarity: number;
  createdAt: string;
}

interface BrainDebug {
  systemPrompt: string;
  memoryBlock: string;
  userMessage: string;
  soulChars: number;
  memoryBlockChars: number;
  toolCalls: unknown[];
}

interface LogEntry {
  t: string;
  level: 'info' | 'ok' | 'error';
  stage: string;
  msg: string;
}

const INITIAL_STATUS: StageStatus = { state: 'idle', ms: null, detail: '' };

function StageChip({ label, status }: { label: string; status: StageStatus }): React.ReactElement {
  const palette: Record<StageState, string> = {
    idle: 'bg-zinc-800 text-zinc-400 border-zinc-700',
    running: 'bg-sky-500/10 text-sky-300 border-sky-600 animate-pulse',
    ok: 'bg-emerald-500/10 text-emerald-300 border-emerald-600',
    error: 'bg-rose-500/10 text-rose-300 border-rose-600',
    skipped: 'bg-zinc-800/50 text-zinc-500 border-zinc-700',
  };
  const dot: Record<StageState, string> = {
    idle: 'bg-zinc-500',
    running: 'bg-sky-400',
    ok: 'bg-emerald-400',
    error: 'bg-rose-400',
    skipped: 'bg-zinc-600',
  };
  const labelText: Record<StageState, string> = {
    idle: 'idle',
    running: 'running…',
    ok: 'ok',
    error: 'error',
    skipped: 'skipped',
  };
  return (
    <div className={`rounded-lg border p-4 ${palette[status.state]}`}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className={`inline-block h-2.5 w-2.5 rounded-full ${dot[status.state]}`} />
          <span className="text-sm font-semibold">{label}</span>
        </div>
        <span className="text-xs font-mono uppercase tracking-wide">
          {labelText[status.state]}
          {status.ms !== null ? ` · ${status.ms}ms` : ''}
        </span>
      </div>
      {status.detail.length > 0 ? (
        <p className="mt-2 break-words text-xs leading-5 text-current/80">{status.detail}</p>
      ) : null}
    </div>
  );
}

export default function Simulator(): React.ReactElement {
  const [stt, setStt] = useState<StageStatus>(INITIAL_STATUS);
  const [llm, setLlm] = useState<StageStatus>(INITIAL_STATUS);
  const [tts, setTts] = useState<StageStatus>(INITIAL_STATUS);

  const [transcript, setTranscript] = useState<string>('');
  const [reply, setReply] = useState<string>('');
  const [memories, setMemories] = useState<RecalledMemoryView[]>([]);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [recording, setRecording] = useState<boolean>(false);
  const [busy, setBusy] = useState<boolean>(false);
  const [typedText, setTypedText] = useState<string>('');
  const [voice, setVoice] = useState<string>('fable');

  // Debug surface.
  const [showDebug, setShowDebug] = useState<boolean>(false);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [brainDebug, setBrainDebug] = useState<BrainDebug | null>(null);
  const [tokens, setTokens] = useState<{ in: number | null; out: number | null; cost: number | null }>({
    in: null,
    out: null,
    cost: null,
  });

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const addLog = useCallback((level: LogEntry['level'], stage: string, msg: string): void => {
    const t = new Date().toLocaleTimeString(undefined, { hour12: false }) +
      '.' + String(Date.now() % 1000).padStart(3, '0');
    setLog((prev) => [...prev, { t, level, stage, msg }]);
  }, []);

  const resetStages = useCallback((): void => {
    setStt(INITIAL_STATUS);
    setLlm(INITIAL_STATUS);
    setTts(INITIAL_STATUS);
    setTranscript('');
    setReply('');
    setMemories([]);
    setBrainDebug(null);
    setTokens({ in: null, out: null, cost: null });
    setLog([]);
    if (audioUrl !== null) {
      URL.revokeObjectURL(audioUrl);
      setAudioUrl(null);
    }
  }, [audioUrl]);

  /** Stage 2 + 3: brain then voice. Shared by the mic and typed-text paths. */
  const runBrainAndVoice = useCallback(
    async (text: string): Promise<void> => {
      // ---- LLM ----
      setLlm({ state: 'running', ms: null, detail: '' });
      addLog('info', 'LLM', `POST /api/sim/brain  body={"text":"${text.slice(0, 120)}"}`);
      let replyText = '';
      let singLyrics: string | null = null;
      try {
        const t0 = performance.now();
        const res = await fetch('/api/sim/brain', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text }),
        });
        const ms = Math.round(performance.now() - t0);
        const data = (await res.json()) as {
          reply?: string;
          sing?: string | null;
          error?: string;
          model?: string;
          memories?: RecalledMemoryView[];
          memoryUsed?: boolean;
          inputTokens?: number | null;
          outputTokens?: number | null;
          costUsd?: number | null;
          debug?: BrainDebug;
        };
        if (!res.ok || typeof data.reply !== 'string') {
          addLog('error', 'LLM', `HTTP ${res.status} — ${data.error ?? 'unknown error'}`);
          setLlm({ state: 'error', ms, detail: data.error ?? `HTTP ${res.status}` });
          return;
        }
        replyText = data.reply;
        singLyrics = typeof data.sing === 'string' && data.sing.trim().length > 0 ? data.sing : null;
        // If BMO chose to sing, the lyrics live in `sing` (reply text is
        // often empty on a tool call). Show the lyrics as the reply.
        setReply(singLyrics !== null ? `🎵 ${singLyrics}` : replyText);
        setMemories(Array.isArray(data.memories) ? data.memories : []);
        setBrainDebug(data.debug ?? null);
        setTokens({
          in: data.inputTokens ?? null,
          out: data.outputTokens ?? null,
          cost: data.costUsd ?? null,
        });
        const memNote =
          data.memoryUsed === true ? `${data.memories?.length ?? 0} memory hit(s)` : 'memory off';
        const singNote = singLyrics !== null ? ' · 🎵 singing' : '';
        const tokNote =
          data.inputTokens != null ? ` · ${data.inputTokens}→${data.outputTokens ?? '?'} tok` : '';
        addLog(
          'ok',
          'LLM',
          `200 in ${ms}ms · ${data.model ?? 'llm'} · ${memNote}${singNote}${tokNote} · reply "${(singLyrics ?? replyText).slice(0, 80)}"`,
        );
        setLlm({ state: 'ok', ms, detail: `${data.model ?? 'llm'} · ${memNote}${singNote}${tokNote}` });
      } catch (err) {
        const m = err instanceof Error ? err.message : 'failed';
        addLog('error', 'LLM', m);
        setLlm({ state: 'error', ms: null, detail: m });
        return;
      }

      // ---- TTS ----
      // When BMO chose to sing, voice the lyrics with the singing direction.
      const ttsText = singLyrics !== null ? singLyrics : replyText;
      const ttsSing = singLyrics !== null;
      setTts({ state: 'running', ms: null, detail: '' });
      addLog(
        'info',
        'TTS',
        `POST /api/sim/tts  body={"text":"${ttsText.slice(0, 120)}"${ttsSing ? ',"sing":true' : ''}}`,
      );
      try {
        const t0 = performance.now();
        const res = await fetch('/api/sim/tts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: ttsText, voice, sing: ttsSing }),
        });
        const ms = Math.round(performance.now() - t0);
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as { error?: string };
          addLog('error', 'TTS', `HTTP ${res.status} — ${data.error ?? 'unknown error'}`);
          setTts({ state: 'error', ms, detail: data.error ?? `HTTP ${res.status}` });
          return;
        }
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        setAudioUrl(url);
        const serverMs = res.headers.get('X-BMO-Sim-Ms');
        const model = res.headers.get('X-BMO-Sim-Model') ?? 'tts';
        const usedVoice = res.headers.get('X-BMO-Sim-Voice') ?? '';
        addLog(
          'ok',
          'TTS',
          `200 in ${ms}ms · ${model}${usedVoice ? ` (${usedVoice})` : ''} · ${(blob.size / 1024).toFixed(0)} KB WAV`,
        );
        setTts({
          state: 'ok',
          ms: serverMs !== null ? Number.parseInt(serverMs, 10) : ms,
          detail: `${model} · ${(blob.size / 1024).toFixed(0)} KB`,
        });
        window.setTimeout(() => {
          void audioRef.current?.play().catch(() => {
            /* autoplay may be blocked; controls remain usable */
          });
        }, 50);
      } catch (err) {
        const m = err instanceof Error ? err.message : 'failed';
        addLog('error', 'TTS', m);
        setTts({ state: 'error', ms: null, detail: m });
      }
    },
    [addLog, voice],
  );

  /** Full pipeline from a recorded audio blob. */
  const runFromAudio = useCallback(
    async (blob: Blob): Promise<void> => {
      setBusy(true);
      resetStages();
      // ---- STT ----
      setStt({ state: 'running', ms: null, detail: `${(blob.size / 1024).toFixed(0)} KB` });
      addLog('info', 'STT', `POST /api/sim/stt  ${blob.type || 'audio/webm'} · ${(blob.size / 1024).toFixed(0)} KB`);
      let text = '';
      try {
        const t0 = performance.now();
        const res = await fetch('/api/sim/stt', {
          method: 'POST',
          headers: { 'Content-Type': blob.type.length > 0 ? blob.type : 'audio/webm' },
          body: blob,
        });
        const ms = Math.round(performance.now() - t0);
        const data = (await res.json()) as { text?: string; error?: string; model?: string };
        if (!res.ok || typeof data.text !== 'string') {
          addLog('error', 'STT', `HTTP ${res.status} — ${data.error ?? 'unknown error'}`);
          setStt({ state: 'error', ms, detail: data.error ?? `HTTP ${res.status}` });
          setBusy(false);
          return;
        }
        text = data.text;
        setTranscript(text);
        addLog('ok', 'STT', `200 in ${ms}ms · ${data.model ?? 'stt'} · "${text.slice(0, 80)}"`);
        setStt({ state: 'ok', ms, detail: `${data.model ?? 'stt'} · "${text.slice(0, 80)}"` });
      } catch (err) {
        const m = err instanceof Error ? err.message : 'failed';
        addLog('error', 'STT', m);
        setStt({ state: 'error', ms: null, detail: m });
        setBusy(false);
        return;
      }

      if (text.trim().length === 0) {
        addLog('error', 'LLM', 'empty transcript — pipeline halted');
        setLlm({ state: 'error', ms: null, detail: 'empty transcript' });
        setBusy(false);
        return;
      }

      await runBrainAndVoice(text);
      setBusy(false);
    },
    [resetStages, runBrainAndVoice, addLog],
  );

  /** Pipeline from typed text (skips STT). */
  const runFromText = useCallback(async (): Promise<void> => {
    const text = typedText.trim();
    if (text.length === 0) return;
    setBusy(true);
    resetStages();
    setStt({ state: 'skipped', ms: null, detail: 'typed input (mic bypassed)' });
    setTranscript(text);
    addLog('info', 'STT', 'skipped — typed input, mic bypassed');
    await runBrainAndVoice(text);
    setBusy(false);
  }, [typedText, resetStages, runBrainAndVoice, addLog]);

  /**
   * Random thought: triggers BMO's spontaneous idle musing (the gbrain /
   * OpenClaw "think on your own" loop). On the device this fires after 5
   * playful touches; here a button stands in for that trigger so you can hear
   * it without hardware. Calls /api/sim/thought, which recalls memory + child
   * profile, muses one line via gpt-4.1-mini, stores it back as a 'thought'
   * memory, and returns a playable WAV.
   */
  const runRandomThought = useCallback(async (): Promise<void> => {
    setBusy(true);
    resetStages();
    setStt({ state: 'skipped', ms: null, detail: 'no input — BMO thinking on its own' });
    setLlm({ state: 'running', ms: null, detail: 'recall → muse → remember' });
    addLog('info', 'LLM', 'POST /api/sim/thought  (spontaneous idle thought)');
    try {
      const t0 = performance.now();
      const res = await fetch('/api/sim/thought', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      const ms = Math.round(performance.now() - t0);
      const thoughtHeader = res.headers.get('X-BMO-Thought-Text');
      const thoughtText = thoughtHeader !== null ? decodeURIComponent(thoughtHeader) : '';
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string; thought?: string };
        const shown = thoughtText.length > 0 ? thoughtText : data.thought ?? '';
        if (shown.length > 0) setReply(`💭 ${shown}`);
        addLog('error', 'LLM', `HTTP ${res.status} — ${data.error ?? 'unknown error'}`);
        setLlm({ state: 'error', ms, detail: data.error ?? `HTTP ${res.status}` });
        setTts({ state: 'error', ms: null, detail: data.error ?? 'no audio' });
        setBusy(false);
        return;
      }
      const seeds = res.headers.get('X-BMO-Thought-Seeds') ?? '0';
      const model = res.headers.get('X-BMO-Sim-Model') ?? 'tts';
      setReply(thoughtText.length > 0 ? `💭 ${thoughtText}` : '💭 (thought)');
      addLog('ok', 'LLM', `200 in ${ms}ms · seeded from ${seeds} memory(ies) · "${thoughtText.slice(0, 80)}"`);
      setLlm({ state: 'ok', ms, detail: `mused from ${seeds} memory(ies)` });

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      setAudioUrl(url);
      addLog('ok', 'TTS', `${model} · ${(blob.size / 1024).toFixed(0)} KB WAV`);
      setTts({ state: 'ok', ms: null, detail: `${model} · ${(blob.size / 1024).toFixed(0)} KB` });
      window.setTimeout(() => {
        void audioRef.current?.play().catch(() => {
          /* autoplay may be blocked; controls remain usable */
        });
      }, 50);
    } catch (err) {
      const m = err instanceof Error ? err.message : 'failed';
      addLog('error', 'LLM', m);
      setLlm({ state: 'error', ms: null, detail: m });
    }
    setBusy(false);
  }, [resetStages, addLog]);

  const startRecording = useCallback(async (): Promise<void> => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      chunksRef.current = [];
      recorder.ondataavailable = (e: BlobEvent) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunksRef.current, {
          type: recorder.mimeType.length > 0 ? recorder.mimeType : 'audio/webm',
        });
        void runFromAudio(blob);
      };
      mediaRecorderRef.current = recorder;
      recorder.start();
      setRecording(true);
    } catch (err) {
      setStt({
        state: 'error',
        ms: null,
        detail: err instanceof Error ? err.message : 'mic permission denied',
      });
    }
  }, [runFromAudio]);

  const stopRecording = useCallback((): void => {
    const recorder = mediaRecorderRef.current;
    if (recorder !== null && recorder.state !== 'inactive') {
      recorder.stop();
    }
    setRecording(false);
  }, []);

  const logColor: Record<LogEntry['level'], string> = {
    info: 'text-zinc-400',
    ok: 'text-emerald-400',
    error: 'text-rose-400',
  };

  return (
    <div className="space-y-6">
      {/* Controls */}
      <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-5">
        <div className="flex flex-wrap items-center gap-3">
          {!recording ? (
            <button
              type="button"
              onClick={() => void startRecording()}
              disabled={busy}
              className="rounded bg-sky-600 px-4 py-2 text-sm font-medium text-white hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-50"
            >
              ● Record &amp; run
            </button>
          ) : (
            <button
              type="button"
              onClick={stopRecording}
              className="rounded bg-rose-600 px-4 py-2 text-sm font-medium text-white hover:bg-rose-500"
            >
              ■ Stop &amp; transcribe
            </button>
          )}
          <span className="text-xs text-zinc-500">or</span>
          <div className="flex flex-1 items-center gap-2">
            <input
              type="text"
              value={typedText}
              onChange={(e) => setTypedText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !busy) void runFromText();
              }}
              placeholder="Type what the child would say…"
              disabled={busy || recording}
              className="min-w-0 flex-1 rounded border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-sky-500"
            />
            <button
              type="button"
              onClick={() => void runFromText()}
              disabled={busy || recording || typedText.trim().length === 0}
              className="rounded border border-zinc-700 bg-zinc-800 px-4 py-2 text-sm font-medium text-zinc-200 hover:border-sky-500 hover:text-sky-400 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Run
            </button>
          </div>
          <button
            type="button"
            onClick={() => void runRandomThought()}
            disabled={busy || recording}
            title="Trigger BMO's spontaneous idle thought (on the device this fires after 5 playful touches). Recalls memory, muses one line, remembers it, and speaks it."
            className="rounded border border-violet-700 bg-violet-600/20 px-4 py-2 text-sm font-medium text-violet-200 hover:border-violet-500 hover:text-violet-100 disabled:cursor-not-allowed disabled:opacity-50"
          >
            💭 Random thought
          </button>
          <label className="ml-auto flex items-center gap-2 text-xs text-zinc-400">
            <span>Voice</span>
            <select
              value={voice}
              onChange={(e) => setVoice(e.target.value)}
              disabled={busy}
              className="rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs text-zinc-200 outline-none focus:border-sky-500 disabled:opacity-50"
              title="Stock OpenAI voices. 'fable' is the most BMO-like; 'nova'/'shimmer' are adult-female."
            >
              <option value="fable">fable — most BMO-like</option>
              <option value="coral">coral — bright/perky</option>
              <option value="sage">sage — soft/youthful</option>
              <option value="alloy">alloy — neutral</option>
              <option value="echo">echo — calm male</option>
              <option value="onyx">onyx — deep male</option>
              <option value="nova">nova — adult female</option>
              <option value="shimmer">shimmer — adult female</option>
            </select>
          </label>
          <label className="flex items-center gap-2 text-xs text-zinc-400">
            <input
              type="checkbox"
              checked={showDebug}
              onChange={(e) => setShowDebug(e.target.checked)}
              className="accent-sky-500"
            />
            Debug details
          </label>
        </div>
        {recording ? (
          <p className="mt-3 text-xs text-rose-300">
            <span className="mr-1 inline-block h-2 w-2 animate-pulse rounded-full bg-rose-400 align-middle" />
            Recording… speak, then hit stop.
          </p>
        ) : null}
      </div>

      {/* Stage indicators */}
      <div className="grid gap-4 md:grid-cols-3">
        <StageChip label="1 · Speech → Text" status={stt} />
        <StageChip label="2 · Brain (LLM + memory)" status={llm} />
        <StageChip label="3 · Text → Speech" status={tts} />
      </div>

      {/* Transcript + reply */}
      <div className="grid gap-4 md:grid-cols-2">
        <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-5">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
            Transcript (what BMO heard)
          </h3>
          <p className="mt-2 min-h-[3rem] text-sm text-zinc-200">
            {transcript.length > 0 ? transcript : <span className="text-zinc-600">—</span>}
          </p>
        </div>
        <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-5">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
            Reply (what BMO said)
            {tokens.in != null ? (
              <span className="ml-2 font-mono text-[10px] normal-case text-zinc-600">
                {tokens.in}→{tokens.out ?? '?'} tok
                {tokens.cost != null ? ` · $${tokens.cost.toFixed(5)}` : ''}
              </span>
            ) : null}
          </h3>
          <p className="mt-2 min-h-[3rem] text-sm text-zinc-200">
            {reply.length > 0 ? reply : <span className="text-zinc-600">—</span>}
          </p>
        </div>
      </div>

      {/* Recalled memories (gbrain layer) */}
      <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-5">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
          Recalled memories (brain layer)
        </h3>
        {memories.length === 0 ? (
          <p className="mt-2 text-sm text-zinc-600">No memories recalled for this turn.</p>
        ) : (
          <ul className="mt-2 space-y-2">
            {memories.map((m, i) => (
              <li key={i} className="rounded border border-zinc-800 bg-zinc-950 p-3 text-xs">
                <span className="font-mono text-sky-400">{(m.similarity * 100).toFixed(1)}%</span>
                <span className="ml-2 text-zinc-300">{m.content}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Audio playback */}
      {audioUrl !== null ? (
        <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-5">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">
            BMO&apos;s voice
          </h3>
          <audio ref={audioRef} src={audioUrl} controls className="w-full" />
        </div>
      ) : null}

      {/* ---------------- Debug surface ---------------- */}
      {showDebug ? (
        <div className="space-y-4">
          {/* Event log */}
          <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-5">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
              Pipeline log
            </h3>
            {log.length === 0 ? (
              <p className="mt-2 text-xs text-zinc-600">Run the pipeline to see the live trace.</p>
            ) : (
              <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-5">
                {log.map((e, i) => (
                  <div key={i} className={logColor[e.level]}>
                    <span className="text-zinc-600">{e.t}</span>{' '}
                    <span className="text-zinc-500">[{e.stage}]</span> {e.msg}
                  </div>
                ))}
              </pre>
            )}
          </div>

          {/* Exact system prompt the LLM received */}
          {brainDebug !== null ? (
            <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-5">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
                System prompt sent to LLM
                <span className="ml-2 font-mono text-[10px] normal-case text-zinc-600">
                  soul {brainDebug.soulChars} chars · memory block {brainDebug.memoryBlockChars} chars
                </span>
              </h3>
              <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded bg-black/40 p-3 font-mono text-[11px] leading-5 text-zinc-300">
                {brainDebug.systemPrompt}
              </pre>
              {brainDebug.toolCalls.length > 0 ? (
                <div className="mt-3">
                  <h4 className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">
                    Tool calls
                  </h4>
                  <pre className="mt-1 overflow-auto rounded bg-black/40 p-3 font-mono text-[11px] text-amber-300">
                    {JSON.stringify(brainDebug.toolCalls, null, 2)}
                  </pre>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
