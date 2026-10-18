import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_TEXT_ZOOM, MIN_TEXT_ZOOM, nextTextZoom, textZoomAction } from './useTextZoom.js';

test('zoom keys need Ctrl or Cmd and cover both keyboard rows and the numpad', () => {
  assert.equal(textZoomAction({ key: '=', code: 'Equal', ctrlKey: true }), 'in');
  assert.equal(textZoomAction({ key: '+', code: 'Equal', ctrlKey: true }), 'in');
  assert.equal(textZoomAction({ key: '+', code: 'NumpadAdd', metaKey: true }), 'in');
  assert.equal(textZoomAction({ key: '-', code: 'Minus', ctrlKey: true }), 'out');
  assert.equal(textZoomAction({ key: '-', code: 'NumpadSubtract', ctrlKey: true }), 'out');
  assert.equal(textZoomAction({ key: '0', code: 'Digit0', ctrlKey: true }), 'reset');
  assert.equal(textZoomAction({ key: '=', code: 'Equal' }), null, 'plain typing must not zoom');
  assert.equal(textZoomAction({ key: '-', code: 'Minus', ctrlKey: true, altKey: true }), null);
});

test('zoom steps by 10% within its limits and resets to 100%', () => {
  assert.equal(nextTextZoom(1, 'in'), 1.1);
  assert.equal(nextTextZoom(1.1, 'out'), 1);
  assert.equal(nextTextZoom(MAX_TEXT_ZOOM, 'in'), MAX_TEXT_ZOOM);
  assert.equal(nextTextZoom(MIN_TEXT_ZOOM, 'out'), MIN_TEXT_ZOOM);
  assert.equal(nextTextZoom(1.7, 'reset'), 1);
});
