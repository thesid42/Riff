import { randomUUID } from 'node:crypto';
import { assignPersonaWave, personaById } from '../shared/personas.js';
import { calibrateHumanJudgment } from './human-behavior.js';
import {
  DEFAULT_OFFER,
  headlineSetSchema,
  type AgentJob,
  type CreativeOutcome,
  type DecisionRecord,
  type LoopActivity,
  type LoopPhase,
  type LoopStatus,
  type LoopStopReason,
  type PersonaSegmentMetrics,
  type RoundSummary,
  type RunWaveInput,
  type WaveSnapshot,
} from '../shared/run.js';
import type { Campaign, Experiment, Lesson, MetricsSnapshot, Variant } from '../shared/types.js';
import { emptyMetricsSnapshot } from '../shared/types.js';
import type { CampaignDatabase } from './database.js';
import { applyLessonToImagePrompt } from '../shared/image-prompts.js';
import { IMAGE_TIMEOUT_MS, suggestImagePrompt, type CreativeAsset, type CreativeService } from './creative.js';
import {
  DEFAULT_MAX_AUTO_ROUNDS,
  DEFAULT_SUCCESS_CLICK_RATE,
  LIQUID_VISION_IMAGE_MAX_BYTES,
  LIQUID_VISION_VIDEO_MAX_BYTES,
  ProviderError,
  type AnalyticsClient,
  type AnalyticsEvent,
  type CreativeJudgeMedia,
  type LiquidClient,
} from './providers/index.js';
import { MAX_AGENT_COST_CENTS, deciderSpeed, eventCost, jobProgress, lastJobError, latestJudgmentAt, segmentMetrics, signupSeries, totalsFromJobs, variantTotals } from './wave-metrics.js';

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
  /**
   * Generates a chained round's images at step 3. Absent when BFL is unconfigured or
   * AUTO_CREATIVE_ENABLED is false; the loop then reuses the previous round's media and says so.
   */
  creative?: LoopCreative;
  /** Longest wait for a generated creative job. Defaults to the per-image limit times the image count, plus margin. */
  creativeTimeoutMs?: number;
  /** How often to re-read a generating creative job. */
  creativePollMs?: number;
  /** Reads stored creative media so persona judges can inspect the image or video they are shown. */
  assets?: { getAsset(jobId: string): Promise<CreativeAsset | undefined> };
}

/** The slice of CreativeService the loop needs; test fakes need only this method. */
export type LoopCreative = Pick<CreativeService, 'createImageJob'>;

type RoundMedia = Array<{ imageUrl: string | null; videoUrl: string | null }>;
type VisualMode = 'shared' | 'distinct' | 'text-only';

/** What the current loop is running, so a chained round can decide what to carry forward. */
interface LoopRound {
  headlines: string[];
  media: RoundMedia;
  visualMode: VisualMode;
  personaIds: string[];
  hypothesis: string;
}

/** The step 6 outcome that the next round is built from. */
interface NextRound {
  /** test: the full 1 → 2 → 3 → 4 path. collect: 6 → 4 on the same experiment. */
  kind: 'test' | 'collect';
  decisionId: string;
  hypothesis: string;
  personaIds: string[];
  needsNewCreative: boolean;
}

type RoundCreative =
  | { ok: true; outcome: CreativeOutcome; media: RoundMedia; visualMode: VisualMode; note?: string }
  | { ok: false; message: string };

const INGEST_BATCH = 50;
const MAX_RETRIES = 2;
const CREATIVE_TIMEOUT_MARGIN_MS = 30_000;
const DEFAULT_CREATIVE_POLL_MS = 1_000;

export class ExperimentRunService {
  private readonly workers = new Map<string, { stop: boolean; inflight: Set<Promise<void>> }>();
  private readonly ingestErrors = new Map<string, string>();
  private readonly reviewErrors = new Map<string, string>();
  private readonly loopStatuses = new Map<string, LoopStatus>();
  /** The headlines, media and personas of each campaign's latest round, carried into the next. */
  private readonly loopRounds = new Map<string, LoopRound>();
  /** Why a loop reused creative without a generator, surfaced when that loop stops. */
  private readonly creativeNotes = new Map<string, string>();
  /** Timers for chained rounds that have not started yet, so shutdown can cancel them. */
  private readonly pendingRounds = new Map<string, ReturnType<typeof setTimeout>>();
  /** Chained rounds between their timer and start(), including any wait on image generation. */
  private readonly preparing = new Map<string, { controller: AbortController; task: Promise<void> }>();
  /** Live phase and the latest iteration event, so the UI can say what the agent is doing. */
  private readonly loopActivities = new Map<string, LoopActivity>();

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
      loopContinuing: this.pendingRounds.has(campaign.id) || this.preparing.has(campaign.id) || this.options.database.isLoopActive(campaign.id),
      loopActive: this.options.database.isLoopActive(campaign.id),
      successClickRate: this.loopThreshold(campaign),
      maxAutoRounds: this.loopMaxRounds(campaign),
      loopActivity: this.liveActivity(campaign, jobs),
    };
  }

  private setLoopActivity(campaignId: string, next: { phase: LoopPhase; title: string; detail: string; round?: number; event?: string | null }): void {
    const prior = this.loopActivities.get(campaignId);
    this.loopActivities.set(campaignId, {
      phase: next.phase,
      title: next.title,
      detail: next.detail,
      round: next.round ?? prior?.round ?? this.currentLoopRound(campaignId),
      event: next.event !== undefined ? next.event : prior?.event ?? null,
    });
  }

  private liveActivity(campaign: Campaign, jobs: AgentJob[]): LoopActivity | null {
    const stored = this.loopActivities.get(campaign.id);
    const live = campaign.runtime === 'running' || this.pendingRounds.has(campaign.id) || this.preparing.has(campaign.id) || this.options.database.isLoopActive(campaign.id);
    if (!live) return null;
    const round = stored?.round || this.currentLoopRound(campaign.id);
    const event = stored?.event ?? this.creativeNotes.get(campaign.id) ?? null;
    const progress = jobProgress(jobs);
    if (this.preparing.has(campaign.id) || this.pendingRounds.has(campaign.id)) {
      return stored ?? {
        phase: this.preparing.has(campaign.id) ? 'generating' : 'starting',
        title: this.preparing.has(campaign.id) ? 'Preparing the next round' : 'Starting the next round',
        detail: 'The last wave finished. The next test is getting ready.',
        round, event,
      };
    }
    if (campaign.runtime === 'running') {
      const done = progress.succeeded + progress.failed;
      return {
        phase: 'judging',
        title: 'Judging this wave',
        detail: progress.total
          ? `${done} of ${progress.total} personas finished · ${progress.running} live · ${progress.succeeded} judged`
          : 'Personas are lining up to inspect the ad.',
        round, event,
      };
    }
    return stored ?? {
      phase: 'reviewing',
      title: 'Writing the lesson',
      detail: 'The wave finished. The agent is turning results into the next improvement.',
      round, event,
    };
  }

  private loopThreshold(campaign: Campaign): number {
    return campaign.successClickRate ?? this.options.successClickRate ?? DEFAULT_SUCCESS_CLICK_RATE;
  }

  private loopMaxRounds(campaign: Campaign): number {
    return campaign.maxAutoRounds ?? this.options.maxAutoRounds ?? DEFAULT_MAX_AUTO_ROUNDS;
  }

  /** Round within the current loop, not the campaign's lifetime experiment count. */
  private currentLoopRound(campaignId: string): number {
    const total = this.options.database.listExperiments(campaignId).length;
    const origin = this.options.database.getLoopOrigin(campaignId);
    return Math.max(1, total - origin);
  }

  details(campaign: Campaign): {
    campaign: Campaign;
    variants: Variant[];
    experiments: Experiment[];
    lessons: Lesson[];
    decisions: DecisionRecord[];
    wave: WaveSnapshot;
  } {
    this.backfillMissingLesson(campaign);
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
  async rounds(campaign: Campaign): Promise<Array<{ round: number; experiment: Experiment; metrics: MetricsSnapshot } & RoundSummary>> {
    const experiments = this.options.database.listExperiments(campaign.id);
    const ordered = [...experiments].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const decisions = this.options.database.listDecisions(campaign.id);
    const variantsByRound = ordered.map((experiment) => this.options.database.listExperimentVariants(experiment.id));
    const results = await Promise.all(ordered.map(async (experiment, index) => {
      const variants = variantsByRound[index]!;
      const personaIds = [...new Set(this.options.database.listAgentJobs(campaign.id, experiment.id).map((job) => job.personaId))].sort();
      // The previous round's decision records what step 3 did for this one; older rows predate
      // that field, so fall back to comparing the media the two rounds actually used.
      const previous = index > 0 ? ordered[index - 1]! : null;
      const recorded = previous ? decisions.find((decision) => decision.experimentId === previous.id)?.creativeOutcome : null;
      return {
        round: index + 1,
        experiment,
        metrics: await this.metricsForExperiment(campaign, experiment),
        creative: previous ? recorded ?? compareRoundMedia(variantsByRound[index - 1]!, variants) : 'initial' as const,
        personas: personaIds.map((id) => ({ id, label: personaById(id, campaign.customPersonas)?.label ?? id })),
        media: variants.map((variant) => ({ label: variant.label, headline: variant.headline, imageUrl: variant.imageUrl, videoUrl: variant.videoUrl })),
      };
    }));
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
      updatedAt: latestJudgmentAt(succeeded),
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
    if (!parsed.success) throw new RunServiceError(400, 'validation_error', 'Provide 2 or 3 unique headlines, each no longer than 60 characters.');
    if (campaign.runtime === 'running') throw new RunServiceError(409, 'wave_active', 'Headlines cannot change while a wave is running.');
    return this.options.database.setHeadlines(campaign.id, parsed.data, new Date().toISOString()) ?? campaign;
  }

  async start(
    campaign: Campaign,
    input: RunWaveInput,
    media: RoundMedia,
    visualMode: VisualMode = 'text-only',
    round: { hypothesis?: string; chained?: boolean } = {},
  ): Promise<WaveSnapshot> {
    if (!this.options.liquid) throw new RunServiceError(503, 'liquid_unavailable', 'Liquid is not configured.');
    if (!this.options.analytics) throw new RunServiceError(503, 'analytics_unavailable', 'Analytics is not configured.');
    if (campaign.runtime === 'running') throw new RunServiceError(409, 'wave_active', 'This draft already has a persona wave running.');
    const headlines = headlineSetSchema.safeParse(input.headlines?.length ? input.headlines : campaign.headlines);
    if (!headlines.success) throw new RunServiceError(400, 'headlines_required', 'Ask Liquid for headlines, or enter 2 or 3 unique headlines no longer than 60 characters each, before starting a wave.');
    // A manual start begins a fresh loop: clear the previous stop reason. Either way, record what
    // this round runs so the next chained round can decide what to carry forward.
    this.loopStatuses.delete(campaign.id);
    if (input.successClickRate !== undefined || input.maxAutoRounds !== undefined) {
      this.options.database.setLoopSettings(campaign.id, {
        ...(input.successClickRate !== undefined ? { successClickRate: input.successClickRate } : {}),
        ...(input.maxAutoRounds !== undefined ? { maxAutoRounds: input.maxAutoRounds } : {}),
      }, new Date().toISOString());
      campaign = this.options.database.getCampaign(campaign.id) ?? campaign;
    }
    this.options.database.setLoopActive(campaign.id, true, new Date().toISOString());
    if (!round.chained) {
      this.options.database.setLoopOrigin(campaign.id, this.options.database.listExperiments(campaign.id).length, new Date().toISOString());
      this.creativeNotes.delete(campaign.id);
      this.loopActivities.delete(campaign.id);
      this.cancelPreparing(campaign.id);
    }
    const hypothesis = round.hypothesis || (visualMode === 'distinct'
      ? 'Compare complete campaign concepts, including each headline and its paired visual, while holding the offer constant.'
      : visualMode === 'shared'
        ? 'Compare headline directions while holding the offer and shared media constant.'
        : 'Compare headline directions with text-only variants while holding the offer constant.');
    this.loopRounds.set(campaign.id, { headlines: headlines.data, media, visualMode, personaIds: input.profileMix ?? [], hypothesis });
    const now = new Date().toISOString();
    this.options.database.setHeadlines(campaign.id, headlines.data, now);
    const experiment = this.options.database.createExperiment({
      id: randomUUID(),
      campaignId: campaign.id,
      hypothesis,
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
    this.setLoopActivity(campaign.id, {
      phase: 'judging',
      title: 'Judging this wave',
      detail: `${input.agentCount} personas are inspecting the ad.`,
      round: this.currentLoopRound(campaign.id),
      event: round.chained ? undefined : null,
    });
    this.pump(campaign.id, input.concurrency);
    return this.snapshot(this.options.database.getCampaign(campaign.id)!);
  }

  pause(campaign: Campaign): WaveSnapshot {
    const between = this.pendingRounds.has(campaign.id) || this.preparing.has(campaign.id);
    if (campaign.runtime !== 'running' && !between) throw new RunServiceError(409, 'wave_not_running', 'There is no running wave to pause.');
    const worker = this.workers.get(campaign.id);
    if (worker) worker.stop = true;
    const pending = this.pendingRounds.get(campaign.id);
    if (pending) { clearTimeout(pending); this.pendingRounds.delete(campaign.id); }
    this.cancelPreparing(campaign.id);
    // A manual pause ends the automatic loop; scheduleNextRound also re-checks runtime.
    this.options.database.setLoopActive(campaign.id, false, new Date().toISOString());
    this.loopActivities.delete(campaign.id);
    this.loopStatuses.set(campaign.id, {
      reason: 'paused',
      round: this.currentLoopRound(campaign.id),
      maxRounds: this.loopMaxRounds(campaign),
      message: 'The campaign agent was paused, so automatic improvement stopped.',
      bestClickRate: null,
      threshold: this.loopThreshold(campaign),
      metricsSource: 'none',
    });
    // Between rounds there is no wave to resume, so the draft stays idle rather than paused.
    if (campaign.runtime === 'running') {
      this.options.database.setRuntime(campaign.id, 'paused', campaign.agentCount, campaign.concurrency, new Date().toISOString());
    }
    return this.snapshot(this.options.database.getCampaign(campaign.id)!);
  }

  resume(campaign: Campaign): WaveSnapshot {
    if (campaign.runtime !== 'paused') throw new RunServiceError(409, 'wave_not_paused', 'There is no paused wave to resume.');
    if (!this.options.liquid || !this.options.analytics) throw new RunServiceError(503, 'provider_unavailable', 'Liquid and analytics must stay configured to resume.');
    this.options.database.setLoopActive(campaign.id, true, new Date().toISOString());
    this.loopStatuses.delete(campaign.id);
    this.setLoopActivity(campaign.id, {
      phase: 'judging',
      title: 'Judging this wave',
      detail: 'The campaign agent resumed. Personas are inspecting the ad again.',
    });
    this.options.database.setRuntime(campaign.id, 'running', campaign.agentCount, campaign.concurrency, new Date().toISOString());
    this.pump(campaign.id, campaign.concurrency);
    return this.snapshot(this.options.database.getCampaign(campaign.id)!);
  }

  recover(): void {
    this.options.database.markInterruptedAgentJobs(new Date().toISOString());
    for (const campaign of this.options.database.listLoopActiveCampaigns()) {
      void this.resumeAgent(campaign.id);
    }
  }

  async close(): Promise<void> {
    for (const timer of this.pendingRounds.values()) clearTimeout(timer);
    this.pendingRounds.clear();
    const preparing = [...this.preparing.values()];
    for (const { controller } of preparing) controller.abort();
    await Promise.all(preparing.map(({ task }) => task));
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
    const mediaType = variant.videoUrl ? 'video' : variant.imageUrl ? 'image' : null;
    const result = await this.options.liquid.judgeCreative({
      brief: [`Campaign: ${campaign.name}`, `Product: ${campaign.product}`, `Audience: ${campaign.audience}`, `Goal: sign-ups`, `Offer: ${variant.offer}`].join('\n'),
      personaCard: persona.card,
      personaLabel: persona.label,
      assignedHeadline: variant.headline,
      siblingHeadlines: siblings,
      mediaUrl,
      mediaType,
      media: await this.loadJudgeMedia(mediaUrl, mediaType),
    });
    return {
      ...result,
      judgment: calibrateHumanJudgment({
        judgment: result.judgment,
        persona,
        seed: `${job.id}:${job.personaId}:${job.variantId}`,
        mediaType,
      }),
    };
  }

  private async loadJudgeMedia(mediaUrl: string | null, mediaType: 'image' | 'video' | null): Promise<CreativeJudgeMedia | undefined> {
    if (!mediaUrl || !mediaType || !this.options.assets) return undefined;
    const match = /^\/api\/creative-assets\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i.exec(mediaUrl);
    if (!match?.[1]) return undefined;
    const asset = await this.options.assets.getAsset(match[1]);
    if (!asset || asset.mediaType !== mediaType) return undefined;
    const maxBytes = mediaType === 'video' ? LIQUID_VISION_VIDEO_MAX_BYTES : LIQUID_VISION_IMAGE_MAX_BYTES;
    if (asset.bytes.byteLength === 0 || asset.bytes.byteLength > maxBytes) return undefined;
    return { bytes: asset.bytes, contentType: asset.contentType, mediaType: asset.mediaType };
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
    if (succeeded === 0) return;
    this.reviewErrors.delete(campaignId);
    this.setLoopActivity(campaignId, {
      phase: 'reviewing',
      title: 'Writing the lesson',
      detail: 'The wave finished. Turning persona results into the next improvement.',
    });

    // Step 5 feeding step 6: judge the round against the configured success threshold using the
    // same metrics the dashboard shows, and record which source decided it.
    const round = this.currentLoopRound(campaignId);
    const maxRounds = this.loopMaxRounds(campaign);
    const threshold = this.loopThreshold(campaign);
    const measured = await this.metricsForExperiment(campaign, { ...experiment, windowEnd: experiment.windowEnd ?? now });
    const bestClickRate = bestVariantClickRate(measured);
    const stop = (reason: LoopStopReason, message: string) => {
      this.options.database.setLoopActive(campaignId, false, new Date().toISOString());
      this.loopActivities.delete(campaignId);
      const creativeNote = this.creativeNotes.get(campaignId);
      this.loopStatuses.set(campaignId, {
        reason, round, maxRounds, message, bestClickRate, threshold, metricsSource: measured.source === 'none' ? 'none' : measured.source,
        ...(creativeNote ? { creativeNote } : {}),
      });
    };

    // The threshold decides whether to chain another round, not whether to review. Step 6 always
    // runs so the decision and lesson are recorded for this round either way.
    const thresholdMet = bestClickRate != null && bestClickRate >= threshold;
    // Each evidence line names its persona ID, and the same IDs form the whitelist Liquid may
    // target next round. Liquid accepts at most 30 evidence items, so keep the largest segments.
    const segments = segmentMetrics(jobs, campaign.customPersonas)
      .sort((a, b) => b.sampleSize - a.sampleSize || a.segment.localeCompare(b.segment))
      .slice(0, 30);
    const evidence = segments.map((segment, index) => ({
      id: `SEG-${String(index + 1).padStart(2, '0')}`,
      summary: `${segment.label} (persona ${segment.segment}): ${segment.signups}/${segment.views} sign-ups, median decide ${segment.medianDecideMs ?? '—'} ms, confidence ${segment.averageConfidence == null ? '—' : segment.averageConfidence.toFixed(2)}, friction ${segment.topFriction ?? 'none'}.`,
    }));
    const brief = [
      `Campaign: ${campaign.name}`,
      `Product: ${campaign.product}`,
      `Audience: ${campaign.audience}`,
      `Goal: sign-ups`,
      `Approved claims: ${campaign.approvedClaims.length ? JSON.stringify(campaign.approvedClaims) : 'None supplied.'}`,
      `Headlines tested: ${campaign.headlines.join(' | ')}`,
    ].join('\n');
    if (brief.length > 4_000) {
      this.recordWaveLesson(campaign, experiment, fallbackLessonStatement(campaign.headlines, segments, bestClickRate), evidence.map((item) => item.id));
      stop('review_failed', 'Campaign details exceed the experiment planner limit, so the loop stopped. Shorten the campaign name, product, audience, or approved claims.');
      return;
    }
    if (!this.options.liquid) {
      this.recordWaveLesson(campaign, experiment, fallbackLessonStatement(campaign.headlines, segments, bestClickRate), evidence.map((item) => item.id));
      return;
    }
    try {
      const result = await this.options.liquid.proposeExperimentWithMetadata({
        brief,
        evidence,
        lessons: this.options.database.listLessons(campaignId).slice(0, 10).map((lesson) => ({ id: lesson.id, statement: lesson.statement })),
        personas: segments.map((segment) => ({ id: segment.segment, label: segment.label })),
        stage: 'review',
      });
      const proposed = result.decision.action === 'wait' && headlineSetSchema.safeParse(result.decision.headlines).success
        ? {
          ...result.decision,
          action: 'propose_test' as const,
          hypothesis: result.decision.hypothesis.trim() || 'The latest wave supports a follow-up headline and creative test.',
        }
        : result.decision;
      const decision: DecisionRecord = {
        id: randomUUID(),
        campaignId,
        experimentId: experiment.id,
        action: proposed.action,
        explanation: proposed.explanation,
        hypothesis: proposed.hypothesis,
        headlines: proposed.headlines,
        evidenceIds: proposed.evidenceIds,
        personaIds: proposed.personaIds,
        needsNewCreative: proposed.needsNewCreative,
        creativeOutcome: null,
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
      this.setLoopActivity(campaignId, {
        phase: 'reviewing',
        title: 'Lesson saved',
        detail: 'The lesson is ready. Deciding whether to improve the next image or keep collecting.',
        event: 'Saved a lesson from this wave.',
      });
      if (thresholdMet) {
        stop('threshold_met', `A variant reached a ${((bestClickRate ?? 0) * 100).toFixed(1)}% click rate, meeting the ${(threshold * 100).toFixed(1)}% threshold, so the loop stopped.`);
        return;
      }

      // wait below the threshold: the evidence is too weak to plan from, so keep collecting on
      // the same experiment (6 → 4). Plan, rules and creative do not change, but the round still
      // counts toward the cap and must fit the budget.
      if (proposed.action === 'wait') {
        if (atRoundCap(round, maxRounds)) {
          stop('round_cap', `Liquid asked for more evidence, but the loop reached its limit of ${maxRounds} rounds. Start another wave manually to continue.`);
          return;
        }
        const spend = await this.spendSoFar(campaign);
        const overBudget = budgetViolation(campaign, spend, campaign.agentCount);
        if (overBudget) {
          stop('rules_failed', overBudget);
          return;
        }
        const current = this.loopRounds.get(campaignId);
        this.loopStatuses.delete(campaignId);
        this.setLoopActivity(campaignId, {
          phase: 'starting',
          title: 'Collecting more evidence',
          detail: 'The last wave was too thin to plan from. Running another pass on the same test.',
          event: 'Not enough signal yet. Collecting more evidence on the same test.',
        });
        this.scheduleNextRound(campaignId, round, {
          kind: 'collect',
          decisionId: decision.id,
          hypothesis: `Keep collecting evidence: ${current?.hypothesis ?? experiment.hypothesis}`,
          personaIds: current?.personaIds ?? [],
          needsNewCreative: false,
        });
        return;
      }

      // Step 2: check the proposal against the brief's claims, the budget and the test rules
      // before anything is applied. A failure leaves the tested headlines in place.
      const spend = await this.spendSoFar(campaign);
      const overBudget = budgetViolation(campaign, spend, campaign.agentCount);
      if (overBudget) {
        stop('rules_failed', overBudget);
        return;
      }
      const headlineViolation = headlineRuleViolation(proposed.headlines, campaign.approvedClaims);
      if (!headlineViolation) {
        this.options.database.setHeadlines(campaignId, proposed.headlines, decision.createdAt);
      }
      if (atRoundCap(round, maxRounds)) {
        stop('round_cap', `The loop reached its limit of ${maxRounds} rounds. Start another wave manually to continue.`);
        return;
      }
      const keepHeadlines = Boolean(headlineViolation);
      const needsNewCreative = proposed.needsNewCreative || keepHeadlines;
      this.loopStatuses.delete(campaignId);
      this.setLoopActivity(campaignId, {
        phase: 'starting',
        title: needsNewCreative ? 'Improving the next image' : 'Planning the next test',
        detail: keepHeadlines
          ? 'The proposed headlines broke a claim rule, so this round keeps the current copy and tries a new image.'
          : needsNewCreative
            ? 'The next round will generate a new image from a short visual change, not the raw lesson text.'
            : 'The next round will keep the current image and try new wording.',
        event: keepHeadlines
          ? `${headlineViolation} Kept the current headlines and continuing.`
          : needsNewCreative
            ? 'Next: generate a new image from the lesson.'
            : 'Next: keep the current image and test new headlines.',
      });
      this.scheduleNextRound(campaignId, round, {
        kind: 'test',
        decisionId: decision.id,
        hypothesis: proposed.hypothesis,
        personaIds: proposed.personaIds,
        needsNewCreative,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Campaign review failed.';
      this.reviewErrors.set(campaignId, message);
      this.recordWaveLesson(campaign, experiment, fallbackLessonStatement(campaign.headlines, segments, bestClickRate), evidence.map((item) => item.id));
      if (atRoundCap(round, maxRounds)) {
        stop('review_failed', `The review step failed, so the loop stopped: ${message}`);
        return;
      }
      const spend = await this.spendSoFar(campaign);
      const overBudget = budgetViolation(campaign, spend, campaign.agentCount);
      if (overBudget) {
        stop('rules_failed', overBudget);
        return;
      }
      const fallback = this.fallbackDecision(campaign, experiment, fallbackLessonStatement(campaign.headlines, segments, bestClickRate), evidence.map((item) => item.id));
      this.loopStatuses.delete(campaignId);
      this.setLoopActivity(campaignId, {
        phase: 'starting',
        title: 'Continuing after a review issue',
        detail: 'A fallback lesson was saved. The next round will still try a new image.',
        event: `Review had a problem: ${message} Saved a fallback lesson and continuing.`,
      });
      this.scheduleNextRound(campaignId, round, {
        kind: 'test',
        decisionId: fallback.id,
        hypothesis: fallback.hypothesis,
        personaIds: [],
        needsNewCreative: true,
      });
    }
  }

  private fallbackDecision(campaign: Campaign, experiment: Experiment, statement: string, evidenceIds: string[]): DecisionRecord {
    const existing = this.options.database.latestDecision(campaign.id);
    if (existing?.experimentId === experiment.id) return existing;
    const decision: DecisionRecord = {
      id: randomUUID(),
      campaignId: campaign.id,
      experimentId: experiment.id,
      action: 'propose_test',
      explanation: statement,
      hypothesis: 'Use the latest experiment learning to improve the next headline-and-visual test.',
      headlines: campaign.headlines,
      evidenceIds,
      personaIds: [],
      needsNewCreative: true,
      creativeOutcome: null,
      createdAt: new Date().toISOString(),
    };
    return this.options.database.createDecision(decision);
  }

  /** Resume a persisted campaign agent after a process restart. */
  private async resumeAgent(campaignId: string): Promise<void> {
    const campaign = this.options.database.getCampaign(campaignId);
    if (!campaign || !this.options.database.isLoopActive(campaignId) || !this.options.liquid || !this.options.analytics) return;
    const experiment = this.options.database.latestExperiment(campaignId);
    if (!experiment) return;
    const jobs = this.options.database.listAgentJobs(campaignId, experiment.id);
    const unfinished = jobs.some((job) => job.status === 'pending' || job.status === 'running');
    if (unfinished || experiment.status === 'collecting') {
      this.loopStatuses.delete(campaignId);
      if (campaign.runtime !== 'running') {
        this.options.database.setRuntime(campaignId, 'running', campaign.agentCount, campaign.concurrency, new Date().toISOString());
      }
      this.pump(campaignId, campaign.concurrency);
      return;
    }
    const measured = await this.metricsForExperiment(campaign, experiment);
    const threshold = this.loopThreshold(campaign);
    const maxRounds = this.loopMaxRounds(campaign);
    const round = this.currentLoopRound(campaignId);
    if (atRoundCap(round, maxRounds)) {
      this.options.database.setLoopActive(campaignId, false, new Date().toISOString());
      this.loopActivities.delete(campaignId);
      this.loopStatuses.set(campaignId, {
        reason: 'round_cap',
        round,
        maxRounds,
        message: `The loop reached its limit of ${maxRounds} rounds. Start another wave manually to continue.`,
        bestClickRate: bestVariantClickRate(measured),
        threshold,
        metricsSource: measured.source === 'none' ? 'none' : measured.source,
      });
      return;
    }
    const bestClickRate = bestVariantClickRate(measured);
    if (bestClickRate != null && bestClickRate >= threshold) {
      this.options.database.setLoopActive(campaignId, false, new Date().toISOString());
      this.loopActivities.delete(campaignId);
      this.loopStatuses.set(campaignId, {
        reason: 'threshold_met',
        round: this.currentLoopRound(campaignId),
        maxRounds: this.loopMaxRounds(campaign),
        message: `A variant reached a ${(bestClickRate * 100).toFixed(1)}% click rate, meeting the ${(threshold * 100).toFixed(1)}% threshold, so the loop stopped.`,
        bestClickRate,
        threshold,
        metricsSource: measured.source === 'none' ? 'none' : measured.source,
      });
      return;
    }
    const fallback = this.fallbackDecision(
      campaign,
      experiment,
      this.options.database.listLessons(campaignId).find((lesson) => lesson.experimentId === experiment.id)?.statement
        ?? fallbackLessonStatement(campaign.headlines, segmentMetrics(jobs, campaign.customPersonas), bestClickRate),
      [],
    );
    this.scheduleNextRound(campaignId, this.currentLoopRound(campaignId), {
      kind: 'test',
      decisionId: fallback.id,
      hypothesis: fallback.hypothesis,
      personaIds: [],
      needsNewCreative: true,
    });
  }

  /** Completed waves without a lesson still get one from the stored jobs. */
  private backfillMissingLesson(campaign: Campaign): void {
    const existing = new Set(
      this.options.database.listLessons(campaign.id).map((lesson) => lesson.experimentId),
    );
    for (const experiment of this.options.database.listExperiments(campaign.id)) {
      if (experiment.status === 'collecting' || existing.has(experiment.id)) continue;
      const jobs = this.options.database.listAgentJobs(campaign.id, experiment.id);
      if (!jobs.some((job) => job.status === 'succeeded')) continue;
      const segments = segmentMetrics(jobs, campaign.customPersonas)
        .sort((a, b) => b.sampleSize - a.sampleSize || a.segment.localeCompare(b.segment))
        .slice(0, 30);
      this.recordWaveLesson(
        campaign,
        experiment,
        fallbackLessonStatement(campaign.headlines, segments, null),
        segments.map((_, index) => `SEG-${String(index + 1).padStart(2, '0')}`),
      );
      existing.add(experiment.id);
    }
  }

  private recordWaveLesson(campaign: Campaign, experiment: Experiment, statement: string, evidenceIds: string[]): void {
    if (this.options.database.listLessons(campaign.id).some((lesson) => lesson.experimentId === experiment.id)) return;
    const clean = statement.trim().replace(/\s+/g, ' ').slice(0, 500);
    if (!clean) return;
    this.options.database.createLesson({
      id: randomUUID(),
      campaignId: campaign.id,
      statement: clean,
      audience: campaign.audience,
      offer: DEFAULT_OFFER,
      experimentId: experiment.id,
      evidenceIds,
      status: 'active',
      createdAt: new Date().toISOString(),
    });
  }

  /** Simulated spend across every round of the campaign, from the same source the dashboard reads. */
  private async spendSoFar(campaign: Campaign): Promise<number> {
    const experiments = this.options.database.listExperiments(campaign.id);
    const snapshots = await Promise.all(experiments.map((experiment) => this.metricsForExperiment(campaign, experiment)));
    return snapshots.reduce((sum, snapshot) => sum + snapshot.totals.spendCents, 0);
  }

  /**
   * Starts the next round once the current worker has unwound.
   *
   * finishWave runs inside pump's loop, which only deletes its worker entry in the `finally`
   * that follows. Calling start() -> pump() from here would hit pump's "already running" guard
   * and return silently, leaving the jobs enqueued with nothing to process them. Deferring past
   * the current task lets that `finally` run first.
   */
  private scheduleNextRound(campaignId: string, round: number, next: NextRound): void {
    // A microtask is not late enough: microtasks drain before the awaiting caller reaches the
    // `finally` that removes the worker, so pump() would still see one and refuse. A timer runs
    // on the macrotask queue, after run() has fully unwound.
    const timer = setTimeout(() => {
      this.pendingRounds.delete(campaignId);
      const controller = new AbortController();
      const task = this.runNextRound(campaignId, round, next, controller.signal).finally(() => {
        if (this.preparing.get(campaignId)?.controller === controller) this.preparing.delete(campaignId);
      });
      this.preparing.set(campaignId, { controller, task });
    }, 0);
    timer.unref?.();
    this.pendingRounds.set(campaignId, timer);
  }

  private async runNextRound(campaignId: string, round: number, next: NextRound, signal: AbortSignal): Promise<void> {
    const campaign = this.options.database.getCampaign(campaignId);
    const failed = (reason: LoopStopReason, message: string) => {
      this.loopActivities.delete(campaignId);
      this.loopStatuses.set(campaignId, {
        reason,
        round,
        maxRounds: campaign ? this.loopMaxRounds(campaign) : this.options.maxAutoRounds ?? DEFAULT_MAX_AUTO_ROUNDS,
        message,
        bestClickRate: null,
        threshold: campaign ? this.loopThreshold(campaign) : this.options.successClickRate ?? DEFAULT_SUCCESS_CLICK_RATE,
        metricsSource: 'none',
      });
    };
    try {
      // Re-read state: the user may have paused, deleted, or restarted in the meantime.
      if (!campaign || campaign.runtime !== 'idle' || this.workers.has(campaignId)) return;
      const current = this.loopRounds.get(campaignId) ?? { headlines: [], media: [], visualMode: 'text-only' as const, personaIds: [], hypothesis: '' };

      // Step 3: create or reuse the creative. A collection round keeps everything as it was.
      let creative: RoundCreative = next.kind === 'collect'
        ? { ok: true, outcome: hasMedia(current.media) ? 'reused' : 'text-only', media: current.media, visualMode: current.visualMode }
        : await this.creativeForRound(campaign, current, next.needsNewCreative, signal);
      if (signal.aborted) return;
      if (!creative.ok) {
        // Keep the agent moving: a failed image job must not kill the whole campaign loop.
        const fallbackMedia = hasMedia(current.media)
          ? current.media
          : campaign.headlines.map(() => ({ imageUrl: null, videoUrl: null }));
        creative = {
          ok: true,
          outcome: hasMedia(current.media) ? 'reused' : 'text-only',
          media: fallbackMedia,
          visualMode: hasMedia(current.media) ? current.visualMode : 'text-only',
          note: `New creative was not ready (${creative.message}) so this round continued on the previous visual.`,
        };
      }
      if (creative.note) this.creativeNotes.set(campaignId, creative.note);
      if (creative.ok) {
        const event = creative.outcome === 'new'
          ? 'Generated a new image from the last lesson.'
          : creative.outcome === 'reused'
            ? (creative.note ?? 'Kept the previous image for this round.')
            : 'This round is running on headline copy only.';
        this.setLoopActivity(campaignId, {
          phase: 'starting',
          title: 'Starting the next wave',
          detail: 'Personas will now inspect the latest headlines and visual.',
          round: this.currentLoopRound(campaignId) + 1,
          event,
        });
      }

      const latest = this.options.database.getCampaign(campaignId);
      if (!latest || latest.runtime !== 'idle' || this.workers.has(campaignId)) return;
      this.options.database.setDecisionCreativeOutcome(next.decisionId, creative.outcome);
      await this.start(latest, {
        headlines: latest.headlines,
        agentCount: latest.agentCount,
        concurrency: latest.concurrency,
        // An empty list means every persona (filterPersonas treats [] as the full roster), never
        // an empty wave. Named IDs restrict the wave to the personas Liquid chose.
        profileMix: next.personaIds.length ? next.personaIds : [],
      }, creative.media, creative.visualMode, { hypothesis: next.hypothesis, chained: true });
    } catch (error) {
      failed('review_failed', `The next round could not start: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
  }

  /**
   * Step 3 for a planned round. Liquid decides create or reuse, but reuse is only valid when the
   * existing images were made for these exact headlines; otherwise generation is mandatory.
   */
  private async creativeForRound(campaign: Campaign, current: LoopRound, needsNewCreative: boolean, signal: AbortSignal): Promise<RoundCreative> {
    const headlines = campaign.headlines;
    const media = hasMedia(current.media);
    const headlinesMatch = current.headlines.length === headlines.length && current.headlines.every((headline, index) => headline === headlines[index]);
    if (!needsNewCreative && (!media || headlinesMatch)) {
      this.setLoopActivity(campaign.id, {
        phase: 'starting',
        title: 'Keeping the current image',
        detail: 'This round is a wording-only test, so the previous visual stays.',
        event: 'Kept the previous image. This round tests new headlines.',
      });
      return media
        ? { ok: true, outcome: 'reused', media: current.media, visualMode: current.visualMode }
        : { ok: true, outcome: 'text-only', media: headlines.map(() => ({ imageUrl: null, videoUrl: null })), visualMode: 'text-only' };
    }

    const creative = this.options.creative;
    if (!creative) {
      // Without a generator, keep the previous media rather than stall the loop, but record that
      // the round reused it so it is never mistaken for fresh creative.
      if (!media) return { ok: true, outcome: 'text-only', media: headlines.map(() => ({ imageUrl: null, videoUrl: null })), visualMode: 'text-only' };
      return {
        ok: true,
        outcome: 'reused',
        media: headlines.map((_, index) => current.media[index] ?? { imageUrl: null, videoUrl: null }),
        visualMode: current.visualMode,
        note: 'Image generation is off or unconfigured, so chained rounds reused the previous round\'s images instead of creating new ones.',
      };
    }

    this.setLoopActivity(campaign.id, {
      phase: 'generating',
      title: 'Generating a new image',
      detail: 'Applying a short visual change from the last lesson, keeping the same product photography quality.',
      event: 'Starting a new image from the last lesson.',
    });
    let jobId: string;
    try {
      const lesson = latestLessonStatement(this.options.database, campaign.id);
      const job = await creative.createImageJob(campaign, {
        // A fresh ID per round, so a retry never collides with the previous round's reservation.
        requestId: randomUUID(),
        headlines,
        imagePrompt: applyLessonToImagePrompt(suggestImagePrompt(campaign), lesson),
        variantPrompts: loopVariantPrompts(campaign, headlines, lesson),
      }, signal);
      jobId = job.id;
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'The image job could not be created.' };
    }

    // createImageJob returns once the job is reserved; wait for every image to be ready.
    const timeoutMs = this.options.creativeTimeoutMs ?? IMAGE_TIMEOUT_MS * headlines.length + CREATIVE_TIMEOUT_MARGIN_MS;
    const pollMs = this.options.creativePollMs ?? DEFAULT_CREATIVE_POLL_MS;
    const deadline = Date.now() + timeoutMs;
    while (!signal.aborted) {
      const job = this.options.database.getCreativeJob(jobId);
      if (!job) return { ok: false, message: 'The image job disappeared before it finished.' };
      if (job.status === 'ready') {
        const outputs = [...job.outputs].sort((a, b) => a.index - b.index);
        if (outputs.length !== headlines.length || outputs.some((output, index) => output.headline !== headlines[index] || output.status !== 'ready' || !output.imageUrl)) {
          return { ok: false, message: 'The image job finished without one ready image per headline.' };
        }
        return { ok: true, outcome: 'new', media: outputs.map((output) => ({ imageUrl: output.imageUrl, videoUrl: null })), visualMode: 'distinct' };
      }
      if (job.status === 'failed' || job.status === 'uncertain') return { ok: false, message: job.error ?? `The image job ended as ${job.status}.` };
      if (Date.now() >= deadline) return { ok: false, message: `The images were not ready within ${Math.round(timeoutMs / 1000)} seconds.` };
      await delay(pollMs, signal);
    }
    return { ok: false, message: 'The round was cancelled while its images were generating.' };
  }

  private cancelPreparing(campaignId: string): void {
    const preparing = this.preparing.get(campaignId);
    if (!preparing) return;
    preparing.controller.abort();
    this.preparing.delete(campaignId);
  }
}

function hasMedia(media: RoundMedia): boolean {
  return media.some((item) => item.imageUrl || item.videoUrl);
}

function compareRoundMedia(previous: Variant[], current: Variant[]): CreativeOutcome {
  const urls = (variants: Variant[]) => variants.map((variant) => variant.videoUrl ?? variant.imageUrl);
  const now = urls(current);
  if (now.every((url) => !url)) return 'text-only';
  const before = new Set(urls(previous));
  return now.some((url) => url && !before.has(url)) ? 'new' : 'reused';
}

function atRoundCap(round: number, maxRounds: number): boolean {
  return maxRounds > 0 && round >= maxRounds;
}

function fallbackLessonStatement(headlines: string[], segments: PersonaSegmentMetrics[], bestClickRate: number | null): string {
  const tested = headlines.filter(Boolean).join(' | ') || 'the tested headlines';
  const rate = bestClickRate == null ? 'not measured' : `${(bestClickRate * 100).toFixed(1)}%`;
  const lead = segments[0];
  const result = lead
    ? `${lead.label} had ${lead.signups}/${lead.views} sign-ups${lead.topFriction && lead.topFriction !== 'none' ? `, with ${lead.topFriction} as the main friction` : ''}.`
    : 'No persona segment produced a usable result.';
  return `After testing ${tested}, the best click rate was ${rate}. ${result}`;
}

function latestLessonStatement(database: CampaignDatabase, campaignId: string): string {
  return database.listLessons(campaignId)[0]?.statement ?? '';
}

/** One visual per headline, so each round compares complete headline-and-visual concepts. */
function loopVariantPrompts(campaign: Campaign, headlines: string[], lesson = ''): string[] {
  const base = suggestImagePrompt(campaign);
  return headlines.map((headline, index) =>
    applyLessonToImagePrompt(
      `${base} Concept ${String.fromCharCode(65 + index)}: compose the scene to suit the headline "${headline}", which will be added later; render no text in the image.`,
      lesson,
    ));
}

/**
 * Words that assert durability, superiority, guarantees or environmental benefit. A headline may
 * use one only when an approved claim does.
 */
const CLAIM_WORDS = [
  'guarantee', 'guaranteed', 'proven', 'clinically', 'certified', 'best', '#1', 'lifetime', 'forever',
  'unbreakable', 'indestructible', 'cheapest', 'fastest', 'eco-friendly', 'sustainable', 'recyclable',
  'biodegradable', 'carbon', 'plastic-free', 'award-winning', 'save', 'saves', 'savings',
];

/**
 * Step 2: returns the first rule a proposal breaks, or null. The claims check is a deterministic
 * floor, not a reading of intent: numbers and claim words in a headline must appear in the
 * approved claims.
 */
export function headlineRuleViolation(headlines: string[], approvedClaims: string[]): string | null {
  const parsed = headlineSetSchema.safeParse(headlines);
  if (!parsed.success) return 'The proposed test did not have 2 or 3 unique headlines, so it was not applied.';
  const unapproved = unapprovedClaims(parsed.data, approvedClaims);
  if (unapproved) return `The headline "${unapproved.headline}" asserts "${unapproved.term}", which is not in the approved claims, so the proposal was not applied.`;
  return null;
}

export function checkRules(campaign: Pick<Campaign, 'approvedClaims' | 'budgetCents'>, headlines: string[], spentCents: number, agentCount: number): string | null {
  return headlineRuleViolation(headlines, campaign.approvedClaims) ?? budgetViolation(campaign, spentCents, agentCount);
}

/** A round may start only if its worst-case spend still fits inside the campaign budget. */
function budgetViolation(campaign: Pick<Campaign, 'budgetCents'>, spentCents: number, agentCount: number): string | null {
  const nextRoundCents = agentCount * MAX_AGENT_COST_CENTS;
  if (spentCents + nextRoundCents <= campaign.budgetCents) return null;
  return `The next round could spend up to ${cents(nextRoundCents)}, and ${cents(spentCents)} of the ${cents(campaign.budgetCents)} budget is already spent, so the loop stopped.`;
}

function unapprovedClaims(headlines: string[], approvedClaims: string[]): { headline: string; term: string } | null {
  const approved = approvedClaims.join(' ').toLocaleLowerCase();
  const approvedNumbers = new Set(approved.match(/\d+(?:[.,]\d+)*/g) ?? []);
  for (const headline of headlines) {
    const text = headline.toLocaleLowerCase();
    const number = (text.match(/\d+(?:[.,]\d+)*/g) ?? []).find((value) => !approvedNumbers.has(value));
    if (number) return { headline, term: number };
    const word = CLAIM_WORDS.find((term) => containsTerm(text, term) && !containsTerm(approved, term));
    if (word) return { headline, term: word };
  }
  return null;
}

function containsTerm(text: string, term: string): boolean {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9#-])${escaped}($|[^a-z0-9-])`).test(text);
}

function cents(value: number): string {
  return `$${(value / 100).toFixed(2)}`;
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

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
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
