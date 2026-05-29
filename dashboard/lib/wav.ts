/**
 * 44-byte RIFF/WAVE header construction for PCM16 mono LE audio.
 *
 * The streaming TTS pipeline yields raw PCM16 samples from OpenRouter; the
 * firmware (and any audio decoder hit through `/api/voice/tts` or `/api/brain`)
 * expects either raw PCM with a documented Content-Type or a real WAV file.
 *
 * For finite-length payloads we set the data and file sizes to the actual
 * byte counts. For streaming responses we don't yet know the total length so
 * we fill in `0xFFFFFFFF` per the de-facto convention used by FFmpeg and most
 * tolerant decoders to mean "unknown / streamed" size.
 *
 * Layout (offsets in bytes, all multi-byte fields little-endian):
 *
 *   00  "RIFF"            (4 bytes ASCII)
 *   04  fileSize - 8       (uint32, = 36 + dataSize, or 0xFFFFFFFF when unknown)
 *   08  "WAVE"            (4 bytes ASCII)
 *   12  "fmt "            (4 bytes ASCII)
 *   16  fmtChunkSize=16   (uint32)
 *   20  audioFormat=1     (uint16, 1 = PCM)
 *   22  channels          (uint16)
 *   24  sampleRate        (uint32)
 *   28  byteRate          (uint32, = sampleRate * channels * bitsPerSample/8)
 *   32  blockAlign        (uint16, = channels * bitsPerSample/8)
 *   34  bitsPerSample     (uint16)
 *   36  "data"            (4 bytes ASCII)
 *   40  dataSize          (uint32, or 0xFFFFFFFF when unknown)
 */

/** Streaming sentinel: signals "unknown size" to tolerant decoders. */
const STREAMING_DATA_SIZE = 0xffffffff;

export interface BuildWavHeaderOptions {
  /**
   * Total payload byte count, or `0xFFFFFFFF` when the size is unknown
   * because the audio is being streamed.
   */
  pcmByteLength: number;
  sampleRate: number;
  /** Channel count. Defaults to 1 (mono). */
  channels?: number;
  /** Bits per sample. Defaults to 16. */
  bitsPerSample?: number;
}

/** Returns a 44-byte RIFF/WAVE header for the given PCM parameters. */
export function buildWavHeader(opts: BuildWavHeaderOptions): Buffer {
  const channels = opts.channels ?? 1;
  const bitsPerSample = opts.bitsPerSample ?? 16;
  const { sampleRate, pcmByteLength } = opts;

  const blockAlign = channels * (bitsPerSample / 8);
  const byteRate = sampleRate * blockAlign;

  // When the data size is the streaming sentinel, the total file size is also
  // unknown, so write the same sentinel into the RIFF chunk size field.
  const fileSizeMinus8 =
    pcmByteLength === STREAMING_DATA_SIZE ? STREAMING_DATA_SIZE : 36 + pcmByteLength;

  const buf = Buffer.alloc(44);
  buf.write('RIFF', 0, 4, 'ascii');
  buf.writeUInt32LE(fileSizeMinus8, 4);
  buf.write('WAVE', 8, 4, 'ascii');
  buf.write('fmt ', 12, 4, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(byteRate, 28);
  buf.writeUInt16LE(blockAlign, 32);
  buf.writeUInt16LE(bitsPerSample, 34);
  buf.write('data', 36, 4, 'ascii');
  buf.writeUInt32LE(pcmByteLength, 40);
  return buf;
}

/**
 * Wraps raw PCM16 mono LE bytes with a complete WAV header. Used when the
 * full payload is known up front (e.g. test fixtures, non-streaming returns).
 */
export function wrapPcm16AsWav(pcm: Buffer, sampleRate: number): Buffer {
  const header = buildWavHeader({
    pcmByteLength: pcm.byteLength,
    sampleRate,
    channels: 1,
    bitsPerSample: 16,
  });
  return Buffer.concat([header, pcm]);
}
