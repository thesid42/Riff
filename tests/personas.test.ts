import { describe, expect, it } from 'vitest';
import { PERSONA_TEMPLATES, assignPersonaWave } from '../shared/personas.js';

describe('persona catalog', () => {
  it('covers at least eight age and job templates', () => {
    expect(PERSONA_TEMPLATES.length).toBeGreaterThanOrEqual(8);
    expect(PERSONA_TEMPLATES.length).toBeLessThanOrEqual(12);
    expect(new Set(PERSONA_TEMPLATES.map((persona) => persona.id)).size).toBe(PERSONA_TEMPLATES.length);
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
});
