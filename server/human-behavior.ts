import type { PersonaTemplate } from '../shared/personas.js';
import { clampRange, clampUnit, type NoticedFirst, type PersonaAction, type PersonaFriction, type PersonaJudgment } from '../shared/run.js';

export interface HumanDecisionInput {
  judgment: PersonaJudgment;
  persona: PersonaTemplate;
  seed: string;
  mediaType?: 'image' | 'video' | null;
}

interface PersonaPriors {
  priceSensitivity: number;
  skepticism: number;
  busyness: number;
}

export function calibrateHumanJudgment(input: HumanDecisionInput): PersonaJudgment {
  const priors = personaPriors(input.persona);
  const scored = repairScores(input.judgment, input.seed);
  const action = decideAction(scored, priors, input.judgment.friction, input.seed);
  const friction = frictionForAction(action, input.judgment.friction, priors, scored);
  return {
    action,
    reason: reasonForAction(action, friction, input.judgment.reason),
    dwellSeconds: dwellForAction(action, input.judgment.dwellSeconds, `${input.seed}:dwell`),
    timeToActionSeconds: timeToActionForAction(action, input.judgment.timeToActionSeconds, `${input.seed}:tta`),
    confidence: clampUnit(scored.confidence),
    attention: clampUnit(scored.attention),
    clarity: clampUnit(scored.clarity),
    trust: clampUnit(alignTrust(action, scored.trust)),
    purchaseIntent: clampUnit(alignIntent(action, scored.purchaseIntent)),
    noticedFirst: noticedForMedia(input.judgment.noticedFirst, input.mediaType, scored.attention),
    friction,
  };
}

export function personaPriors(persona: PersonaTemplate): PersonaPriors {
  let priceSensitivity = 0.38;
  let skepticism = 0.4;
  let busyness = 0.36;
  if (persona.work === 'student' || persona.work === 'early-career') priceSensitivity += 0.22;
  if (persona.work === 'specialist') skepticism += 0.18;
  if (persona.work === 'manager') busyness += 0.12;
  if (persona.work === 'retired') {
    skepticism += 0.08;
    busyness -= 0.12;
  }
  if (persona.ageBand === '18-24') priceSensitivity += 0.06;
  if (persona.ageBand === '55+') skepticism += 0.08;
  if (persona.device === 'phone') busyness += 0.16;
  if (persona.household === 'family') priceSensitivity += 0.06;
  return {
    priceSensitivity: clampUnit(priceSensitivity),
    skepticism: clampUnit(skepticism),
    busyness: clampUnit(busyness),
  };
}

function repairScores(judgment: PersonaJudgment, seed: string) {
  const collapsed = judgment.attention < 0.08 && judgment.clarity < 0.08 && judgment.trust < 0.08 && judgment.purchaseIntent < 0.08;
  if (!collapsed) {
    return {
      attention: judgment.attention,
      clarity: judgment.clarity,
      trust: judgment.trust,
      purchaseIntent: judgment.purchaseIntent,
      confidence: judgment.confidence > 0.95 && judgment.attention < 0.2 ? 0.55 : judgment.confidence,
    };
  }
  const claimed = judgment.action === 'signup' ? 0.48 : judgment.action === 'click' ? 0.4 : 0.26;
  return {
    attention: wobble(claimed + 0.04, seed, 'attn'),
    clarity: wobble(claimed + 0.08, seed, 'clarity'),
    trust: wobble(claimed - 0.02, seed, 'trust'),
    purchaseIntent: wobble(claimed - 0.06, seed, 'intent'),
    confidence: 0.48,
  };
}

function decideAction(scores: ReturnType<typeof repairScores>, priors: PersonaPriors, friction: PersonaFriction, seed: string): PersonaAction {
  let clickLogit = -1.65;
  clickLogit += 1.55 * scores.attention;
  clickLogit += 0.75 * scores.clarity;
  clickLogit += 0.55 * scores.purchaseIntent;
  clickLogit -= 0.75 * priors.busyness;
  clickLogit -= 0.35 * priors.skepticism;
  clickLogit += frictionPenalty(friction, { busy: -0.55, relevance: -0.7, price: -0.2, trust: -0.35, none: 0.2 });
  if (hash01(`${seed}:click`) >= sigmoid(clickLogit)) return 'skip';

  let signupLogit = -1.7;
  signupLogit += 1.55 * scores.purchaseIntent;
  signupLogit += 1.15 * scores.trust;
  signupLogit -= 0.75 * priors.priceSensitivity;
  signupLogit -= 0.4 * priors.skepticism;
  signupLogit += frictionPenalty(friction, { price: -0.75, trust: -0.85, relevance: -0.45, busy: -0.2, none: 0.3 });
  return hash01(`${seed}:signup`) < sigmoid(signupLogit) ? 'signup' : 'click';
}

function wobble(base: number, seed: string, label: string): number {
  return clampUnit(base + (hash01(`${seed}:${label}`) - 0.5) * 0.16);
}

function frictionPenalty(friction: PersonaFriction, weights: Record<PersonaFriction, number>): number {
  return weights[friction];
}

function alignIntent(action: PersonaAction, intent: number): number {
  if (action === 'signup') return Math.max(0.52, intent);
  if (action === 'click') return clampRange(intent, 0.2, 0.72);
  return Math.min(intent, 0.36);
}

function alignTrust(action: PersonaAction, trust: number): number {
  if (action === 'signup') return Math.max(0.42, trust);
  if (action === 'click') return Math.max(0.18, trust);
  return trust;
}

function frictionForAction(action: PersonaAction, reported: PersonaFriction, priors: PersonaPriors, scores: ReturnType<typeof repairScores>): PersonaFriction {
  if (action !== 'skip') return action === 'signup' ? 'none' : reported === 'none' ? 'none' : reported;
  if (reported !== 'none') return reported;
  if (priors.busyness >= 0.55 && scores.attention < 0.45) return 'busy';
  if (priors.priceSensitivity >= 0.55 && scores.purchaseIntent < 0.4) return 'price';
  if (priors.skepticism >= 0.55 && scores.trust < 0.45) return 'trust';
  return scores.purchaseIntent < 0.28 ? 'relevance' : 'none';
}

function noticedForMedia(noticed: NoticedFirst, mediaType: HumanDecisionInput['mediaType'], attention: number): NoticedFirst {
  if (noticed !== 'unsure') return noticed;
  if (mediaType === 'video') return attention >= 0.28 ? 'video' : 'headline';
  if (mediaType === 'image') return attention >= 0.28 ? 'image' : 'headline';
  return 'headline';
}

function reasonForAction(action: PersonaAction, friction: PersonaFriction, reason: string): string {
  const briefMatch = /matches the described|join the waitlist|sign up for the waitlist|product matches/i.test(reason);
  if (action === 'skip' && briefMatch) {
    if (friction === 'price') return 'I would keep scrolling; the ad does not make the cost feel worth it.';
    if (friction === 'trust') return 'I would keep scrolling; there is not enough proof to trust this yet.';
    if (friction === 'relevance') return 'I would keep scrolling; this does not feel meant for me.';
    if (friction === 'busy') return 'I would keep scrolling; I am moving too fast to stop for this.';
    return 'I would keep scrolling; the ad did not create enough intent to act.';
  }
  if (action === 'click' && briefMatch) return 'I would open the ad to check the details, not sign up yet.';
  if (action === 'signup' && briefMatch) return 'I would join the waitlist; the ad felt clear and useful enough to act now.';
  return reason;
}

function dwellForAction(action: PersonaAction, reported: number, seed: string): number {
  const jitter = hash01(seed);
  if (action === 'skip') return clampRange(reported > 0 && reported <= 6 ? reported : 1.2 + jitter * 3.2, 0.6, 6);
  if (action === 'click') return clampRange(reported >= 3 && reported <= 16 ? reported : 4 + jitter * 8, 3, 16);
  return clampRange(reported >= 8 && reported <= 28 ? reported : 10 + jitter * 12, 8, 28);
}

function timeToActionForAction(action: PersonaAction, reported: number, seed: string): number {
  const jitter = hash01(seed);
  if (action === 'skip') return clampRange(reported > 0 && reported <= 5 ? reported : 0.8 + jitter * 2.4, 0.4, 5);
  if (action === 'click') return clampRange(reported >= 2 && reported <= 12 ? reported : 2.5 + jitter * 6, 2, 12);
  return clampRange(reported >= 5 && reported <= 22 ? reported : 7 + jitter * 10, 5, 22);
}

function sigmoid(value: number): number {
  return 1 / (1 + Math.exp(-value));
}

function hash01(seed: string): number {
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 4_294_967_296;
}
