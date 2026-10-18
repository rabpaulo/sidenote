import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';
import { defaultProfilePath } from './profile-store.js';
import { TOKEN_FILE } from './backend-auth.js';

// The running backend writes the token of its run next to the profile.
const token = process.env.INTERVIEWAI_TOKEN || fs.readFileSync(path.join(path.dirname(defaultProfilePath()), TOKEN_FILE), 'utf8').trim();
const ws = new WebSocket(`ws://127.0.0.1:3001?token=${encodeURIComponent(token)}`);

console.log('[Test Client] Connecting to ws://127.0.0.1:3001...');

ws.on('open', () => {
  console.log('[Test Client] Connected! Sending test voice prompt...');
  ws.send(
    JSON.stringify({
      type: 'voice_message',
      text: 'Responda apenas: Olá do Antigravity!',
      source: 'voice',
    })
  );
});

ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.type === 'agent_stream') {
    if (msg.data?.step_update?.text_delta) {
      process.stdout.write(msg.data.step_update.text_delta);
    }
    if (msg.data?.result) {
      console.log('\n[RESULT RECEIVED]:', msg.data.result.response);
    }
  }
  if (msg.type === 'agent_done') {
    console.log('[Test Client] Turn complete! Exit code:', msg.code);
    ws.close();
    process.exit(0);
  }
});

ws.on('error', (err) => {
  console.error('[Test Client] Error:', err);
  process.exit(1);
});
