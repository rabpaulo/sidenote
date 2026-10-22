import React, { useState } from 'react';
import { X, CalendarDays, Loader2, LogOut, ExternalLink, Check, RefreshCw, Users, FileText } from 'lucide-react';

const SETUP_URL = 'https://console.cloud.google.com/apis/credentials';

export function eventTimeLabel(event) {
  if (!event?.start) return '';
  const start = new Date(event.start);
  const day = start.toDateString() === new Date().toDateString() ? 'Hoje' : start.toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit' });
  if (event.allDay) return `${day} · dia inteiro`;
  const time = (ms) => new Date(ms).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  return `${day} · ${time(event.start)}${event.end ? `–${time(event.end)}` : ''}`;
}

function ClientForm({ google, onCancel }) {
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const submit = async (event) => {
    event.preventDefault();
    if (await google.saveClient(clientId.trim(), clientSecret.trim())) {
      setClientId('');
      setClientSecret('');
      onCancel?.();
    }
  };
  return (
    <form onSubmit={submit} className="rounded-xl border border-neutral-800/80 bg-neutral-900/30 p-3 space-y-2">
      <h3 className="font-semibold text-neutral-100">{onCancel ? 'Seu próprio cliente OAuth' : '1. Cliente OAuth do Google'}</h3>
      {!onCancel && (
        <p className="text-[11px] text-neutral-400 leading-relaxed">
          O Sidenote não traz um cliente do Google embutido. Crie o seu uma vez no Google Cloud (uns 5 minutos, gratuito):
        </p>
      )}
      <ol className="list-decimal pl-4 space-y-0.5 text-[11px] text-neutral-400 leading-relaxed">
        <li>No Google Cloud, crie um projeto e ative as APIs <b>Google Calendar</b>, <b>Google Docs</b> e <b>Google Drive</b>.</li>
        <li>Em <b>Tela de consentimento OAuth</b>, escolha “Externo” e adicione seu e-mail como usuário de teste.</li>
        <li>Em <b>Credenciais</b>, crie um “ID do cliente OAuth” do tipo <b>App para computador</b> e cole os dados abaixo.</li>
      </ol>
      <a href={SETUP_URL} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[11px] text-accent-300 hover:text-accent-200">
        Abrir o Google Cloud <ExternalLink size={10} />
      </a>
      <input
        value={clientId}
        onChange={(event) => setClientId(event.target.value)}
        placeholder="Client ID (…apps.googleusercontent.com)"
        spellCheck={false}
        aria-label="Client ID do Google"
        className="w-full rounded-lg border border-neutral-800 bg-black/40 px-2.5 py-1.5 font-mono text-[11px] text-neutral-100 outline-none focus:border-accent-500/60"
      />
      <input
        type="password"
        value={clientSecret}
        onChange={(event) => setClientSecret(event.target.value)}
        placeholder="Client secret"
        autoComplete="off"
        spellCheck={false}
        aria-label="Client secret do Google"
        className="w-full rounded-lg border border-neutral-800 bg-black/40 px-2.5 py-1.5 font-mono text-[11px] text-neutral-100 outline-none focus:border-accent-500/60"
      />
      <div className="flex items-center gap-3">
        <button type="submit" disabled={!clientId.trim() || google.busy === 'client'} className="px-3 py-1.5 rounded-lg bg-accent-500/20 border border-accent-500/30 text-accent-100 hover:bg-accent-500/30 disabled:opacity-40 cursor-pointer disabled:cursor-default">
          Salvar cliente
        </button>
        {onCancel && <button type="button" onClick={onCancel} className="text-[11px] text-neutral-400 underline hover:text-white cursor-pointer">Cancelar</button>}
      </div>
    </form>
  );
}

function EventList({ google }) {
  const { events, event: chosen, busy } = google;
  if (events === null) return <p className="flex items-center gap-1.5 text-neutral-400"><Loader2 size={12} className="animate-spin" /> Lendo a agenda…</p>;
  if (!events.length) return <p className="text-neutral-500">Nenhum evento entre agora e amanhã.</p>;
  return (
    <ul className="space-y-1.5">
      {events.map((event) => {
        const selected = chosen?.id === event.id;
        return (
          <li key={event.id} className={`rounded-lg border px-2.5 py-2 ${selected ? 'border-accent-500/40 bg-accent-950/20' : 'border-neutral-800/80 bg-neutral-900/30'}`}>
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <p className="font-semibold text-neutral-100 truncate">{event.title}</p>
                <p className="text-[10px] text-neutral-500">
                  {eventTimeLabel(event)}
                  {event.attendees.length > 0 && <> · <Users size={9} className="inline -mt-0.5" /> {event.attendees.length}</>}
                  {event.attachments.length > 0 && <> · <FileText size={9} className="inline -mt-0.5" /> {event.attachments.length}</>}
                </p>
              </div>
              <button
                type="button"
                onClick={() => (selected ? google.clearEvent() : google.chooseEvent(event.id))}
                disabled={busy === `event:${event.id}`}
                className={`shrink-0 flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] border cursor-pointer ${selected ? 'border-accent-500/40 text-accent-100' : 'border-neutral-700 text-neutral-300 hover:bg-white/5'}`}
              >
                {busy === `event:${event.id}` ? <Loader2 size={11} className="animate-spin" /> : selected ? <Check size={11} /> : null}
                {selected ? 'Em uso' : 'Usar nesta reunião'}
              </button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/** Google account: OAuth client, sign-in, calendar events for the meeting and Docs. */
export function GoogleModal({ isOpen, onClose, google }) {
  const [ownClient, setOwnClient] = useState(false);
  if (!isOpen) return null;
  const { status, error } = google;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 overflow-y-auto">
      <div className="fixed inset-0 bg-black/80 backdrop-blur-md" onClick={onClose} />
      <div role="dialog" aria-modal="true" aria-labelledby="google-title" className="relative w-full max-w-lg rounded-2xl border border-neutral-800 bg-[#0e0e14] shadow-2xl overflow-hidden z-10 flex flex-col max-h-[90vh] text-[12px]">
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-neutral-800/80 bg-neutral-950/60">
          <h2 id="google-title" className="flex items-center gap-2 text-base font-bold text-white tracking-tight">
            <CalendarDays size={16} className="text-accent-300" />
            Google Agenda e Docs
          </h2>
          <button type="button" onClick={onClose} aria-label="Fechar" className="p-1.5 rounded-lg text-neutral-400 hover:text-white hover:bg-neutral-800/80 transition cursor-pointer">
            <X size={16} />
          </button>
        </div>

        <div className="p-5 overflow-y-auto space-y-3">
          <p className="text-neutral-400 leading-relaxed">
            Com o Google conectado, a reunião da agenda (título, participantes, descrição e Docs anexados) entra no contexto das sugestões e do resumo,
            você importa um Google Docs no <b className="text-neutral-200">Meu contexto</b> e salva reuniões no Google Docs.
          </p>
          {error && (
            <p role="alert" className="flex items-start justify-between gap-2 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-rose-200">
              <span>{error}</span>
              <button type="button" onClick={google.clearError} aria-label="Fechar aviso" className="cursor-pointer"><X size={11} /></button>
            </p>
          )}
          {status?.error && <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-amber-200">{status.error}</p>}

          {!status ? (
            <p className="flex items-center gap-1.5 text-neutral-400"><Loader2 size={12} className="animate-spin" /> Carregando…</p>
          ) : !status.configured ? (
            <ClientForm google={google} />
          ) : !status.connected && ownClient ? (
            <ClientForm google={google} onCancel={() => setOwnClient(false)} />
          ) : !status.connected ? (
            <section className="rounded-xl border border-neutral-800/80 bg-neutral-900/30 p-3 space-y-2">
              <h3 className="font-semibold text-neutral-100">{status.clientSource === 'bundled' ? 'Entrar com o Google' : '2. Entrar com o Google'}</h3>
              <p className="text-neutral-400 leading-relaxed">
                O login abre no navegador. O Sidenote pede só leitura da agenda e dos Docs, e acesso aos arquivos que ele mesmo criar no Drive.
              </p>
              {status.clientSource === 'bundled' && (
                <p className="text-[11px] text-neutral-500 leading-relaxed">
                  Se o Google avisar que o app não foi verificado, clique em <b className="text-neutral-300">Avançado</b> e depois em <b className="text-neutral-300">Acessar Sidenote</b>.
                </p>
              )}
              {status.connecting ? (
                <div className="flex items-center gap-2 text-neutral-300">
                  <Loader2 size={12} className="animate-spin" /> Aguardando o login no navegador…
                  <button type="button" onClick={google.cancelConnect} className="ml-auto text-[11px] text-neutral-400 underline hover:text-white cursor-pointer">Cancelar</button>
                </div>
              ) : (
                <button type="button" onClick={google.connect} disabled={google.busy === 'connect'} className="px-3 py-1.5 rounded-lg bg-accent-200 text-neutral-950 font-semibold hover:bg-white disabled:opacity-50 cursor-pointer">
                  Conectar conta Google
                </button>
              )}
              <p className="text-[10px] text-neutral-600">
                {status.clientSource === 'bundled' ? (
                  <button type="button" onClick={() => setOwnClient(true)} className="underline hover:text-neutral-300 cursor-pointer">Usar meu próprio cliente OAuth</button>
                ) : (
                  <>
                    Cliente {status.clientHint}{status.clientSource === 'env' ? ' (variável de ambiente)' : ''}.{' '}
                    {status.clientSource === 'saved' && (
                      <button type="button" onClick={google.removeClient} className="underline hover:text-neutral-300 cursor-pointer">
                        {status.bundledClient ? 'Voltar ao cliente do Sidenote' : 'Trocar cliente'}
                      </button>
                    )}
                  </>
                )}
              </p>
            </section>
          ) : (
            <>
              <div className="flex items-center gap-2 rounded-xl border border-emerald-500/20 bg-emerald-500/5 px-3 py-2 text-emerald-200">
                <Check size={13} />
                <span className="truncate">Conectado{status.email ? ` como ${status.email}` : ''}</span>
                <button type="button" onClick={google.disconnect} disabled={google.busy === 'disconnect'} className="ml-auto flex items-center gap-1 text-[11px] text-neutral-400 hover:text-rose-300 cursor-pointer">
                  <LogOut size={11} /> Desconectar
                </button>
              </div>
              <section className="space-y-2">
                <div className="flex items-center justify-between">
                  <h3 className="text-[11px] font-semibold uppercase tracking-wider text-neutral-500">Agenda · agora até amanhã</h3>
                  <button type="button" onClick={google.refreshEvents} disabled={google.busy === 'events'} className="flex items-center gap-1 text-[11px] text-neutral-400 hover:text-white cursor-pointer">
                    <RefreshCw size={11} className={google.busy === 'events' ? 'animate-spin' : ''} /> Atualizar
                  </button>
                </div>
                <EventList google={google} />
                {google.event?.documents?.length > 0 && (
                  <p className="text-[10px] text-neutral-500">
                    Docs anexados no contexto: {google.event.documents.map((doc) => doc.title).join(', ')}.
                  </p>
                )}
              </section>
              <p className="text-[10px] text-neutral-500 leading-relaxed">
                Google Docs: importe um documento em <b>Meu contexto</b> (Perfil ou Conversa) e salve reuniões pelo botão do Docs no Resumo ou no Histórico.
              </p>
            </>
          )}
          {google.file && <p className="text-[10px] text-neutral-600 font-mono break-all">Credenciais em {google.file}</p>}
        </div>
      </div>
    </div>
  );
}
