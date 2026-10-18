import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_IMAGES, normalizeImages, promptWithImageFiles } from './agent-images.js';

test('only well-formed supported images are kept, up to the limit', () => {
  const ok = { mimeType: 'image/jpeg', data: 'AAAA', extra: true };
  const images = normalizeImages([ok, { mimeType: 'image/gif', data: 'AAAA' }, { mimeType: 'image/png', data: 'not base64!' },
    { mimeType: 'image/png', data: '' }, null, ...Array(MAX_IMAGES).fill(ok)]);
  assert.equal(images.length, MAX_IMAGES);
  assert.deepEqual(images[0], { mimeType: 'image/jpeg', data: 'AAAA' });
  assert.deepEqual(normalizeImages('x'), []);
});

test('prompts without image files are unchanged', () => {
  assert.equal(promptWithImageFiles('pergunta', []), 'pergunta');
  assert.match(promptWithImageFiles('pergunta', ['/tmp/a.jpg']), /- \/tmp\/a\.jpg\n\npergunta$/);
});
