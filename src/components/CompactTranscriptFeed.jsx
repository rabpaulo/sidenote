import React, { useState, useLayoutEffect, useRef } from 'react';
import {
  Sparkles,
  Mic,
  Camera,
  Copy,
  Check,
  StopCircle,
  Clock,
  Terminal,
  Bot,
  Asterisk,
  Monitor,
  Send,
  RotateCw,
  Cpu,
  ArrowDown,
} from 'lucide-react';
import { FormattedAgentResponse } from './CodeBlock.jsx';
import { NotesCard } from './NotesCard.jsx';
import { PROVIDERS } from '../config/models.js';

const AGENT_STYLES = {
  antigravity: { name: 'ANTIGRAVITY', fallbackModel: 'Gemini', Icon: Sparkles, card: 'border-cyan-500/25 bg-[#0f1422]/85',
    divider: 'border-cyan-500/15', icon: 'text-cyan-400', label: 'text-cyan-300' },
  codex: { name: 'CODEX', fallbackModel: 'GPT-6', Icon: Bot, card: 'border-purple-500/25 bg-[#14101e]/85',
    divider: 'border-purple-500/15', icon: 'text-purple-400', label: 'text-purple-300' },
  claude: { name: 'CLAUDE CODE', fallbackModel: 'Claude', Icon: Asterisk, card: 'border-amber-500/25 bg-[#1a140c]/85',
    divider: 'border-amber-500/15', icon: 'text-amber-400', label: 'text-amber-300' },
  opencode: { name: 'OPENCODE', fallbackModel: 'OpenCode', Icon: Terminal, card: 'border-emerald-500/25 bg-[#0d1714]/85',
    divider: 'border-emerald-500/15', icon: 'text-emerald-400', label: 'text-emerald-300' },
};

// Providers reached with an API key share one look, labeled with their name.
function agentStyle(provider) {
  if (AGENT_STYLES[provider]) return AGENT_STYLES[provider];
  const config = PROVIDERS[provider];
  if (!config) return AGENT_STYLES.antigravity;
  return { name: config.shortName.toUpperCase(), fallbackModel: config.shortName, Icon: Cpu, card: 'border-sky-500/25 bg-[#0e1520]/85',
    divider: 'border-sky-500/15', icon: 'text-sky-400', label: 'text-sky-300' };
}

// Stable default, since the feed's scroll effect depends on it.
const NO_NOTES = {};

export function CompactTranscriptFeed({
  activeTab,
  messages,
  interimTranscript,
  isListening,
  isPcCapturing,
  isPcSpeaking,
  isTranscribingPc,
  pcLiveTranscripts = [],
  utteranceNotes = NO_NOTES,
  autoRespond,
  isProcessing,
  currentToolCall,
  frequencyBars,
  onAbort,
  onTriggerCopilot,
  agentSettings,
  isCompact = false,
}) {
  // Compact mode shows only the latest agent answer.
  const feedMessages = isCompact
    ? messages.filter((m) => m.role === 'copilot' || m.role === 'agent').slice(-1)
    : messages;
  const [copiedId, setCopiedId] = useState(null);
  const [isFollowing, setIsFollowing] = useState(true);
  const feedRef = useRef(null);
  const followingRef = useRef(true);

  useLayoutEffect(() => {
    followingRef.current = true;
    setIsFollowing(true);
  }, [activeTab]);

  // Follow updates only while the reader is at the bottom. Scroll this feed
  // directly so repeated tokens do not start competing smooth animations.
  useLayoutEffect(() => {
    if (!messages.length && !interimTranscript && !pcLiveTranscripts.length && !isProcessing) {
      followingRef.current = true;
      setIsFollowing(true);
    }
    if (followingRef.current && feedRef.current) {
      feedRef.current.scrollTop = feedRef.current.scrollHeight;
    }
  }, [activeTab, isCompact, messages, interimTranscript, pcLiveTranscripts, utteranceNotes, isProcessing]);

  const handleScroll = (event) => {
    const feed = event.currentTarget;
    const atBottom = feed.scrollHeight - feed.clientHeight - feed.scrollTop <= 32;
    followingRef.current = atBottom;
    setIsFollowing(atBottom);
  };

  const resumeFollowing = () => {
    followingRef.current = true;
    setIsFollowing(true);
    if (feedRef.current) feedRef.current.scrollTop = feedRef.current.scrollHeight;
  };

  const renderFeed = (content) => (
    <div className="app-reading-feed flex-1 min-h-0 flex flex-col">
      <div
        ref={feedRef}
        onScroll={handleScroll}
        className="app-transcript-feed flex-1 min-h-0 overflow-y-auto px-4 py-4 space-y-3 text-xs"
      >
        {content}
      </div>
      {!isFollowing && (
        <div className="app-reading-status">
          <span>Leitura pausada · áudio e respostas continuam</span>
          <button type="button" onClick={resumeFollowing} aria-label="Voltar ao vivo" className="app-resume-live">
            <ArrowDown size={12} aria-hidden="true" />
            Voltar ao vivo
          </button>
        </div>
      )}
    </div>
  );

  const handleCopy = (text, id) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 1800);
  };

  // Each card shows once: PC questions carry their own, and compact mode moves it
  // onto the only answer it shows.
  const notesFor = (item) => {
    const id = item.id || '';
    if (id.startsWith('pc-')) return isCompact ? null : utteranceNotes[id.slice(3)];
    if (id.startsWith('copilot-pc-')) return isCompact ? utteranceNotes[id.slice(11)] : null;
    if (item.role === 'agent') return isCompact ? item.notes : null;
    return item.notes;
  };
  const liveNotes = isCompact
    ? [...pcLiveTranscripts].reverse().map((item) => utteranceNotes[item.utteranceId]).find((hits) => hits?.length)
    : null;

  const miniBars = frequencyBars ? frequencyBars.slice(16, 32) : [];
  const activeProviderName = agentSettings?.currentProviderConfig?.shortName || 'Agente';

  // --- TAB: TRANSCRIÇÃO ---
  if (activeTab === 'transcription') {
    return renderFeed(
      <>
        {!isCompact && isPcCapturing && (isPcSpeaking || isTranscribingPc) && (
          <div
            role="status"
            aria-live="polite"
            className="flex items-center gap-2 rounded-lg border border-indigo-500/20 bg-indigo-500/[0.07] px-3 py-2 text-[11px] text-indigo-200"
          >
            <span className="relative flex h-2 w-2 shrink-0">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-indigo-400 opacity-60" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-indigo-400" />
            </span>
            <span>
              {isPcSpeaking
                ? autoRespond
                  ? 'Escutando o PC e preparando sugestões ao vivo…'
                  : 'Transcrevendo enquanto o PC fala…'
                : autoRespond
                  ? 'Pausa detectada. Consolidando a resposta…'
                  : 'Pausa detectada. Finalizando a transcrição…'}
            </span>
          </div>
        )}

        {isCompact && feedMessages.length === 0 && !isProcessing && !liveNotes && (
          <div className="h-full flex items-center justify-center text-center p-4 text-[11px] text-zinc-500">
            {isPcSpeaking || isTranscribingPc ? 'Escutando a pergunta…' : 'A resposta do agente aparece aqui.'}
          </div>
        )}

        {/* Empty state */}
        {!isCompact && messages.length === 0 && !interimTranscript && !isProcessing && !isPcSpeaking && !isTranscribingPc && (
          <div className="h-full flex flex-col items-center justify-center text-center p-6 text-zinc-500 min-h-[260px]">
            <div className="w-10 h-10 rounded-full bg-white/[0.04] border border-white/[0.08] flex items-center justify-center mb-2.5 text-blue-300">
              <Mic size={17} />
            </div>
            <h4 className="text-zinc-200 font-semibold text-xs mb-1">InterviewAI está escutando</h4>
            <div className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md bg-white/[0.04] border border-white/[0.06] text-[10px] text-zinc-400 font-mono">
              <kbd className="px-1 py-0.5 rounded bg-white/10 text-zinc-200">ESPAÇO</kbd> para falar •{' '}
              <kbd className="px-1 py-0.5 rounded bg-white/10 text-zinc-200">Alt+Space</kbd> microfone
            </div>
          </div>
        )}

        {/* Message Feed */}
        {feedMessages.map((item, idx) => {
          const key = item.id || `msg-${idx}`;
          const isCopied = copiedId === key;

          // 1. User Message (Você falou)
          if (item.role === 'user') {
            return (
              <div
                key={key}
                className="transcript-entry rounded-xl border border-white/[0.06] bg-[#14141c]/80 p-3 shadow-sm"
              >
                <div className="flex items-center justify-between mb-1.5 text-[10px]">
                  <div className="flex items-center gap-1.5 font-bold tracking-wider text-cyan-400">
                    {item.source === 'screenshot' ? <Camera size={11} /> : <Mic size={11} />}
                    <span>VOCÊ</span>
                  </div>
                  <span className="font-mono text-zinc-500">
                    {item.timestamp ? new Date(item.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : ''}
                  </span>
                </div>
                {item.images?.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 mb-1.5">
                    {item.images.map((src, imageIdx) => (
                      <img
                        key={imageIdx}
                        src={src}
                        alt="Captura de tela enviada"
                        className="max-h-28 max-w-full rounded-md border border-white/10 object-contain"
                      />
                    ))}
                  </div>
                )}
                <p className="text-zinc-200 font-medium leading-relaxed italic text-[12px]">
                  “{item.text}”
                </p>
                <NotesCard hits={notesFor(item)} />
              </div>
            );
          }

          // 2. Interlocutor (PC / Reunião / Call)
          if (item.role === 'interlocutor') {
            return (
              <div
                key={key}
                className="transcript-entry transcript-entry--question rounded-xl border border-indigo-500/20 bg-[#101324]/80 p-3 shadow-sm"
              >
                <div className="flex items-center justify-between mb-1.5 text-[10px]">
                  <div className="flex items-center gap-1.5 font-bold tracking-wider text-indigo-300">
                    <Monitor size={11} />
                    <span>PC / REUNIÃO</span>
                  </div>
                  <div className="flex items-center gap-2">
                    {item.durationSec && (
                      <span className="text-[9px] px-1.5 py-0.2 rounded bg-indigo-500/10 text-indigo-300 border border-indigo-500/20 font-mono">
                        {item.durationSec.toFixed(1)}s
                      </span>
                    )}
                    <span className="font-mono text-zinc-500">
                      {item.timestamp ? new Date(item.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : ''}
                    </span>
                  </div>
                </div>

                <p className="text-zinc-200 font-medium leading-relaxed italic text-[12px] mb-2">
                  “{item.text}”
                </p>
                <NotesCard hits={notesFor(item)} />

                <div className="flex justify-end">
                  <button
                    type="button"
                    onClick={() =>
                      onTriggerCopilot?.(item.text, {
                        provider: agentSettings?.provider,
                        model: agentSettings?.currentModelId,
                        reasoningEffort: agentSettings?.currentReasoning,
                        fastMode: agentSettings?.fastMode,
                      })
                    }
                    className="flex items-center gap-1 px-2 py-1 rounded-md bg-indigo-500/20 hover:bg-indigo-500/30 text-indigo-300 hover:text-white text-[10px] font-semibold transition cursor-pointer border border-indigo-500/30"
                  >
                    <Sparkles size={10} />
                    <span>Diga isso</span>
                  </button>
                </div>
              </div>
            );
          }

          // 3. Copilot / Say This (Diga isso)
          if (item.role === 'copilot') {
            return (
              <React.Fragment key={key}>
              <NotesCard hits={notesFor(item)} />
              <div className="transcript-entry transcript-entry--answer say-this">
                <button
                  type="button"
                  onClick={() => handleCopy(item.text, key)}
                  className="say-this__copy"
                  title={isCopied ? 'Resposta copiada' : 'Copiar resposta'}
                  aria-label={isCopied ? 'Resposta copiada' : 'Copiar resposta'}
                >
                  {isCopied ? <Check size={14} /> : <Copy size={14} />}
                </button>
                <div className="say-this__content">
                  {(item.isPreview || item.isUpdating || item.status === 'cancelled') && (
                    <div className="mb-1.5 text-[10px] text-zinc-400">
                      {item.status === 'cancelled' ? 'Sugestão interrompida' : item.isUpdating ? 'Atualizando sugestão…' : 'Sugestão ao vivo • fala em andamento'}
                    </div>
                  )}
                  <div className="say-this__body">
                    {item.status === 'streaming' && !item.text ? (
                      <div className="say-this__pending">
                        <span className="w-1.5 h-1.5 rounded-full animate-pulse bg-current" />
                        <span>Formulando resposta ideal...</span>
                      </div>
                    ) : (
                      <FormattedAgentResponse text={item.text} />
                    )}
                  </div>
                </div>
              </div>
              </React.Fragment>
            );
          }

          // 4. Agent Code / Task Output
          const style = agentStyle(item.provider);
          const AgentIcon = style.Icon;
          return (
            <React.Fragment key={key}>
            <NotesCard hits={notesFor(item)} />
            <div
              className={`transcript-entry transcript-entry--assistant rounded-xl border p-3 shadow-md ${style.card}`}
            >
              <div
                className={`flex items-center justify-between mb-1.5 pb-1.5 border-b text-[10px] ${style.divider}`}
              >
                <div className="flex items-center gap-1.5 font-bold tracking-wide">
                  <AgentIcon size={12} className={style.icon} />
                  <span className={style.label}>{style.name}</span>
                  <span className="text-[9px] font-mono text-zinc-400 font-normal">
                    • {item.model || style.fallbackModel}
                  </span>
                </div>

                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => handleCopy(item.text, key)}
                    className="p-1 rounded hover:bg-white/10 text-zinc-400 hover:text-white transition cursor-pointer"
                    title="Copiar saída"
                  >
                    {isCopied ? <Check size={11} className="text-emerald-400" /> : <Copy size={11} />}
                  </button>
                  <span className="font-mono text-zinc-500">
                    {item.timestamp ? new Date(item.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''}
                  </span>
                </div>
              </div>

              {/* Tool call badge */}
              {item.toolCall && (
                <div className="mb-2 px-2 py-1 rounded bg-black/40 border border-white/[0.08] text-[10px] font-mono text-zinc-300 flex items-center gap-1.5">
                  <Terminal size={10} className="text-amber-400 shrink-0" />
                  <span className="text-amber-300">{item.toolCall.tool}</span>
                  <span className="truncate text-zinc-400">{JSON.stringify(item.toolCall.params || '')}</span>
                </div>
              )}

              <div className="text-zinc-100 leading-relaxed text-[12px]">
                <FormattedAgentResponse text={item.text} />
              </div>
            </div>
            </React.Fragment>
          );
        })}

        {liveNotes && <NotesCard hits={liveNotes} live />}

        {!isCompact && pcLiveTranscripts.map((item) => (
          <div key={item.utteranceId} className="rounded-xl border border-indigo-500/30 bg-indigo-500/[0.07] p-3" role="status" aria-live="polite">
            <div className="flex items-center gap-1.5 mb-1 text-[10px] text-indigo-300 font-bold">
              <Monitor size={12} />
              <span>PC / REUNIÃO · TRANSCRIÇÃO AO VIVO</span>
            </div>
            <p className="text-zinc-100 leading-relaxed text-[12px]">{item.text}</p>
            <NotesCard hits={utteranceNotes[item.utteranceId]} live />
          </div>
        ))}

        {/* Live speech preview while speaking */}
        {!isCompact && interimTranscript && (
          <div className="rounded-xl border border-cyan-500/40 bg-cyan-950/30 p-2.5 shadow-sm backdrop-blur-md animate-pulse">
            <div className="flex items-center justify-between mb-1 text-[10px] text-cyan-400 font-bold">
              <div className="flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-ping" />
                <span>OUVINDO AGORA...</span>
              </div>
              {/* Mini animated bars */}
              <div className="flex items-end gap-0.5 h-3">
                {miniBars.map((h, i) => (
                  <div
                    key={i}
                    className="w-0.5 bg-cyan-400 rounded-full transition-all duration-75"
                    style={{ height: `${Math.max(20, h * 0.8)}%` }}
                  />
                ))}
              </div>
            </div>
            <p className="text-zinc-100 font-medium italic text-[12px]">
              “{interimTranscript}”
            </p>
          </div>
        )}

        {/* Live Agent / Copilot Generating status */}
        {isProcessing && (
          <div className="flex items-center justify-between p-2 rounded-xl bg-white/[0.03] border border-white/[0.06] text-[11px] text-zinc-300">
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-cyan-400 animate-ping" />
              <span>Gerando resposta com IA...</span>
            </div>
            {onAbort && (
              <button
                type="button"
                onClick={onAbort}
                className="flex items-center gap-1 px-2 py-0.5 rounded text-[10px] text-rose-400 hover:bg-rose-500/15 border border-rose-500/20 transition cursor-pointer"
              >
                <StopCircle size={10} />
                <span>Parar</span>
              </button>
            )}
          </div>
        )}

      </>
    );
  }

  // --- TAB: SESSÃO ---
  if (activeTab === 'session') {
    const qAndAs = [];
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (msg.role === 'interlocutor' || msg.role === 'user') {
        const nextMsg = messages[i + 1];
        const answer = nextMsg && (nextMsg.role === 'copilot' || nextMsg.role === 'agent') ? nextMsg : null;
        qAndAs.push({ question: msg, answer });
      }
    }

    return renderFeed(
      <>
        {qAndAs.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-center p-6 text-zinc-500 min-h-[260px]">
            <Terminal size={20} className="mb-2 text-zinc-500" />
            <h4 className="text-zinc-300 font-semibold text-xs mb-1">Nenhum momento registrado</h4>
            <p className="text-[11px] text-zinc-500">
              Perguntas e respostas da sua reunião serão agrupadas aqui para fácil consulta.
            </p>
          </div>
        ) : (
          qAndAs.map((pair, idx) => (
            <div
              key={idx}
              className="rounded-xl border border-white/[0.06] bg-[#121218]/90 p-3 shadow-sm backdrop-blur-md space-y-2"
            >
              <div className="text-[10px] font-bold text-zinc-400 uppercase tracking-wider">
                Momento #{idx + 1}
              </div>
              <div className="p-2 rounded bg-white/[0.03] border border-white/[0.04]">
                <div className="text-[10px] text-zinc-400 mb-1 font-semibold">
                  {pair.question.role === 'interlocutor' ? 'INTERLOCUTOR PERGUNTOU:' : 'VOCÊ FALOU:'}
                </div>
                <p className="text-zinc-200 text-[11px] italic">“{pair.question.text}”</p>
              </div>

              {pair.answer ? (
                <div className="p-2 rounded bg-emerald-950/20 border border-emerald-500/20">
                  <div className="flex items-center justify-between text-[10px] text-emerald-300 mb-1 font-semibold">
                    <span>RESPOSTA DA IA:</span>
                    <button
                      type="button"
                      onClick={() => handleCopy(pair.answer.text, `sess-${idx}`)}
                      className="p-1 hover:bg-emerald-500/20 rounded cursor-pointer"
                    >
                      {copiedId === `sess-${idx}` ? (
                        <Check size={10} className="text-emerald-400" />
                      ) : (
                        <Copy size={10} />
                      )}
                    </button>
                  </div>
                  <p className="text-zinc-100 text-[11px] leading-relaxed line-clamp-4">
                    {pair.answer.text}
                  </p>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() =>
                    onTriggerCopilot?.(pair.question.text, {
                      provider: agentSettings?.provider,
                      model: agentSettings?.currentModelId,
                      reasoningEffort: agentSettings?.currentReasoning,
                      fastMode: agentSettings?.fastMode,
                    })
                  }
                  className="w-full py-1 rounded bg-blue-500/15 hover:bg-blue-500/25 border border-blue-500/30 text-blue-300 text-[10px] font-semibold transition cursor-pointer"
                >
                  Gerar sugestão para este momento
                </button>
              )}
            </div>
          ))
        )}
      </>
    );
  }

  return null;
}
