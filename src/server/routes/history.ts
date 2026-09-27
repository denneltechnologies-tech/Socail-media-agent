import { Router } from 'express';
import { sql, desc } from 'drizzle-orm';
import { db, schema } from '../../db/index.js';
import { asyncHandler } from '../middleware.js';

export const historyRouter = Router();

function getInterval(period: unknown): string {
  switch (period) {
    case '30d': return "30 days";
    case '90d': return "90 days";
    case 'all': return "10 years";
    case '7d':
    default:
      return "7 days";
  }
}

const latestAnalytics = sql`
  SELECT DISTINCT ON (post_id) post_id, likes, comments, shares, impressions, reach, engagement_rate
  FROM post_analytics
  ORDER BY post_id, fetched_at DESC
`;

historyRouter.get('/stats', asyncHandler(async (req, res) => {
  const period = req.query['period'] as string || '7d';
  const interval = getInterval(period);

  const [overview] = await db.execute<{
    totalGenerated: number;
    totalPublished: number;
    totalFailed: number;
    totalPending: number;
    avgSafetyScore: number | null;
    avgQualityScore: number | null;
    totalLikes: number;
    totalComments: number;
    totalShares: number;
    totalImpressions: number;
    avgEngagementRate: number | null;
  }>(sql`
    SELECT
      COUNT(p.id)::int AS "totalGenerated",
      COUNT(p.id) FILTER (WHERE p.status = 'published')::int AS "totalPublished",
      COUNT(p.id) FILTER (WHERE p.status = 'failed')::int AS "totalFailed",
      COUNT(p.id) FILTER (WHERE p.status IN ('pending', 'review', 'scheduled', 'generating'))::int AS "totalPending",
      AVG(p.safety_score)::float8 AS "avgSafetyScore",
      AVG(p.quality_score)::float8 AS "avgQualityScore",
      COALESCE(SUM(a.likes), 0)::int AS "totalLikes",
      COALESCE(SUM(a.comments), 0)::int AS "totalComments",
      COALESCE(SUM(a.shares), 0)::int AS "totalShares",
      COALESCE(SUM(a.impressions), 0)::int AS "totalImpressions",
      AVG(a.engagement_rate)::float8 AS "avgEngagementRate"
    FROM posts p
    LEFT JOIN (${latestAnalytics}) a ON a.post_id = p.id
    WHERE p.created_at >= NOW() - INTERVAL '${sql.raw(interval)}'
  `);

  const platformStats = await db.execute(sql`
    SELECT
      p.platform,
      COUNT(p.id)::int AS "count",
      COUNT(p.id) FILTER (WHERE p.status = 'published')::int AS "published",
      COUNT(p.id) FILTER (WHERE p.status = 'failed')::int AS "failed",
      COALESCE(SUM(a.likes), 0)::int AS "likes",
      COALESCE(SUM(a.comments), 0)::int AS "comments",
      COALESCE(SUM(a.shares), 0)::int AS "shares",
      COALESCE(SUM(a.impressions), 0)::int AS "impressions",
      AVG(a.engagement_rate)::float8 AS "avgEngagement"
    FROM posts p
    LEFT JOIN (${latestAnalytics}) a ON a.post_id = p.id
    WHERE p.created_at >= NOW() - INTERVAL '${sql.raw(interval)}'
    GROUP BY p.platform
  `);

  const timeline = await db.execute(sql`
    SELECT
      TO_CHAR(p.created_at, 'YYYY-MM-DD') AS date,
      COUNT(p.id)::int AS "generated",
      COUNT(p.id) FILTER (WHERE p.status = 'published')::int AS "published",
      COALESCE(SUM(a.likes), 0)::int AS "likes",
      COALESCE(SUM(a.impressions), 0)::int AS "impressions"
    FROM posts p
    LEFT JOIN (${latestAnalytics}) a ON a.post_id = p.id
    WHERE p.created_at >= NOW() - INTERVAL '${sql.raw(interval)}'
    GROUP BY 1
    ORDER BY 1 ASC
  `);

  res.json({
    period,
    overview: {
      totalGenerated: overview?.totalGenerated ?? 0,
      totalPublished: overview?.totalPublished ?? 0,
      totalFailed: overview?.totalFailed ?? 0,
      totalPending: overview?.totalPending ?? 0,
      avgSafetyScore: Math.round(overview?.avgSafetyScore ?? 100),
      avgQualityScore: Math.round(overview?.avgQualityScore ?? 0),
      totalLikes: overview?.totalLikes ?? 0,
      totalComments: overview?.totalComments ?? 0,
      totalShares: overview?.totalShares ?? 0,
      totalImpressions: overview?.totalImpressions ?? 0,
      avgEngagementRate: Number((overview?.avgEngagementRate ?? 0).toFixed(2)),
    },
    platformStats: [...platformStats],
    timeline: [...timeline],
  });
}));

historyRouter.get('/posts', asyncHandler(async (req, res) => {
  const period = req.query['period'] as string || 'all';
  const platform = req.query['platform'] as string;
  const status = req.query['status'] as string;
  const search = req.query['search'] as string;
  const page = Math.max(1, parseInt(req.query['page'] as string || '1', 10));
  const limit = Math.min(100, Math.max(1, parseInt(req.query['limit'] as string || '25', 10)));
  const offset = (page - 1) * limit;

  const interval = getInterval(period);

  let whereSql = sql`WHERE p.created_at >= NOW() - INTERVAL '${sql.raw(interval)}'`;
  if (platform) {
    whereSql = sql`${whereSql} AND p.platform = ${platform}`;
  }
  if (status) {
    whereSql = sql`${whereSql} AND p.status = ${status}`;
  }
  if (search) {
    whereSql = sql`${whereSql} AND (p.text ILIKE ${'%' + search + '%'} OR p.platform_post_id ILIKE ${'%' + search + '%'})`;
  }

  const posts = await db.execute(sql`
    SELECT
      p.id,
      p.project_id AS "projectId",
      p.account_id AS "accountId",
      p.platform,
      p.content_type AS "contentType",
      p.text,
      p.hashtags,
      p.media_urls AS "mediaUrls",
      p.status,
      p.tone,
      p.platform_post_id AS "platformPostId",
      p.platform_url AS "platformUrl",
      p.safety_score AS "safetyScore",
      p.quality_score AS "qualityScore",
      p.error_message AS "errorMessage",
      p.scheduled_at AS "scheduledAt",
      p.published_at AS "publishedAt",
      p.created_at AS "createdAt",
      acc.username AS "accountUsername",
      proj.name AS "projectName",
      COALESCE(a.likes, 0) AS likes,
      COALESCE(a.comments, 0) AS comments,
      COALESCE(a.shares, 0) AS shares,
      COALESCE(a.impressions, 0) AS impressions,
      COALESCE(a.engagement_rate, 0) AS "engagementRate"
    FROM posts p
    LEFT JOIN accounts acc ON acc.id = p.account_id
    LEFT JOIN projects proj ON proj.id = p.project_id
    LEFT JOIN (${latestAnalytics}) a ON a.post_id = p.id
    ${whereSql}
    ORDER BY p.created_at DESC
    LIMIT ${limit} OFFSET ${offset}
  `);

  const [countResult] = await db.execute<{ count: number }>(sql`
    SELECT COUNT(*)::int AS count
    FROM posts p
    ${whereSql}
  `);

  res.json({
    posts: [...posts],
    total: countResult?.count ?? 0,
    page,
    limit,
    totalPages: Math.ceil((countResult?.count ?? 0) / limit),
  });
}));

historyRouter.get('/logs', asyncHandler(async (_req, res) => {
  const recentLogs = await db
    .select()
    .from(schema.logs)
    .orderBy(desc(schema.logs.createdAt))
    .limit(50);

  const recentJobs = await db
    .select()
    .from(schema.jobQueue)
    .orderBy(desc(schema.jobQueue.createdAt))
    .limit(30);

  res.json({ logs: recentLogs, jobs: recentJobs });
}));
