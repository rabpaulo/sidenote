// Explicitly invoked diagnostic: uses the existing account's included quota.
// Never records meeting content or enables API keys/extra credits.
import { performance } from 'node:perf_hooks';
import { prepareAgentSession, runUnifiedAgent, closeAgentSession } from '../server/agent-bridge.js';
import { buildCopilotPrompt } from '../server/gemini-copilot.js';

const provider = process.env.LATENCY_PROVIDER || 'antigravity';
const model = process.env.LATENCY_MODEL || ({ codex: 'gpt-5.6-luna', claude: 'claude-haiku-5-5' }[provider] || 'gemini-3.8-flash');
const reasoningEffort = 'low';
const options = { provider, model, reasoningEffort, fastMode: true, cwd: process.cwd() };
const prompt = buildCopilotPrompt('Como você investigaria uma API lenta sem interromper o serviço em produção?', 'general', true);
let conversationId;
try {
  const preparing = performance.now();
  ({ conversationId } = await prepareAgentSession(options));
  console.log(JSON.stringify({ stage: 'ready', ms: Math.round(performance.now() - preparing), provider, model }));
  for (let run = 1; run <= Number(process.env.LATENCY_RUNS || 2); run++) {
    const started = performance.now();
    let firstTextMs = null;
    let characters = 0;
    const eventCounts = {};
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { handle.kill(); reject(new Error('Response exceeded 45 seconds')); }, 45000);
      const handle = runUnifiedAgent({ ...options, conversationId, prompt,
        onMessage(data) {
          const id = data.conversation_id || data.result?.conversation_id;
          if (id) conversationId = id;
          const step = data.step_update;
          const type = step?.step_type || step?.type || data.event;
          eventCounts[type] = (eventCounts[type] || 0) + 1;
          const text = step?.text_delta || step?.content || step?.text || data.result?.response;
          if (text) {
            firstTextMs ??= Math.round(performance.now() - started);
            if (data.result?.response) characters = text.length;
            else characters += text.length;
          }
        },
        onError(error) { clearTimeout(timer); reject(error); },
        onClose() { clearTimeout(timer); resolve(); },
      });
    });
    console.log(JSON.stringify({ stage: 'response', run, firstTextMs,
      totalMs: Math.round(performance.now() - started), eventCounts, characters }));
    if (firstTextMs === null || firstTextMs > 3000) process.exitCode = 1;
  }
} finally { closeAgentSession(); }
