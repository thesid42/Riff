import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Campaign, CampaignInput, Experiment, Lesson, Variant } from '../shared/types.js';
import type { CreativeImageJob, CreativeImageJobStatus, CreativeVideoOptions } from '../shared/creative.js';
import {
  DEFAULT_AGENT_COUNT,
  DEFAULT_CONCURRENCY,
  DEFAULT_OFFER,
  type AgentJob,
  type CampaignRuntime,
  type DecisionRecord,
} from '../shared/run.js';

export interface StoredCreativeImageJob extends CreativeImageJob {
  requestHash: string;
  model: string;
  mediaType: 'image' | 'video';
  width: number;
  height: number;
  pollingUrl: string | null;
  contentType: 'image/png' | 'image/jpeg' | 'image/webp' | 'video/mp4' | null;
}

export type CreativeReservation =
  | { kind: 'created'; job: StoredCreativeImageJob }
  | { kind: 'existing'; job: StoredCreativeImageJob }
  | { kind: 'conflict' }
  | { kind: 'busy' };

export type CreativeJobPatch = Partial<Pick<StoredCreativeImageJob,
  'status' | 'imageUrl' | 'videoUrl' | 'error' | 'providerTaskId' | 'pollingUrl' | 'contentType'>>;

export class CampaignDatabase {
  readonly #database: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.#database = new DatabaseSync(path);
    this.#database.exec('PRAGMA foreign_keys = ON');
    this.#migrate();
  }

  #migrate(): void {
    const version = this.#database.prepare('PRAGMA user_version').get() as { user_version: number };
    if (version.user_version < 1) {
      this.#database.exec(`
        CREATE TABLE campaigns (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          product TEXT NOT NULL,
          audience TEXT NOT NULL,
          goal TEXT NOT NULL CHECK (goal = 'signups'),
          approved_claims TEXT NOT NULL,
          budget_cents INTEGER NOT NULL CHECK (budget_cents > 0),
          currency TEXT NOT NULL CHECK (currency = 'USD'),
          status TEXT NOT NULL CHECK (status = 'draft'),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        PRAGMA user_version = 1;
      `);
    }
    const currentVersion = this.#database.prepare('PRAGMA user_version').get() as { user_version: number };
    if (currentVersion.user_version < 2) {
      this.#database.exec(`
        CREATE TABLE creative_image_jobs (
          id TEXT PRIMARY KEY,
          campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
          request_hash TEXT NOT NULL,
          headlines TEXT NOT NULL,
          image_prompt TEXT NOT NULL,
          model TEXT NOT NULL,
          media_type TEXT NOT NULL CHECK (media_type IN ('image', 'video')),
          video_options TEXT,
          width INTEGER NOT NULL,
          height INTEGER NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('submitting', 'generating', 'ready', 'failed', 'uncertain')),
          image_url TEXT,
          video_url TEXT,
          error TEXT,
          provider_task_id TEXT,
          polling_url TEXT,
          content_type TEXT CHECK (content_type IS NULL OR content_type IN ('image/png', 'image/jpeg', 'image/webp', 'video/mp4')),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          CHECK ((media_type = 'image' AND width = 1024 AND height = 1024) OR (media_type = 'video' AND width = 0 AND height = 0))
        );
        CREATE UNIQUE INDEX one_active_creative_job_per_campaign
          ON creative_image_jobs(campaign_id)
          WHERE status IN ('submitting', 'generating', 'uncertain');
        PRAGMA user_version = 3;
      `);
    } else if (currentVersion.user_version < 3) {
      this.#database.exec(`
        DROP INDEX one_active_creative_job_per_campaign;
        ALTER TABLE creative_image_jobs RENAME TO creative_image_jobs_v2;
        CREATE TABLE creative_image_jobs (
          id TEXT PRIMARY KEY,
          campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
          request_hash TEXT NOT NULL,
          headlines TEXT NOT NULL,
          image_prompt TEXT NOT NULL,
          model TEXT NOT NULL,
          media_type TEXT NOT NULL CHECK (media_type IN ('image', 'video')),
          video_options TEXT,
          width INTEGER NOT NULL,
          height INTEGER NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('submitting', 'generating', 'ready', 'failed', 'uncertain')),
          image_url TEXT,
          video_url TEXT,
          error TEXT,
          provider_task_id TEXT,
          polling_url TEXT,
          content_type TEXT CHECK (content_type IS NULL OR content_type IN ('image/png', 'image/jpeg', 'image/webp', 'video/mp4')),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          CHECK ((media_type = 'image' AND width = 1024 AND height = 1024) OR (media_type = 'video' AND width = 0 AND height = 0))
        );
        INSERT INTO creative_image_jobs
          (id, campaign_id, request_hash, headlines, image_prompt, model, media_type, video_options, width, height,
           status, image_url, video_url, error, provider_task_id, polling_url, content_type, created_at, updated_at)
        SELECT id, campaign_id, request_hash, headlines, image_prompt, model, 'image', NULL, width, height,
          status, image_url, NULL, error, provider_task_id, polling_url, content_type, created_at, updated_at
        FROM creative_image_jobs_v2;
        DROP TABLE creative_image_jobs_v2;
        CREATE UNIQUE INDEX one_active_creative_job_per_campaign
          ON creative_image_jobs(campaign_id)
          WHERE status IN ('submitting', 'generating', 'uncertain');
        PRAGMA user_version = 3;
      `);
    }
    const afterCreative = this.#database.prepare('PRAGMA user_version').get() as { user_version: number };
    if (afterCreative.user_version < 4) {
      this.#database.exec(`
        ALTER TABLE campaigns ADD COLUMN runtime TEXT NOT NULL DEFAULT 'idle';
        ALTER TABLE campaigns ADD COLUMN agent_count INTEGER NOT NULL DEFAULT 40;
        ALTER TABLE campaigns ADD COLUMN concurrency INTEGER NOT NULL DEFAULT 8;
        ALTER TABLE campaigns ADD COLUMN headlines TEXT NOT NULL DEFAULT '[]';
        CREATE TABLE experiments (
          id TEXT PRIMARY KEY,
          campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
          hypothesis TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('draft', 'collecting', 'inconclusive', 'completed')),
          window_start TEXT,
          window_end TEXT,
          created_at TEXT NOT NULL
        );
        CREATE TABLE variants (
          id TEXT PRIMARY KEY,
          campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
          experiment_id TEXT NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
          label TEXT NOT NULL,
          headline TEXT NOT NULL,
          offer TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('draft', 'creating', 'ready', 'paused', 'failed')),
          image_url TEXT,
          video_url TEXT,
          parent_id TEXT,
          created_at TEXT NOT NULL
        );
        CREATE TABLE lessons (
          id TEXT PRIMARY KEY,
          campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
          statement TEXT NOT NULL,
          audience TEXT NOT NULL,
          offer TEXT NOT NULL,
          experiment_id TEXT NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
          evidence_ids TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('active', 'needs_retest')),
          created_at TEXT NOT NULL
        );
        CREATE TABLE decisions (
          id TEXT PRIMARY KEY,
          campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
          experiment_id TEXT NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
          action TEXT NOT NULL CHECK (action IN ('wait', 'propose_test')),
          explanation TEXT NOT NULL,
          hypothesis TEXT NOT NULL,
          headlines TEXT NOT NULL,
          evidence_ids TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE TABLE agent_jobs (
          id TEXT PRIMARY KEY,
          campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
          experiment_id TEXT NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
          variant_id TEXT NOT NULL REFERENCES variants(id) ON DELETE CASCADE,
          persona_id TEXT NOT NULL,
          audience_segment TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'succeeded', 'failed')),
          action TEXT CHECK (action IS NULL OR action IN ('skip', 'click', 'signup')),
          reason TEXT,
          dwell_seconds REAL,
          time_to_action_seconds REAL,
          confidence REAL,
          attention REAL,
          clarity REAL,
          trust REAL,
          purchase_intent REAL,
          noticed_first TEXT,
          friction TEXT,
          elapsed_ms INTEGER,
          queue_wait_ms INTEGER,
          prompt_tokens INTEGER,
          completion_tokens INTEGER,
          error TEXT,
          enqueued_at TEXT NOT NULL,
          started_at TEXT,
          finished_at TEXT
        );
        CREATE INDEX agent_jobs_campaign_status ON agent_jobs(campaign_id, status);
        PRAGMA user_version = 4;
      `);
    }
  }

  listCampaigns(): Campaign[] {
    const rows = this.#database.prepare(`
      SELECT id, name, product, audience, goal, approved_claims, budget_cents,
             currency, status, runtime, agent_count, concurrency, headlines, created_at, updated_at
      FROM campaigns ORDER BY created_at DESC, id DESC
    `).all() as unknown as CampaignRow[];
    return rows.map(toCampaign);
  }

  getCampaign(id: string): Campaign | undefined {
    const row = this.#database.prepare(`
      SELECT id, name, product, audience, goal, approved_claims, budget_cents,
             currency, status, runtime, agent_count, concurrency, headlines, created_at, updated_at
      FROM campaigns WHERE id = ?
    `).get(id) as unknown as CampaignRow | undefined;
    return row ? toCampaign(row) : undefined;
  }

  createCampaign(id: string, input: CampaignInput, now: string): Campaign {
    const data = input;
    this.#database.prepare(`
      INSERT INTO campaigns
        (id, name, product, audience, goal, approved_claims, budget_cents, currency, status, runtime, agent_count, concurrency, headlines, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft', 'idle', ?, ?, '[]', ?, ?)
    `).run(id, data.name, data.product, data.audience, data.goal, JSON.stringify(data.approvedClaims), data.budgetCents, data.currency, DEFAULT_AGENT_COUNT, DEFAULT_CONCURRENCY, now, now);
    return this.getCampaign(id)!;
  }

  listCreativeJobs(campaignId: string): CreativeImageJob[] {
    const rows = this.#database.prepare(`
      SELECT * FROM creative_image_jobs WHERE campaign_id = ? ORDER BY created_at DESC, id DESC
    `).all(campaignId) as unknown as CreativeJobRow[];
    return rows.map(toCreativeJob);
  }

  getCreativeJob(id: string): StoredCreativeImageJob | undefined {
    const row = this.#database.prepare('SELECT * FROM creative_image_jobs WHERE id = ?').get(id) as unknown as CreativeJobRow | undefined;
    return row ? toStoredCreativeJob(row) : undefined;
  }

  reserveCreativeJob(input: Omit<StoredCreativeImageJob, 'providerTaskId' | 'pollingUrl' | 'contentType'> & {
    providerTaskId?: string | null;
    pollingUrl?: string | null;
    contentType?: StoredCreativeImageJob['contentType'];
  }): CreativeReservation {
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      const prior = this.getCreativeJob(input.id);
      if (prior) {
        this.#database.exec('COMMIT');
        return prior.campaignId === input.campaignId && prior.requestHash === input.requestHash
          ? { kind: 'existing', job: prior }
          : { kind: 'conflict' };
      }
      const active = this.#database.prepare(`
        SELECT id FROM creative_image_jobs
        WHERE campaign_id = ? AND status IN ('submitting', 'generating', 'uncertain')
        LIMIT 1
      `).get(input.campaignId);
      if (active) {
        this.#database.exec('COMMIT');
        return { kind: 'busy' };
      }
      this.#database.prepare(`
      INSERT INTO creative_image_jobs
          (id, campaign_id, request_hash, headlines, image_prompt, model, media_type, video_options, width, height, status,
           image_url, video_url, error, provider_task_id, polling_url, content_type, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(input.id, input.campaignId, input.requestHash, JSON.stringify(input.headlines), input.imagePrompt,
        input.model, input.mediaType, input.videoOptions === null ? null : JSON.stringify(input.videoOptions), input.width, input.height, input.status, input.imageUrl, input.videoUrl, input.error, input.providerTaskId ?? null,
        input.pollingUrl ?? null, input.contentType ?? null, input.createdAt, input.updatedAt);
      this.#database.exec('COMMIT');
      return { kind: 'created', job: this.getCreativeJob(input.id)! };
    } catch (error) {
      try { this.#database.exec('ROLLBACK'); } catch { /* The transaction may already have rolled back. */ }
      throw error;
    }
  }

  updateCreativeJob(id: string, patch: CreativeJobPatch, now: string): StoredCreativeImageJob | undefined {
    const current = this.getCreativeJob(id);
    if (!current) return undefined;
    const next: StoredCreativeImageJob = { ...current, ...patch, updatedAt: now };
    this.#database.prepare(`
      UPDATE creative_image_jobs SET status = ?, image_url = ?, video_url = ?, error = ?, provider_task_id = ?,
        polling_url = ?, content_type = ?, updated_at = ? WHERE id = ?
    `).run(next.status, next.imageUrl, next.videoUrl, next.error, next.providerTaskId, next.pollingUrl, next.contentType, next.updatedAt, id);
    return this.getCreativeJob(id);
  }

  markInterruptedCreativeJobs(now: string): void {
    this.#database.prepare(`
      UPDATE creative_image_jobs
      SET status = 'uncertain', error = 'Generation was interrupted by a server restart. Review provider status before starting another job.', updated_at = ?
      WHERE status IN ('submitting', 'generating')
    `).run(now);
  }

  setHeadlines(campaignId: string, headlines: string[], now: string): Campaign | undefined {
    this.#database.prepare('UPDATE campaigns SET headlines = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(headlines), now, campaignId);
    return this.getCampaign(campaignId);
  }

  setRuntime(campaignId: string, runtime: CampaignRuntime, agentCount: number, concurrency: number, now: string): Campaign | undefined {
    this.#database.prepare('UPDATE campaigns SET runtime = ?, agent_count = ?, concurrency = ?, updated_at = ? WHERE id = ?')
      .run(runtime, agentCount, concurrency, now, campaignId);
    return this.getCampaign(campaignId);
  }

  createExperiment(input: { id: string; campaignId: string; hypothesis: string; status: Experiment['status']; windowStart: string; createdAt: string }): Experiment {
    this.#database.prepare(`
      INSERT INTO experiments (id, campaign_id, hypothesis, status, window_start, window_end, created_at)
      VALUES (?, ?, ?, ?, ?, NULL, ?)
    `).run(input.id, input.campaignId, input.hypothesis, input.status, input.windowStart, input.createdAt);
    return this.getExperiment(input.id)!;
  }

  getExperiment(id: string): Experiment | undefined {
    const row = this.#database.prepare('SELECT * FROM experiments WHERE id = ?').get(id) as unknown as ExperimentRow | undefined;
    return row ? toExperiment(row, this.listVariantIds(row.id)) : undefined;
  }

  latestExperiment(campaignId: string): Experiment | undefined {
    const row = this.#database.prepare('SELECT * FROM experiments WHERE campaign_id = ? ORDER BY created_at DESC, id DESC LIMIT 1')
      .get(campaignId) as unknown as ExperimentRow | undefined;
    return row ? toExperiment(row, this.listVariantIds(row.id)) : undefined;
  }

  listExperiments(campaignId: string): Experiment[] {
    const rows = this.#database.prepare('SELECT * FROM experiments WHERE campaign_id = ? ORDER BY created_at DESC, id DESC')
      .all(campaignId) as unknown as ExperimentRow[];
    return rows.map((row) => toExperiment(row, this.listVariantIds(row.id)));
  }

  completeExperiment(id: string, status: Experiment['status'], windowEnd: string): void {
    this.#database.prepare('UPDATE experiments SET status = ?, window_end = ? WHERE id = ?').run(status, windowEnd, id);
  }

  createVariants(inputs: Array<Omit<Variant, 'parentId'> & { parentId?: string | null }>): Variant[] {
    const statement = this.#database.prepare(`
      INSERT INTO variants (id, campaign_id, experiment_id, label, headline, offer, status, image_url, video_url, parent_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.#database.exec('BEGIN');
    try {
      for (const input of inputs) {
        statement.run(input.id, input.campaignId, input.experimentId, input.label, input.headline, input.offer ?? DEFAULT_OFFER,
          input.status, input.imageUrl, input.videoUrl, input.parentId ?? null, input.createdAt);
      }
      this.#database.exec('COMMIT');
    } catch (error) {
      try { this.#database.exec('ROLLBACK'); } catch { /* The transaction may already have rolled back. */ }
      throw error;
    }
    return this.listVariants(inputs[0]?.campaignId ?? '');
  }

  listVariants(campaignId: string): Variant[] {
    const rows = this.#database.prepare('SELECT * FROM variants WHERE campaign_id = ? ORDER BY created_at ASC, label ASC')
      .all(campaignId) as unknown as VariantRow[];
    return rows.map(toVariant);
  }

  listExperimentVariants(experimentId: string): Variant[] {
    const rows = this.#database.prepare('SELECT * FROM variants WHERE experiment_id = ? ORDER BY label ASC')
      .all(experimentId) as unknown as VariantRow[];
    return rows.map(toVariant);
  }

  listVariantIds(experimentId: string): string[] {
    const rows = this.#database.prepare('SELECT id FROM variants WHERE experiment_id = ? ORDER BY label ASC')
      .all(experimentId) as Array<{ id: string }>;
    return rows.map((row) => row.id);
  }

  getVariant(id: string): Variant | undefined {
    const row = this.#database.prepare('SELECT * FROM variants WHERE id = ?').get(id) as unknown as VariantRow | undefined;
    return row ? toVariant(row) : undefined;
  }

  enqueueAgentJobs(jobs: AgentJob[]): void {
    const statement = this.#database.prepare(`
      INSERT INTO agent_jobs (
        id, campaign_id, experiment_id, variant_id, persona_id, audience_segment, status, action, reason,
        dwell_seconds, time_to_action_seconds, confidence, attention, clarity, trust, purchase_intent,
        noticed_first, friction, elapsed_ms, queue_wait_ms, prompt_tokens, completion_tokens, error,
        enqueued_at, started_at, finished_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.#database.exec('BEGIN');
    try {
      for (const job of jobs) {
        statement.run(
          job.id, job.campaignId, job.experimentId, job.variantId, job.personaId, job.audienceSegment, job.status,
          job.action, job.reason, job.dwellSeconds, job.timeToActionSeconds, job.confidence, job.attention, job.clarity,
          job.trust, job.purchaseIntent, job.noticedFirst, job.friction, job.elapsedMs, job.queueWaitMs,
          job.promptTokens, job.completionTokens, job.error, job.enqueuedAt, job.startedAt, job.finishedAt,
        );
      }
      this.#database.exec('COMMIT');
    } catch (error) {
      try { this.#database.exec('ROLLBACK'); } catch { /* The transaction may already have rolled back. */ }
      throw error;
    }
  }

  listAgentJobs(campaignId: string, experimentId?: string): AgentJob[] {
    const rows = (experimentId
      ? this.#database.prepare('SELECT * FROM agent_jobs WHERE campaign_id = ? AND experiment_id = ? ORDER BY enqueued_at ASC, id ASC').all(campaignId, experimentId)
      : this.#database.prepare('SELECT * FROM agent_jobs WHERE campaign_id = ? ORDER BY enqueued_at ASC, id ASC').all(campaignId)) as unknown as AgentJobRow[];
    return rows.map(toAgentJob);
  }

  claimNextAgentJob(campaignId: string, now: string): AgentJob | undefined {
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      const row = this.#database.prepare(`
        SELECT * FROM agent_jobs WHERE campaign_id = ? AND status = 'pending' ORDER BY enqueued_at ASC, id ASC LIMIT 1
      `).get(campaignId) as unknown as AgentJobRow | undefined;
      if (!row) {
        this.#database.exec('COMMIT');
        return undefined;
      }
      this.#database.prepare('UPDATE agent_jobs SET status = ?, started_at = ? WHERE id = ?').run('running', now, row.id);
      this.#database.exec('COMMIT');
      return this.getAgentJob(row.id);
    } catch (error) {
      try { this.#database.exec('ROLLBACK'); } catch { /* The transaction may already have rolled back. */ }
      throw error;
    }
  }

  getAgentJob(id: string): AgentJob | undefined {
    const row = this.#database.prepare('SELECT * FROM agent_jobs WHERE id = ?').get(id) as unknown as AgentJobRow | undefined;
    return row ? toAgentJob(row) : undefined;
  }

  finishAgentJob(id: string, patch: Partial<AgentJob>): AgentJob | undefined {
    const current = this.getAgentJob(id);
    if (!current) return undefined;
    const next = { ...current, ...patch };
    this.#database.prepare(`
      UPDATE agent_jobs SET status = ?, action = ?, reason = ?, dwell_seconds = ?, time_to_action_seconds = ?,
        confidence = ?, attention = ?, clarity = ?, trust = ?, purchase_intent = ?, noticed_first = ?, friction = ?,
        elapsed_ms = ?, queue_wait_ms = ?, prompt_tokens = ?, completion_tokens = ?, error = ?, started_at = ?, finished_at = ?
      WHERE id = ?
    `).run(
      next.status, next.action, next.reason, next.dwellSeconds, next.timeToActionSeconds, next.confidence, next.attention,
      next.clarity, next.trust, next.purchaseIntent, next.noticedFirst, next.friction, next.elapsedMs, next.queueWaitMs,
      next.promptTokens, next.completionTokens, next.error, next.startedAt, next.finishedAt, id,
    );
    return this.getAgentJob(id);
  }

  markInterruptedAgentJobs(now: string): void {
    this.#database.prepare(`
      UPDATE agent_jobs SET status = 'failed', error = 'The persona job was interrupted by a server restart.', finished_at = ?
      WHERE status = 'running'
    `).run(now);
    this.#database.prepare(`UPDATE campaigns SET runtime = 'paused', updated_at = ? WHERE runtime = 'running'`).run(now);
  }

  createDecision(record: DecisionRecord): DecisionRecord {
    this.#database.prepare(`
      INSERT INTO decisions (id, campaign_id, experiment_id, action, explanation, hypothesis, headlines, evidence_ids, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(record.id, record.campaignId, record.experimentId, record.action, record.explanation, record.hypothesis,
      JSON.stringify(record.headlines), JSON.stringify(record.evidenceIds), record.createdAt);
    return record;
  }

  listDecisions(campaignId: string): DecisionRecord[] {
    const rows = this.#database.prepare('SELECT * FROM decisions WHERE campaign_id = ? ORDER BY created_at DESC, id DESC')
      .all(campaignId) as unknown as DecisionRow[];
    return rows.map(toDecision);
  }

  latestDecision(campaignId: string): DecisionRecord | undefined {
    const row = this.#database.prepare('SELECT * FROM decisions WHERE campaign_id = ? ORDER BY created_at DESC, id DESC LIMIT 1')
      .get(campaignId) as unknown as DecisionRow | undefined;
    return row ? toDecision(row) : undefined;
  }

  createLesson(lesson: Lesson): Lesson {
    this.#database.prepare(`
      INSERT INTO lessons (id, campaign_id, statement, audience, offer, experiment_id, evidence_ids, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(lesson.id, lesson.campaignId, lesson.statement, lesson.audience, lesson.offer, lesson.experimentId,
      JSON.stringify(lesson.evidenceIds), lesson.status, lesson.createdAt);
    return lesson;
  }

  listLessons(campaignId: string): Lesson[] {
    const rows = this.#database.prepare('SELECT * FROM lessons WHERE campaign_id = ? ORDER BY created_at DESC, id DESC')
      .all(campaignId) as unknown as LessonRow[];
    return rows.map(toLesson);
  }

  close(): void {
    this.#database.close();
  }
}

interface CampaignRow {
  id: string;
  name: string;
  product: string;
  audience: string;
  goal: 'signups';
  approved_claims: string;
  budget_cents: number;
  currency: 'USD';
  status: 'draft';
  runtime: CampaignRuntime;
  agent_count: number;
  concurrency: number;
  headlines: string;
  created_at: string;
  updated_at: string;
}

interface ExperimentRow {
  id: string;
  campaign_id: string;
  hypothesis: string;
  status: Experiment['status'];
  window_start: string | null;
  window_end: string | null;
  created_at: string;
}

interface VariantRow {
  id: string;
  campaign_id: string;
  experiment_id: string;
  label: string;
  headline: string;
  offer: string;
  status: Variant['status'];
  image_url: string | null;
  video_url: string | null;
  parent_id: string | null;
  created_at: string;
}

interface LessonRow {
  id: string;
  campaign_id: string;
  statement: string;
  audience: string;
  offer: string;
  experiment_id: string;
  evidence_ids: string;
  status: Lesson['status'];
  created_at: string;
}

interface DecisionRow {
  id: string;
  campaign_id: string;
  experiment_id: string;
  action: DecisionRecord['action'];
  explanation: string;
  hypothesis: string;
  headlines: string;
  evidence_ids: string;
  created_at: string;
}

interface AgentJobRow {
  id: string;
  campaign_id: string;
  experiment_id: string;
  variant_id: string;
  persona_id: string;
  audience_segment: string;
  status: AgentJob['status'];
  action: AgentJob['action'];
  reason: string | null;
  dwell_seconds: number | null;
  time_to_action_seconds: number | null;
  confidence: number | null;
  attention: number | null;
  clarity: number | null;
  trust: number | null;
  purchase_intent: number | null;
  noticed_first: AgentJob['noticedFirst'];
  friction: AgentJob['friction'];
  elapsed_ms: number | null;
  queue_wait_ms: number | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  error: string | null;
  enqueued_at: string;
  started_at: string | null;
  finished_at: string | null;
}

interface CreativeJobRow {
  id: string;
  campaign_id: string;
  request_hash: string;
  headlines: string;
  image_prompt: string;
  model: string;
  media_type: 'image' | 'video';
  video_options: string | null;
  width: number;
  height: number;
  status: CreativeImageJobStatus;
  image_url: string | null;
  video_url: string | null;
  error: string | null;
  provider_task_id: string | null;
  polling_url: string | null;
  content_type: 'image/png' | 'image/jpeg' | 'image/webp' | 'video/mp4' | null;
  created_at: string;
  updated_at: string;
}

function toCampaign(row: CampaignRow): Campaign {
  return {
    id: row.id,
    name: row.name,
    product: row.product,
    audience: row.audience,
    goal: row.goal,
    approvedClaims: JSON.parse(row.approved_claims) as string[],
    budgetCents: row.budget_cents,
    currency: row.currency,
    status: row.status,
    runtime: row.runtime ?? 'idle',
    agentCount: row.agent_count ?? DEFAULT_AGENT_COUNT,
    concurrency: row.concurrency ?? DEFAULT_CONCURRENCY,
    headlines: JSON.parse(row.headlines || '[]') as string[],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toExperiment(row: ExperimentRow, variantIds: string[]): Experiment {
  return {
    id: row.id,
    campaignId: row.campaign_id,
    hypothesis: row.hypothesis,
    status: row.status,
    variantIds,
    windowStart: row.window_start,
    windowEnd: row.window_end,
    createdAt: row.created_at,
  };
}

function toVariant(row: VariantRow): Variant {
  return {
    id: row.id,
    campaignId: row.campaign_id,
    experimentId: row.experiment_id,
    label: row.label,
    headline: row.headline,
    offer: row.offer,
    status: row.status,
    imageUrl: row.image_url,
    videoUrl: row.video_url,
    parentId: row.parent_id,
    createdAt: row.created_at,
  };
}

function toLesson(row: LessonRow): Lesson {
  return {
    id: row.id,
    campaignId: row.campaign_id,
    statement: row.statement,
    audience: row.audience,
    offer: row.offer,
    experimentId: row.experiment_id,
    evidenceIds: JSON.parse(row.evidence_ids) as string[],
    status: row.status,
    createdAt: row.created_at,
  };
}

function toDecision(row: DecisionRow): DecisionRecord {
  return {
    id: row.id,
    campaignId: row.campaign_id,
    experimentId: row.experiment_id,
    action: row.action,
    explanation: row.explanation,
    hypothesis: row.hypothesis,
    headlines: JSON.parse(row.headlines) as string[],
    evidenceIds: JSON.parse(row.evidence_ids) as string[],
    createdAt: row.created_at,
  };
}

function toAgentJob(row: AgentJobRow): AgentJob {
  return {
    id: row.id,
    campaignId: row.campaign_id,
    experimentId: row.experiment_id,
    variantId: row.variant_id,
    personaId: row.persona_id,
    audienceSegment: row.audience_segment,
    status: row.status,
    action: row.action,
    reason: row.reason,
    dwellSeconds: row.dwell_seconds,
    timeToActionSeconds: row.time_to_action_seconds,
    confidence: row.confidence,
    attention: row.attention,
    clarity: row.clarity,
    trust: row.trust,
    purchaseIntent: row.purchase_intent,
    noticedFirst: row.noticed_first,
    friction: row.friction,
    elapsedMs: row.elapsed_ms,
    queueWaitMs: row.queue_wait_ms,
    promptTokens: row.prompt_tokens,
    completionTokens: row.completion_tokens,
    error: row.error,
    enqueuedAt: row.enqueued_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

function toCreativeJob(row: CreativeJobRow): CreativeImageJob {
  const { id, campaignId, headlines, imagePrompt, mediaType, status, imageUrl, videoUrl, videoOptions, error, providerTaskId, createdAt, updatedAt } = toStoredCreativeJob(row);
  return { id, campaignId, headlines, imagePrompt, mediaType, status, imageUrl, videoUrl, videoOptions, error, providerTaskId, createdAt, updatedAt };
}

function toStoredCreativeJob(row: CreativeJobRow): StoredCreativeImageJob {
  return {
    id: row.id,
    campaignId: row.campaign_id,
    requestHash: row.request_hash,
    headlines: JSON.parse(row.headlines) as string[],
    imagePrompt: row.image_prompt,
    model: row.model,
    mediaType: row.media_type,
    width: row.width,
    height: row.height,
    status: row.status,
    imageUrl: row.image_url,
    videoUrl: row.video_url,
    videoOptions: row.video_options ? JSON.parse(row.video_options) as CreativeVideoOptions : null,
    error: row.error,
    providerTaskId: row.provider_task_id,
    pollingUrl: row.polling_url,
    contentType: row.content_type,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
