import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMath, parseAgentResponse, splitFences } from './agent-response.js';

test('groups code blocks separated by short headings into labelled tabs', () => {
  const blocks = parseAgentResponse([
    'Use um hash map: tempo $O(n)$ e espaço $O(n)$.',
    '',
    '#### Python',
    '```python',
    'def two_sum(nums, target): ...',
    '```',
    '',
    '#### Exemplo de uso',
    '```python',
    'print(two_sum([2, 7], 9))',
    '```',
    '**TypeScript:**',
    '```ts',
    'function twoSum() {}',
    '```',
  ].join('\n'));

  assert.equal(blocks.length, 2);
  assert.deepEqual(blocks[0], { type: 'markdown', text: 'Use um hash map: tempo `O(n)` e espaço `O(n)`.\n' });
  assert.equal(blocks[1].type, 'tabs');
  assert.deepEqual(blocks[1].tabs.map((tab) => [tab.label, tab.language]), [
    ['Python', 'python'],
    ['Exemplo de uso', 'python'],
    ['TypeScript', 'ts'],
  ]);
  assert.equal(blocks[1].tabs[1].code, 'print(two_sum([2, 7], 9))');
});

test('keeps a lone code block and long explanations between blocks untouched', () => {
  const explanation = 'Aqui eu explico em detalhe como o algoritmo percorre o array. '.repeat(6);
  const blocks = parseAgentResponse(`### Solução\n\`\`\`go\nfunc a() {}\n\`\`\`\n${explanation}\n\`\`\`go\nfunc b() {}\n\`\`\``);
  assert.deepEqual(blocks.map((block) => block.type), ['markdown', 'code', 'markdown', 'code']);
  assert.equal(blocks[0].text, '### Solução');
});

test('falls back to language names and keeps an unterminated block streaming', () => {
  const blocks = parseAgentResponse('```python\na = 1\n```\n```typescript\nconst a');
  assert.deepEqual(blocks[0].tabs.map((tab) => [tab.label, tab.closed]), [['Python', true], ['TypeScript', false]]);
  assert.equal(blocks[0].tabs[1].code, 'const a');
});

test('dedents fences nested in lists', () => {
  assert.deepEqual(splitFences('1. Passo\n   ```js\n   if (a) {\n     b();\n   }\n   ```')[1], {
    type: 'code', language: 'js', code: 'if (a) {\n  b();\n}', closed: true,
  });
});

test('turns inline TeX into inline code without touching currency', () => {
  assert.equal(normalizeMath('**$O(n \\log n)$** e $O(n^2)$'), '**`O(n log n)`** e `O(n²)`');
  assert.equal(normalizeMath('Entre R$5.000 e R$7.000, ou R$ 6.000'), 'Entre R$5.000 e R$7.000, ou R$ 6.000');
});
