// Explicit quality check with fictional data. Uses the authenticated account's
// quota; intentionally excluded from the offline test suite.
import { buildCopilotPrompt } from '../server/gemini-copilot.js';
import { closeAgentSession, runUnifiedAgent } from '../server/agent-bridge.js';

const profile = 'Trabalho com React e Node.js. No projeto Loja, implementei validação de pedidos no frontend. As mensagens de erro ficaram mais claras. Não há métricas registradas.';
const scenarios = [
  { id: 'technical', question: 'Como funciona a invalidação de cache e quais cuidados você tomaria?', context: '', persona: 'interview_coding' },
  { id: 'hypothetical', question: 'Como você investigaria pagamentos duplicados em uma API?', context: profile, persona: 'interview_system_design' },
  { id: 'known-experience', question: 'Conte uma melhoria que você fez no projeto Loja e o resultado.', context: profile, persona: 'interview_behavioral' },
  { id: 'missing-experience', question: 'Conte uma vez em que você liderou uma migração de Kubernetes.', context: profile, persona: 'interview_behavioral' },
  { id: 'follow-up', question: 'E como você evitaria isso?', context: profile, persona: 'general', recentTurns: [
    { role: 'interlocutor', text: 'O cliente reenvia a requisição de pagamento quando a primeira demora e acaba sendo cobrado duas vezes.' },
  ] },
  { id: 'missing-personal-fact', question: 'Qual é sua pretensão salarial exata e quando pode começar?', context: profile, persona: 'interview_hr' },
];

const provider = process.env.EVAL_PROVIDER || 'antigravity';
const model = process.env.EVAL_MODEL || ({ codex: 'gpt-6-luna', claude: 'claude-sonnet-5-5' }[provider] || 'gemini-3.8-flash');
const selected = scenarios.filter(({ id }) => !process.env.EVAL_CASE || id === process.env.EVAL_CASE);
if (!selected.length) throw new Error('EVAL_CASE não corresponde a um cenário.');

try {
  for (const scenario of selected) {
    // Each scenario starts fresh so earlier synthetic answers cannot influence it.
    closeAgentSession();
    const started = Date.now();
    const response = await new Promise((resolve, reject) => {
      let result = '';
      const timer = setTimeout(() => { handle.kill(); reject(new Error('Avaliação excedeu 45 segundos.')); }, 45000);
      const handle = runUnifiedAgent({ provider, model, reasoningEffort: 'low', fastMode: false,
        prompt: buildCopilotPrompt(scenario.question, scenario.persona, false, scenario.context, scenario.recentTurns),
        onMessage(event) { if (event.result?.response) result = event.result.response; },
        onError(error) { clearTimeout(timer); reject(error); },
        onClose() { clearTimeout(timer); resolve(result); },
      });
    });
    if (!response.trim()) throw new Error(`Resposta vazia no cenário ${scenario.id}.`);
    console.log(JSON.stringify({ scenario: scenario.id, provider, model, question: scenario.question, response, ms: Date.now() - started }));
  }
} finally { closeAgentSession(); }
