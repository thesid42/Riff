import { describe, expect, it } from 'vitest';
import { deriveMetrics, emptyMetricTotals, emptyMetricsSnapshot } from '../shared/types.js';
import { createApp } from '../server/app.js';

describe('metrics foundation', () => {
  it('returns null derived rates and costs when denominators are zero', () => {
    expect(deriveMetrics(emptyMetricTotals())).toEqual({
      clickRate: null,
      signupPerClick: null,
      signupPerImpression: null,
      costPerClickCents: null,
      costPerSignupCents: null,
    });
  });

  it('calculates rates from integer count and cent totals', () => {
    expect(deriveMetrics({ impressions: 200, uniqueVisitors: 150, clicks: 20, signups: 4, spendCents: 1200 })).toEqual({
      clickRate: 0.1,
      signupPerClick: 0.2,
      signupPerImpression: 0.02,
      costPerClickCents: 60,
      costPerSignupCents: 300,
    });
  });

  it('serves honest empty metrics without requesting external analytics', async () => {
    const app = createApp({ databasePath: ':memory:' });
    try {
      const created = await app.inject({
        method: 'POST',
        url: '/api/campaigns',
        payload: { name: 'Campaign', product: 'Product', audience: 'Audience', approvedClaims: [], budgetCents: 1000 },
      });
      const campaignId = created.json().campaign.id as string;
      const response = await app.inject({ method: 'GET', url: `/api/campaigns/${campaignId}/metrics` });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(emptyMetricsSnapshot(campaignId));
    } finally {
      await app.close();
    }
  });
});
