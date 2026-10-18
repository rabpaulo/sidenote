export const PERSONA_CATEGORIES = [
  { id: 'interview', name: 'Entrevistas' },
  { id: 'business', name: 'Negócios' },
  { id: 'general', name: 'Geral' },
];

export const AVAILABLE_PERSONAS = [
  {
    id: 'interview_coding',
    category: 'interview',
    shortName: 'LeetCode & Código',
    iconName: 'Code',
    description: 'Algoritmos, estruturas de dados e Big-O.',
  },
  {
    id: 'interview_system_design',
    category: 'interview',
    shortName: 'System Design',
    iconName: 'Network',
    description: 'Escalabilidade, arquitetura e trade-offs.',
  },
  {
    id: 'interview_behavioral',
    category: 'interview',
    shortName: 'Comportamental (STAR)',
    iconName: 'Users',
    description: 'Situações passadas no formato STAR.',
  },
  {
    id: 'interview_hr',
    category: 'interview',
    shortName: 'RH & Triagem',
    iconName: 'Briefcase',
    description: 'Trajetória, motivação e expectativa salarial.',
  },
  {
    id: 'interview_reverse',
    category: 'interview',
    shortName: 'Perguntas ao Entrevistador',
    iconName: 'HelpCircle',
    description: 'Perguntas para fazer no final da entrevista.',
  },
  {
    id: 'sales',
    category: 'business',
    shortName: 'Vendas & Pitch',
    iconName: 'DollarSign',
    description: 'Pitch, objeções e fechamento.',
  },
  {
    id: 'general',
    category: 'general',
    shortName: 'Reunião Geral',
    iconName: 'MessageSquare',
    description: 'Conversa livre, 1:1s e alinhamentos.',
  },
];

export const DEFAULT_PERSONA = 'general';

export function getPersonaById(id) {
  // Retrocompatibilidade: 'interview' legado aponta para 'interview_coding'
  if (id === 'interview') return AVAILABLE_PERSONAS.find((p) => p.id === 'interview_coding');
  return AVAILABLE_PERSONAS.find((p) => p.id === id) || AVAILABLE_PERSONAS.find((p) => p.id === DEFAULT_PERSONA);
}
