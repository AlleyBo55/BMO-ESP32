/**
 * Tests for the WAV header builder used by the streaming TTS path.
 *
 * The dashboard wraps PCM16 streams from OpenRouter in a canonical RIFF/WAVE
 * header so the firmware (and `curl --output reply.wav`) can play the result.
 * These tests verify byte layout against the RIFF spec for several common
 * sample rates and channel counts.
 */

import { describe, expect, test } from 'vitest';

function readUInt32LE(buf: Buffer, offset: number): number {
  return buf.readUInt32LE(offset);
}

function readUInt16LE(buf: Buffer, offset: number): number {
  return buf.readUInt16LE(offset);
}

function readAscii(buf: Buffer, offset: number, length: number): string {
  return buf.subarray(offset, offset + length).toString('ascii');
}

describe('buildWavHeader', () => {
  test.each([
    { sampleRate: 24000, channels: 1, bitsPerSample: 16, pcmByteLength: 48000 },
    { sampleRate: 16000, channels: 1, bitsPerSample: 16, pcmByteLength: 32000 },
    { sampleRate: 44100, channels: 2, bitsPerSample: 16, pcmByteLength: 176400 },
  ])(
    'matches RIFF spec for $sampleRate Hz / $channels ch / $pcmByteLength data bytes',
    async ({ sampleRate, channels, bitsPerSample, pcmByteLength }) => {
      const mod = await import('@/lib/wav');
      const header: Buffer = mod.buildWavHeader({
        sampleRate,
        channels,
        bitsPerSample,
        pcmByteLength,
      });

      expect(header.byteLength).toBe(44);
      expect(readAscii(header, 0, 4)).toBe('RIFF');
      expect(readUInt32LE(header, 4)).toBe(36 + pcmByteLength);
      expect(readAscii(header, 8, 4)).toBe('WAVE');
      expect(readAscii(header, 12, 4)).toBe('fmt ');
      expect(readUInt32LE(header, 16)).toBe(16); // fmt chunk size
      expect(readUInt16LE(header, 20)).toBe(1); // PCM
      expect(readUInt16LE(header, 22)).toBe(channels);
      expect(readUInt32LE(header, 24)).toBe(sampleRate);
      expect(readUInt32LE(header, 28)).toBe(
        sampleRate * channels * (bitsPerSample / 8),
      );
      expect(readUInt16LE(header, 32)).toBe(channels * (bitsPerSample / 8));
      expect(readUInt16LE(header, 34)).toBe(bitsPerSample);
      expect(readAscii(header, 36, 4)).toBe('data');
      expect(readUInt32LE(header, 40)).toBe(pcmByteLength);
    },
  );

  test('streaming sentinel: pcmByteLength=0xFFFFFFFF writes the same sentinel as fileSize', async () => {
    const mod = await import('@/lib/wav');
    const header: Buffer = mod.buildWavHeader({
      sampleRate: 24000,
      channels: 1,
      bitsPerSample: 16,
      pcmByteLength: 0xffffffff,
    });
    expect(readUInt32LE(header, 4)).toBe(0xffffffff);
    expect(readUInt32LE(header, 40)).toBe(0xffffffff);
  });
});

describe('wrapPcm16AsWav', () => {
  test('round trips: prepended header + body length matches', async () => {
    const mod = await import('@/lib/wav');
    const body = Buffer.alloc(200);
    for (let i = 0; i < body.length; i += 1) body[i] = i & 0xff;
    const wrapped: Buffer = mod.wrapPcm16AsWav(body, 24000);
    expect(wrapped.byteLength).toBe(44 + body.byteLength);
    expect(readAscii(wrapped, 0, 4)).toBe('RIFF');
    expect(readUInt32LE(wrapped, 40)).toBe(body.byteLength);
    expect(wrapped.subarray(44).equals(body)).toBe(true);
  });
});
