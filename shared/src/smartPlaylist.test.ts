import { describe, expect, it } from 'vitest';
import vectors from '../vectors/smart-playlist.json';
import { evaluateSmartPlaylist, resolveSpeed, smartPlaylistDefinitionSchema, type EpisodeView } from './smartPlaylist.js';

describe('smart playlist vectors', () => {
  for (const c of vectors.cases) {
    it(c.name, () => {
      const def = smartPlaylistDefinitionSchema.parse(c.definition);
      expect(evaluateSmartPlaylist(def, vectors.episodes as EpisodeView[], vectors.now)).toEqual(c.expected);
    });
  }
});

describe('resolveSpeed', () => {
  it('prefers podcast override', () => {
    expect(resolveSpeed({ defaultSpeed: 1.2, podcastSpeeds: { a: 2 } }, 'a')).toBe(2);
    expect(resolveSpeed({ defaultSpeed: 1.2, podcastSpeeds: { a: 2 } }, 'b')).toBe(1.2);
  });
});
