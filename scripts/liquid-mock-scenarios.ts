import type { ExperimentContext, ExperimentDecision } from '../server/providers/liquid.js';

export interface LiquidMockScenario {
  id: 'initial-campaign' | 'low-data-review' | 'audience-shift-retest';
  title: string;
  expectedAction: ExperimentDecision['action'];
  context: ExperimentContext;
}

const sharedBrief = [
  'This is a fictional sandbox scenario for evaluating a campaign-advice model. Do not claim these events happened in a real campaign.',
  'Product: Everyday Bottle, a fictional reusable stainless-steel bottle. Goal: waitlist sign-ups.',
  'Synthetic approved claims only: 750 ml capacity; stainless-steel construction; designed for repeated use.',
  'Keep any proposed headlines within those claims. You are advising only; do not launch a campaign, generate an image, or contact a provider.',
].join(' ');

export const LIQUID_MOCK_SCENARIOS: LiquidMockScenario[] = [
  {
    id: 'initial-campaign',
    title: 'Initial campaign proposal',
    expectedAction: 'propose_test',
    context: {
      stage: 'initial',
      brief: `${sharedBrief} Audience: first-time visitors who are interested in practical everyday products. No ad has run and there are no performance observations. Propose an initial controlled headline comparison or wait if the brief does not support one.`,
      evidence: [
        { id: 'SYN-BRIEF-01', summary: 'Synthetic brief: fictional 750 ml stainless-steel bottle for a waitlist sign-up campaign; no ads have run.' },
        { id: 'SYN-CLAIMS-01', summary: 'Synthetic approved claims: 750 ml capacity, stainless-steel construction, designed for repeated use.' },
      ],
      lessons: [],
    },
  },
  {
    id: 'low-data-review',
    title: 'Low-data review',
    expectedAction: 'wait',
    context: {
      stage: 'review',
      brief: `${sharedBrief} Audience: first-time visitors. Review a synthetic early read from two comparable headline variants. The variants used the same image and waitlist offer with only their headlines changed. The minimum evidence rule is 500 impressions per variant before choosing a direction. Do not overstate small samples.`,
      evidence: [
        { id: 'SYN-LOW-A-01', summary: 'Synthetic Variant A has 46 impressions and 1 sign-up in the early review window.' },
        { id: 'SYN-LOW-B-01', summary: 'Synthetic Variant B has 41 impressions and 0 sign-ups in the same early review window.' },
        { id: 'SYN-MINIMUM-01', summary: 'Synthetic review rule: at least 500 impressions per variant are needed before selecting a direction; neither variant meets it.' },
      ],
      lessons: [],
    },
  },
  {
    id: 'audience-shift-retest',
    title: 'Audience shift and scoped retest',
    expectedAction: 'propose_test',
    context: {
      stage: 'retest',
      brief: `${sharedBrief} Audience has shifted from returning customers to first-time visitors. A prior synthetic note describes a headline result among returning customers only. That lesson is not established for the new audience. Recommend a controlled retest for first-time visitors when the evidence supports it, keeping the image and offer the same and changing only the headline; do not generalize the prior lesson.`,
      evidence: [
        { id: 'SYN-SHIFT-01', summary: 'Synthetic scenario change: the next review concerns first-time visitors rather than returning customers.' },
        { id: 'SYN-RETURNING-01', summary: 'Synthetic prior experiment: “Refill. Reuse. Repeat.” had more sign-ups among returning customers in a small, scoped sample; it has not been tested with first-time visitors.' },
      ],
      lessons: [
        { id: 'LESSON-RETURNING-01', statement: 'For returning customers only, “Refill. Reuse. Repeat.” showed an early sign-up lead in a small synthetic sample. Retest before applying this to another audience.' },
      ],
    },
  },
];

export const OFFLINE_FIXTURE_DECISIONS: ExperimentDecision[] = [
  {
    action: 'propose_test',
    explanation: 'The brief supports comparing two truthful, distinct headlines while keeping the offer the same.',
    hypothesis: 'A concrete capacity headline may invite more first-time visitors to join the waitlist.',
    headlines: ['A 750 ml bottle for every day', 'Take 750 ml along for the day'],
    evidenceIds: ['SYN-BRIEF-01', 'SYN-CLAIMS-01'],
  },
  {
    action: 'wait',
    explanation: 'Both variants are far below the stated minimum sample, so the small difference is not enough to choose.',
    hypothesis: '',
    headlines: [],
    evidenceIds: ['SYN-LOW-A-01', 'SYN-LOW-B-01', 'SYN-MINIMUM-01'],
  },
  {
    action: 'propose_test',
    explanation: 'The earlier observation is scoped to returning customers, so first-time visitors need a comparable retest.',
    hypothesis: 'For first-time visitors, compare two claim-safe headlines while keeping the offer and audience constant.',
    headlines: ['A steel bottle made for repeat use', 'A 750 ml bottle for every day'],
    evidenceIds: ['SYN-SHIFT-01', 'SYN-RETURNING-01'],
  },
];
