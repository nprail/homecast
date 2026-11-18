import { describe, expect, it } from 'vitest';
import vectors from '../vectors/show-notes.json';
import { parseShowNotes } from './showNotes.js';

describe('show notes vectors', () => {
  for (const c of vectors.cases) {
    it(c.name, () => {
      expect(parseShowNotes(c.html, c.durationMs)).toEqual(c.expected);
    });
  }
});
