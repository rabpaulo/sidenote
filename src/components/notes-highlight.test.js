import test from 'node:test';
import assert from 'node:assert/strict';
import { highlightSegments } from './notes-highlight.js';

test('splits the snippet at match ranges and skips bad ones', () => {
  assert.deepEqual(highlightSegments('a latência p99', [[11, 14], [2, 10], [5, 7], [12, 40]]), [
    { text: 'a ', match: false },
    { text: 'latência', match: true },
    { text: ' ', match: false },
    { text: 'p99', match: true },
  ]);
  assert.deepEqual(highlightSegments('sem destaque'), [{ text: 'sem destaque', match: false }]);
});
