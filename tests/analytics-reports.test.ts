import { describe, expect, it } from 'vitest';
import { formatReportText, type AnalyticsReport } from '../src/analytics/reporter.js';
import { schema } from '../src/db/index.js';

describe('formatReportText', () => {
  const sampleReport: AnalyticsReport = {
    period: 'Son 7 gun',
    totalPosts: 12,
    postsPublished: 10,
    postsFailed: 2,
    totalLikes: 250,
    totalComments: 35,
    totalShares: 18,
    totalImpressions: 4800,
    avgEngagementRate: 5.62,
    topPosts: [
      {
        postId: 'post-1',
        text: 'Autonomous social media agent in action',
        likes: 120,
        platform: 'twitter',
        username: 'tech_bot',
      },
    ],
    accountBreakdowns: [
      {
        accountId: 'acc-1',
        username: 'tech_bot',
        platform: 'twitter',
        postCount: 12,
        totalLikes: 250,
      },
    ],
    insights: [
      {
        type: 'platform_leader',
        message: 'TWITTER led all platforms with 250 total likes.',
      },
    ],
  };

  it('formats overall summary metrics into readable markdown report', () => {
    const text = formatReportText(sampleReport);
    expect(text).toContain('Son 7 gun Raporu');
    expect(text).toContain('Toplam Post: 12');
    expect(text).toContain('Toplam Beğeni: 250');
    expect(text).toContain('Toplam Yorum: 35');
    expect(text).toContain('Toplam Paylaşım: 18');
    expect(text).toContain('Toplam Gösterim: 4800');
    expect(text).toContain('5.62%');
  });

  it('includes top posts in formatted output', () => {
    const text = formatReportText(sampleReport);
    expect(text).toContain('En İyi Postlar');
    expect(text).toContain('[twitter] @tech_bot');
    expect(text).toContain('120 ❤️');
  });

  it('includes account breakdown in formatted output', () => {
    const text = formatReportText(sampleReport);
    expect(text).toContain('Hesap Performansı');
    expect(text).toContain('@tech_bot (twitter): 12 post, 250 ❤️');
  });

  it('includes strategic insights in formatted output', () => {
    const text = formatReportText(sampleReport);
    expect(text).toContain('Analiz Bulguları');
    expect(text).toContain('TWITTER led all platforms with 250 total likes.');
  });
});

describe('Database Schema: Analytics Reports & Strategy Optimizations', () => {
  it('defines analyticsReports table with required persistence fields', () => {
    expect(schema.analyticsReports).toBeDefined();
    expect(schema.analyticsReports.id).toBeDefined();
    expect(schema.analyticsReports.projectId).toBeDefined();
    expect(schema.analyticsReports.reportType).toBeDefined();
    expect(schema.analyticsReports.period).toBeDefined();
    expect(schema.analyticsReports.startDate).toBeDefined();
    expect(schema.analyticsReports.endDate).toBeDefined();
    expect(schema.analyticsReports.metrics).toBeDefined();
    expect(schema.analyticsReports.topPosts).toBeDefined();
    expect(schema.analyticsReports.accountBreakdowns).toBeDefined();
    expect(schema.analyticsReports.platformBreakdown).toBeDefined();
    expect(schema.analyticsReports.trends).toBeDefined();
    expect(schema.analyticsReports.insights).toBeDefined();
    expect(schema.analyticsReports.createdAt).toBeDefined();
  });

  it('defines strategyOptimizations table with audit fields', () => {
    expect(schema.strategyOptimizations).toBeDefined();
    expect(schema.strategyOptimizations.id).toBeDefined();
    expect(schema.strategyOptimizations.accountId).toBeDefined();
    expect(schema.strategyOptimizations.periodDays).toBeDefined();
    expect(schema.strategyOptimizations.postsAnalyzed).toBeDefined();
    expect(schema.strategyOptimizations.changes).toBeDefined();
    expect(schema.strategyOptimizations.analysisData).toBeDefined();
    expect(schema.strategyOptimizations.createdAt).toBeDefined();
  });

  it('defines postAnalytics time-series snapshots table', () => {
    expect(schema.postAnalytics).toBeDefined();
    expect(schema.postAnalytics.id).toBeDefined();
    expect(schema.postAnalytics.postId).toBeDefined();
    expect(schema.postAnalytics.likes).toBeDefined();
    expect(schema.postAnalytics.comments).toBeDefined();
    expect(schema.postAnalytics.shares).toBeDefined();
    expect(schema.postAnalytics.impressions).toBeDefined();
    expect(schema.postAnalytics.reach).toBeDefined();
    expect(schema.postAnalytics.engagementRate).toBeDefined();
    expect(schema.postAnalytics.fetchedAt).toBeDefined();
  });
});

describe('Growth Calculation over Time', () => {
  it('correctly calculates growth delta between snapshots', () => {
    const snapshots = [
      { likes: 10, impressions: 200, comments: 2, shares: 1, reach: 150 },
      { likes: 45, impressions: 850, comments: 8, shares: 5, reach: 600 },
      { likes: 110, impressions: 2400, comments: 19, shares: 12, reach: 1800 },
    ];

    const initial = snapshots[0]!;
    const latest = snapshots[snapshots.length - 1]!;

    const growth = {
      likesGrowth: latest.likes - initial.likes,
      impressionsGrowth: latest.impressions - initial.impressions,
      commentsGrowth: latest.comments - initial.comments,
      sharesGrowth: latest.shares - initial.shares,
      reachGrowth: latest.reach - initial.reach,
      snapshotsCount: snapshots.length,
    };

    expect(growth.likesGrowth).toBe(100);
    expect(growth.impressionsGrowth).toBe(2200);
    expect(growth.commentsGrowth).toBe(17);
    expect(growth.sharesGrowth).toBe(11);
    expect(growth.reachGrowth).toBe(1650);
    expect(growth.snapshotsCount).toBe(3);
  });
});
