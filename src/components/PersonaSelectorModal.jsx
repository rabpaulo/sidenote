import React from 'react';
import {
  X,
  Check,
  Briefcase,
  Code,
  Network,
  Users,
  HelpCircle,
  DollarSign,
  MessageSquare,
} from 'lucide-react';
import { AVAILABLE_PERSONAS, PERSONA_CATEGORIES, getPersonaById } from '../config/personas.js';

const ICON_MAP = {
  Code,
  Network,
  Users,
  Briefcase,
  HelpCircle,
  DollarSign,
  MessageSquare,
};

export function PersonaSelectorModal({
  isOpen,
  onClose,
  selectedPersona,
  onSelectPersona,
}) {
  if (!isOpen) return null;

  const activeId = getPersonaById(selectedPersona)?.id;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6 overflow-y-auto">
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/80 backdrop-blur-md transition-opacity animate-in fade-in duration-200"
        onClick={onClose}
      />

      {/* Modal Dialog */}
      <div className="relative w-full max-w-md rounded-3xl border border-zinc-800 bg-[#0e0e14] shadow-2xl overflow-hidden z-10 flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-800/80 bg-zinc-950/60">
          <h2 className="text-lg font-bold text-white tracking-tight">Modo</h2>
          <button
            onClick={onClose}
            className="p-2 rounded-xl text-zinc-400 hover:text-white hover:bg-zinc-800/80 transition cursor-pointer"
          >
            <X size={18} />
          </button>
        </div>

        {/* Scrollable Body */}
        <div className="p-4 overflow-y-auto space-y-4 flex-1 custom-scrollbar">
          {PERSONA_CATEGORIES.map((category) => (
            <div key={category.id}>
              <label className="text-xs font-bold uppercase tracking-wider text-zinc-400 mb-2 px-2 block">
                {category.name}
              </label>

              <div className="space-y-1">
                {AVAILABLE_PERSONAS.filter((p) => p.category === category.id).map((persona) => {
                  const isSelected = persona.id === activeId;
                  const IconComponent = ICON_MAP[persona.iconName] || MessageSquare;

                  return (
                    <button
                      key={persona.id}
                      type="button"
                      onClick={() => {
                        onSelectPersona(persona.id);
                        onClose();
                      }}
                      className={`w-full px-3 py-2.5 rounded-xl border flex items-center gap-3 text-left cursor-pointer transition ${
                        isSelected
                          ? 'border-blue-500/50 bg-blue-950/20'
                          : 'border-transparent hover:bg-zinc-900/70'
                      }`}
                    >
                      <IconComponent size={16} className={isSelected ? 'text-blue-400' : 'text-zinc-400'} />
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-semibold text-white">{persona.shortName}</div>
                        <div className="text-xs text-zinc-500 truncate">{persona.description}</div>
                      </div>
                      {isSelected && <Check size={14} strokeWidth={3} className="text-blue-400 shrink-0" />}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
