import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCopilotPrompt, buildCopilotPromptParts } from './gemini-copilot.js';

test('the copilot prompt starts with what stays the same and ends with the speech', () => {
  const notes = [{ title: 'Pagamentos', heading: '', text: 'Latência p99 de 120 ms.' }];
  const first = buildCopilotPromptParts('Qual é a latência?', 'interview_coding', false, 'Dev pleno', [], notes);
  const second = buildCopilotPromptParts('E o throughput?', 'interview_coding', true, 'Dev pleno',
    [{ role: 'interlocutor', text: 'Qual é a latência?' }]);
  assert.equal(first.stable, second.stable, 'the cacheable start does not depend on the question');
  assert.match(first.stable, /Dev pleno/);
  assert.doesNotMatch(first.stable, /latência|Pagamentos/i);
  assert.match(first.dynamic, /Pagamentos/);
  assert.match(second.dynamic, /sugestão provisória/);
  assert.ok(first.dynamic.trimEnd().endsWith('"Qual é a latência?"'));
  assert.equal(buildCopilotPrompt('Oi', 'sales'), buildCopilotPromptParts('Oi', 'sales').stable + buildCopilotPromptParts('Oi', 'sales').dynamic);
});
