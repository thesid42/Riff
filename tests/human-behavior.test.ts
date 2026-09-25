import { describe, expect, it } from 'vitest';
import { PERSONA_TEMPLATES } from '../shared/personas.js';
import type { PersonaJudgment } from '../shared/run.js';
import { calibrateHumanJudgment } from '../server/human-behavior.js';

const student = PERSONA_TEMPLATES.find((persona) => persona.id === 'age-18-24-student')!;
const engineer = PERSONA_TEMPLATES.find((persona) => persona.id === 'de-ber-engineer')!;

const collapsed: PersonaJudgment = {
  action: 'signup',
  reason: 'The product matches the described sage green bottle and the offer is to join the waitlist.',
  dwellSeconds: 30,
  timeToActionSeconds: 15,
  confidence: 1,
  attention: 0,
  clarity: 0,
  trust: 0,
  purchaseIntent: 0,
  noticedFirst: 'unsure',
  friction: 'none',
};

const strong: PersonaJudgment = {
  ...collapsed,
  attention: 0.78,
  clarity: 0.8,
  trust: 0.72,
  purchaseIntent: 0.68,
  confidence: 0.7,
  friction: 'none',
  reason: 'The bottle looks easy to carry and the offer is clear.',
};

function rate(persona: typeof student, judgment: PersonaJudgment, mediaType: 'image' | null, prefix: string, n = 400) {
  const counts = { skip: 0, click: 0, signup: 0 };
  for (let index = 0; index < n; index += 1) {
    const result = calibrateHumanJudgment({
      judgment,
      persona,
      seed: `${prefix}:${index}`,
      mediaType,
    });
    counts[result.action] += 1;
  }
  return {
    skip: counts.skip / n,
    click: counts.click / n,
    signup: counts.signup / n,
    clickThrough: (counts.click + counts.signup) / n,
  };
}

describe('human feed-scroll calibration', () => {
  it('turns collapsed signup-everything output into a skip-heavy mix with a few clicks', () => {
    const result = rate(student, collapsed, 'image', 'collapsed');
    expect(result.skip).toBeGreaterThan(0.3);
    expect(result.skip).toBeLessThan(0.85);
    expect(result.clickThrough).toBeGreaterThan(0.16);
    expect(result.signup).toBeLessThan(0.28);
    const one = calibrateHumanJudgment({ judgment: collapsed, persona: student, seed: 'collapsed:1', mediaType: 'image' });
    expect(one.purchaseIntent).toBeLessThan(0.55);
    expect(one.noticedFirst === 'headline' || one.noticedFirst === 'image').toBe(true);
    expect(one.reason).toMatch(/I |I'd |I'm /);
    expect(one.reason).toMatch(/student|Austin|phone/i);
  });

  it('keeps the same seed deterministic', () => {
    const first = calibrateHumanJudgment({ judgment: strong, persona: engineer, seed: 'stable-seed', mediaType: 'image' });
    const second = calibrateHumanJudgment({ judgment: strong, persona: engineer, seed: 'stable-seed', mediaType: 'image' });
    expect(first).toEqual(second);
  });

  it('lets a strong ad produce some clicks without converting most viewers', () => {
    const result = rate(engineer, strong, 'image', 'strong');
    expect(result.clickThrough).toBeGreaterThan(0.18);
    expect(result.clickThrough).toBeLessThan(0.75);
    expect(result.signup).toBeLessThan(0.4);
    expect(result.skip).toBeGreaterThan(0.25);
  });

  it('makes price-sensitive students rarely sign up', () => {
    const priced: PersonaJudgment = { ...strong, friction: 'price', purchaseIntent: 0.45 };
    const result = rate(student, priced, 'image', 'price');
    expect(result.signup).toBeLessThan(0.18);
  });

  it('aligns signup scores so intent and trust are not zero', () => {
    const judged = calibrateHumanJudgment({
      judgment: { ...strong, purchaseIntent: 0.2, trust: 0.1 },
      persona: engineer,
      seed: 'align-signup',
      mediaType: 'image',
    });
    if (judged.action === 'signup') {
      expect(judged.purchaseIntent).toBeGreaterThanOrEqual(0.52);
      expect(judged.trust).toBeGreaterThanOrEqual(0.42);
    }
    if (judged.action === 'skip') expect(judged.purchaseIntent).toBeLessThanOrEqual(0.36);
  });
});
