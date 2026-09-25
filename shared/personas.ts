export interface PersonaTemplate {
  id: string;
  ageBand: '18-24' | '25-34' | '35-44' | '45-54' | '55+';
  work: 'student' | 'early-career' | 'specialist' | 'manager' | 'retired';
  label: string;
  card: string;
}

export const PERSONA_TEMPLATES: PersonaTemplate[] = [
  { id: 'age-18-24-student', ageBand: '18-24', work: 'student', label: '18–24 student', card: 'You are an 18–24-year-old student on a phone, price-sensitive, and short on time.' },
  { id: 'age-18-24-early', ageBand: '18-24', work: 'early-career', label: '18–24 early career', card: 'You are 18–24, in a first job, commuting, and comparing everyday products quickly.' },
  { id: 'age-25-34-early', ageBand: '25-34', work: 'early-career', label: '25–34 early career', card: 'You are 25–34, early in your career, and look for practical products that fit a busy week.' },
  { id: 'age-25-34-specialist', ageBand: '25-34', work: 'specialist', label: '25–34 specialist', card: 'You are a 25–34-year-old specialist. You read claims carefully and dislike vague marketing.' },
  { id: 'age-35-44-specialist', ageBand: '35-44', work: 'specialist', label: '35–44 specialist', card: 'You are 35–44, established in a specialist role, and value clarity, trust, and durability claims you can verify.' },
  { id: 'age-35-44-manager', ageBand: '35-44', work: 'manager', label: '35–44 manager', card: 'You are a 35–44-year-old manager. You decide quickly when an offer is clear and skip ads that feel generic.' },
  { id: 'age-45-54-manager', ageBand: '45-54', work: 'manager', label: '45–54 manager', card: 'You are 45–54 and manage a team. You notice price, trust, and whether the product fits an existing routine.' },
  { id: 'age-45-54-specialist', ageBand: '45-54', work: 'specialist', label: '45–54 specialist', card: 'You are a 45–54-year-old specialist. You linger on headlines that feel specific and skip hype.' },
  { id: 'age-55-retired', ageBand: '55+', work: 'retired', label: '55+ not working', card: 'You are 55 or older and not working. You want simple language, readable offers, and reasons to trust the brand.' },
  { id: 'age-55-manager', ageBand: '55+', work: 'manager', label: '55+ manager', card: 'You are 55 or older and still managing work. You are skeptical of slogans and notice whether the offer is concrete.' },
];

export function personaById(id: string): PersonaTemplate | undefined {
  return PERSONA_TEMPLATES.find((persona) => persona.id === id);
}

export function filterPersonas(ids?: string[]): PersonaTemplate[] {
  if (!ids?.length) return PERSONA_TEMPLATES;
  const allowed = new Set(ids);
  const selected = PERSONA_TEMPLATES.filter((persona) => allowed.has(persona.id));
  return selected.length ? selected : PERSONA_TEMPLATES;
}

function seedNumber(seed: string): number {
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function assignPersonaWave(input: {
  seed: string;
  agentCount: number;
  variantIds: string[];
  personaIds?: string[];
}): Array<{ index: number; persona: PersonaTemplate; variantId: string }> {
  const personas = filterPersonas(input.personaIds);
  if (input.variantIds.length < 1) throw new Error('At least one variant is required.');
  if (!Number.isSafeInteger(input.agentCount) || input.agentCount < 1) throw new Error('Agent count must be a positive integer.');
  const offset = seedNumber(input.seed) % personas.length;
  return Array.from({ length: input.agentCount }, (_, index) => ({
    index,
    persona: personas[(offset + index) % personas.length],
    variantId: input.variantIds[index % input.variantIds.length],
  }));
}
