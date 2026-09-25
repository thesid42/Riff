import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Campaign, CampaignInput } from '../shared/types.js';
import type { CreativeImageJob, CreativeImageJobStatus, CreativeVideoOptions } from '../shared/creative.js';

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
  }

  listCampaigns(): Campaign[] {
    const rows = this.#database.prepare(`
      SELECT id, name, product, audience, goal, approved_claims, budget_cents,
             currency, status, created_at, updated_at
      FROM campaigns ORDER BY created_at DESC, id DESC
    `).all() as unknown as CampaignRow[];
    return rows.map(toCampaign);
  }

  getCampaign(id: string): Campaign | undefined {
    const row = this.#database.prepare(`
      SELECT id, name, product, audience, goal, approved_claims, budget_cents,
             currency, status, created_at, updated_at
      FROM campaigns WHERE id = ?
    `).get(id) as unknown as CampaignRow | undefined;
    return row ? toCampaign(row) : undefined;
  }

  createCampaign(id: string, input: CampaignInput, now: string): Campaign {
    const data = input;
    this.#database.prepare(`
      INSERT INTO campaigns
        (id, name, product, audience, goal, approved_claims, budget_cents, currency, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)
    `).run(id, data.name, data.product, data.audience, data.goal, JSON.stringify(data.approvedClaims), data.budgetCents, data.currency, now, now);
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
  created_at: string;
  updated_at: string;
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
    createdAt: row.created_at,
    updatedAt: row.updated_at,
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
