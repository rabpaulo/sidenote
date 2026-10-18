import React, { useState } from 'react';
import { AppMenu } from './AppMenu.jsx';
import {
  Mic,
  MicOff,
  Keyboard,
  Send,
  X,
  UserRound,
} from 'lucide-react';

export function CompactBottomBar({
  isListening,
  isProcessing,
  toggleListening,
  onSendMessage,
  agentSettings,
  onOpenContext,
  hasContext,
  menuProps,
}) {
  const [showInputDrawer, setShowInputDrawer] = useState(false);
  const [textInput, setTextInput] = useState('');

  const handleTextSubmit = (e) => {
    e.preventDefault();
    if (!textInput.trim() || isProcessing) return;
    onSendMessage(textInput.trim(), 'text', {
      provider: agentSettings.provider,
      model: agentSettings.currentModelId,
      reasoningEffort: agentSettings.currentReasoning,
      fastMode: agentSettings.fastMode,
    });
    setTextInput('');
    setShowInputDrawer(false);
  };

  return (
    <div className="app-bottom-bar relative px-4 py-2.5">
      {/* Keyboard Input Drawer */}
      {showInputDrawer && (
        <form onSubmit={handleTextSubmit} className="mb-2 flex items-center gap-1.5">
          <input
            type="text"
            value={textInput}
            onChange={(e) => setTextInput(e.target.value)}
            placeholder="Digite sua dúvida ou comando..."
            autoFocus
            disabled={isProcessing}
            className="app-text-input flex-1 bg-white/[0.05] border border-white/[0.1] rounded-xl px-2.5 py-1.5 text-xs text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-blue-500/50"
          />
          <button
            type="submit"
            disabled={!textInput.trim() || isProcessing}
            className="app-primary-button px-2.5 py-1.5 rounded-full bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold flex items-center gap-1 transition cursor-pointer disabled:opacity-40"
          >
            <Send size={11} />
            <span>Enviar</span>
          </button>
          <button
            type="button"
            onClick={() => setShowInputDrawer(false)}
            className="p-1.5 text-zinc-400 hover:text-white rounded-lg transition cursor-pointer"
          >
            <X size={14} />
          </button>
        </form>
      )}

      {/* Main Bottom Controls Bar */}
      <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
        {/* Left: Menu, Context & Keyboard triggers */}
        <div className="flex items-center gap-1">
          <AppMenu
            {...menuProps}
            agentSettings={agentSettings}
            onOpenChange={(open) => {
              if (open) setShowInputDrawer(false);
            }}
          />
          <button
            type="button"
            onClick={() => {
              setShowInputDrawer(false);
              onOpenContext();
            }}
            aria-label="Meu contexto"
            title={hasContext ? 'Meu contexto para a entrevista' : 'Meu contexto (vazio): preencha para respostas personalizadas'}
            className="app-quiet-button relative p-2 rounded-xl transition cursor-pointer text-zinc-400"
          >
            <UserRound size={15} />
            {!hasContext && <span aria-hidden="true" className="absolute top-1.5 right-1.5 w-1.5 h-1.5 rounded-full bg-blue-400" />}
          </button>
          <button
            type="button"
            onClick={() => setShowInputDrawer(!showInputDrawer)}
            className={`p-2 rounded-xl transition cursor-pointer ${
              showInputDrawer
                ? 'bg-white/10 text-white border border-white/20'
                : 'app-quiet-button text-zinc-400'
            }`}
            title="Digitar comando ou pergunta de texto"
          >
            <Keyboard size={15} />
          </button>

        </div>

        {/* Center: Hero Mic Button */}
        <div className="flex flex-col items-center">
          <button
            type="button"
            onClick={toggleListening}
            className={`relative flex items-center justify-center w-11 h-11 rounded-full transition-all duration-200 cursor-pointer shadow-lg ${
              isListening
                ? 'bg-blue-500 text-white shadow-blue-500/20 scale-105 ring-4 ring-blue-500/15'
                : 'bg-white text-black hover:scale-105 hover:bg-zinc-200 font-bold'
            }`}
            title={isListening ? 'Clique para parar (Alt+Space)' : 'Clique para falar (Alt+Space ou segure ESPAÇO)'}
          >
            {isListening && (
              <span className="absolute inset-0 rounded-full bg-blue-400 animate-ping opacity-20 pointer-events-none" />
            )}
            {isListening ? <MicOff size={18} /> : <Mic size={18} />}
          </button>
        </div>

        <div aria-hidden="true" />
      </div>
    </div>
  );
}
