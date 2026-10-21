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

function ClientForm({ google }) {
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const submit = async (event) => {
    event.preventDefault();
    if (await google.saveClient(clientId.trim(), clientSecret.trim())) {
      setClientId('');
      setClientSecret('');
    }
  };
  return (
    <form onSubmit={submit} className="rounded-xl border border-zinc-800/80 bg-zinc-900/30 p-3 space-y-2">
      <h3 className="font-semibold text-zinc-100">1. Cliente OAuth do Google</h3>
      <ol className="list-decimal pl-4 space-y-0.5 text-[11px] text-zinc-400 leading-relaxed">
        <li>No Google Cloud, crie um projeto e ative as APIs <b>Google Calendar</b>, <b>Google Docs</b> e <b>Google Drive</b>.</li>
        <li>Em <b>Tela de consentimento OAuth</b>, escolha “Externo” e adicione seu e-mail como usuário de teste.</li>
        <li>Em <b>Credenciais</b>, crie um “ID do cliente OAuth” do tipo <b>App para computador</b> e cole os dados abaixo.</li>
      </ol>
      <a href={SETUP_URL} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[11px] text-blue-300 hover:text-blue-200">
        Abrir o Google Cloud <ExternalLink size={10} />
      </a>
      <input
        value={clientId}
        onChange={(event) => setClientId(event.target.value)}
        placeholder="Client ID (…apps.googleusercontent.com)"
        spellCheck={false}
        aria-label="Client ID do Google"
        className="w-full rounded-lg border border-zinc-800 bg-black/40 px-2.5 py-1.5 font-mono text-[11px] text-zinc-100 outline-none focus:border-blue-500/60"
      />
      <input
        type="password"
        value={clientSecret}
        onChange={(event) => setClientSecret(event.target.value)}
        placeholder="Client secret"
        autoComplete="off"
        spellCheck={false}
        aria-label="Client secret do Google"
        className="w-full rounded-lg border border-zinc-800 bg-black/40 px-2.5 py-1.5 font-mono text-[11px] text-zinc-100 outline-none focus:border-blue-500/60"
      />
      <button type="submit" disabled={!clientId.trim() || google.busy === 'client'} className="px-3 py-1.5 rounded-lg bg-blue-500/20 border border-blue-500/30 text-blue-100 hover:bg-blue-500/30 disabled:opacity-40 cursor-pointer disabled:cursor-default">
        Salvar cliente
      </button>
    </form>
  );
}

function EventList({ google }) {
  const { events, event: chosen, busy } = google;
  if (events === null) return <p className="flex items-center gap-1.5 text-zinc-400"><Loader2 size={12} className="animate-spin" /> Lendo a agenda…</p>;
  if (!events.length) return <p className="text-zinc-500">Nenhum evento entre agora e amanhã.</p>;
  return (
    <ul className="space-y-1.5">
      {events.map((event) => {
        const selected = chosen?.id === event.id;
        return (
          <li key={event.id} className={`rounded-lg border px-2.5 py-2 ${selected ? 'border-blue-500/40 bg-blue-950/20' : 'border-zinc-800/80 bg-zinc-900/30'}`}>
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <p className="font-semibold text-zinc-100 truncate">{event.title}</p>
                <p className="text-[10px] text-zinc-500">
                  {eventTimeLabel(event)}
                  {event.attendees.length > 0 && <> · <Users size={9} className="inline -mt-0.5" /> {event.attendees.length}</>}
                  {event.attachments.length > 0 && <> · <FileText size={9} className="inline -mt-0.5" /> {event.attachments.length}</>}
                </p>
              </div>
              <button
                type="button"
                onClick={() => (selected ? google.clearEvent() : google.chooseEvent(event.id))}
                disabled={busy === `event:${event.id}`}
                className={`shrink-0 flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] border cursor-pointer ${selected ? 'border-blue-500/40 text-blue-100' : 'border-zinc-700 text-zinc-300 hover:bg-white/5'}`}
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
  if (!isOpen) return null;
  const { status, error } = google;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 overflow-y-auto">
      <div className="fixed inset-0 bg-black/80 backdrop-blur-md" onClick={onClose} />
      <div role="dialog" aria-modal="true" aria-labelledby="google-title" className="relative w-full max-w-lg rounded-2xl border border-zinc-800 bg-[#0e0e14] shadow-2xl overflow-hidden z-10 flex flex-col max-h-[90vh] text-[12px]">
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-zinc-800/80 bg-zinc-950/60">
          <h2 id="google-title" className="flex items-center gap-2 text-base font-bold text-white tracking-tight">
            <CalendarDays size={16} className="text-blue-300" />
            Google Agenda e Docs
          </h2>
          <button type="button" onClick={onClose} aria-label="Fechar" className="p-1.5 rounded-lg text-zinc-400 hover:text-white hover:bg-zinc-800/80 transition cursor-pointer">
            <X size={16} />
          </button>
        </div>

        <div className="p-5 overflow-y-auto space-y-3">
          <p className="text-zinc-400 leading-relaxed">
            Com o Google conectado, a reunião da agenda (título, participantes, descrição e Docs anexados) entra no contexto das sugestões e do resumo,
            você importa um Google Docs no <b className="text-zinc-200">Meu contexto</b> e salva reuniões no Google Docs.
          </p>
          {error && (
            <p role="alert" className="flex items-start justify-between gap-2 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-rose-200">
              <span>{error}</span>
              <button type="button" onClick={google.clearError} aria-label="Fechar aviso" className="cursor-pointer"><X size={11} /></button>
            </p>
          )}
          {status?.error && <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-amber-200">{status.error}</p>}

          {!status ? (
            <p className="flex items-center gap-1.5 text-zinc-400"><Loader2 size={12} className="animate-spin" /> Carregando…</p>
          ) : !status.configured ? (
            <ClientForm google={google} />
          ) : !status.connected ? (
            <section className="rounded-xl border border-zinc-800/80 bg-zinc-900/30 p-3 space-y-2">
              <h3 className="font-semibold text-zinc-100">2. Entrar com o Google</h3>
              <p className="text-zinc-400 leading-relaxed">
                O login abre no navegador. O Sidenote pede só leitura da agenda e dos Docs, e acesso aos arquivos que ele mesmo criar no Drive.
              </p>
              {status.connecting ? (
                <div className="flex items-center gap-2 text-zinc-300">
                  <Loader2 size={12} className="animate-spin" /> Aguardando o login no navegador…
                  <button type="button" onClick={google.cancelConnect} className="ml-auto text-[11px] text-zinc-400 underline hover:text-white cursor-pointer">Cancelar</button>
                </div>
              ) : (
                <button type="button" onClick={google.connect} disabled={google.busy === 'connect'} className="px-3 py-1.5 rounded-lg bg-blue-500 text-white font-semibold hover:bg-blue-400 disabled:opacity-50 cursor-pointer">
                  Conectar conta Google
                </button>
              )}
              <p className="text-[10px] text-zinc-600">
                Cliente {status.clientHint}{status.clientSource === 'env' ? ' (variável de ambiente)' : ''}.{' '}
                {status.clientSource === 'saved' && (
                  <button type="button" onClick={google.removeClient} className="underline hover:text-zinc-300 cursor-pointer">Trocar cliente</button>
                )}
              </p>
            </section>
          ) : (
            <>
              <div className="flex items-center gap-2 rounded-xl border border-emerald-500/20 bg-emerald-500/5 px-3 py-2 text-emerald-200">
                <Check size={13} />
                <span className="truncate">Conectado{status.email ? ` como ${status.email}` : ''}</span>
                <button type="button" onClick={google.disconnect} disabled={google.busy === 'disconnect'} className="ml-auto flex items-center gap-1 text-[11px] text-zinc-400 hover:text-rose-300 cursor-pointer">
                  <LogOut size={11} /> Desconectar
                </button>
              </div>
              <section className="space-y-2">
                <div className="flex items-center justify-between">
                  <h3 className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">Agenda · agora até amanhã</h3>
                  <button type="button" onClick={google.refreshEvents} disabled={google.busy === 'events'} className="flex items-center gap-1 text-[11px] text-zinc-400 hover:text-white cursor-pointer">
                    <RefreshCw size={11} className={google.busy === 'events' ? 'animate-spin' : ''} /> Atualizar
                  </button>
                </div>
                <EventList google={google} />
                {google.event?.documents?.length > 0 && (
                  <p className="text-[10px] text-zinc-500">
                    Docs anexados no contexto: {google.event.documents.map((doc) => doc.title).join(', ')}.
                  </p>
                )}
              </section>
              <p className="text-[10px] text-zinc-500 leading-relaxed">
                Google Docs: importe um documento em <b>Meu contexto</b> (Perfil ou Vaga) e salve reuniões pelo botão do Docs no Resumo ou no Histórico.
              </p>
            </>
          )}
          {google.file && <p className="text-[10px] text-zinc-600 font-mono break-all">Credenciais em {google.file}</p>}
        </div>
      </div>
    </div>
  );
}
