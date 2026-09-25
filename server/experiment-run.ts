import { randomUUID } from 'node:crypto';
import { assignPersonaWave, personaById } from '../shared/personas.js';
import {
  DEFAULT_OFFER,
  headlineSetSchema,
  type AgentJob,
  type DecisionRecord,
  type RunWaveInput,
  type WaveSnapshot,
} from '../shared/run.js';
import type { Campaign, Experiment, Lesson, MetricsSnapshot, Variant } from '../shared/types.js';
import { emptyMetricsSnapshot } from '../shared/types.js';
import type { CampaignDatabase } from './database.js';
import { ProviderError, type AnalyticsClient, type AnalyticsEvent, type LiquidClient } from './providers/index.js';
import { deciderSpeed, eventCost, jobProgress, lastJobError, segmentMetrics, signupSeries, totalsFromJobs, variantTotals } from './wave-metrics.js';

export class RunServiceError extends Error {
  constructor(readonly statusCode: number, readonly code: string, message: string) {
    super(message);
    this.name = 'RunServiceError';
  }
}

export interface ExperimentRunOptions {
  database: CampaignDatabase;
  liquid?: Pick<LiquidClient, 'judgeCreative' | 'proposeExperimentWithMetadata'>;
  analytics?: AnalyticsClient;
}

const INGEST_BATCH = 50;
const MAX_RETRIES = 2;

export class ExperimentRunService {
  private readonly workers = new Map<string, { stop: boolean; inflight: Set<Promise<void>> }>();
  private readonly ingestErrors = new Map<string, string>();
  private readonly reviewErrors = new Map<string, string>();

  constructor(private readonly options: ExperimentRunOptions) {}

  snapshot(campaign: Campaign): WaveSnapshot {
    const experiment = this.options.database.latestExperiment(campaign.id);
    const jobs = experiment ? this.options.database.listAgentJobs(campaign.id, experiment.id) : [];
    return {
      runtime: campaign.runtime,
      agentCount: campaign.agentCount,
      concurrency: campaign.concurrency,
      headlines: campaign.headlines,
      experimentId: experiment?.id ?? null,
      progress: jobProgress(jobs),
      segments: segmentMetrics(jobs, campaign.customPersonas),
      deciderSpeed: deciderSpeed(jobs),
      latestDecision: this.options.database.latestDecision(campaign.id) ?? null,
      lastError: lastJobError(jobs),
      ingestError: this.ingestErrors.get(campaign.id) ?? null,
      reviewError: this.reviewErrors.get(campaign.id) ?? null,
    };
  }

  details(campaign: Campaign): {
    campaign: Campaign;
    variants: Variant[];
    experiments: Experiment[];
    lessons: Lesson[];
    decisions: DecisionRecord[];
    wave: WaveSnapshot;
  } {
    return {
      campaign,
      variants: this.options.database.listVariants(campaign.id),
      experiments: this.options.database.listExperiments(campaign.id),
      lessons: this.options.database.listLessons(campaign.id),
      decisions: this.options.database.listDecisions(campaign.id),
      wave: this.snapshot(campaign),
    };
  }

  metrics(campaign: Campaign): MetricsSnapshot {
    const experiment = this.options.database.latestExperiment(campaign.id);
    const jobs = experiment ? this.options.database.listAgentJobs(campaign.id, experiment.id) : [];
    if (jobs.length === 0) return emptyMetricsSnapshot(campaign.id);
    const succeeded = jobs.filter((job) => job.status === 'succeeded');
    const decide = succeeded.map((job) => job.elapsedMs).filter((value): value is number => value != null);
    return {
      campaignId: campaign.id,
      source: this.options.analytics?.provider ?? 'none',
      status: succeeded.length ? 'available' : 'not_started',
      window: { label: experiment ? 'Current wave' : 'All time', start: experiment?.windowStart ?? null, end: experiment?.windowEnd ?? null },
      updatedAt: succeeded.at(-1)?.finishedAt ?? null,
      totals: totalsFromJobs(jobs),
      variants: variantTotals(jobs),
      series: signupSeries(jobs),
      message: succeeded.length ? 'Persona wave results from local judgments, also written to analytics when configured.' : 'The persona wave has not produced results yet.',
      decideTimeMedianMs: medianSafe(decide),
      decideTimeP90Ms: percentileSafe(decide, 90),
    };
  }

  persistHeadlines(campaign: Campaign, headlines: string[]): Campaign {
    const parsed = headlineSetSchema.safeParse(headlines);
    if (!parsed.success) throw new RunServiceError(400, 'validation_error', 'Provide 2 or 3 unique headlines.');
    if (campaign.runtime === 'running') throw new RunServiceError(409, 'wave_active', 'Headlines cannot change while a wave is running.');
    return this.options.database.setHeadlines(campaign.id, parsed.data, new Date().toISOString()) ?? campaign;
  }

  async start(
    campaign: Campaign,
    input: RunWaveInput,
    media: Array<{ imageUrl: string | null; videoUrl: string | null }>,
    visualMode: 'shared' | 'distinct' | 'text-only' = 'text-only',
  ): Promise<WaveSnapshot> {
    if (!this.options.liquid) throw new RunServiceError(503, 'liquid_unavailable', 'Liquid is not configured.');
    if (!this.options.analytics) throw new RunServiceError(503, 'analytics_unavailable', 'Analytics is not configured.');
    if (campaign.runtime === 'running') throw new RunServiceError(409, 'wave_active', 'This draft already has a persona wave running.');
    const headlines = headlineSetSchema.safeParse(input.headlines?.length ? input.headlines : campaign.headlines);
    if (!headlines.success) throw new RunServiceError(400, 'headlines_required', 'Ask Liquid for headlines, or enter 2 or 3 unique headlines, before starting a wave.');
    const now = new Date().toISOString();
    this.options.database.setHeadlines(campaign.id, headlines.data, now);
    const experiment = this.options.database.createExperiment({
      id: randomUUID(),
      campaignId: campaign.id,
      hypothesis: visualMode === 'distinct'
        ? 'Compare complete campaign concepts, including each headline and its paired visual, while holding the offer constant.'
        : visualMode === 'shared'
          ? 'Compare headline directions while holding the offer and shared media constant.'
          : 'Compare headline directions with text-only variants while holding the offer constant.',
      status: 'collecting',
      windowStart: now,
      createdAt: now,
    });
    const variants = headlines.data.map((headline, index) => ({
      id: randomUUID(),
      campaignId: campaign.id,
      experimentId: experiment.id,
      label: String.fromCharCode(65 + index),
      headline,
      offer: DEFAULT_OFFER,
      status: 'ready' as const,
      imageUrl: media[index]?.imageUrl ?? null,
      videoUrl: media[index]?.videoUrl ?? null,
      parentId: null,
      createdAt: now,
    }));
    this.options.database.createVariants(variants);
    const assignments = assignPersonaWave({
      seed: `${campaign.id}:${experiment.id}`,
      agentCount: input.agentCount,
      variantIds: variants.map((variant) => variant.id),
      personaIds: input.profileMix,
      extras: campaign.customPersonas,
    });
    this.options.database.enqueueAgentJobs(assignments.map((assignment) => ({
      id: randomUUID(),
      campaignId: campaign.id,
      experimentId: experiment.id,
      variantId: assignment.variantId,
      personaId: assignment.persona.id,
      audienceSegment: assignment.persona.id,
      status: 'pending',
      action: null,
      reason: null,
      dwellSeconds: null,
      timeToActionSeconds: null,
      confidence: null,
      attention: null,
      clarity: null,
      trust: null,
      purchaseIntent: null,
      noticedFirst: null,
      friction: null,
      elapsedMs: null,
      queueWaitMs: null,
      promptTokens: null,
      completionTokens: null,
      error: null,
      enqueuedAt: now,
      startedAt: null,
      finishedAt: null,
    })));
    this.options.database.setRuntime(campaign.id, 'running', input.agentCount, input.concurrency, now);
    this.pump(campaign.id, input.concurrency);
    return this.snapshot(this.options.database.getCampaign(campaign.id)!);
  }

  pause(campaign: Campaign): WaveSnapshot {
    if (campaign.runtime !== 'running') throw new RunServiceError(409, 'wave_not_running', 'There is no running wave to pause.');
    const worker = this.workers.get(campaign.id);
    if (worker) worker.stop = true;
    this.options.database.setRuntime(campaign.id, 'paused', campaign.agentCount, campaign.concurrency, new Date().toISOString());
    return this.snapshot(this.options.database.getCampaign(campaign.id)!);
  }

  resume(campaign: Campaign): WaveSnapshot {
    if (campaign.runtime !== 'paused') throw new RunServiceError(409, 'wave_not_paused', 'There is no paused wave to resume.');
    if (!this.options.liquid || !this.options.analytics) throw new RunServiceError(503, 'provider_unavailable', 'Liquid and analytics must stay configured to resume.');
    this.options.database.setRuntime(campaign.id, 'running', campaign.agentCount, campaign.concurrency, new Date().toISOString());
    this.pump(campaign.id, campaign.concurrency);
    return this.snapshot(this.options.database.getCampaign(campaign.id)!);
  }

  recover(): void {
    this.options.database.markInterruptedAgentJobs(new Date().toISOString());
  }

  async close(): Promise<void> {
    for (const worker of this.workers.values()) worker.stop = true;
    await Promise.all([...this.workers.values()].flatMap((worker) => [...worker.inflight]));
    this.workers.clear();
  }

  private pump(campaignId: string, concurrency: number): void {
    if (this.workers.get(campaignId)) return;
    const worker = { stop: false, inflight: new Set<Promise<void>>() };
    this.workers.set(campaignId, worker);
    const run = async () => {
      const pending: AnalyticsEvent[] = [];
      try {
        while (!worker.stop) {
          while (worker.inflight.size >= concurrency) await Promise.race(worker.inflight);
          const campaign = this.options.database.getCampaign(campaignId);
          if (!campaign || campaign.runtime !== 'running') break;
          const claimed = this.options.database.claimNextAgentJob(campaignId, new Date().toISOString());
          if (!claimed) {
            if (worker.inflight.size === 0) {
              await this.flushEvents(campaignId, pending);
              await this.finishWave(campaignId);
              break;
            }
            await Promise.race(worker.inflight);
            continue;
          }
          const task = this.executeJob(claimed, pending).finally(() => worker.inflight.delete(task));
          worker.inflight.add(task);
        }
        await Promise.all([...worker.inflight]);
        await this.flushEvents(campaignId, pending);
      } finally {
        this.workers.delete(campaignId);
      }
    };
    void run();
  }

  private async executeJob(job: AgentJob, pending: AnalyticsEvent[]): Promise<void> {
    const startedAt = job.startedAt ?? new Date().toISOString();
    const queueWaitMs = Math.max(0, Date.parse(startedAt) - Date.parse(job.enqueuedAt) || 0);
    const wallStart = Date.now();
    let attempt = 0;
    while (attempt <= MAX_RETRIES) {
      try {
        const result = await this.judge(job);
        const finishedAt = new Date().toISOString();
        const saved = this.options.database.finishAgentJob(job.id, {
          status: 'succeeded',
          ...result.judgment,
          elapsedMs: result.metadata.elapsedMs,
          queueWaitMs,
          promptTokens: result.metadata.usage?.promptTokens ?? null,
          completionTokens: result.metadata.usage?.completionTokens ?? null,
          error: null,
          startedAt,
          finishedAt,
        });
        if (saved) pending.push(...eventsForJob(saved));
        if (pending.length >= INGEST_BATCH) await this.flushEvents(job.campaignId, pending);
        return;
      } catch (error) {
        attempt += 1;
        const retryable = error instanceof ProviderError && (
          error.code === 'timeout' || error.code === 'request' || error.message.includes('completion token budget')
        );
        if (retryable && attempt <= MAX_RETRIES) {
          await delay(backoffMs(error, attempt));
          continue;
        }
        this.options.database.finishAgentJob(job.id, {
          status: 'failed',
          error: error instanceof Error ? error.message : 'The persona judgment failed.',
          elapsedMs: Math.max(0, Date.now() - wallStart),
          queueWaitMs,
          startedAt,
          finishedAt: new Date().toISOString(),
        });
        return;
      }
    }
  }

  private async judge(job: AgentJob) {
    const campaign = this.options.database.getCampaign(job.campaignId);
    const variant = this.options.database.getVariant(job.variantId);
    const persona = personaById(job.personaId, campaign?.customPersonas);
    if (!campaign || !variant || !persona || !this.options.liquid) throw new RunServiceError(500, 'job_missing', 'The persona job lost its campaign context.');
    const siblings = this.options.database.listExperimentVariants(job.experimentId)
      .map((item) => item.headline)
      .filter((headline) => headline !== variant.headline);
    const mediaUrl = variant.videoUrl ?? variant.imageUrl;
    return this.options.liquid.judgeCreative({
      brief: [`Campaign: ${campaign.name}`, `Product: ${campaign.product}`, `Audience: ${campaign.audience}`, `Goal: sign-ups`, `Offer: ${variant.offer}`].join('\n'),
      personaCard: persona.card,
      personaLabel: persona.label,
      assignedHeadline: variant.headline,
      siblingHeadlines: siblings,
      mediaUrl,
      mediaType: variant.videoUrl ? 'video' : variant.imageUrl ? 'image' : null,
    });
  }

  private async flushEvents(campaignId: string, pending: AnalyticsEvent[]): Promise<void> {
    if (!pending.length || !this.options.analytics) return;
    const batch = pending.splice(0, pending.length);
    try {
      for (let index = 0; index < batch.length; index += 500) {
        await this.options.analytics.ingest(batch.slice(index, index + 500));
      }
      this.ingestErrors.delete(campaignId);
    } catch (error) {
      this.ingestErrors.set(campaignId, error instanceof Error ? error.message : 'Analytics ingest failed.');
    }
  }

  private async finishWave(campaignId: string): Promise<void> {
    const campaign = this.options.database.getCampaign(campaignId);
    const experiment = this.options.database.latestExperiment(campaignId);
    if (!campaign || !experiment) return;
    const jobs = this.options.database.listAgentJobs(campaignId, experiment.id);
    const succeeded = jobs.filter((job) => job.status === 'succeeded').length;
    const now = new Date().toISOString();
    this.options.database.completeExperiment(experiment.id, succeeded === 0 ? 'inconclusive' : 'completed', now);
    this.options.database.setRuntime(campaignId, 'idle', campaign.agentCount, campaign.concurrency, now);
    if (!this.options.liquid || succeeded === 0) return;
    this.reviewErrors.delete(campaignId);
    const segments = segmentMetrics(jobs, campaign.customPersonas);
    const evidence = segments.map((segment, index) => ({
      id: `SEG-${String(index + 1).padStart(2, '0')}`,
      summary: `${segment.label}: ${segment.signups}/${segment.views} sign-ups, median decide ${segment.medianDecideMs ?? '—'} ms, confidence ${segment.averageConfidence == null ? '—' : segment.averageConfidence.toFixed(2)}, friction ${segment.topFriction ?? 'none'}.`,
    }));
    try {
      const result = await this.options.liquid.proposeExperimentWithMetadata({
        brief: [`Campaign: ${campaign.name}`, `Product: ${campaign.product}`, `Audience: ${campaign.audience}`, `Goal: sign-ups`, `Headlines tested: ${campaign.headlines.join(' | ')}`].join('\n'),
        evidence,
        lessons: this.options.database.listLessons(campaignId).slice(0, 10).map((lesson) => ({ id: lesson.id, statement: lesson.statement })),
        stage: 'review',
      });
      const decision: DecisionRecord = {
        id: randomUUID(),
        campaignId,
        experimentId: experiment.id,
        action: result.decision.action,
        explanation: result.decision.explanation,
        hypothesis: result.decision.hypothesis,
        headlines: result.decision.headlines,
        evidenceIds: result.decision.evidenceIds,
        createdAt: new Date().toISOString(),
      };
      this.options.database.createDecision(decision);
      this.options.database.createLesson({
        id: randomUUID(),
        campaignId,
        statement: result.decision.explanation,
        audience: campaign.audience,
        offer: DEFAULT_OFFER,
        experimentId: experiment.id,
        evidenceIds: result.decision.evidenceIds,
        status: 'active',
        createdAt: decision.createdAt,
      });
      if (result.decision.action === 'propose_test') {
        this.options.database.setHeadlines(campaignId, result.decision.headlines, decision.createdAt);
      }
    } catch (error) {
      this.reviewErrors.set(campaignId, error instanceof Error ? error.message : 'Campaign review failed.');
    }
  }
}

function eventsForJob(job: AgentJob): AnalyticsEvent[] {
  const timestamp = job.finishedAt ?? new Date().toISOString();
  const shared = {
    campaign_id: job.campaignId,
    experiment_id: job.experimentId,
    variant_id: job.variantId,
    visitor_id: job.id,
    agent_id: job.id,
    audience_segment: job.audienceSegment,
    timestamp,
    decision_latency_ms: job.elapsedMs ?? undefined,
    dwell_seconds: job.dwellSeconds ?? undefined,
    time_to_action_seconds: job.timeToActionSeconds ?? undefined,
    confidence: job.confidence ?? undefined,
    attention: job.attention ?? undefined,
    clarity: job.clarity ?? undefined,
    trust: job.trust ?? undefined,
    purchase_intent: job.purchaseIntent ?? undefined,
    noticed_first: job.noticedFirst ?? undefined,
    friction: job.friction ?? undefined,
  };
  const events: AnalyticsEvent[] = [{ ...shared, event_id: randomUUID(), event_type: 'impression', cost_cents: eventCost('skip') }];
  if (job.action === 'click' || job.action === 'signup') {
    events.push({ ...shared, event_id: randomUUID(), event_type: 'click', cost_cents: eventCost('click') - eventCost('skip') });
  }
  if (job.action === 'signup') {
    events.push({ ...shared, event_id: randomUUID(), event_type: 'signup', cost_cents: 0 });
  }
  return events;
}

function backoffMs(error: unknown, attempt: number): number {
  const rateLimited = error instanceof Error && /HTTP 429/.test(error.message);
  const base = rateLimited ? 1_000 : 250;
  return Math.min(8_000, base * (2 ** (attempt - 1)));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function medianSafe(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function percentileSafe(values: number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}
