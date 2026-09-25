import { describe, expect, it } from 'vitest';
import { buildProductImagePrompt, buildProductImagePrompts } from '../shared/image-prompts.js';
import type { Campaign } from '../shared/types.js';
import { suggestImagePrompt } from '../server/creative.js';

const product = '750 ml stainless steel bottle with sage green body and brushed steel cap';

describe('commercial product image prompts', () => {
  it('builds three distinct positive commercial compositions in subject-to-lighting order', () => {
    const prompts = buildProductImagePrompts({ product, audience: 'daily commuters' });

    expect(prompts).toHaveLength(3);
    expect(new Set(prompts).size).toBe(3);
    for (const prompt of prompts) {
      expect(prompt).toContain(product);
      expect(prompt).toMatch(/Single .*Composition: .*Style: .*Lighting:/);
      expect(prompt).toContain('Unspecified surfaces remain plain and unbranded');
      expect(prompt).toContain('Photography only');
      expect(prompt.length).toBeLessThanOrEqual(4_000);
    }
    expect(prompts[0]).toContain('three-quarter hero');
    expect(prompts[0]).toContain('on warm ivory');
    expect(prompts[1]).toContain('daily commuters');
    expect(prompts[1]).toContain('editorial still-life photography');
    expect(prompts[2]).toContain('elevated three-quarter tabletop view');
    expect(prompts[2]).toContain('warm-stone and soft-sage backdrop planes');
    expect(prompts[0]).not.toContain('daily commuters');
    expect(prompts[2]).not.toContain('daily commuters');
  });

  it('stages hinged books and hollow vessels without contradictory physical directions', () => {
    const notebook = buildProductImagePrompts({ product: 'A terracotta notebook with interior dotted pages and elastic closure' });
    expect(notebook.every(prompt => prompt.includes('fully closed') && prompt.includes('Interior patterns remain inside'))).toBe(true);
    expect(notebook[2]).toContain('overhead graphic flat lay');
    const mug = buildProductImagePrompts({ product: 'An ivory ceramic mug with a rounded handle' });
    expect(mug.every(prompt => prompt.includes('upright on its solid base') && prompt.includes('open top rim'))).toBe(true);
    expect(mug[2]).not.toContain('overhead graphic flat lay');
    expect(mug[2]).toContain('single level surface');
  });

  it('keeps the full supported product description, supports missing audience, and selects a shared hero prompt', () => {
    const longProduct = `Notebook, terracotta linen cover, 160 dotted pages, elastic closure, ${'soft rounded corners, '.repeat(8)}bronze wire binding`;
    const context = { product: longProduct.slice(0, 300) };
    const prompts = buildProductImagePrompts(context, 3);
    expect(prompts.every((prompt) => prompt.includes(context.product))).toBe(true);
    expect(prompts[1]).toContain('a calm, contemporary everyday setting');

    const campaign = {
      id: 'campaign', name: 'Notebook', product: context.product, audience: 'Readers and students', goal: 'signups',
      approvedClaims: [], budgetCents: 5_000, currency: 'USD', status: 'draft', runtime: 'idle', agentCount: 40,
      concurrency: 8, headlines: [], customPersonas: [], createdAt: '2026-09-25T00:00:00.000Z', updatedAt: '2026-09-25T00:00:00.000Z',
    } satisfies Campaign;
    expect(suggestImagePrompt(campaign)).toBe(buildProductImagePrompt({ product: campaign.product, audience: campaign.audience }, 'hero'));
  });
});
