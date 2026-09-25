import { randomUUID } from 'node:crypto';
import { assignPersonaWave, personaById } from '../shared/personas.js';
import {
  DEFAULT_OFFER,
  headlineSetSchema,
  type AgentJob,
  type DecisionRecord,
  type LoopStatus,
  type LoopStopReason,
  type RunWaveInput,
  type WaveSnapshot,
} from '../shared/run.js';
import type { Campaign, Experiment, Lesson, MetricsSnapshot, Variant } from '../shared/types.js';
import { emptyMetricsSnapshot } from '../shared/types.js';
import type { CampaignDatabase } from './database.js';
import { DEFAULT_MAX_AUTO_ROUNDS, DEFAULT_SUCCESS_CLICK_RATE, ProviderError, type AnalyticsClient, type AnalyticsEvent, type LiquidClient } from './providers/index.js';
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
  /** Click rate at which the loop stops early. Defaults to SUCCESS_CLICK_RATE_THRESHOLD. */
  successClickRate?: number;
  /** Upper bound on automatically chained waves. */
  maxAutoRounds?: number;
}

const INGEST_BATCH = 50;
const MAX_RETRIES = 2;

export class ExperimentRunService {
  private readonly workers = new Map<string, { stop: boolean; inflight: Set<Promise<void>> }>();
  private readonly ingestErrors = new Map<string, string>();
  private readonly reviewErrors = new Map<string, string>();
  private readonly loopStatuses = new Map<string, LoopStatus>();
  /** Media carried into each chained round so every wave shares the approved creative. */
  private readonly loopMedia = new Map<string, Array<{ imageUrl: string | null; videoUrl: string | null }>>();
  /** Timers for chained rounds that have not started yet, so shutdown can cancel them. */
  private readonly pendingRounds = new Map<string, ReturnType<typeof setTimeout>>();

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
      loopStatus: this.loopStatuses.get(campaign.id) ?? null,
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

  async metrics(campaign: Campaign): Promise<MetricsSnapshot> {
    const experiment = this.options.database.latestExperiment(campaign.id);
    if (!experiment) return emptyMetricsSnapshot(campaign.id);
    return this.metricsForExperiment(campaign, experiment);
  }

  /** Metrics for every round of a campaign, newest first, so the UI can chart each version. */
  async rounds(campaign: Campaign): Promise<Array<{ round: number; experiment: Experiment; metrics: MetricsSnapshot }>> {
    const experiments = this.options.database.listExperiments(campaign.id);
    const ordered = [...experiments].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const results = await Promise.all(ordered.map(async (experiment, index) => ({
      round: index + 1,
      experiment,
      metrics: await this.metricsForExperiment(campaign, experiment),
    })));
    return results.reverse();
  }

  /**
   * Reads one experiment's results from analytics, falling back to the locally recorded jobs.
   * `source` always names the path that produced the numbers, so a silent fallback stays visible.
   */
  private async metricsForExperiment(campaign: Campaign, experiment: Experiment): Promise<MetricsSnapshot> {
    const jobs = this.options.database.listAgentJobs(campaign.id, experiment.id);
    const local = this.localMetrics(campaign, experiment, jobs);
    const analytics = this.options.analytics;
    if (!analytics || !experiment.windowStart) return local;
    try {
      const window = { start: experiment.windowStart, end: experiment.windowEnd ?? new Date().toISOString() };
      const query = {
        campaignId: campaign.id,
        experimentId: experiment.id,
        start: new Date(window.start).toISOString(),
        end: new Date(window.end).toISOString(),
      };
      const [rows, series] = await Promise.all([analytics.query(query), analytics.querySeries(query)]);
      if (rows.length === 0) return local;
      const variants = rows.map((row) => ({
        variantId: row.variantId,
        totals: {
          impressions: row.impressions,
          uniqueVisitors: row.uniqueVisitors,
          clicks: row.clicks,
          signups: row.signups,
          spendCents: row.spendCents,
        },
      }));
      const totals = variants.reduce((sum, item) => ({
        impressions: sum.impressions + item.totals.impressions,
        uniqueVisitors: sum.uniqueVisitors + item.totals.uniqueVisitors,
        clicks: sum.clicks + item.totals.clicks,
        signups: sum.signups + item.totals.signups,
        spendCents: sum.spendCents + item.totals.spendCents,
      }), { impressions: 0, uniqueVisitors: 0, clicks: 0, signups: 0, spendCents: 0 });
      return {
        ...local,
        source: analytics.provider,
        status: 'available',
        totals,
        variants,
        // The series pipe is optional; keep the locally derived line when it returns nothing.
        series: series.length ? series : local.series,
        message: `Results read from ${analytics.provider}.`,
      };
    } catch (error) {
      return {
        ...local,
        message: `${local.message} Analytics read failed, so these numbers come from local judgments: ${error instanceof Error ? error.message : 'unknown error'}`,
      };
    }
  }

  private localMetrics(campaign: Campaign, experiment: Experiment | null, jobs: AgentJob[]): MetricsSnapshot {
    if (jobs.length === 0) return emptyMetricsSnapshot(campaign.id);
    const succeeded = jobs.filter((job) => job.status === 'succeeded');
    const decide = succeeded.map((job) => job.elapsedMs).filter((value): value is number => value != null);
    return {
      campaignId: campaign.id,
      source: 'sqlite',
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
    // A manual start begins a fresh loop: clear the previous stop reason and carry the media forward.
    this.loopStatuses.delete(campaign.id);
    this.loopMedia.set(campaign.id, media);
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
    const pending = this.pendingRounds.get(campaign.id);
    if (pending) { clearTimeout(pending); this.pendingRounds.delete(campaign.id); }
    // A manual pause ends the automatic loop; scheduleNextRound also re-checks runtime.
    this.loopStatuses.set(campaign.id, {
      reason: 'paused',
      round: this.options.database.listExperiments(campaign.id).length,
      maxRounds: this.options.maxAutoRounds ?? DEFAULT_MAX_AUTO_ROUNDS,
      message: 'The wave was paused, so the automatic loop stopped.',
      bestClickRate: null,
      threshold: this.options.successClickRate ?? DEFAULT_SUCCESS_CLICK_RATE,
      metricsSource: 'none',
    });
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
    for (const timer of this.pendingRounds.values()) clearTimeout(timer);
    this.pendingRounds.clear();
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

    // Step 5 feeding step 6: judge the round against the configured success threshold using the
    // same metrics the dashboard shows, and record which source decided it.
    const round = this.options.database.listExperiments(campaignId).length;
    const maxRounds = this.options.maxAutoRounds ?? DEFAULT_MAX_AUTO_ROUNDS;
    const threshold = this.options.successClickRate ?? DEFAULT_SUCCESS_CLICK_RATE;
    const measured = await this.metricsForExperiment(campaign, { ...experiment, windowEnd: experiment.windowEnd ?? now });
    const bestClickRate = bestVariantClickRate(measured);
    const stop = (reason: LoopStopReason, message: string) => {
      this.loopStatuses.set(campaignId, {
        reason, round, maxRounds, message, bestClickRate, threshold, metricsSource: measured.source === 'none' ? 'none' : measured.source,
      });
    };

    // The threshold decides whether to chain another round, not whether to review. Step 6 always
    // runs so the decision and lesson are recorded for this round either way.
    const thresholdMet = bestClickRate != null && bestClickRate >= threshold;
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
      if (thresholdMet) {
        stop('threshold_met', `A variant reached a ${((bestClickRate ?? 0) * 100).toFixed(1)}% click rate, meeting the ${(threshold * 100).toFixed(1)}% threshold, so the loop stopped.`);
        return;
      }
      if (result.decision.action !== 'propose_test') {
        stop('liquid_wait', 'Liquid asked to keep collecting evidence instead of proposing a new test, so the loop stopped.');
        return;
      }
      this.options.database.setHeadlines(campaignId, result.decision.headlines, decision.createdAt);
      if (round >= maxRounds) {
        stop('round_cap', `The loop reached its limit of ${maxRounds} rounds. Start another wave manually to continue.`);
        return;
      }
      this.loopStatuses.delete(campaignId);
      this.scheduleNextRound(campaignId, round);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Campaign review failed.';
      this.reviewErrors.set(campaignId, message);
      stop('review_failed', `The review step failed, so the loop stopped: ${message}`);
    }
  }

  /**
   * Starts the next round once the current worker has unwound.
   *
   * finishWave runs inside pump's loop, which only deletes its worker entry in the `finally`
   * that follows. Calling start() -> pump() from here would hit pump's "already running" guard
   * and return silently, leaving the jobs enqueued with nothing to process them. Deferring past
   * the current task lets that `finally` run first.
   */
  private scheduleNextRound(campaignId: string, round: number): void {
    // A microtask is not late enough: microtasks drain before the awaiting caller reaches the
    // `finally` that removes the worker, so pump() would still see one and refuse. A timer runs
    // on the macrotask queue, after run() has fully unwound.
    const timer = setTimeout(() => {
      this.pendingRounds.delete(campaignId);
      void (async () => {
        // Re-read state: the user may have paused, deleted, or restarted in the meantime.
        const campaign = this.options.database.getCampaign(campaignId);
        if (!campaign || campaign.runtime !== 'idle') return;
        if (this.workers.has(campaignId)) return;
        const media = this.loopMedia.get(campaignId) ?? [];
        try {
          await this.start(campaign, {
            headlines: campaign.headlines,
            agentCount: campaign.agentCount,
            concurrency: campaign.concurrency,
            profileMix: [],
          }, media);
        } catch (error) {
          this.loopStatuses.set(campaignId, {
            reason: 'review_failed',
            round,
            maxRounds: this.options.maxAutoRounds ?? DEFAULT_MAX_AUTO_ROUNDS,
            message: `The next round could not start: ${error instanceof Error ? error.message : 'unknown error'}`,
            bestClickRate: null,
            threshold: this.options.successClickRate ?? DEFAULT_SUCCESS_CLICK_RATE,
            metricsSource: 'none',
          });
        }
      })();
    }, 0);
    timer.unref?.();
    this.pendingRounds.set(campaignId, timer);
  }
}

/** Highest clicks/impressions across variants, or null when nothing has been measured. */
function bestVariantClickRate(metrics: MetricsSnapshot): number | null {
  const rates = metrics.variants
    .filter((variant) => variant.totals.impressions > 0)
    .map((variant) => variant.totals.clicks / variant.totals.impressions);
  return rates.length ? Math.max(...rates) : null;
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
