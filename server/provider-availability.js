import readline from 'node:readline';
import { agentWorkspace, cliAvailable, killProcessTree, resolveCliBin, spawnCli } from './cli-process.js';
import { API_PROVIDERS, API_PROVIDER_IDS, chatModels } from '../shared/api-providers.js';
import { listApiModels } from './api-session.js';
import { opencodeEnv } from './opencode-session.js';

// Each check asks the CLI about the login and the account's models without sending
// a prompt, so it uses no model quota. Only a definite answer (not installed, logged
// out, model not listed) blocks a provider; a timeout or unexpected output leaves it
// usable as "unknown", so a network hiccup never stops the CLI from being prepared.
// API providers list the key's models the same way; a rejected key blocks them.
// `catalog` ({ id, name }) is the model list the client shows for providers whose
// models come from the account instead of src/config/models.js.
const CHECK_TIMEOUT_MS = 20000;
// Failed turns ask for a recheck; this keeps a burst of errors from spawning one each.
const RECHECK_INTERVAL_MS = 15000;

const NAMES = { antigravity: 'Antigravity', codex: 'Codex', claude: 'Claude Code', opencode: 'OpenCode' };
const BINS = { antigravity: 'agy', codex: 'codex', claude: 'claude', opencode: 'opencode' };

const unavailable = (reason) => ({ status: 'unavailable', reason });
const unknown = (reason) => ({ status: 'unknown', reason });
const LOGIN_HINT = /log ?in|sign ?in|auth|credential|unauthori[sz]ed/i;
const firstLine = (text) => text.split('\n').map((line) => line.trim()).find(Boolean)?.slice(0, 200) || '';

function run(bin, args, env = process.env) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let child;
    try {
      child = spawnCli(bin, args, { cwd: agentWorkspace(), stdio: ['ignore', 'pipe', 'pipe'], env });
    } catch (error) {
      resolve({ code: -1, stdout, stderr: error.message });
      return;
    }
    const timer = setTimeout(() => {
      killProcessTree(child);
      resolve({ code: -1, stdout, stderr, timedOut: true });
    }, CHECK_TIMEOUT_MS);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: error.message }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

async function checkAntigravity(bin) {
  const { code, stdout, stderr, timedOut } = await run(bin, ['models']);
  if (timedOut) return unknown('O Antigravity não respondeu ao listar os modelos.');
  // Lines are "<id>\t<display name>"; progress messages have no tab.
  const models = stdout.split('\n').filter((line) => line.includes('\t')).map((line) => line.split('\t')[0].trim()).filter(Boolean);
  if (code !== 0 || !models.length) {
    const detail = firstLine(stderr) || firstLine(stdout);
    if (code !== 0 && LOGIN_HINT.test(`${stderr}\n${stdout}`)) {
      return unavailable(`Antigravity indisponível${detail ? `: ${detail}` : ''}. Confira o login no agy.`);
    }
    return unknown(`Não foi possível listar os modelos do Antigravity${detail ? `: ${detail}` : ''}.`);
  }
  return { status: 'available', models };
}

async function checkCodex(bin) {
  const child = spawnCli(bin, ['app-server', '--listen', 'stdio://',
    '-c', 'forced_login_method="chatgpt"', '-c', 'model_provider="openai"'], {
    cwd: agentWorkspace(), stdio: ['pipe', 'pipe', 'ignore'],
  });
  const pending = new Map();
  let nextId = 0;
  const failAll = (error) => {
    for (const { reject } of pending.values()) reject(error);
    pending.clear();
  };
  child.on('error', failAll);
  child.on('close', () => failAll(new Error('O Codex encerrou durante a verificação.')));
  child.stdin.on('error', failAll);
  const reader = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  reader.on('line', (line) => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    const request = message.id !== undefined && !message.method && pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message || 'Erro no Codex'));
    else request.resolve(message.result);
  });
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  });
  const timer = setTimeout(() => failAll(new Error('O Codex não respondeu à verificação.')), CHECK_TIMEOUT_MS);
  try {
    await rpc('initialize', { clientInfo: { name: 'interviewai', title: 'InterviewAI', version: '1.0.0' } });
    child.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
    const { account } = await rpc('account/read', {});
    if (!account) return unavailable('Faça login no Codex com "codex login" para usar este provedor.');
    const models = [];
    let cursor = null;
    do {
      const page = await rpc('model/list', { includeHidden: true, cursor });
      models.push(...(page.data || []).map((model) => model.id));
      cursor = page.nextCursor;
    } while (cursor && models.length < 500);
    return { status: 'available', models };
  } catch (error) {
    return unknown(`Não foi possível verificar o Codex: ${error.message}`);
  } finally {
    clearTimeout(timer);
    reader.close();
    killProcessTree(child);
  }
}

async function checkClaude(bin) {
  // Same environment as the sessions, which drop API keys to use the subscription login.
  const { ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, ...env } = process.env;
  const { stdout, stderr, timedOut } = await run(bin, ['auth', 'status'], env);
  if (timedOut) return unknown('O Claude Code não respondeu à verificação de login.');
  let status = null;
  try { status = JSON.parse(stdout); } catch {}
  if (status?.loggedIn) return { status: 'available', models: null };
  if (status) return unavailable('Faça login no Claude Code com "claude auth login" para usar este provedor.');
  const detail = firstLine(stderr) || firstLine(stdout);
  return unknown(`Não foi possível verificar o login do Claude Code${detail ? `: ${detail}` : ''}.`);
}

// Lines are "<provider>/<model>"; the list includes the providers whose key was saved here.
async function checkOpencode(bin) {
  const { code, stdout, stderr, timedOut } = await run(bin, ['models'], opencodeEnv());
  if (timedOut) return unknown('O OpenCode não respondeu ao listar os modelos.');
  const models = stdout.split('\n').map((line) => line.trim()).filter((line) => /^[\w.-]+\/\S+$/.test(line));
  if (code !== 0 || !models.length) {
    const detail = firstLine(stderr) || firstLine(stdout);
    return unknown(`Não foi possível listar os modelos do OpenCode${detail ? `: ${detail}` : ''}.`);
  }
  return { status: 'available', models, catalog: models.map((id) => ({ id, name: id })) };
}

async function checkApi(provider) {
  const result = await listApiModels(provider);
  if (!result.models) return result;
  const catalog = chatModels(provider, result.models);
  // An empty filtered list means the filter missed this account's names, not that nothing works.
  const listed = catalog.length ? catalog : result.models;
  return { status: 'available', models: listed.map((model) => model.id), catalog: listed };
}

const CHECKS = {
  antigravity: checkAntigravity, codex: checkCodex, claude: checkClaude, opencode: checkOpencode,
  ...Object.fromEntries(API_PROVIDER_IDS.map((id) => [id, () => checkApi(id)])),
};

async function checkProvider(provider) {
  if (API_PROVIDERS[provider]) {
    try { return await CHECKS[provider](); }
    catch (error) { return unknown(`Não foi possível verificar ${API_PROVIDERS[provider].shortName}: ${error.message}`); }
  }
  const bin = resolveCliBin(BINS[provider]);
  if (!cliAvailable(bin)) {
    return unavailable(`${NAMES[provider]} não está instalado (comando "${BINS[provider]}" não encontrado).`);
  }
  try { return await CHECKS[provider](bin); }
  catch (error) { return unknown(`Não foi possível verificar o ${NAMES[provider]}: ${error.message}`); }
}

export function createProviderAvailability({ onChange = () => {}, check = checkProvider } = {}) {
  const state = Object.fromEntries(Object.keys(CHECKS).map((provider) => [provider, { status: 'checking' }]));
  const running = new Map();
  const checkedAt = new Map();

  function refresh(provider, { force = false } = {}) {
    if (!provider) return Promise.all(Object.keys(CHECKS).map((name) => refresh(name, { force })));
    if (running.has(provider)) return running.get(provider);
    if (!force && Date.now() - (checkedAt.get(provider) || 0) < RECHECK_INTERVAL_MS) return Promise.resolve(state[provider]);
    const job = check(provider).then((result) => {
      running.delete(provider);
      checkedAt.set(provider, Date.now());
      state[provider] = result;
      if (result.status === 'unavailable') console.warn(`[Providers] ${provider}: ${result.reason}`);
      onChange(snapshot(), provider);
      return result;
    });
    running.set(provider, job);
    return job;
  }

  function snapshot() {
    return Object.fromEntries(Object.entries(state).map(([name, entry]) => [name, { ...entry }]));
  }

  return { refresh, state: snapshot };
}
