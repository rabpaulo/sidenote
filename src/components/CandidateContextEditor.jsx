import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { X, Plus, Trash2, FileText, UserRound, BookOpen, Building2, StickyNote, Loader2 } from 'lucide-react';
import { DocumentDropZone } from './DocumentDropZone.jsx';
import {
  composeCandidateContext,
  mergeImportedFields,
  normalizeProfile,
  LANGUAGE_SUGGESTIONS,
  MAX_CONTEXT_CHARS,
  MAX_EXPERIENCES,
  MAX_STACK_ITEMS,
  SENIORITY_OPTIONS,
} from '../../shared/candidate-profile.js';
import { apiFetch } from '../backend.js';

const TABS = [
  { id: 'profile', label: 'Perfil', Icon: UserRound },
  { id: 'experiences', label: 'Experiências', Icon: BookOpen },
  { id: 'job', label: 'Conversa', Icon: Building2 },
  { id: 'extras', label: 'Extras', Icon: StickyNote },
];

const JOB_FIELDS = ['jobCompany', 'jobRole', 'jobCompanyContext', 'jobRequirements', 'motivation'];
const filled = (value) => (Array.isArray(value) ? value.length > 0 : Boolean(value?.trim?.()));
const TAB_FILLED = {
  profile: (p) => ['name', 'role', 'seniority', 'years', 'preferredLanguage', 'summary', 'stack'].some((k) => filled(p[k])),
  experiences: (p) => p.experiences.some((e) => filled(e.title) || filled(e.story)),
  job: (p) => JOB_FIELDS.some((k) => filled(p[k])),
  extras: (p) => filled(p.notes),
};

function Field({ label, hint, children, htmlFor }) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={htmlFor} className="block text-[11px] font-medium text-zinc-300">{label}</label>
      {children}
      {hint && <p className="text-[11px] leading-snug text-zinc-500">{hint}</p>}
    </div>
  );
}

function TextInput({ id, value, onChange, ...props }) {
  return <input id={id} type="text" value={value} onChange={(e) => onChange(e.target.value)} className="app-field" {...props} />;
}

function TextArea({ id, value, onChange, rows = 3, ...props }) {
  return <textarea id={id} value={value} onChange={(e) => onChange(e.target.value)} rows={rows} className="app-field resize-y leading-relaxed" {...props} />;
}

function Chip({ active, onClick, children }) {
  return (
    <button type="button" onClick={onClick} aria-pressed={active} className={`app-chip ${active ? 'app-chip--on' : ''}`}>
      {children}
    </button>
  );
}

function TagInput({ id, tags, onChange, placeholder }) {
  const [draft, setDraft] = useState('');
  const add = (raw) => {
    const items = raw.split(',').map((item) => item.trim()).filter(Boolean);
    if (items.length) onChange(normalizeProfile({ stack: [...tags, ...items] }).stack);
    setDraft('');
  };
  return (
    <div className="app-field flex flex-wrap items-center gap-1.5 !py-1.5">
      {tags.map((tag) => (
        <span key={tag} className="app-tag">
          {tag}
          <button type="button" onClick={() => onChange(tags.filter((t) => t !== tag))} aria-label={`Remover ${tag}`} className="text-zinc-400 hover:text-white cursor-pointer">
            <X size={11} />
          </button>
        </span>
      ))}
      <input
        id={id}
        type="text"
        value={draft}
        disabled={tags.length >= MAX_STACK_ITEMS}
        onChange={(e) => (e.target.value.includes(',') ? add(e.target.value) : setDraft(e.target.value))}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); add(draft); }
          if (e.key === 'Backspace' && !draft && tags.length) onChange(tags.slice(0, -1));
        }}
        onBlur={() => add(draft)}
        placeholder={tags.length ? '' : placeholder}
        className="flex-1 min-w-[90px] bg-transparent text-xs text-zinc-100 placeholder-zinc-500 focus:outline-none py-0.5"
      />
    </div>
  );
}

function ProfileTab({ draft, set, uid, onImport, googleConnected, interviewMode }) {
  return (
    <div className="space-y-4">
      <DocumentDropZone
        kind="cv"
        title="Importar currículo ou bio"
        hint="Arraste um currículo, bio ou perfil do LinkedIn (PDF, DOCX, TXT)."
        onImported={onImport}
        googleConnected={googleConnected}
      />
      <Field label="Nome" htmlFor={`${uid}-name`}>
        <TextInput id={`${uid}-name`} value={draft.name} onChange={(v) => set('name', v)} maxLength={80} placeholder="Como você se apresenta" />
      </Field>
      <div className="grid grid-cols-[1fr_92px] gap-3">
        <Field label="Cargo atual" htmlFor={`${uid}-role`}>
          <TextInput id={`${uid}-role`} value={draft.role} onChange={(v) => set('role', v)} maxLength={120} placeholder="Ex.: Desenvolvedor Full Stack" />
        </Field>
        <Field label="Anos de exp." htmlFor={`${uid}-years`}>
          <TextInput id={`${uid}-years`} value={draft.years} onChange={(v) => set('years', v.replace(/\D/g, '').slice(0, 2))} inputMode="numeric" placeholder="Ex.: 5" />
        </Field>
      </div>
      {interviewMode && (
        <>
          <Field label="Nível">
            <div className="flex flex-wrap gap-1.5" role="group" aria-label="Nível">
              {SENIORITY_OPTIONS.map((option) => (
                <Chip key={option} active={draft.seniority === option} onClick={() => set('seniority', draft.seniority === option ? '' : option)}>{option}</Chip>
              ))}
            </div>
          </Field>
          <Field label="Linguagem preferida" htmlFor={`${uid}-language`} hint="Usada nas soluções de código quando a pergunta não pede outra linguagem.">
            <TextInput id={`${uid}-language`} value={draft.preferredLanguage} onChange={(v) => set('preferredLanguage', v)} maxLength={40} placeholder="Ex.: TypeScript" />
            <div className="flex flex-wrap gap-1.5 pt-0.5">
              {LANGUAGE_SUGGESTIONS.map((language) => (
                <Chip key={language} active={draft.preferredLanguage.trim().toLowerCase() === language.toLowerCase()} onClick={() => set('preferredLanguage', language)}>{language}</Chip>
              ))}
            </div>
          </Field>
        </>
      )}
      <Field label="Áreas e ferramentas que você domina" htmlFor={`${uid}-stack`} hint="Enter ou vírgula para adicionar.">
        <TagInput id={`${uid}-stack`} tags={draft.stack} onChange={(v) => set('stack', v)} placeholder="Ex.: Vendas B2B, React, Power BI" />
      </Field>
      <Field label="Resumo profissional" htmlFor={`${uid}-summary`}>
        <TextArea id={`${uid}-summary`} value={draft.summary} onChange={(v) => set('summary', v)} maxLength={1500} placeholder="2 ou 3 frases sobre sua trajetória, sua função e no que você trabalha hoje." />
      </Field>
    </div>
  );
}

function ExperiencesTab({ draft, set, uid }) {
  const [focusIndex, setFocusIndex] = useState(null);
  const update = (index, key, value) => set('experiences', draft.experiences.map((item, i) => (i === index ? { ...item, [key]: value } : item)));
  return (
    <div className="space-y-3">
      <p className="text-[11px] leading-relaxed text-zinc-400">
        Projetos e casos reais que você pode citar numa conversa: o problema, o que foi feito e o resultado. A IA não inventa detalhes além do que estiver aqui.
      </p>
      {draft.experiences.map((item, index) => (
        <div key={index} className="app-context-card space-y-2.5">
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">#{index + 1}</span>
            <input
              type="text"
              value={item.title}
              onChange={(e) => update(index, 'title', e.target.value)}
              maxLength={120}
              autoFocus={focusIndex === index}
              aria-label={`Título da experiência ${index + 1}`}
              placeholder="Projeto ou situação"
              className="flex-1 min-w-0 bg-transparent text-xs font-medium text-zinc-100 placeholder-zinc-500 focus:outline-none"
            />
            <button
              type="button"
              onClick={() => set('experiences', draft.experiences.filter((_, i) => i !== index))}
              aria-label={`Remover experiência ${index + 1}`}
              title="Remover"
              className="p-1 rounded-md text-zinc-500 hover:text-red-300 hover:bg-red-500/10 cursor-pointer"
            >
              <Trash2 size={13} />
            </button>
          </div>
          <TextArea
            id={`${uid}-exp-${index}`}
            value={item.story}
            onChange={(v) => update(index, 'story', v)}
            rows={4}
            maxLength={1500}
            aria-label={`Descrição da experiência ${index + 1}`}
            placeholder="Qual era o problema? O que você decidiu e fez? O que aconteceu depois e o que aprendeu?"
          />
        </div>
      ))}
      {draft.experiences.length === 0 && (
        <div className="rounded-xl border border-dashed border-white/10 px-4 py-6 text-center text-[11px] text-zinc-500">
          Nenhuma experiência ainda.
        </div>
      )}
      <button
        type="button"
        disabled={draft.experiences.length >= MAX_EXPERIENCES}
        onClick={() => {
          setFocusIndex(draft.experiences.length);
          set('experiences', [...draft.experiences, { title: '', story: '' }]);
        }}
        className="app-quiet-button w-full flex items-center justify-center gap-1.5 rounded-xl border border-white/10 px-3 py-2 text-xs text-zinc-200 cursor-pointer disabled:opacity-40"
      >
        <Plus size={13} />
        {draft.experiences.length >= MAX_EXPERIENCES ? `Limite de ${MAX_EXPERIENCES} experiências` : 'Adicionar experiência'}
      </button>
    </div>
  );
}

function JobTab({ draft, set, uid, onImport, googleConnected }) {
  const hasJob = TAB_FILLED.job(draft);
  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <p className="text-[11px] leading-relaxed text-zinc-400">A reunião de agora: com quem é e o que está em jogo. Atualize antes de cada uma.</p>
        {hasJob && (
          <button
            type="button"
            onClick={() => JOB_FIELDS.forEach((key) => set(key, ''))}
            className="shrink-0 text-[11px] text-zinc-500 hover:text-zinc-200 underline-offset-2 hover:underline cursor-pointer"
          >
            Limpar conversa
          </button>
        )}
      </div>
      <DocumentDropZone
        kind="job"
        title="Importar material da reunião"
        hint="Arraste a pauta, uma proposta ou material da empresa (PDF, DOCX, TXT)."
        onImported={onImport}
        googleConnected={googleConnected}
      />
      <div className="grid grid-cols-2 gap-3">
        <Field label="Empresa" htmlFor={`${uid}-company`}>
          <TextInput id={`${uid}-company`} value={draft.jobCompany} onChange={(v) => set('jobCompany', v)} maxLength={120} placeholder="Ex.: cliente, parceiro ou seu time" />
        </Field>
        <Field label="Assunto" htmlFor={`${uid}-job-role`}>
          <TextInput id={`${uid}-job-role`} value={draft.jobRole} onChange={(v) => set('jobRole', v)} maxLength={120} placeholder="Ex.: Renovação do contrato" />
        </Field>
      </div>
      <Field label="Sobre a empresa e os produtos" htmlFor={`${uid}-company-context`} hint="A IA conecta as respostas a esse contexto quando fizer sentido.">
        <TextArea id={`${uid}-company-context`} value={draft.jobCompanyContext} onChange={(v) => set('jobCompanyContext', v)} rows={4} maxLength={2000} placeholder="O que a empresa faz, produtos (por exemplo, de IA ou de infraestrutura), clientes, stack, momento do time…" />
      </Field>
      <Field label="Pontos importantes" htmlFor={`${uid}-requirements`}>
        <TextArea id={`${uid}-requirements`} value={draft.jobRequirements} onChange={(v) => set('jobRequirements', v)} rows={5} maxLength={1500} placeholder="Pauta, requisitos, dúvidas que devem aparecer, números que precisam estar à mão…" />
      </Field>
      <Field label="Seu objetivo na conversa" htmlFor={`${uid}-motivation`}>
        <TextArea id={`${uid}-motivation`} value={draft.motivation} onChange={(v) => set('motivation', v)} maxLength={800} placeholder="O que você quer que saia da reunião: fechar o escopo, alinhar prazos, aprovar uma proposta…" />
      </Field>
    </div>
  );
}

function ExtrasTab({ draft, set, uid, file, preview }) {
  const [importing, setImporting] = useState(false);
  const [message, setMessage] = useState(null);
  const requestRef = useRef(null);
  useEffect(() => () => requestRef.current?.abort(), []);

  async function importFile() {
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    const timer = setTimeout(() => controller.abort(), 10000);
    setImporting(true);
    setMessage(null);
    try {
      const response = await apiFetch('/api/candidate-context/file', { signal: controller.signal, cache: 'no-store' });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Não foi possível carregar o contexto.md.');
      const notes = [draft.notes.trim(), result.text].filter(Boolean).join('\n\n');
      if (notes.length > 6000) throw new Error('As notas ficariam com mais de 6.000 caracteres. Reduza o texto antes de importar.');
      set('notes', notes);
      setMessage({ ok: true, text: 'contexto.md adicionado às notas. Revise e salve.' });
    } catch (failure) {
      if (requestRef.current === controller) {
        setMessage({ ok: false, text: controller.signal.aborted ? 'A leitura demorou demais. Tente novamente.' : failure.message });
      }
    } finally {
      clearTimeout(timer);
      if (requestRef.current === controller) {
        requestRef.current = null;
        setImporting(false);
      }
    }
  }

  return (
    <div className="space-y-4">
      <Field label="Outras informações" htmlFor={`${uid}-notes`} hint="Fatos que a IA pode citar quando perguntarem.">
        <TextArea id={`${uid}-notes`} value={draft.notes} onChange={(v) => set('notes', v)} rows={7} maxLength={6000} placeholder="Preços e condições, prazos, disponibilidade, números do time, links úteis…" autoFocus />
      </Field>
      <div className="space-y-1.5">
        <button type="button" onClick={importFile} disabled={importing} className="app-quiet-button flex items-center gap-1.5 rounded-lg border border-white/10 px-3 py-1.5 text-xs text-zinc-200 cursor-pointer disabled:opacity-50">
          {importing ? <Loader2 size={12} className="animate-spin" /> : <FileText size={12} />}
          {importing ? 'Lendo arquivo…' : 'Importar contexto.md'}
        </button>
        {message && <p role={message.ok ? 'status' : 'alert'} className={`text-[11px] ${message.ok ? 'text-zinc-400' : 'text-red-300'}`}>{message.text}</p>}
      </div>
      <details className="app-context-card">
        <summary className="cursor-pointer text-[11px] font-medium text-zinc-300">Ver o texto enviado à IA</summary>
        <pre className="mt-2 max-h-56 overflow-y-auto whitespace-pre-wrap break-words text-[11px] leading-relaxed text-zinc-400 font-sans select-text">
          {preview || 'Nada preenchido ainda.'}
        </pre>
      </details>
      {file && (
        <p className="text-[11px] leading-relaxed text-zinc-500">
          Salvo em <code className="break-all text-zinc-400">{file}</code>. Continua lá ao reiniciar ou reinstalar o app; para apagar, limpe os campos e salve.
        </p>
      )}
    </div>
  );
}

export function CandidateContextEditor({ profile, file, status, loadError, onRetry, onSave, onClose, googleConnected = false, interviewMode = false }) {
  const uid = useId();
  const [tab, setTab] = useState('profile');
  const [draft, setDraft] = useState(() => normalizeProfile(profile));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const baseline = useRef(JSON.stringify(normalizeProfile(profile)));

  // The profile can arrive after the sheet opens (slow backend); adopt it while untouched.
  useEffect(() => {
    const previous = baseline.current;
    baseline.current = JSON.stringify(normalizeProfile(profile));
    setDraft((current) => (JSON.stringify(current) === previous ? normalizeProfile(profile) : current));
  }, [profile]);

  const preview = useMemo(() => composeCandidateContext(draft), [draft]);
  const dirty = JSON.stringify(draft) !== baseline.current;
  const tooLong = preview.length > MAX_CONTEXT_CHARS;
  const ready = status === 'ready';
  const set = (key, value) => {
    setDraft((current) => ({ ...current, [key]: value }));
    setConfirmDiscard(false);
  };

  const requestClose = () => (dirty ? setConfirmDiscard(true) : onClose());

  async function save() {
    if (!ready || !dirty || tooLong || saving) return;
    setSaving(true);
    setError('');
    try {
      await onSave(draft);
      onClose();
    } catch (failure) {
      setError(failure.message);
      setSaving(false);
    }
  }

  const latest = useRef({});
  latest.current = { save, requestClose };
  useEffect(() => {
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') { event.preventDefault(); latest.current.requestClose(); }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); latest.current.save(); }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const importFields = (fields) => {
    setDraft((current) => mergeImportedFields(current, fields));
    setConfirmDiscard(false);
  };
  const panelProps = { draft, set, uid, onImport: importFields, googleConnected, interviewMode };

  return (
    <div role="dialog" aria-modal="true" aria-labelledby={`${uid}-title`} className="app-context-editor fixed inset-0 z-50 flex flex-col select-text">
      <header className="flex items-start gap-3 px-4 pt-4 pb-2">
        <div className="min-w-0 flex-1">
          <h2 id={`${uid}-title`} className="text-sm font-semibold text-zinc-100">Meu contexto</h2>
          <p className="text-[11px] text-zinc-500">A IA usa estes dados para personalizar cada resposta.</p>
        </div>
        <button type="button" onClick={requestClose} aria-label="Fechar meu contexto" className="app-quiet-button p-1.5 -mr-1 rounded-lg text-zinc-400 cursor-pointer">
          <X size={16} />
        </button>
      </header>

      <div role="tablist" aria-label="Seções do contexto" className="app-context-tabs flex gap-1 px-3">
        {TABS.map(({ id, label, Icon }) => {
          const count = id === 'experiences' ? draft.experiences.length : 0;
          return (
            <button
              key={id}
              type="button"
              role="tab"
              id={`${uid}-tab-${id}`}
              aria-selected={tab === id}
              aria-controls={`${uid}-panel`}
              onClick={() => setTab(id)}
              className="app-context-tab"
            >
              <Icon size={13} />
              <span>{label}</span>
              {count > 0 ? <span className="app-context-tab__count">{count}</span> : TAB_FILLED[id](draft) && <span className="app-context-tab__dot" aria-label="preenchido" />}
            </button>
          );
        })}
      </div>

      <div id={`${uid}-panel`} role="tabpanel" aria-labelledby={`${uid}-tab-${tab}`} className="flex-1 overflow-y-auto px-4 py-4">
        {status === 'loading' && (
          <p className="flex items-center gap-2 text-xs text-zinc-400"><Loader2 size={13} className="animate-spin" /> Carregando seu perfil…</p>
        )}
        {status === 'error' && (
          <div role="alert" className="space-y-2 text-xs text-red-300">
            <p>{loadError || 'Não foi possível carregar o perfil.'}</p>
            <button type="button" onClick={onRetry} className="app-quiet-button rounded-lg border border-white/10 px-3 py-1.5 text-zinc-200 cursor-pointer">Tentar novamente</button>
          </div>
        )}
        {ready && tab === 'profile' && <ProfileTab {...panelProps} />}
        {ready && tab === 'experiences' && <ExperiencesTab {...panelProps} />}
        {ready && tab === 'job' && <JobTab {...panelProps} />}
        {ready && tab === 'extras' && <ExtrasTab {...panelProps} file={file} preview={preview} />}
      </div>

      <footer className="app-context-footer px-4 py-3">
        {confirmDiscard ? (
          <div className="flex items-center gap-2">
            <span className="flex-1 text-xs text-zinc-300">Descartar alterações?</span>
            <button type="button" onClick={() => setConfirmDiscard(false)} className="text-xs text-zinc-400 hover:text-white px-3 py-2 cursor-pointer">Continuar editando</button>
            <button type="button" onClick={onClose} className="rounded-full bg-red-500/15 border border-red-500/30 px-4 py-2 text-xs font-semibold text-red-200 hover:bg-red-500/25 cursor-pointer">Descartar</button>
          </div>
        ) : (
          <>
            {(error || tooLong) && (
              <p role="alert" className="mb-2 text-[11px] text-red-300">
                {error || `O contexto passou de ${MAX_CONTEXT_CHARS.toLocaleString('pt-BR')} caracteres. Reduza alguns campos para salvar.`}
              </p>
            )}
            <div className="flex items-center gap-2">
              <span className={`flex-1 text-[11px] tabular-nums ${tooLong ? 'text-red-300' : 'text-zinc-500'}`}>
                {dirty ? 'Alterações não salvas · ' : ''}
                {preview.length.toLocaleString('pt-BR')} / {MAX_CONTEXT_CHARS.toLocaleString('pt-BR')}
              </span>
              <button type="button" onClick={requestClose} className="text-xs text-zinc-400 hover:text-white px-3 py-2 cursor-pointer">Cancelar</button>
              <button
                type="button"
                onClick={save}
                disabled={!ready || !dirty || tooLong || saving}
                title="Salvar (Ctrl+S)"
                className="app-primary-button flex items-center gap-1.5 bg-white text-black rounded-full px-4 py-2 text-xs font-semibold cursor-pointer disabled:opacity-40"
              >
                {saving && <Loader2 size={12} className="animate-spin" />}
                {saving ? 'Salvando…' : 'Salvar'}
              </button>
            </div>
          </>
        )}
      </footer>
    </div>
  );
}
