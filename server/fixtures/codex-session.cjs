#!/usr/bin/env node
// Offline app-server stand-in. No credentials, network or model usage.
const readline = require('node:readline');
const emit = (message) => process.stdout.write(JSON.stringify(message) + '\n');
let threadId;
let turns = 0;
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const { id, method, params } = JSON.parse(line);
  if (method === 'initialize') {
    setTimeout(() => emit({ id, result: { userAgent: 'fixture' } }), 150);
  } else if (method === 'thread/start' || method === 'thread/resume') {
    threadId = params.threadId || `codex-test-${process.pid}`;
    emit({ id, result: { thread: { id: threadId } } });
  } else if (method === 'turn/start') {
    // Image inputs are echoed as markers so tests can check what reached the server.
    const prompt = params.input.map((item) => (item.type === 'text' ? item.text : `[${item.type}:${item.url.split(';')[0]}]`)).join(' ');
    if (prompt === '__rpc_error__') return emit({ id, error: { message: 'Falha RPC simulada' } });
    const turn = { id: `turn-${++turns}`, status: 'inProgress' };
    emit({ id, result: { turn } });
    emit({ method: 'turn/started', params: { threadId, turn } });
    if (prompt === '__wait__') return;
    setTimeout(() => {
      if (prompt === '__exit__') return process.exit(1);
      if (prompt === '__error__') return emit({ method: 'turn/completed', params: {
        threadId, turn: { ...turn, status: 'failed', error: { message: 'Falha simulada' } },
      } });
      const item = { id: `item-${turns}`, type: 'agentMessage', text: prompt };
      emit({ method: 'item/agentMessage/delta', params: { threadId, turnId: turn.id, itemId: item.id, delta: prompt } });
      emit({ method: 'item/completed', params: { threadId, turnId: turn.id, item } });
      emit({ method: 'thread/tokenUsage/updated', params: { threadId, tokenUsage: { last: {
        inputTokens: 10, outputTokens: 2, cachedInputTokens: 0, totalTokens: 12,
      } } } });
      emit({ method: 'turn/completed', params: { threadId, turn: { ...turn, status: 'completed' } } });
    }, 10);
  }
});
