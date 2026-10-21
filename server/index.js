import express from 'express';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { runUnifiedAgent, runIsolatedAgent, prepareAgentSession, closeAgentSession, prepareOneShotSessions, runsOneShot } from './agent-bridge.js';
import { importDocument, importText, ImportError, MAX_IMPORT_BYTES } from './document-import.js';
import { systemAudioEngine, SystemAudioEngine } from './system-audio-engine.js';
import { createTranscriber } from './transcriber.js';
import { createModelStore } from './speech-models.js';
import { createSpeechSettings } from './speech-settings.js';
import { wirePcTranscription } from './pc-transcription.js';
import { createLiveCopilot } from './live-copilot.js';
import { readCandidateContext } from './candidate-context.js';
import { createProfileStore, defaultProfilePath, migrateLegacyDataDir } from './profile-store.js';
import { createNotesVault, createNotesLookup, publicHit } from './notes-vault.js';
import { agentWorkspace, cliAvailable, resolveCliBin } from './cli-process.js';
import { composeCandidateContext, MAX_CONTEXT_CHARS } from '../shared/candidate-profile.js';
import { createConversationMemory } from './conversation-memory.js';
import { createSessionTranscript } from './session-transcript.js';
import { buildSummaryPrompt, createSummaryService, parseSummary, saveSessionMarkdown, sessionMarkdown } from './session-summary.js';
import { createMeetingHistory } from './meeting-history.js';
import { existingNote, writeMeetingNote } from './meeting-vault.js';
import { listAudioStreams } from './audio-apps.js';
import { createBackendAuth } from './backend-auth.js';
import { buildAgentPrompt, meetingEventBlock } from './agent-prompt.js';
import { normalizeImages, imageDataUrl, SCREENSHOT_PROMPT } from './agent-images.js';
import { AVAILABLE_MODELS, AVAILABLE_PERSONAS, generateCopilotResponse } from './gemini-copilot.js';
import { AUTO_LANGUAGE, LANGUAGES } from '../shared/language.js';
import { unavailableReason } from '../shared/provider-availability.js';
import { createProviderAvailability } from './provider-availability.js';
import { providerKeys } from './provider-keys.js';
import { resetApiConversations } from './api-session.js';
import { API_PROVIDER_IDS, isApiProvider, isHttpProvider } from '../shared/api-providers.js';
import { LOCAL_PROVIDER_IDS } from '../shared/local-providers.js';
import { createLocalModels, isModelName } from './local-models.js';
import { createGoogle, GoogleError } from './google.js';
import { accountEmail, createDocument, getEvent, listEvents, readDocument } from './google-workspace.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const distPath = path.resolve(__dirname, '../dist');

// Before anything reads or writes the data folder.
migrateLegacyDataDir();

const app = express();
const PORT = process.env.PORT || 3001;
// Only reachable from this machine, and only by the app's window (see backend-auth.js).
const HOST = '127.0.0.1';
const auth = createBackendAuth({
  token: process.env.SIDENOTE_TOKEN,
  port: PORT,
  extraOrigins: [process.env.SIDENOTE_DEV_URL, ...(process.env.SIDENOTE_ALLOWED_ORIGINS || '').split(',')],
});

app.use(auth.rejectForeignOrigins);
app.use(cors(auth.corsOptions));
app.use(express.json({ limit: '25mb' }));

// Log every HTTP request
app.use((req, res, next) => {
  console.log(`[HTTP ${req.method}] ${req.url}`);
  next();
});

// Lets Electron know the backend is up before it has the token.
app.get('/api/health', (req, res) => res.json({ status: 'online' }));
app.use('/api', auth.requireToken);

// Serve frontend static build if dist exists
if (fs.existsSync(distPath)) {
  console.log(`[Server] Serving static frontend from ${distPath}`);
  app.use(express.static(distPath));
}

const server = http.createServer(app);
const wss = new WebSocketServer({ server, verifyClient: (info) => auth.verifySocket(info) });

const PROVIDER_IDS = ['antigravity', 'codex', 'claude', 'opencode', ...API_PROVIDER_IDS, ...LOCAL_PROVIDER_IDS];
const activeConversationIds = Object.fromEntries(PROVIDER_IDS.map((id) => [id, null]));
const DEFAULT_MODELS = {
  antigravity: 'gemini-3.8-flash',
  codex: 'gpt-6-luna',
  claude: 'claude-sonnet-5-5',
};
// OpenCode and the API providers have no fixed list: their first listed model is the default.
function defaultModelFor(provider) {
  return DEFAULT_MODELS[provider] || providerAvailability.state()[provider]?.models?.[0] || null;
}
let activeAgentProcess = null;
let copilotGeneration = 0;
let agentTurnCounter = 0;

let selectedProvider = 'antigravity';
let selectedModel = 'gemini-3.8-flash';
let selectedReasoningEffort = 'medium';
let selectedFastMode = true;
let selectedPersona = 'general';
const profileStore = createProfileStore();
let candidateProfile = await profileStore.load();
let candidateContext = composeCandidateContext(candidateProfile);
console.log(`[Profile] Using ${profileStore.file}`);
let autoRespond = true;
let lastPcTranscript = '';
let activeLanguage = AUTO_LANGUAGE;
const conversationMemory = createConversationMemory();
const sessionTranscript = createSessionTranscript();
// Summary settings come from the client. No provider means the conversation's model.
let summarySettings = { auto: true, provider: null, model: null, saveOnReset: true, saveToVault: false, saveToGoogleDocs: false };
// Finished meetings, titled by the model that writes their final summary.
// Speech recognition: Google, or a local engine whose model is downloaded next to the profile.
const dataDir = path.dirname(profileStore.file);
const speechModels = createModelStore({
  dir: process.env.SIDENOTE_MODELS_DIR || path.join(dataDir, 'models'),
  python: () => speechSettings.python(),
  onChange: () => broadcastSpeech(),
});
const speechSettings = createSpeechSettings({
  dataDir,
  models: speechModels,
  onChange: () => broadcastSpeech(),
  // A new venv changes the Python the worker runs with.
  onInstalled: () => transcriber.retry(),
});
speechSettings.refreshProbe();
const transcriber = createTranscriber({
  python: () => speechSettings.python(),
  config: () => speechSettings.workerConfig(),
  onEvent: (event) => {
    if (event.type === 'fallback') broadcast({ ...event, type: 'speech_fallback' });
    broadcastSpeech();
  },
});
const speechStatus = () => ({ ...speechSettings.status(), active: transcriber.info() });
function broadcastSpeech() {
  broadcast({ type: 'speech_status', status: speechStatus() });
}
const transcribeAudioBuffer = transcriber.transcribe;
const warmTranscriber = transcriber.warm;

const meetingHistory = createMeetingHistory({
  dir: process.env.SIDENOTE_HISTORY_DIR || path.join(path.dirname(profileStore.file), 'history'),
  onChange: () => broadcast({ type: 'history_changed' }),
});
// Meetings left open when the app closed, or whose summary a restart interrupted.
// Read once the port is ours: a second backend that cannot start must not take
// over the draft of the one that is running.
let pendingMeetings = [];

// Local Obsidian vault search. It runs on partial transcripts, so by the time an
// utterance is final its notes are already on screen and ready for the prompt.
const notesVault = createNotesVault({
  configFile: process.env.SIDENOTE_NOTES_CONFIG || path.join(path.dirname(defaultProfilePath()), 'notes.json'),
});
notesVault.load();
const notesLookup = createNotesLookup({
  search: (text) => notesVault.search(text),
  onHits: (utteranceId, hits) => broadcast({ type: 'notes_hits', utteranceId, hits }),
});

// Local models (Ollama, LM Studio): hardware scan, recommendations and downloads.
const localModels = createLocalModels({
  onChange: ({ pulls, settled }) => {
    broadcast({ type: 'local_ai_pulls', pulls });
    // A finished or removed download changes what the provider can offer.
    if (settled) {
      providerAvailability.refresh('ollama', { force: true });
      providerAvailability.refresh('lmstudio', { force: true });
    }
  },
});

// Google account (Calendar and Docs).
const google = createGoogle({ onChange: (status) => broadcast({ type: 'google_status', status }) });
const googleRequest = (url, init) => google.request(url, init);

// The Google Calendar event chosen for the meeting in progress, with the text of its
// attached Docs. It goes into every suggestion, message and summary of this session.
let meetingEvent = null;
const publicEvent = (event) => event && { ...event, documents: (event.documents || []).map(({ title, url }) => ({ title, url })) };
// What the history keeps: no attachment text, which can be long and is in Drive anyway.
const storedEvent = (event) => event && (({ documents, attachments, ...rest }) => rest)(event);

function setMeetingEvent(event) {
  meetingEvent = event;
  summaryService.refresh();
  broadcast({ type: 'meeting_event', event: publicEvent(event) });
}

function googleFailure(res, error, fallback) {
  if (!(error instanceof GoogleError) && !error.status) console.error(`[Google] ${error.message}`);
  res.status(error.status || 500).json({ error: error.status ? error.message : fallback });
}

// A screenshot sent without text gets a default request; memory keeps only a marker for the image.
function readUserTurn({ text, images }) {
  const typed = typeof text === 'string' ? text.trim() : '';
  const attached = normalizeImages(images);
  return {
    images: attached,
    request: typed || (attached.length ? SCREENSHOT_PROMPT : ''),
    display: typed || (attached.length ? 'Captura de tela' : ''),
    memory: attached.length ? `[captura de tela anexada] ${typed}`.trim() : typed,
  };
}

function broadcast(data) {
  const payload = JSON.stringify(data);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  });
}

// Login and account models of each CLI. An unavailable provider or model is never
// started; the client receives the reason and offers only usable options.
const providerAvailability = createProviderAvailability({
  onChange: (availability, provider) => {
    broadcast({ type: 'provider_availability', availability });
    if (provider !== selectedProvider || activeAgentProcess) return;
    // Also retries a failed start once the recheck it triggered finds the provider usable.
    const blocked = blockedReason(selectedProvider, selectedModel);
    if (blocked || agentSession.status === 'unavailable' || agentSession.status === 'error') {
      preparationKey = null;
      prepareSelectedSession();
    }
  },
});

function blockedReason(provider, model) {
  const name = AVAILABLE_MODELS.find((entry) => entry.id === model)?.name;
  return unavailableReason(providerAvailability.state(), provider, model, name);
}

// Session preparation is independent of response generation and never sends a prompt.
let preparationGeneration = 0;
let preparationKey = null;
let agentSession = { status: 'starting', provider: selectedProvider };
function prepareSelectedSession() {
  if (activeAgentProcess) return;
  const provider = selectedProvider;
  const blocked = blockedReason(provider, selectedModel);
  if (blocked) {
    preparationKey = null;
    preparationGeneration++;
    closeAgentSession(provider);
    agentSession = { status: 'unavailable', provider, error: blocked };
    broadcast({ type: 'agent_session', ...agentSession });
    return;
  }
  const key = JSON.stringify([selectedProvider, selectedModel, selectedReasoningEffort, selectedFastMode]);
  if (preparationKey === key && agentSession.status !== 'error') return;
  preparationKey = key;
  const generation = ++preparationGeneration;
  agentSession = { status: 'starting', provider };
  broadcast({ type: 'agent_session', ...agentSession });
  const options = { provider, model: selectedModel, reasoningEffort: selectedReasoningEffort,
    fastMode: selectedFastMode, cwd: agentWorkspace() };
  prepareOneShotSessions(options);
  prepareAgentSession({ ...options, conversationId: activeConversationIds[provider] })
    .then(({ conversationId, pid }) => {
      if (generation !== preparationGeneration) return;
      activeConversationIds[provider] = conversationId;
      agentSession = { status: 'ready', provider, conversationId, pid };
      broadcast({ type: 'agent_session', ...agentSession });
    }).catch((error) => {
      if (generation !== preparationGeneration) return;
      agentSession = { status: 'error', provider, error: error.message };
      broadcast({ type: 'agent_session', ...agentSession });
      console.warn(`[Session] ${provider}: ${error.message}`);
      // A logout or a model removed from the account shows up as a failed start.
      providerAvailability.refresh(provider);
    });
}

function syncAgentSettings({ provider, model, reasoningEffort, fastMode }) {
  const changed = (provider && provider !== selectedProvider) || (model && model !== selectedModel)
    || (reasoningEffort && reasoningEffort !== selectedReasoningEffort)
    || (fastMode !== undefined && !!fastMode !== selectedFastMode);
  if (changed) {
    liveCopilot.cancel();
    if (activeAgentProcess) {
      activeAgentProcess.kill();
      activeAgentProcess = null;
      broadcast({ type: 'agent_aborted' });
    }
    closeAgentSession(selectedProvider);
    preparationKey = null;
    preparationGeneration++;
  }
  if (provider) selectedProvider = provider;
  if (model) selectedModel = model;
  if (reasoningEffort) selectedReasoningEffort = reasoningEffort;
  if (fastMode !== undefined) selectedFastMode = !!fastMode;
  prepareSelectedSession();
}

function resetAgentSession(provider) {
  liveCopilot.cancel();
  activeAgentProcess?.kill();
  activeAgentProcess = null;
  preparationGeneration++;
  preparationKey = null;
  closeAgentSession(provider);
  if (!provider || isHttpProvider(provider)) resetApiConversations();
  if (provider && activeConversationIds[provider] !== undefined) activeConversationIds[provider] = null;
  else {
    for (const name of Object.keys(activeConversationIds)) activeConversationIds[name] = null;
  }
  pcTranscription.cancel();
  systemAudioEngine.discardSpeech();
  lastPcTranscript = '';
  conversationMemory.clear();
  archiveSession();
  // The next session is another meeting; its event is chosen again.
  if (meetingEvent) setMeetingEvent(null);
  sessionTranscript.clear();
  summaryService.reset();
  notesLookup.clear();
  broadcast({ type: 'session_reset', activeConversationIds, timestamp: Date.now() });
  prepareSelectedSession();
}

// Wire up Linux System Audio loopback engine
let lastLevelBroadcast = 0;
systemAudioEngine.on('level', ({ level, rms }) => {
  const now = Date.now();
  if (now - lastLevelBroadcast >= 45) {
    lastLevelBroadcast = now;
    broadcast({ type: 'pc_audio_level', level, rms });
  }
});

const liveCopilot = createLiveCopilot({
  enabled: () => autoRespond,
  canStart: () => !activeAgentProcess,
  speculate: () => runsOneShot(selectedProvider),
  start: ({ text, utteranceId, isPreview, onSettled }) => triggerCopilotForText(text, {
    replyId: `copilot-pc-${utteranceId}`, utteranceId, isPreview, onSettled,
  }),
  onFinalized: (id) => broadcast({ type: 'copilot_finalized', replyId: `copilot-pc-${id}` }),
  onDiscarded: (id) => broadcast({ type: 'copilot_discarded', replyId: `copilot-pc-${id}` }),
});

function summaryConfig() {
  const provider = summarySettings.provider || selectedProvider;
  const model = summarySettings.provider
    ? summarySettings.model || defaultModelFor(provider)
    : selectedModel;
  return { auto: summarySettings.auto, provider, model, fastMode: selectedFastMode, error: blockedReason(provider, model),
    context: meetingEventBlock(meetingEvent) };
}

const summaryService = createSummaryService({
  transcript: sessionTranscript,
  config: summaryConfig,
  // A throwaway CLI process: the live conversation never sees the summary request.
  run: (options) => runIsolatedAgent({ ...options, timeoutMs: 180000, cwd: agentWorkspace() }),
  canAutoStart: () => !activeAgentProcess,
  onUpdate: (summary) => broadcast({ type: 'summary_update', summary }),
});

function recordTranscript(role, text, options) {
  if (!sessionTranscript.add(role, text, options)) return;
  summaryService.noteActivity();
  meetingHistory.saveDraft({ startedAt: sessionTranscript.startedAt, entries: sessionTranscript.entries() });
}

// One-shot live answers never enter the CLI conversation, so a direct message
// carries what was said and suggested since the previous direct message.
function meetingSinceLastMessage(provider) {
  if (!runsOneShot(provider)) return [];
  const entries = sessionTranscript.entries();
  const lastMessage = entries.findLastIndex((entry) => entry.role === 'user');
  return entries.slice(lastMessage + 1)
    .filter((entry) => entry.role === 'interlocutor' || entry.id?.startsWith('copilot-'))
    .slice(-8);
}

function sessionsDir() {
  return path.join(path.dirname(profileStore.file), 'sessions');
}

// Writes a finished meeting's final summary; the model also picks its title.
function summarizeMeeting(id, { previous = null } = {}) {
  const record = meetingHistory.get(id);
  if (!record) return Promise.resolve(null);
  const config = summaryConfig();
  if (config.error) return Promise.resolve(meetingHistory.update(id, { status: 'done', summaryError: config.error }));
  meetingHistory.update(id, { status: 'summarizing', summaryError: null });
  return runIsolatedAgent({
    prompt: buildSummaryPrompt({ entries: record.entries, startedAt: record.startedAt, previous, final: true,
      context: meetingEventBlock(record.event) }),
    provider: config.provider, model: config.model, reasoningEffort: 'medium', fastMode: config.fastMode,
    timeoutMs: 180000, cwd: agentWorkspace(),
  }).then((output) => {
    const { title, body } = parseSummary(output);
    if (!body) throw new Error('O modelo não retornou um resumo.');
    return meetingHistory.update(id, { status: 'done', title: title || record.title, summary: body, model: config.model });
  }).catch((error) => {
    console.warn(`[History] Final summary of ${id} failed: ${error.message}`);
    return meetingHistory.update(id, { status: 'done', summaryError: error.message });
  });
}

async function summarizePendingMeetings() {
  for (const id of pendingMeetings.splice(0)) {
    if (meetingHistory.get(id)?.status !== 'pending') continue;
    await summarizeMeeting(id);
    autoSaveToVault(id);
    autoSaveToGoogleDocs(id);
  }
}

function connectedVault() {
  const { connected, path: vaultPath } = notesVault.status;
  return connected && vaultPath ? vaultPath : null;
}

// Writes a history meeting into the Obsidian vault and remembers its note.
async function saveMeetingToVault(id) {
  const vaultPath = connectedVault();
  if (!vaultPath) throw Object.assign(new Error('Conecte uma vault do Obsidian para salvar nela.'), { status: 400 });
  const record = meetingHistory.get(id);
  if (!record) throw Object.assign(new Error('Reunião não encontrada.'), { status: 404 });
  const file = await writeMeetingNote(vaultPath, record);
  meetingHistory.update(id, { vaultFile: file });
  return file;
}

function autoSaveToVault(id) {
  if (!summarySettings.saveToVault || !connectedVault()) return;
  saveMeetingToVault(id)
    .then((file) => {
      console.log(`[History] Saved ${id} to the vault at ${file}`);
      broadcast({ type: 'summary_saved', file, archived: true, vault: true });
    })
    .catch((error) => {
      console.error(`[History] Could not save ${id} to the vault: ${error.message}`);
      broadcast({ type: 'summary_save_error', error: error.message });
    });
}

// Creates (or, when it has one already, returns) the Google Doc of a history meeting.
async function saveMeetingToGoogleDocs(id, { again = false } = {}) {
  const record = meetingHistory.get(id);
  if (!record) throw Object.assign(new Error('Reunião não encontrada.'), { status: 404 });
  if (record.googleDoc && !again) return record.googleDoc;
  const markdown = sessionMarkdown({ entries: record.entries, startedAt: record.startedAt, summary: record.summary,
    model: record.model, title: record.title, now: record.endedAt });
  const doc = await createDocument(googleRequest, { title: `${record.title || 'Reunião'} · Sidenote`, markdown });
  meetingHistory.update(id, { googleDoc: doc });
  return doc;
}

function autoSaveToGoogleDocs(id) {
  if (!summarySettings.saveToGoogleDocs || !google.connected) return;
  saveMeetingToGoogleDocs(id)
    .then((doc) => console.log(`[History] Saved ${id} to Google Docs at ${doc.url}`))
    .catch((error) => {
      console.error(`[History] Could not save ${id} to Google Docs: ${error.message}`);
      broadcast({ type: 'summary_save_error', error: `Google Docs: ${error.message}` });
    });
}

// "Nova sessão" moves the finished meeting into the history, summarizing it first
// when the summary on screen does not cover the last lines, and, if enabled, also
// keeps it as Markdown.
function archiveSession() {
  meetingHistory.clearDraft();
  const entries = sessionTranscript.entries();
  const startedAt = sessionTranscript.startedAt;
  const current = summaryService.current();
  const record = meetingHistory.add({
    entries, startedAt, event: storedEvent(meetingEvent),
    ...(current ? { status: 'done', title: current.title, summary: current.text, model: current.model } : {}),
  });
  if (!record) return;
  const finished = current ? Promise.resolve(record) : summarizeMeeting(record.id, { previous: summaryService.basis() });
  finished.then(() => {
    autoSaveToVault(record.id);
    autoSaveToGoogleDocs(record.id);
  });
  if (!summarySettings.saveOnReset) return;
  finished
    .then((saved) => saveSessionMarkdown(sessionsDir(),
      sessionMarkdown({ entries, startedAt, summary: saved?.summary, model: saved?.model, title: saved?.title }),
      record.endedAt, saved?.title))
    .then((file) => {
      console.log(`[Summary] Saved finished session to ${file}`);
      broadcast({ type: 'summary_saved', file, archived: true });
    })
    .catch((error) => {
      console.error(`[Summary] Could not save the finished session: ${error.message}`);
      broadcast({ type: 'summary_save_error', error: error.message });
    });
}

const pcTranscription = wirePcTranscription(systemAudioEngine, {
  transcribe: transcribeAudioBuffer,
  concurrency: () => transcriber.concurrency(),
  getLanguage: () => activeLanguage,
  broadcast,
  onPartial: (text, id) => {
    notesLookup.lookup(id, text);
    liveCopilot.partial(text, id);
  },
  onCancel: (id) => liveCopilot.cancel(id),
  onFinal: (text, id) => {
    lastPcTranscript = text;
    conversationMemory.remember('interlocutor', text);
    recordTranscript('interlocutor', text);
    notesLookup.lookup(id, text);
    liveCopilot.final(text, id);
  },
});

systemAudioEngine.on('status', (status) => {
  // The recognizer process is ready before the first utterance.
  if (status.isCapturing) warmTranscriber();
  broadcast({ type: 'pc_capture_status', ...status });
});

function triggerCopilotForText(transcript, overrideOptions = {}) {
  if (!transcript?.trim()) return;
  // A preview answers speech still in progress; only the complete utterance is remembered.
  const startsAsPreview = typeof overrideOptions.isPreview === 'function' ? overrideOptions.isPreview() : !!overrideOptions.isPreview;
  if (!startsAsPreview) conversationMemory.remember('interlocutor', transcript);
  // PC utterances were recorded when transcribed; this is a typed or repeated trigger.
  if (!overrideOptions.utteranceId && transcript !== lastPcTranscript) recordTranscript('interlocutor', transcript);

  if (activeAgentProcess) {
    activeAgentProcess.kill();
    activeAgentProcess = null;
  }
  const generation = ++copilotGeneration;
  const replyId = overrideOptions.replyId || `copilot-${Date.now()}-${generation}`;
  const isPreview = () => typeof overrideOptions.isPreview === 'function'
    ? overrideOptions.isPreview() : !!overrideOptions.isPreview;
  let settled = false;
  const settle = (result) => {
    if (settled) return;
    settled = true;
    overrideOptions.onSettled?.(result);
  };

  const provider = overrideOptions.provider || selectedProvider || 'antigravity';
  const model = overrideOptions.model || selectedModel || defaultModelFor(provider);
  const persona = overrideOptions.persona || selectedPersona;
  const reasoningEffort = overrideOptions.reasoningEffort || selectedReasoningEffort || 'medium';
  const fastMode = overrideOptions.fastMode !== undefined ? overrideOptions.fastMode : selectedFastMode;
  // Live answers carry the recent speech in the prompt, so they can run outside the
  // conversation where that makes cancelling a preview cheap.
  const oneShot = runsOneShot(provider);
  const convId = oneShot ? null : activeConversationIds[provider] || null;
  // PC utterances already showed their notes card through notes_hits.
  const notes = notesLookup.lookup(overrideOptions.utteranceId || null, transcript);

  broadcast({
    type: 'copilot_started',
    replyId, isPreview: isPreview(),
    prompt: transcript,
    ...(overrideOptions.utteranceId ? {} : { notes: notes.map(publicHit) }),
    provider,
    model,
    persona,
    timestamp: Date.now(),
  });
  const blocked = blockedReason(provider, model);
  if (blocked) {
    broadcast({ type: 'copilot_error', replyId, error: blocked, provider, model });
    settle({ error: blocked });
    return null;
  }

  const processHandle = generateCopilotResponse({
    transcript,
    provider,
    model,
    persona,
    reasoningEffort,
    fastMode,
    conversationId: convId,
    oneShot,
    // A preview uses the complete prompt: when the final transcript matches it, it is the answer.
    candidateContext,
    recentTurns: conversationMemory.beforeQuestion(transcript),
    notes,
    event: meetingEvent,
    cwd: agentWorkspace(),
    onToken: (token, fullText) => {
      if (generation !== copilotGeneration || settled) return;
      broadcast({
        type: 'copilot_token',
        replyId, isPreview: isPreview(),
        token,
        fullText,
        provider,
        model,
      });
    },
    onError: (err) => {
      if (generation !== copilotGeneration || settled) return;
      providerAvailability.refresh(provider);
      broadcast({ type: 'copilot_error', replyId, error: err.message, provider, model });
      activeAgentProcess = null;
      settle({ error: err.message });
    },
    onComplete: (response, resConvId) => {
      if (generation !== copilotGeneration || settled) return;
      if (resConvId && !oneShot) activeConversationIds[provider] = resConvId;
      recordTranscript('assistant', response, { id: replyId });
      broadcast({
        type: 'copilot_completed',
        replyId, isPreview: isPreview(),
        prompt: transcript,
        response,
        provider,
        model,
        persona,
        conversationId: oneShot ? null : resConvId,
        timestamp: Date.now(),
      });
      activeAgentProcess = null;
      settle({ response });
    },
  });
  activeAgentProcess = {
    pid: processHandle.pid,
    kill() {
      if (settled) return;
      if (generation === copilotGeneration) {
        copilotGeneration++;
        activeAgentProcess = null;
        broadcast({ type: 'copilot_cancelled', replyId });
      }
      processHandle.kill();
      settle({ cancelled: true });
    },
  };
  return activeAgentProcess;
}

// REST endpoints
app.get('/api/status', (req, res) => {
  const agyBin = resolveCliBin('agy');
  const codexBin = resolveCliBin('codex');
  const claudeBin = resolveCliBin('claude');

  res.json({
    status: 'online',
    platform: process.platform,
    agyAvailable: cliAvailable(agyBin),
    agyBinPath: agyBin,
    codexAvailable: cliAvailable(codexBin),
    codexBinPath: codexBin,
    claudeAvailable: cliAvailable(claudeBin),
    claudeBinPath: claudeBin,
    cwd: process.cwd(),
    selectedProvider,
    selectedModel,
    activeConversationIds,
    agentSession,
    providerAvailability: providerAvailability.state(),
    isProcessing: activeAgentProcess !== null,
  });
});

app.post('/api/reset-session', (req, res) => {
  resetAgentSession(req.body?.provider);
  res.json({ success: true, message: 'Sessão reiniciada com sucesso', activeConversationIds });
});

app.get('/api/candidate-context/file', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const { status, ...body } = await readCandidateContext(path.resolve(__dirname, '..'));
  res.status(status).json(body);
});

app.get('/api/profile', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ profile: candidateProfile, file: profileStore.file });
});

app.put('/api/profile', async (req, res) => {
  const profile = req.body?.profile;
  if (!profile || typeof profile !== 'object') return res.status(400).json({ error: 'Perfil inválido.' });
  const context = composeCandidateContext(profile);
  if (context.length > MAX_CONTEXT_CHARS) {
    return res.status(400).json({ error: `O contexto ultrapassa ${MAX_CONTEXT_CHARS.toLocaleString('pt-BR')} caracteres. Reduza alguns campos.` });
  }
  try {
    candidateProfile = await profileStore.save(profile);
    candidateContext = composeCandidateContext(candidateProfile);
    res.json({ profile: candidateProfile, file: profileStore.file });
  } catch (error) {
    console.error(`[Profile] Could not save ${profileStore.file}: ${error.message}`);
    res.status(500).json({ error: 'Não foi possível salvar o perfil no disco.' });
  }
});

// Fills profile fields from a résumé (kind=cv) or job post (kind=job). Nothing is saved:
// the editor merges the fields into its draft and the user reviews before saving.
app.post(
  '/api/profile/import',
  express.raw({ type: () => true, limit: MAX_IMPORT_BYTES }),
  async (req, res) => {
    const kind = req.query.kind;
    let filename = '';
    try { filename = decodeURIComponent(String(req.get('x-file-name') || '')); } catch {}
    try {
      const result = await importDocument({
        kind,
        buffer: req.body,
        filename,
        // A throwaway CLI process, so the interview conversation never sees the document.
        runAgent: (prompt) => runIsolatedAgent({
          provider: selectedProvider, model: selectedModel, reasoningEffort: 'low', fastMode: true,
          prompt, cwd: agentWorkspace(),
        }),
      });
      console.log(`[Profile] Imported ${kind} from "${filename}" (${result.chars} chars${result.warning ? ', fallback' : ''})`);
      res.json(result);
    } catch (error) {
      if (!(error instanceof ImportError)) console.error(`[Profile] Import failed: ${error.message}`);
      res.status(error.status || 500).json({ error: error instanceof ImportError ? error.message : 'Não foi possível importar o arquivo.' });
    }
  }
);

function notesError(res, error) {
  if (!error.status) console.error(`[Notes] ${error.message}`);
  res.status(error.status || 500).json({ error: error.status ? error.message : 'Não foi possível indexar a vault.', status: notesVault.status });
}

app.get('/api/notes', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ status: notesVault.status });
});

app.put('/api/notes', async (req, res) => {
  try {
    res.json({ status: await notesVault.connect(req.body?.path) });
  } catch (error) {
    notesError(res, error);
  }
});

app.post('/api/notes/reindex', async (req, res) => {
  try {
    res.json({ status: await notesVault.reindex() });
  } catch (error) {
    notesError(res, error);
  }
});

app.delete('/api/notes', async (req, res) => {
  try {
    res.json({ status: await notesVault.disconnect() });
  } catch (error) {
    notesError(res, error);
  }
});

// Lets the settings screen check what a question would retrieve.
app.get('/api/notes/search', (req, res) => {
  const started = performance.now();
  const hits = notesVault.search(String(req.query.q || '')).map(publicHit);
  res.json({ hits, ms: Number((performance.now() - started).toFixed(1)) });
});

// API keys: the client sends a key once and only ever gets back whether one exists.
function keysResponse() {
  return { keys: providerKeys.summary(), file: providerKeys.file };
}

// A new key changes what the provider, and OpenCode with it, can offer.
function refreshForKeys(provider) {
  providerAvailability.refresh(provider, { force: true });
  providerAvailability.refresh('opencode', { force: true });
}

// Speech recognition engine, its Python packages and its downloadable models.
app.get('/api/speech', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (req.query.refresh) await speechSettings.refreshProbe();
  res.json(speechStatus());
});

app.put('/api/speech', async (req, res) => {
  try {
    speechSettings.save({ engine: req.body?.engine, variant: req.body?.variant });
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
  // A new choice gets a fresh chance even if the engine failed before.
  transcriber.retry();
  if (systemAudioEngine.isCapturing) transcriber.warm();
  console.log(`[Speech] Engine set to ${speechSettings.settings.engine}`);
  broadcastSpeech();
  res.json(speechStatus());
});

app.post('/api/speech/engines/:id/install', async (req, res) => {
  try {
    await speechSettings.install(req.params.id);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
  res.json(speechStatus());
});

app.post('/api/speech/models/:id/download', (req, res) => {
  try {
    speechModels.download(req.params.id);
  } catch (error) {
    return res.status(404).json({ error: error.message });
  }
  res.json(speechStatus());
});

app.delete('/api/speech/models/:id/download', (req, res) => {
  speechModels.cancel(req.params.id);
  res.json(speechStatus());
});

app.delete('/api/speech/models/:id', async (req, res) => {
  try {
    await speechModels.remove(req.params.id);
  } catch (error) {
    return res.status(404).json({ error: error.message });
  }
  // A worker still holding the deleted model exits; the next request reports it missing.
  transcriber.retry();
  res.json(speechStatus());
});

app.get('/api/provider-keys', (req, res) => res.json(keysResponse()));

app.put('/api/provider-keys/:provider', (req, res) => {
  const { provider } = req.params;
  if (!isApiProvider(provider)) return res.status(404).json({ error: 'Provedor desconhecido.' });
  try {
    providerKeys.set(provider, req.body?.key);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
  refreshForKeys(provider);
  res.json(keysResponse());
});

app.delete('/api/provider-keys/:provider', (req, res) => {
  const { provider } = req.params;
  if (!isApiProvider(provider)) return res.status(404).json({ error: 'Provedor desconhecido.' });
  try {
    providerKeys.remove(provider);
  } catch (error) {
    return res.status(500).json({ error: `Não foi possível remover a key: ${error.message}` });
  }
  refreshForKeys(provider);
  res.json(keysResponse());
});

// Local models: this machine's hardware, the catalog rated for it, Ollama and LM Studio.
app.get('/api/local-ai', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const rescan = Boolean(req.query.rescan);
  // Opening the screen (or rescanning) also catches an Ollama installed or started meanwhile.
  for (const runtime of LOCAL_PROVIDER_IDS) providerAvailability.refresh(runtime, { force: rescan });
  try {
    res.json(await localModels.status({ rescan }));
  } catch (error) {
    console.error(`[LocalAI] ${error.message}`);
    res.status(500).json({ error: 'Não foi possível verificar os modelos locais.' });
  }
});

app.post('/api/local-ai/models/pull', (req, res) => {
  const id = req.body?.model;
  if (!isModelName(id)) return res.status(400).json({ error: 'Nome de modelo inválido.' });
  localModels.pull(id).catch((error) => console.warn(`[LocalAI] ${error.message}`));
  res.json({ success: true });
});

app.post('/api/local-ai/models/cancel', (req, res) => {
  localModels.cancel(String(req.body?.model || ''));
  res.json({ success: true });
});

app.post('/api/local-ai/models/delete', async (req, res) => {
  try {
    await localModels.remove(req.body?.model);
    res.json({ success: true });
  } catch (error) {
    res.status(error.status || 502).json({ error: `Não foi possível apagar o modelo: ${error.message}` });
  }
});

app.post('/api/local-ai/:runtime/start', async (req, res) => {
  const { runtime } = req.params;
  if (!LOCAL_PROVIDER_IDS.includes(runtime)) return res.status(404).json({ error: 'Runtime desconhecido.' });
  try {
    await localModels.start(runtime);
    providerAvailability.refresh(runtime, { force: true });
    res.json({ success: true });
  } catch (error) {
    res.status(error.status || 502).json({ error: error.message });
  }
});

// Google account: OAuth client, connection, calendar events and Docs.
app.get('/api/google', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ status: google.status(), file: google.file, event: publicEvent(meetingEvent) });
});

app.put('/api/google/client', (req, res) => {
  try {
    google.setClient(req.body || {});
    res.json({ status: google.status() });
  } catch (error) {
    googleFailure(res, error, 'Não foi possível salvar o cliente OAuth.');
  }
});

app.delete('/api/google/client', (req, res) => {
  google.removeClient();
  res.json({ status: google.status() });
});

// Returns the Google sign-in URL; the window opens it in the browser.
app.post('/api/google/connect', async (req, res) => {
  try {
    const { authUrl } = await google.connect({ fetchEmail: () => accountEmail(googleRequest) });
    res.json({ authUrl, status: google.status() });
  } catch (error) {
    googleFailure(res, error, 'Não foi possível iniciar o login no Google.');
  }
});

app.post('/api/google/connect/cancel', (req, res) => {
  google.cancelConnect();
  res.json({ status: google.status() });
});

app.delete('/api/google', async (req, res) => {
  await google.disconnect();
  if (meetingEvent) setMeetingEvent(null);
  res.json({ status: google.status() });
});

app.get('/api/google/events', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!google.connected) return res.json({ events: [] });
  const now = Date.now();
  try {
    // From meetings that started a while ago until the end of tomorrow.
    const until = new Date(now);
    until.setDate(until.getDate() + 2);
    until.setHours(0, 0, 0, 0);
    res.json({ events: await listEvents(googleRequest, { from: now - 3 * 3600 * 1000, to: until.getTime() }) });
  } catch (error) {
    googleFailure(res, error, 'Não foi possível ler a agenda.');
  }
});

// Chooses the meeting in progress; the text of its attached Google Docs comes along.
app.put('/api/google/meeting-event', async (req, res) => {
  const id = typeof req.body?.id === 'string' ? req.body.id : '';
  if (!id) return res.status(400).json({ error: 'Evento inválido.' });
  try {
    const event = await getEvent(googleRequest, id);
    const attachments = event.attachments.filter((file) => file.mimeType === 'application/vnd.google-apps.document' && (file.fileId || file.url)).slice(0, 2);
    const documents = [];
    for (const file of attachments) {
      try {
        const doc = await readDocument(googleRequest, file.fileId || file.url);
        if (doc.text) documents.push({ title: doc.title, url: file.url, text: doc.text });
      } catch (error) {
        console.warn(`[Google] Skipping attachment "${file.title}": ${error.message}`);
      }
    }
    setMeetingEvent({ ...event, documents });
    res.json({ event: publicEvent(meetingEvent) });
  } catch (error) {
    googleFailure(res, error, 'Não foi possível ler o evento.');
  }
});

app.delete('/api/google/meeting-event', (req, res) => {
  setMeetingEvent(null);
  res.json({ event: null });
});

// Fills profile fields from a Google Docs document, like a dropped file.
app.post('/api/profile/import-google', async (req, res) => {
  const { kind, url } = req.body || {};
  try {
    const doc = await readDocument(googleRequest, url);
    const result = await importText({
      kind, text: doc.text,
      runAgent: (prompt) => runIsolatedAgent({
        provider: selectedProvider, model: selectedModel, reasoningEffort: 'low', fastMode: true,
        prompt, cwd: agentWorkspace(),
      }),
    });
    console.log(`[Profile] Imported ${kind} from Google Docs "${doc.title}" (${result.chars} chars)`);
    res.json({ ...result, title: doc.title });
  } catch (error) {
    if (error instanceof ImportError) return res.status(error.status).json({ error: error.message });
    googleFailure(res, error, 'Não foi possível importar o documento.');
  }
});

app.post('/api/settings', (req, res) => {
  const { provider, model, reasoningEffort, fastMode } = req.body || {};
  syncAgentSettings({ provider, model, reasoningEffort, fastMode });
  broadcast({
    type: 'settings_synced',
    provider: selectedProvider,
    model: selectedModel,
    reasoningEffort: selectedReasoningEffort,
    fastMode: selectedFastMode,
  });
  res.json({
    success: true,
    provider: selectedProvider,
    model: selectedModel,
    reasoningEffort: selectedReasoningEffort,
    fastMode: selectedFastMode,
  });
});

// System Audio Capture & Devices Endpoints
app.get('/api/audio-devices', (req, res) => {
  res.json(SystemAudioEngine.listAudioSinks(systemAudioEngine.source));
});

app.post('/api/audio-capture/start', (req, res) => {
  const { sink, app: target, vadThreshold } = req.body || {};
  const success = systemAudioEngine.startCapture({ sink, app: target, vadThreshold });
  res.json({ success, status: systemAudioEngine.getStatus() });
});

app.post('/api/audio-capture/stop', (req, res) => {
  systemAudioEngine.stopCapture();
  res.json({ success: true, status: systemAudioEngine.getStatus() });
});

app.get('/api/audio-capture/status', (req, res) => {
  res.json(systemAudioEngine.getStatus());
});

// Streams being played, to capture one of them instead of the whole desktop (Linux).
app.get('/api/audio-apps', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (systemAudioEngine.source !== 'parec') return res.json({ supported: false, streams: [] });
  try {
    res.json({ supported: true, streams: await listAudioStreams() });
  } catch (error) {
    console.warn(`[SystemAudio] Could not list applications: ${error.message}`);
    res.json({ supported: true, streams: [], error: 'Não foi possível listar os aplicativos com áudio.' });
  }
});

// Meeting history
app.get('/api/history', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ meetings: meetingHistory.list({ query: String(req.query.q || '') }) });
});

app.get('/api/history/:id', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const meeting = meetingHistory.get(req.params.id);
  if (!meeting) return res.status(404).json({ error: 'Reunião não encontrada.' });
  res.json({ meeting });
});

app.post('/api/history/:id/summarize', (req, res) => {
  const meeting = meetingHistory.get(req.params.id);
  if (!meeting) return res.status(404).json({ error: 'Reunião não encontrada.' });
  if (meeting.status === 'summarizing') return res.status(409).json({ error: 'O resumo já está sendo gerado.' });
  summarizeMeeting(meeting.id);
  res.json({ success: true });
});

// Writes every finished meeting that has no note in the connected vault yet.
app.post('/api/history/vault', async (req, res) => {
  const vaultPath = connectedVault();
  if (!vaultPath) return res.status(400).json({ error: 'Conecte uma vault do Obsidian para salvar nela.' });
  let saved = 0;
  let skipped = 0;
  try {
    for (const { id, status } of meetingHistory.list({ limit: Infinity })) {
      const record = meetingHistory.get(id);
      if (status === 'pending' || status === 'summarizing' || await existingNote(vaultPath, record)) { skipped++; continue; }
      await saveMeetingToVault(id);
      saved++;
    }
    console.log(`[History] Saved ${saved} meetings to the vault (${skipped} skipped)`);
    res.json({ saved, skipped });
  } catch (error) {
    console.error(`[History] Vault export failed: ${error.message}`);
    res.status(500).json({ error: 'Não foi possível salvar na vault.', saved, skipped });
  }
});

app.post('/api/history/:id/vault', async (req, res) => {
  try {
    const file = await saveMeetingToVault(req.params.id);
    console.log(`[History] Saved ${req.params.id} to the vault at ${file}`);
    res.json({ file });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ error: error.message });
    console.error(`[History] Could not save ${req.params.id} to the vault: ${error.message}`);
    res.status(500).json({ error: 'Não foi possível salvar na vault.' });
  }
});

app.post('/api/history/:id/google-doc', async (req, res) => {
  try {
    const doc = await saveMeetingToGoogleDocs(req.params.id, { again: Boolean(req.body?.again) });
    res.json({ doc });
  } catch (error) {
    googleFailure(res, error, 'Não foi possível salvar no Google Docs.');
  }
});

app.delete('/api/history/:id', async (req, res) => {
  try {
    if (!(await meetingHistory.remove(req.params.id))) return res.status(404).json({ error: 'Reunião não encontrada.' });
    res.json({ success: true });
  } catch (error) {
    console.error(`[History] Could not delete ${req.params.id}: ${error.message}`);
    res.status(500).json({ error: 'Não foi possível apagar a reunião.' });
  }
});

app.get('/api/models', (req, res) => {
  res.json({
    models: AVAILABLE_MODELS,
    selectedProvider,
    selectedModel,
    selectedPersona,
    autoRespond,
  });
});

app.post('/api/copilot/trigger', (req, res) => {
  const text = req.body?.text || lastPcTranscript;
  if (!text) return res.status(400).json({ error: 'Nenhum texto para responder' });
  liveCopilot.cancel();
  triggerCopilotForText(text, req.body || {});
  res.json({ success: true, text });
});

// Audio transcription: WAV from the window; other formats only reach Google's worker, which converts them with ffmpeg.
app.post(
  '/api/transcribe',
  express.raw({
    type: ['audio/*', 'application/octet-stream', 'video/webm'],
    limit: '30mb',
  }),
  async (req, res) => {
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      return res.status(400).json({ error: 'Nenhum áudio recebido' });
    }
    const controller = new AbortController();
    res.on('close', () => { if (!res.writableEnded) controller.abort(); });
    const requested = String(req.query.lang || 'pt-BR').split(',').filter((language) => LANGUAGES.includes(language));
    const result = await transcribeAudioBuffer(req.body, requested.join(',') || 'pt-BR', { signal: controller.signal });
    if (!controller.signal.aborted) res.json(result);
  }
);

// Saves the current session (summary and full transcript) as Markdown in the app's
// sessions folder or in the connected Obsidian vault.
app.post('/api/summary/export', async (req, res) => {
  const target = ['vault', 'google'].includes(req.body?.target) ? req.body.target : 'sessions';
  const entries = sessionTranscript.entries();
  if (!entries.length) return res.status(400).json({ error: 'Ainda não há nada para salvar nesta sessão.' });
  if (target === 'google') {
    const { text, model, title } = summaryService.state;
    try {
      const doc = await createDocument(googleRequest, {
        title: `${title || meetingEvent?.title || 'Sessão'} · Sidenote`,
        markdown: sessionMarkdown({ entries, startedAt: sessionTranscript.startedAt, summary: text, model, title }),
      });
      console.log(`[Summary] Exported session to Google Docs at ${doc.url}`);
      return res.json({ file: doc.url, url: doc.url });
    } catch (error) {
      return googleFailure(res, error, 'Não foi possível salvar no Google Docs.');
    }
  }
  const vault = notesVault.status;
  if (target === 'vault' && !(vault.connected && vault.path)) {
    return res.status(400).json({ error: 'Conecte uma vault do Obsidian para salvar nela.' });
  }
  const { text, model, title } = summaryService.state;
  const dir = target === 'vault' ? path.join(vault.path, 'Sidenote') : sessionsDir();
  try {
    const file = await saveSessionMarkdown(dir,
      sessionMarkdown({ entries, startedAt: sessionTranscript.startedAt, summary: text, model, title }), entries.at(-1).at, title);
    console.log(`[Summary] Exported session to ${file}`);
    res.json({ file });
  } catch (error) {
    console.error(`[Summary] Export failed: ${error.message}`);
    res.status(500).json({ error: 'Não foi possível salvar o arquivo.' });
  }
});

// REST Fallback for sending a prompt
app.post('/api/message', (req, res) => {
  liveCopilot.cancel();
  const {
    provider = 'antigravity',
    model,
    reasoningEffort,
    fastMode = true,
  } = req.body;
  const turn = readUserTurn(req.body);

  if (!turn.request) {
    return res.status(400).json({ error: 'Mensagem vazia' });
  }
  const blocked = blockedReason(provider, model || selectedModel);
  if (blocked) return res.status(409).json({ error: blocked, provider, model });

  if (activeAgentProcess) {
    activeAgentProcess.kill();
    activeAgentProcess = null;
  }

  let finalResponse = '';
  const convId = activeConversationIds[provider];
  const meeting = meetingSinceLastMessage(provider);
  conversationMemory.remember('user', turn.memory);
  recordTranscript('user', turn.memory);

  activeAgentProcess = runUnifiedAgent({
    provider,
    model,
    reasoningEffort,
    fastMode,
    prompt: buildAgentPrompt(turn.request, candidateProfile, notesVault.search(turn.request), meeting, meetingEvent),
    images: turn.images,
    conversationId: convId,
    cwd: agentWorkspace(),
    onMessage: (eventData) => {
      if (eventData.result?.response) {
        finalResponse = eventData.result.response;
      }
      if (eventData.conversation_id) {
        activeConversationIds[provider] = eventData.conversation_id;
      }
    },
    onError: (err) => {
      activeAgentProcess = null;
      res.status(500).json({ error: err.message });
    },
    onClose: (code) => {
      activeAgentProcess = null;
      recordTranscript('assistant', finalResponse);
      res.json({
        success: true,
        response: finalResponse,
        code,
        provider,
        model,
        conversationId: activeConversationIds[provider],
      });
    },
  });
});

// Catch-all route to serve SPA index.html
if (fs.existsSync(distPath)) {
  app.use((req, res, next) => {
    if (req.method === 'GET' && !req.path.startsWith('/api') && !req.path.startsWith('/ws')) {
      return res.sendFile(path.join(distPath, 'index.html'));
    }
    next();
  });
}

// WebSocket connection handling
wss.on('connection', (ws, req) => {
  const clientIp = req.socket.remoteAddress;
  console.log(`[WS] Client connected from ${clientIp}`);

  // Send current status on connect
  ws.send(
    JSON.stringify({
      type: 'connection_ack',
      agentSession,
      providerAvailability: providerAvailability.state(),
      conversationIds: activeConversationIds,
      isProcessing: activeAgentProcess !== null,
      selectedProvider,
      selectedModel,
      selectedReasoningEffort,
      selectedFastMode,
      selectedPersona,
      autoRespond,
      pcAudioStatus: systemAudioEngine.getStatus(),
      availableModels: AVAILABLE_MODELS,
      availablePersonas: AVAILABLE_PERSONAS,
      availableSinks: SystemAudioEngine.listAudioSinks(systemAudioEngine.source),
      summary: summaryService.state,
      meetingEvent: publicEvent(meetingEvent),
      google: google.status(),
    })
  );

  ws.on('message', (message, isBinary) => {
    // Binary frames carry PC audio (PCM16 mono 16 kHz) captured by the renderer on Windows.
    if (isBinary) {
      systemAudioEngine.pushPcm(message);
      return;
    }
    try {
      const data = JSON.parse(message.toString());
      handleClientMessage(ws, data);
    } catch (err) {
      console.error('[WS] Invalid JSON message:', err);
    }
  });

  ws.on('error', (err) => {
    console.error('[WS] Client connection error:', err);
  });

  ws.on('close', () => {
    console.log('[WS] Client disconnected');
  });
});

function handleClientMessage(ws, data) {
  const { type } = data;

  if (type === 'reset_session') {
    resetAgentSession(data.provider);
    return;
  }

  if (type === 'refresh_providers') {
    providerAvailability.refresh(data.provider, { force: true });
    return;
  }

  // Linux PC Audio Loopback commands
  if (type === 'start_pc_capture') {
    const success = systemAudioEngine.startCapture(data.options || {});
    broadcast({ type: 'pc_capture_status', ...systemAudioEngine.getStatus() });
    return;
  }

  if (type === 'stop_pc_capture') {
    systemAudioEngine.stopCapture();
    broadcast({ type: 'pc_capture_status', ...systemAudioEngine.getStatus() });
    return;
  }

  if (type === 'sync_settings') {
    syncAgentSettings(data);
    broadcast({
      type: 'settings_synced',
      provider: selectedProvider,
      model: selectedModel,
      reasoningEffort: selectedReasoningEffort,
      fastMode: selectedFastMode,
    });
    return;
  }

  if (type === 'set_provider') {
    liveCopilot.cancel();
    if (data.provider) {
      syncAgentSettings({ provider: data.provider });
      broadcast({ type: 'provider_changed', provider: selectedProvider });
    }
    return;
  }

  if (type === 'set_model') {
    liveCopilot.cancel();
    if (data.model) {
      syncAgentSettings({ model: data.model });
      broadcast({ type: 'model_changed', model: selectedModel });
    }
    return;
  }

  if (type === 'set_persona') {
    liveCopilot.cancel();
    if (data.persona) {
      selectedPersona = data.persona;
      broadcast({ type: 'persona_changed', persona: selectedPersona });
    }
    return;
  }

  if (type === 'set_auto_respond') {
    autoRespond = !!data.autoRespond;
    if (!autoRespond) liveCopilot.cancel();
    broadcast({ type: 'auto_respond_changed', autoRespond });
    return;
  }

  if (type === 'trigger_copilot') {
    liveCopilot.cancel();
    const text = data.text || lastPcTranscript;
    triggerCopilotForText(text, {
      provider: data.provider,
      model: data.model,
      persona: data.persona,
      reasoningEffort: data.reasoningEffort,
      fastMode: data.fastMode,
    });
    return;
  }

  if (type === 'set_language') {
    if (data.language === AUTO_LANGUAGE || LANGUAGES.includes(data.language)) activeLanguage = data.language;
    return;
  }

  if (type === 'summary_request') {
    summaryService.request('manual');
    return;
  }

  if (type === 'summary_settings') {
    const { auto, provider, model, saveOnReset, saveToVault, saveToGoogleDocs } = data.settings || {};
    summarySettings = {
      auto: auto !== undefined ? !!auto : summarySettings.auto,
      provider: provider === undefined ? summarySettings.provider : PROVIDER_IDS.includes(provider) ? provider : null,
      model: model === undefined ? summarySettings.model : (typeof model === 'string' && model) || null,
      saveOnReset: saveOnReset !== undefined ? !!saveOnReset : summarySettings.saveOnReset,
      saveToVault: saveToVault !== undefined ? !!saveToVault : summarySettings.saveToVault,
      saveToGoogleDocs: saveToGoogleDocs !== undefined ? !!saveToGoogleDocs : summarySettings.saveToGoogleDocs,
    };
    summaryService.refresh();
    return;
  }

  if (type === 'voice_message' || type === 'text_message') {
    liveCopilot.cancel();
    const turn = readUserTurn(data);
    const prompt = turn.request;
    if (!prompt) {
      ws.send(JSON.stringify({ type: 'error', error: 'Mensagem vazia' }));
      return;
    }

    const provider = data.provider || selectedProvider || 'antigravity';
    const model = data.model || selectedModel || defaultModelFor(provider);
    const reasoningEffort = data.reasoningEffort || selectedReasoningEffort || 'medium';
    const fastMode = data.fastMode !== undefined ? data.fastMode : selectedFastMode;
    const currentConvId = activeConversationIds[provider] || null;
    const blocked = blockedReason(provider, model);
    if (blocked) {
      ws.send(JSON.stringify({ type: 'agent_unavailable', error: blocked, provider, model }));
      return;
    }

    if (activeAgentProcess) {
      console.log('[WS] Aborting previous running process for new prompt...');
      activeAgentProcess.kill();
      activeAgentProcess = null;
    }

    const meeting = meetingSinceLastMessage(provider);
    // Broadcast user message to UI
    conversationMemory.remember('user', turn.memory);
    recordTranscript('user', turn.memory);
    // Every event of this turn names it, so the client streams into the right message.
    const turnId = `turn-${Date.now()}-${++agentTurnCounter}`;
    let replyText = '';
    const notes = turn.images.length && !data.text?.trim() ? [] : notesVault.search(prompt);
    ws.send(
      JSON.stringify({
        type: 'user_message_acknowledged',
        turnId,
        text: turn.display,
        images: turn.images.map(imageDataUrl),
        timestamp: Date.now(),
        source: data.source || 'voice',
        notes: notes.map(publicHit),
        provider,
        model,
        reasoningEffort,
        fastMode,
      })
    );

    // Notify agent is starting
    ws.send(
      JSON.stringify({
        type: 'agent_status',
        status: 'thinking',
        prompt,
        provider,
        model,
        reasoningEffort,
        fastMode,
      })
    );

    activeAgentProcess = runUnifiedAgent({
      provider,
      model,
      reasoningEffort,
      fastMode,
      prompt: buildAgentPrompt(prompt, candidateProfile, notes, meeting, meetingEvent),
      images: turn.images,
      conversationId: currentConvId,
      cwd: agentWorkspace(),
      onMessage: (eventData) => {
        if (eventData.conversation_id) {
          activeConversationIds[provider] = eventData.conversation_id;
        }
        if (eventData.step_update?.conversation_id) {
          activeConversationIds[provider] = eventData.step_update.conversation_id;
        }
        if (eventData.result?.conversation_id) {
          activeConversationIds[provider] = eventData.result.conversation_id;
        }
        if (eventData.step_update?.text_delta) replyText += eventData.step_update.text_delta;
        if (typeof eventData.result?.response === 'string' && eventData.result.response) replyText = eventData.result.response;

        if (ws.readyState === WebSocket.OPEN) {
          ws.send(
            JSON.stringify({
              type: 'agent_stream',
              turnId,
              data: eventData,
              provider,
              model,
              reasoningEffort,
              fastMode,
            })
          );
        }
      },
      onError: (err) => {
        console.error('[Bridge Error]:', err);
        providerAvailability.refresh(provider);
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(
            JSON.stringify({
              type: 'agent_error',
              turnId,
              error: err.message,
              provider,
              model,
            })
          );
        }
        activeAgentProcess = null;
      },
      onClose: (code) => {
        activeAgentProcess = null;
        recordTranscript('assistant', replyText, { id: turnId });
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(
            JSON.stringify({
              type: 'agent_done',
              turnId,
              code,
              provider,
              model,
              conversationId: activeConversationIds[provider],
            })
          );
        }
      },
    });
  } else if (type === 'abort') {
    liveCopilot.cancel();
    if (activeAgentProcess) {
      activeAgentProcess.kill();
      activeAgentProcess = null;
      ws.send(JSON.stringify({ type: 'agent_aborted' }));
    }
  } else if (type === 'ping') {
    ws.send(JSON.stringify({ type: 'pong' }));
  }
}

function shutdown() {
  liveCopilot.cancel();
  activeAgentProcess?.kill();
  closeAgentSession();
  systemAudioEngine.stopCapture();
  notesVault.close();
  localModels.close();
  google.cancelConnect();
  // The meeting in progress is summarized and titled on the next start.
  meetingHistory.flushDraft();
  process.exit(0);
}

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, shutdown);
// Started by Electron with an IPC channel: the channel closes when Electron dies, even
// when it is killed, so the backend never outlives it holding the port with its token.
if (process.send) process.on('disconnect', shutdown);

// Another backend already has the port: stop here, before touching any data.
server.on('error', (error) => {
  console.error(`[Server] ${error.code === 'EADDRINUSE' ? `Port ${PORT} is already in use by another backend` : error.message}`);
  process.exit(1);
});
wss.on('error', () => {});

server.listen(PORT, HOST, () => {
  pendingMeetings = meetingHistory.load();
  try {
    auth.writeTokenFile(path.dirname(profileStore.file));
  } catch (error) {
    console.warn(`[Server] Could not write the token file: ${error.message}`);
  }
  console.log(`[Sidenote Server] Running on http://${HOST}:${PORT}`);
  console.log(`[Sidenote Server] WebSocket ready on ws://${HOST}:${PORT}`);
  prepareSelectedSession();
  providerAvailability.refresh();
  // After the provider check, so a logged-out CLI is reported instead of failing.
  if (pendingMeetings.length) setTimeout(summarizePendingMeetings, 15000).unref();
});
