import { describe, expect, it } from 'vitest';
import { PERSONA_TEMPLATES, assignPersonaWave, createCustomPersona, filterPersonaCatalog, personaById } from '../shared/personas.js';

describe('persona catalog', () => {
  it('covers age, job, country, and city without duplicating ids', () => {
    expect(PERSONA_TEMPLATES.length).toBeGreaterThanOrEqual(12);
    expect(PERSONA_TEMPLATES.length).toBeLessThanOrEqual(20);
    expect(new Set(PERSONA_TEMPLATES.map((persona) => persona.id)).size).toBe(PERSONA_TEMPLATES.length);
    expect(new Set(PERSONA_TEMPLATES.map((persona) => persona.country)).size).toBeGreaterThanOrEqual(10);
    expect(PERSONA_TEMPLATES.every((persona) => persona.job && persona.location && persona.country)).toBe(true);
    expect(PERSONA_TEMPLATES.every((persona) => persona.card.includes(persona.location) && persona.card.includes(persona.country.split(' ')[0]))).toBe(true);
  });

  it('resolves legacy age-and-job ids to the richer location profiles', () => {
    expect(personaById('age-25-34-specialist')?.location).toBe('Berlin');
    expect(personaById('de-ber-engineer')?.job).toBe('software engineer');
  });

  it('round-robins personas and headlines from a stable seed', () => {
    const variantIds = ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'];
    const first = assignPersonaWave({ seed: 'campaign:experiment', agentCount: 8, variantIds });
    const second = assignPersonaWave({ seed: 'campaign:experiment', agentCount: 8, variantIds });
    expect(first).toEqual(second);
    expect(new Set(first.map((item) => item.persona.id)).size).toBeGreaterThan(1);
    expect(first.filter((item) => item.variantId === variantIds[0])).toHaveLength(4);
    expect(first.filter((item) => item.variantId === variantIds[1])).toHaveLength(4);
  });

  it('filters the catalog and adds a custom location persona to the mix', () => {
    const india = filterPersonaCatalog(PERSONA_TEMPLATES, { countries: ['India'] });
    expect(india.every((persona) => persona.country === 'India')).toBe(true);
    expect(india.length).toBeGreaterThan(0);
    const custom = createCustomPersona({
      ageBand: '25-34', work: 'specialist', job: 'dentist', country: 'Spain', location: 'Madrid',
      language: 'Spanish', device: 'phone', household: 'partner',
    }, 'custom-madrid-dentist');
    expect(custom.custom).toBe(true);
    expect(custom.card).toContain('Madrid');
    const mixed = assignPersonaWave({
      seed: 'campaign:custom', agentCount: 4, variantIds: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'],
      personaIds: [custom.id], extras: [custom],
    });
    expect(mixed.every((item) => item.persona.id === custom.id)).toBe(true);
  });
});
