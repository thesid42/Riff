import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Campaign, CampaignInput } from '../shared/types.js';

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
