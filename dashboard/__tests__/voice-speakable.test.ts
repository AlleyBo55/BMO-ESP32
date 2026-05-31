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

describe('toSpeakableText() — strips web-search citations from spoken text', () => {
  test('markdown links collapse to their label', () => {
    expect(
      toSpeakableText('Cuacanya cerah [sumber](https://example.com/cuaca) hari ini.'),
    ).toBe('Cuacanya cerah sumber hari ini.');
  });

  test('bare URLs are removed', () => {
    expect(toSpeakableText('Lihat https://example.com/abc ya.')).toBe('Lihat ya.');
    expect(toSpeakableText('Cek www.example.com sekarang')).toBe('Cek sekarang');
  });

  test('bracketed numeric citations are removed', () => {
    expect(toSpeakableText('Itu benar [1] dan juga [2, 3] tentunya.')).toBe(
      'Itu benar dan juga tentunya.',
    );
  });

  test('citation strip still applies the Bimo rewrite', () => {
    expect(
      toSpeakableText('Kata BMO, cuacanya cerah [1] (https://x.com).'),
    ).toBe('Kata Bimo, cuacanya cerah.');
  });
});
