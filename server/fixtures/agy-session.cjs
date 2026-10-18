#!/usr/bin/env node
// Offline stand-in for the documented CLI protocol; never contacts a provider.
const readline = require('node:readline');
const args = process.argv.slice(2);
const conversationId = args.includes('--conversation')
  ? args[args.indexOf('--conversation') + 1] : `test-${process.pid}`;
const emit = (event) => process.stdout.write(JSON.stringify(event) + '\n');
const input = args.includes('--input-format');
const codex = args.includes('--json');
const queued = [];
let ready = false;
let turns = 0;
function answer(prompt) {
  if (prompt === '__wait__') return;
  setTimeout(() => {
    if (prompt === '__error__') {
      emit({ event: 'result', result: { status: 'ERROR', error: 'Falha simulada' } });
      return;
    }
    if (prompt === '__exit__') { process.exit(1); return; }
    turns++;
    if (codex) {
      emit({ type: 'item.completed', item: { id: 'answer', type: 'agent_message', text: prompt } });
      emit({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 2 } });
      return;
    }
    emit({ event: 'step_update', step_update: { conversation_id: conversationId, text_delta: prompt } });
    emit({ event: 'result', result: { conversation_id: conversationId, status: 'SUCCESS', response: prompt,
      duration_seconds: turns * 100, usage: { input_tokens: turns * 10, output_tokens: turns * 2 } } });
    if (!input) process.exitCode = 0;
  }, 10);
}
if (input) {
  readline.createInterface({ input: process.stdin }).on('line', (line) => {
    const prompt = JSON.parse(line).message.content;
    if (ready) answer(prompt);
    else queued.push(prompt);
  });
}
setTimeout(() => {
  emit(codex ? { type: 'thread.started', thread_id: conversationId } : { event: 'init', conversation_id: conversationId });
  ready = true;
  if (input) queued.forEach(answer);
  else answer(codex ? args.at(-1) : args[args.indexOf('-p') + 1]);
}, 150);
