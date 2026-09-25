import { z } from 'zod';

export const AGE_BANDS = ['18-24', '25-34', '35-44', '45-54', '55+'] as const;
export const WORK_TYPES = ['student', 'early-career', 'specialist', 'manager', 'retired'] as const;
export const DEVICES = ['phone', 'desktop'] as const;
export const HOUSEHOLDS = ['alone', 'partner', 'family'] as const;

export type AgeBand = (typeof AGE_BANDS)[number];
export type WorkType = (typeof WORK_TYPES)[number];
export type DeviceType = (typeof DEVICES)[number];
export type HouseholdType = (typeof HOUSEHOLDS)[number];

export interface PersonaTemplate {
  id: string;
  ageBand: AgeBand;
  work: WorkType;
  job: string;
  country: string;
  location: string;
  language: string;
  device: DeviceType;
  household: HouseholdType;
  label: string;
  card: string;
  custom: boolean;
}

export const customPersonaSchema = z.object({
  ageBand: z.enum(AGE_BANDS),
  work: z.enum(WORK_TYPES),
  job: z.string().trim().min(1).max(80),
  country: z.string().trim().min(1).max(80),
  location: z.string().trim().min(1).max(80),
  language: z.string().trim().min(1).max(40).default('English'),
  device: z.enum(DEVICES).default('phone'),
  household: z.enum(HOUSEHOLDS).default('alone'),
  card: z.string().trim().max(500).optional(),
}).strict();

export type CustomPersonaInput = z.output<typeof customPersonaSchema>;

function persona(input: Omit<PersonaTemplate, 'label' | 'custom' | 'language' | 'device' | 'household'> & {
  language?: string;
  device?: DeviceType;
  household?: HouseholdType;
  custom?: boolean;
}): PersonaTemplate {
  const language = input.language ?? 'English';
  const device = input.device ?? 'phone';
  const household = input.household ?? 'alone';
  const custom = input.custom ?? false;
  return {
    ...input,
    language,
    device,
    household,
    custom,
    label: `${input.ageBand.replace('-', '–')} ${input.job} · ${input.location}, ${input.country}`.slice(0, 80),
  };
}

export const PERSONA_TEMPLATES: PersonaTemplate[] = [
  persona({ id: 'age-18-24-student', ageBand: '18-24', work: 'student', job: 'student', country: 'United States', location: 'Austin', household: 'alone',
    card: 'You are an 18–24-year-old student in Austin, United States. You browse on a phone, compare prices, and skip ads that feel expensive or slow.' }),
  persona({ id: 'age-18-24-early', ageBand: '18-24', work: 'early-career', job: 'retail associate', country: 'United Kingdom', location: 'Manchester', language: 'English',
    card: 'You are 18–24 and work retail in Manchester, United Kingdom. You commute, compare everyday products quickly, and notice whether an offer fits a tight budget.' }),
  persona({ id: 'in-blr-analyst', ageBand: '25-34', work: 'early-career', job: 'junior analyst', country: 'India', location: 'Bengaluru', language: 'English', household: 'family',
    card: 'You are 25–34, a junior analyst in Bengaluru, India. You look for practical products that fit a busy week and distrust vague brand slogans.' }),
  persona({ id: 'de-ber-engineer', ageBand: '25-34', work: 'specialist', job: 'software engineer', country: 'Germany', location: 'Berlin', language: 'German', device: 'desktop',
    card: 'You are a 25–34-year-old software engineer in Berlin, Germany. You read claims carefully, notice ingredients or specs, and skip hype.' }),
  persona({ id: 'jp-tyo-nurse', ageBand: '35-44', work: 'specialist', job: 'nurse', country: 'Japan', location: 'Tokyo', language: 'Japanese', household: 'partner',
    card: 'You are 35–44 and a nurse in Tokyo, Japan. You value clarity, trust, and product claims you can verify before you click.' }),
  persona({ id: 'br-sao-ops', ageBand: '35-44', work: 'manager', job: 'operations manager', country: 'Brazil', location: 'São Paulo', language: 'Portuguese', household: 'family',
    card: 'You are a 35–44-year-old operations manager in São Paulo, Brazil. You decide quickly when an offer is clear and skip ads that feel generic.' }),
  persona({ id: 'ng-los-store', ageBand: '45-54', work: 'manager', job: 'store manager', country: 'Nigeria', location: 'Lagos', household: 'family',
    card: 'You are 45–54 and manage a store in Lagos, Nigeria. You notice price, trust, and whether the product fits an existing routine.' }),
  persona({ id: 'ca-tor-accountant', ageBand: '45-54', work: 'specialist', job: 'accountant', country: 'Canada', location: 'Toronto', device: 'desktop', household: 'partner',
    card: 'You are a 45–54-year-old accountant in Toronto, Canada. You linger on headlines that feel specific and skip slogans.' }),
  persona({ id: 'au-syd-retired', ageBand: '55+', work: 'retired', job: 'not working', country: 'Australia', location: 'Sydney', household: 'partner',
    card: 'You are 55 or older and not working in Sydney, Australia. You want simple language, readable offers, and a clear reason to trust the brand.' }),
  persona({ id: 'us-chi-manager', ageBand: '55+', work: 'manager', job: 'department manager', country: 'United States', location: 'Chicago', household: 'family', device: 'desktop',
    card: 'You are 55 or older and still managing a department in Chicago, United States. You are skeptical of slogans and notice whether the offer is concrete.' }),
  persona({ id: 'mx-mex-teacher', ageBand: '25-34', work: 'specialist', job: 'teacher', country: 'Mexico', location: 'Mexico City', language: 'Spanish', household: 'family',
    card: 'You are a 25–34-year-old teacher in Mexico City, Mexico. You notice family usefulness, price, and whether the product feels safe to recommend.' }),
  persona({ id: 'fr-par-owner', ageBand: '35-44', work: 'manager', job: 'restaurant owner', country: 'France', location: 'Paris', language: 'French', household: 'partner',
    card: 'You are a 35–44-year-old restaurant owner in Paris, France. You judge ads on quality, ingredients, and whether the brand feels careful.' }),
  persona({ id: 'kr-sel-student', ageBand: '18-24', work: 'student', job: 'student', country: 'South Korea', location: 'Seoul', language: 'Korean',
    card: 'You are an 18–24-year-old student in Seoul, South Korea. You scan ads on a phone, care about look and reviews, and skip copy that feels old-fashioned.' }),
  persona({ id: 'ae-dxb-logistics', ageBand: '45-54', work: 'specialist', job: 'logistics specialist', country: 'United Arab Emirates', location: 'Dubai', language: 'English', household: 'family',
    card: 'You are a 45–54-year-old logistics specialist in Dubai, United Arab Emirates. You notice reliability, shipping, and whether the offer is specific.' }),
  persona({ id: 'ke-nbo-rider', ageBand: '25-34', work: 'early-career', job: 'delivery rider', country: 'Kenya', location: 'Nairobi',
    card: 'You are 25–34 and a delivery rider in Nairobi, Kenya. You decide fast, care about price and durability, and skip ads that feel out of reach.' }),
  persona({ id: 'id-jkt-pharmacist', ageBand: '35-44', work: 'specialist', job: 'pharmacist', country: 'Indonesia', location: 'Jakarta', language: 'Indonesian', household: 'family',
    card: 'You are a 35–44-year-old pharmacist in Jakarta, Indonesia. You read ingredient and care claims closely and skip vague wellness marketing.' }),
];

const LEGACY_PERSONA_IDS: Record<string, string> = {
  'age-25-34-early': 'in-blr-analyst',
  'age-25-34-specialist': 'de-ber-engineer',
  'age-35-44-specialist': 'jp-tyo-nurse',
  'age-35-44-manager': 'br-sao-ops',
  'age-45-54-manager': 'ng-los-store',
  'age-45-54-specialist': 'ca-tor-accountant',
  'age-55-retired': 'au-syd-retired',
  'age-55-manager': 'us-chi-manager',
};

export function personaCatalog(extras: PersonaTemplate[] = []): PersonaTemplate[] {
  const seen = new Set(PERSONA_TEMPLATES.map((persona) => persona.id));
  return [...PERSONA_TEMPLATES, ...extras.filter((persona) => !seen.has(persona.id))];
}

export function personaById(id: string, extras: PersonaTemplate[] = []): PersonaTemplate | undefined {
  const resolved = LEGACY_PERSONA_IDS[id] ?? id;
  return personaCatalog(extras).find((persona) => persona.id === resolved);
}

export function filterPersonas(ids?: string[], extras: PersonaTemplate[] = []): PersonaTemplate[] {
  const catalog = personaCatalog(extras);
  if (!ids?.length) return catalog;
  const allowed = new Set(ids.map((id) => LEGACY_PERSONA_IDS[id] ?? id));
  const selected = catalog.filter((persona) => allowed.has(persona.id));
  return selected.length ? selected : catalog;
}

export function filterPersonaCatalog(catalog: PersonaTemplate[], filters: {
  ageBands?: string[];
  countries?: string[];
  works?: string[];
  query?: string;
}): PersonaTemplate[] {
  const query = filters.query?.trim().toLocaleLowerCase() ?? '';
  return catalog.filter((persona) => {
    if (filters.ageBands?.length && !filters.ageBands.includes(persona.ageBand)) return false;
    if (filters.countries?.length && !filters.countries.includes(persona.country)) return false;
    if (filters.works?.length && !filters.works.includes(persona.work)) return false;
    if (!query) return true;
    return [persona.label, persona.job, persona.country, persona.location, persona.language].join(' ').toLocaleLowerCase().includes(query);
  });
}

export function buildPersonaCard(input: CustomPersonaInput): string {
  const home = `${input.location}, ${input.country}`;
  const device = input.device === 'desktop' ? 'a computer' : 'a phone';
  const household = input.household === 'family' ? 'You live with family.' : input.household === 'partner' ? 'You live with a partner.' : 'You live on your own.';
  return `You are ${input.ageBand}, working as a ${input.job} in ${home}. You usually browse on ${device} in ${input.language}. ${household} Judge the ad as this person would.`.slice(0, 500);
}

export function createCustomPersona(input: CustomPersonaInput, id: string): PersonaTemplate {
  const parsed = customPersonaSchema.parse(input);
  return persona({
    id,
    ageBand: parsed.ageBand,
    work: parsed.work,
    job: parsed.job,
    country: parsed.country,
    location: parsed.location,
    language: parsed.language,
    device: parsed.device,
    household: parsed.household,
    card: parsed.card || buildPersonaCard(parsed),
    custom: true,
  });
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
  extras?: PersonaTemplate[];
}): Array<{ index: number; persona: PersonaTemplate; variantId: string }> {
  const personas = filterPersonas(input.personaIds, input.extras);
  if (input.variantIds.length < 1) throw new Error('At least one variant is required.');
  if (!Number.isSafeInteger(input.agentCount) || input.agentCount < 1) throw new Error('Agent count must be a positive integer.');
  const offset = seedNumber(input.seed) % personas.length;
  return Array.from({ length: input.agentCount }, (_, index) => ({
    index,
    persona: personas[(offset + index) % personas.length],
    variantId: input.variantIds[index % input.variantIds.length],
  }));
}
