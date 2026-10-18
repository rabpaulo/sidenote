#!/usr/bin/env node
// Offline stand-in for `claude -p --input-format stream-json`. No credentials, network or model usage.
const readline = require('node:readline');
const args = process.argv.slice(2);
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const sessionId = flag('--resume') || flag('--session-id') || `claude-test-${process.pid}`;
const emit = (message) => process.stdout.write(JSON.stringify({ ...message, session_id: sessionId }) + '\n');
let initialized = false;
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const content = JSON.parse(line).message.content;
  // Image blocks are echoed as markers so tests can check what reached the CLI.
  const prompt = Array.isArray(content)
    ? content.map((block) => (block.type === 'text' ? block.text : `[${block.type}:${block.source.media_type}]`)).join(' ')
    : content;
  if (!initialized) {
    initialized = true;
    emit({ type: 'system', subtype: 'init', model: flag('--model') });
  }
  if (prompt === '__wait__') return;
  setTimeout(() => {
    if (prompt === '__exit__') return process.exit(1);
    if (prompt === '__error__') {
      return emit({ type: 'result', subtype: 'success', is_error: true, result: 'Falha simulada' });
    }
    emit({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: prompt } } });
    emit({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: prompt }] } });
    emit({ type: 'result', subtype: 'success', is_error: false, result: prompt,
      usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 0 } });
  }, 10);
});
