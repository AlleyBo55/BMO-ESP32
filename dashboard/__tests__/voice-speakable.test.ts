import { describe, expect, test } from 'vitest';

import { toSpeakableText } from '@/lib/voice';

describe('toSpeakableText() — BMO -> Bimo for TTS pronunciation', () => {
  test('rewrites standalone BMO', () => {
    expect(toSpeakableText('Halo, aku BMO!')).toBe('Halo, aku Bimo!');
  });

  test('case-insensitive and mid-sentence', () => {
    expect(toSpeakableText('warna semangka bmo itu hijau')).toBe(
      'warna semangka Bimo itu hijau',
    );
  });

  test('handles B-M-O and B.M.O spellings', () => {
    expect(toSpeakableText('B-M-O dan B.M.O')).toBe('Bimo dan Bimo');
  });

  test('handles BeeMo / Bee-Mo variants', () => {
    expect(toSpeakableText('BeeMo dan Bee-Mo')).toBe('Bimo dan Bimo');
  });

  test('does not touch larger words containing the letters', () => {
    // "ambmox" should be untouched (no word boundary around BMO).
    expect(toSpeakableText('ambmox')).toBe('ambmox');
  });

  test('leaves ordinary text alone', () => {
    expect(toSpeakableText('Warna melon hijau muda.')).toBe(
      'Warna melon hijau muda.',
    );
  });
});
