import { Router, type Response } from 'express';
import { eq, and, sql, desc } from 'drizzle-orm';
import { db, schema } from '../../db/index.js';
import { asyncHandler, isUuid } from '../middleware.js';

export const dashboardRouter = Router();

/** Validates the optional ?projectId filter; responds 400 and returns false when invalid */
function readProjectId(query: Record<string, unknown>, res: Response): string | undefined | false {
  const projectId = query['projectId'];
  if (projectId === undefined || projectId === '') return undefined;
  if (!isUuid(projectId)) {
    res.status(400).json({ error: 'Invalid projectId' });
    return false;
  }
  return projectId;
}

/**
 * Analytics are stored as periodic snapshots (every 6h), so aggregates must use only the
 * latest snapshot per post — summing all rows would count the same likes many times.
 */
const latestAnalytics = sql`
  SELECT DISTINCT ON (post_id) post_id, likes, comments, shares, impressions, reach, engagement_rate
  FROM post_analytics
  ORDER BY post_id, fetched_at DESC
`;

dashboardRouter.get('/stats', asyncHandler(async (req, res) => {
  const projectId = readProjectId(req.query, res);
  if (projectId === false) return;

  const [postStats] = await db
    .select({
      total: sql<number>`COUNT(*)::int`,
      published: sql<number>`COUNT(*) FILTER (WHERE ${schema.posts.status} = 'published')::int`,
      failed: sql<number>`COUNT(*) FILTER (WHERE ${schema.posts.status} = 'failed')::int`,
      pending: sql<number>`COUNT(*) FILTER (WHERE ${schema.posts.status} IN ('pending', 'review', 'scheduled'))::int`,
    })
    .from(schema.posts)
    .where(projectId ? eq(schema.posts.projectId, projectId) : undefined);

  const [jobStats] = await db
    .select({
      total: sql<number>`COUNT(*)::int`,
      processing: sql<number>`COUNT(*) FILTER (WHERE ${schema.jobQueue.status} = 'processing')::int`,
      pending: sql<number>`COUNT(*) FILTER (WHERE ${schema.jobQueue.status} IN ('pending', 'retrying'))::int`,
      failed: sql<number>`COUNT(*) FILTER (WHERE ${schema.jobQueue.status} = 'failed')::int`,
    })
    .from(schema.jobQueue);

  const [activeAccounts] = await db
    .select({ count: sql<number>`COUNT(*)::int` })
    .from(schema.accounts)
    .where(and(
      eq(schema.accounts.active, true),
      projectId ? eq(schema.accounts.projectId, projectId) : undefined,
    ));

  res.json({
    posts: postStats ?? { total: 0, published: 0, failed: 0, pending: 0 },
    jobs: jobStats ?? { total: 0, processing: 0, pending: 0, failed: 0 },
    activeAccounts: activeAccounts?.count ?? 0,
  });
}));

dashboardRouter.get('/recent-posts', asyncHandler(async (req, res) => {
  const projectId = readProjectId(req.query, res);
  if (projectId === false) return;

  const recentPosts = await db
    .select()
    .from(schema.posts)
    .where(projectId ? eq(schema.posts.projectId, projectId) : undefined)
    .orderBy(desc(schema.posts.createdAt))
    .limit(20);

  res.json(recentPosts);
}));

function getSqlInterval(period: unknown): string {
  switch (period) {
    case '24h':
    case '1d': return '1 day';
    case '30d': return '30 days';
    case '90d': return '90 days';
    case '1y':
    case '365d': return '365 days';
    case 'all': return '10 years';
    case '7d':
    default:
      return '7 days';
  }
}

dashboardRouter.get('/analytics-summary', asyncHandler(async (req, res) => {
  const projectId = readProjectId(req.query, res);
  if (projectId === false) return;

  const period = (req.query['period'] as string) || '7d';
  const interval = getSqlInterval(period);
  const projectFilter = projectId ? sql`AND p.project_id = ${projectId}` : sql``;

  const [totals] = await db.execute<{
    totalLikes: number; totalComments: number; totalShares: number; totalImpressions: number;
  }>(sql`
    SELECT
      COALESCE(SUM(a.likes), 0)::int AS "totalLikes",
      COALESCE(SUM(a.comments), 0)::int AS "totalComments",
      COALESCE(SUM(a.shares), 0)::int AS "totalShares",
      COALESCE(SUM(a.impressions), 0)::int AS "totalImpressions"
    FROM posts p
    JOIN (${latestAnalytics}) a ON a.post_id = p.id
    WHERE p.created_at >= NOW() - INTERVAL '${sql.raw(interval)}' ${projectFilter}
  `);

  const platformBreakdown = await db.execute(sql`
    SELECT
      p.platform,
      COUNT(*)::int AS "postCount",
      COALESCE(SUM(a.likes), 0)::int AS "totalLikes",
      COALESCE(SUM(a.comments), 0)::int AS "totalComments",
      COALESCE(SUM(a.shares), 0)::int AS "totalShares",
      COALESCE(SUM(a.impressions), 0)::int AS "totalImpressions"
    FROM posts p
    LEFT JOIN (${latestAnalytics}) a ON a.post_id = p.id
    WHERE p.created_at >= NOW() - INTERVAL '${sql.raw(interval)}' ${projectFilter}
    GROUP BY p.platform
  `);

  const dailyTrend = await db.execute(sql`
    SELECT
      TO_CHAR(p.created_at, 'YYYY-MM-DD') AS date,
      COUNT(*)::int AS "postCount",
      COALESCE(SUM(a.likes), 0)::int AS "totalLikes",
      COALESCE(SUM(a.impressions), 0)::int AS "totalImpressions"
    FROM posts p
    LEFT JOIN (${latestAnalytics}) a ON a.post_id = p.id
    WHERE p.created_at >= NOW() - INTERVAL '${sql.raw(interval)}' ${projectFilter}
    GROUP BY 1
    ORDER BY 1
  `);

  res.json({
    period,
    totals: totals ?? { totalLikes: 0, totalComments: 0, totalShares: 0, totalImpressions: 0 },
    platformBreakdown: [...platformBreakdown],
    dailyTrend: [...dailyTrend],
  });
}));

dashboardRouter.get('/analytics-trends', asyncHandler(async (req, res) => {
  const projectId = readProjectId(req.query, res);
  if (projectId === false) return;

  const period = (req.query['period'] as string) || '30d';
  const interval = getSqlInterval(period);
  const projectFilter = projectId ? sql`AND p.project_id = ${projectId}` : sql``;

  const trendData = await db.execute(sql`
    SELECT
      TO_CHAR(p.created_at, 'YYYY-MM-DD') AS date,
      COUNT(*)::int AS "totalPosts",
      COUNT(*) FILTER (WHERE p.status = 'published')::int AS "publishedPosts",
      COUNT(*) FILTER (WHERE p.status = 'failed')::int AS "failedPosts",
      COALESCE(SUM(a.likes), 0)::int AS "totalLikes",
      COALESCE(SUM(a.comments), 0)::int AS "totalComments",
      COALESCE(SUM(a.shares), 0)::int AS "totalShares",
      COALESCE(SUM(a.impressions), 0)::int AS "totalImpressions",
      COALESCE(AVG(a.engagement_rate), 0)::float8 AS "avgEngagementRate"
    FROM posts p
    LEFT JOIN (${latestAnalytics}) a ON a.post_id = p.id
    WHERE p.created_at >= NOW() - INTERVAL '${sql.raw(interval)}' ${projectFilter}
    GROUP BY 1
    ORDER BY 1 ASC
  `);

  res.json({
    period,
    trends: [...trendData].map((r: any) => ({
      ...r,
      avgEngagementRate: Number((r.avgEngagementRate ?? 0).toFixed(2)),
    })),
  });
}));

dashboardRouter.get('/reports', asyncHandler(async (req, res) => {
  const projectId = readProjectId(req.query, res);
  if (projectId === false) return;

  const period = req.query['period'] as string | undefined;
  const reportType = req.query['reportType'] as string | undefined;
  const page = Math.max(1, parseInt((req.query['page'] as string) || '1', 10));
  const limit = Math.min(50, Math.max(1, parseInt((req.query['limit'] as string) || '20', 10)));
  const offset = (page - 1) * limit;

  const { getStoredReports } = await import('../../analytics/reporter.js');
  const result = await getStoredReports({
    projectId: projectId || undefined,
    period,
    reportType,
    limit,
    offset,
  });

  res.json({
    reports: result.reports,
    total: result.total,
    page,
    limit,
    totalPages: Math.ceil(result.total / limit),
  });
}));

dashboardRouter.get('/reports/:id', asyncHandler(async (req, res) => {
  const id = req.params['id'];
  if (!isUuid(id)) {
    res.status(400).json({ error: 'Invalid report id' });
    return;
  }

  const { getStoredReportById } = await import('../../analytics/reporter.js');
  const report = await getStoredReportById(id);
  if (!report) {
    res.status(404).json({ error: 'Report not found' });
    return;
  }

  res.json(report);
}));

dashboardRouter.post('/reports/generate', asyncHandler(async (req, res) => {
  const projectId = req.body?.projectId as string | undefined;
  if (projectId && !isUuid(projectId)) {
    res.status(400).json({ error: 'Invalid projectId' });
    return;
  }

  const period = req.body?.period as string | undefined;
  const reportType = req.body?.reportType as any;

  const { generateReport } = await import('../../analytics/reporter.js');
  const report = await generateReport({
    projectId: projectId || undefined,
    period,
    reportType: reportType || 'custom',
    saveToDb: true,
  });

  res.status(201).json(report);
}));

dashboardRouter.get('/strategy-history', asyncHandler(async (req, res) => {
  const accountId = req.query['accountId'] as string | undefined;
  if (accountId && !isUuid(accountId)) {
    res.status(400).json({ error: 'Invalid accountId' });
    return;
  }

  const history = await db
    .select({
      id: schema.strategyOptimizations.id,
      accountId: schema.strategyOptimizations.accountId,
      accountUsername: schema.accounts.username,
      platform: schema.accounts.platform,
      periodDays: schema.strategyOptimizations.periodDays,
      postsAnalyzed: schema.strategyOptimizations.postsAnalyzed,
      changes: schema.strategyOptimizations.changes,
      analysisData: schema.strategyOptimizations.analysisData,
      createdAt: schema.strategyOptimizations.createdAt,
    })
    .from(schema.strategyOptimizations)
    .innerJoin(schema.accounts, eq(schema.strategyOptimizations.accountId, schema.accounts.id))
    .where(accountId ? eq(schema.strategyOptimizations.accountId, accountId) : undefined)
    .orderBy(desc(schema.strategyOptimizations.createdAt))
    .limit(50);

  res.json(history);
}));

dashboardRouter.get('/account-performance', asyncHandler(async (req, res) => {
  const projectId = readProjectId(req.query, res);
  if (projectId === false) return;

  const period = (req.query['period'] as string) || '7d';
  const interval = getSqlInterval(period);

  const rows = await db.execute<{
    accountId: string;
    username: string;
    platform: string;
    active: boolean;
    hasStrategy: boolean;
    postCount: number;
    totalLikes: number;
    avgEngagementRate: number | null;
  }>(sql`
    SELECT
      acc.id AS "accountId",
      acc.username,
      acc.platform,
      acc.active,
      (acc.strategy IS NOT NULL AND COALESCE((acc.strategy->>'active')::boolean, false)) AS "hasStrategy",
      COUNT(p.id)::int AS "postCount",
      COALESCE(SUM(a.likes), 0)::int AS "totalLikes",
      AVG(a.engagement_rate)::float8 AS "avgEngagementRate"
    FROM accounts acc
    LEFT JOIN posts p ON p.account_id = acc.id AND p.created_at >= NOW() - INTERVAL '${sql.raw(interval)}'
    LEFT JOIN (${latestAnalytics}) a ON a.post_id = p.id
    WHERE TRUE ${projectId ? sql`AND acc.project_id = ${projectId}` : sql``}
    GROUP BY acc.id
    ORDER BY "totalLikes" DESC, "postCount" DESC
  `);

  res.json(rows.map((r) => ({
    ...r,
    avgEngagementRate: Number((r.avgEngagementRate ?? 0).toFixed(2)),
  })));
}));
