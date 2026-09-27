import { eq, and, gte, desc, sql } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { logger } from '../config/logger.js';
import { PostStatus } from '../config/constants.js';
import type {
  ReportMetrics,
  ReportTopPost,
  ReportAccountBreakdown,
  ReportPlatformBreakdown,
  ReportTrendPoint,
  ReportInsight,
  AnalyticsReportRecord,
} from '../types/index.js';

export interface AccountBreakdown extends ReportAccountBreakdown {}

export interface AnalyticsReport {
  id?: string;
  reportType?: string;
  period: string;
  startDate?: Date;
  endDate?: Date;
  totalPosts: number;
  postsPublished: number;
  postsFailed: number;
  totalLikes: number;
  totalComments: number;
  totalShares: number;
  totalImpressions: number;
  avgEngagementRate: number;
  topPosts: ReportTopPost[];
  accountBreakdowns: ReportAccountBreakdown[];
  platformBreakdown?: ReportPlatformBreakdown[];
  trends?: ReportTrendPoint[];
  insights?: ReportInsight[];
}

export interface GenerateReportOptions {
  days?: number;
  period?: string;
  projectId?: string;
  reportType?: 'daily' | 'weekly' | 'monthly' | 'custom';
  saveToDb?: boolean;
}

function parsePeriodToDays(period?: string, defaultDays = 7): { days: number; label: string } {
  if (!period) return { days: defaultDays, label: `Son ${defaultDays} gun` };
  switch (period.toLowerCase()) {
    case '24h':
    case '1d':
      return { days: 1, label: 'Son 24 saat' };
    case '7d':
      return { days: 7, label: 'Son 7 gun' };
    case '30d':
      return { days: 30, label: 'Son 30 gun' };
    case '90d':
      return { days: 90, label: 'Son 90 gun' };
    case '1y':
    case '365d':
      return { days: 365, label: 'Son 1 yil' };
    case 'all':
      return { days: 3650, label: 'Tum Zamanlar' };
    default: {
      const parsed = parseInt(period, 10);
      return Number.isFinite(parsed) && parsed > 0
        ? { days: parsed, label: `Son ${parsed} gun` }
        : { days: defaultDays, label: `Son ${defaultDays} gun` };
    }
  }
}

export async function generateReport(
  daysOrOptions: number | GenerateReportOptions = 7,
): Promise<AnalyticsReport> {
  const options: GenerateReportOptions =
    typeof daysOrOptions === 'number'
      ? { days: daysOrOptions, saveToDb: true }
      : { saveToDb: true, ...daysOrOptions };

  const { days, label } = parsePeriodToDays(options.period, options.days ?? 7);
  const reportType = options.reportType || (days === 1 ? 'daily' : days === 7 ? 'weekly' : 'custom');

  const endDate = new Date();
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);

  const conditions = [gte(schema.posts.createdAt, startDate)];
  if (options.projectId) {
    conditions.push(eq(schema.posts.projectId, options.projectId));
  }

  const posts = await db
    .select()
    .from(schema.posts)
    .where(and(...conditions));

  const postsPublished = posts.filter((p) => p.status === PostStatus.PUBLISHED).length;
  const postsFailed = posts.filter((p) => p.status === PostStatus.FAILED).length;

  const analyticsConditions = [gte(schema.posts.createdAt, startDate)];
  if (options.projectId) {
    analyticsConditions.push(eq(schema.posts.projectId, options.projectId));
  }

  const analyticsRows = await db
    .select({
      postId: schema.postAnalytics.postId,
      likes: sql<number>`MAX(${schema.postAnalytics.likes})`,
      comments: sql<number>`MAX(${schema.postAnalytics.comments})`,
      shares: sql<number>`MAX(${schema.postAnalytics.shares})`,
      impressions: sql<number>`MAX(${schema.postAnalytics.impressions})`,
      reach: sql<number>`MAX(${schema.postAnalytics.reach})`,
      engagementRate: sql<number>`MAX(${schema.postAnalytics.engagementRate})`,
    })
    .from(schema.postAnalytics)
    .innerJoin(schema.posts, eq(schema.postAnalytics.postId, schema.posts.id))
    .where(and(...analyticsConditions))
    .groupBy(schema.postAnalytics.postId);

  const totals = analyticsRows.reduce(
    (acc, row) => ({
      likes: acc.likes + (row.likes ?? 0),
      comments: acc.comments + (row.comments ?? 0),
      shares: acc.shares + (row.shares ?? 0),
      impressions: acc.impressions + (row.impressions ?? 0),
      reach: acc.reach + (row.reach ?? 0),
      engagementSum: acc.engagementSum + (row.engagementRate ?? 0),
    }),
    { likes: 0, comments: 0, shares: 0, impressions: 0, reach: 0, engagementSum: 0 },
  );

  // Platform breakdown
  const platformStatsMap = new Map<string, ReportPlatformBreakdown>();
  for (const post of posts) {
    const existing = platformStatsMap.get(post.platform) ?? {
      platform: post.platform,
      postCount: 0,
      totalLikes: 0,
      totalComments: 0,
      totalShares: 0,
      totalImpressions: 0,
    };
    existing.postCount++;
    platformStatsMap.set(post.platform, existing);
  }

  const postAnalyticsMap = new Map(analyticsRows.map((a) => [a.postId, a]));
  for (const post of posts) {
    const a = postAnalyticsMap.get(post.id);
    if (!a) continue;
    const existing = platformStatsMap.get(post.platform);
    if (existing) {
      existing.totalLikes += a.likes ?? 0;
      existing.totalComments += a.comments ?? 0;
      existing.totalShares += a.shares ?? 0;
      existing.totalImpressions += a.impressions ?? 0;
    }
  }
  const platformBreakdown = [...platformStatsMap.values()];

  // Account breakdown
  const accountIds = [...new Set(posts.map((p) => p.accountId))];
  const accounts =
    accountIds.length > 0
      ? await db
          .select({
            id: schema.accounts.id,
            username: schema.accounts.username,
            platform: schema.accounts.platform,
          })
          .from(schema.accounts)
      : [];

  const accountMap = new Map(accounts.map((a) => [a.id, a]));

  const accountBreakdowns: ReportAccountBreakdown[] = [];
  for (const accountId of accountIds) {
    const acc = accountMap.get(accountId);
    if (!acc) continue;

    const accountPosts = posts.filter((p) => p.accountId === accountId);
    const accountPostIds = new Set(accountPosts.map((p) => p.id));
    const accountAnalytics = analyticsRows.filter((a) => accountPostIds.has(a.postId));
    const accountLikes = accountAnalytics.reduce((sum, a) => sum + (a.likes ?? 0), 0);

    accountBreakdowns.push({
      accountId,
      username: acc.username,
      platform: acc.platform,
      postCount: accountPosts.length,
      totalLikes: accountLikes,
    });
  }
  accountBreakdowns.sort((a, b) => b.totalLikes - a.totalLikes);

  // Top posts with username
  const topAnalytics = [...analyticsRows].sort((a, b) => (b.likes ?? 0) - (a.likes ?? 0)).slice(0, 5);

  const topPosts: ReportTopPost[] = topAnalytics.map((a) => {
    const post = posts.find((p) => p.id === a.postId);
    const acc = post ? accountMap.get(post.accountId) : undefined;
    return {
      postId: a.postId,
      text: post?.text ? post.text.slice(0, 100) : '',
      likes: a.likes ?? 0,
      platform: post?.platform ?? 'unknown',
      username: acc?.username ?? 'unknown',
    };
  });

  // Daily trends over time
  const dailyTrendsMap = new Map<string, ReportTrendPoint>();
  for (const post of posts) {
    const dateStr = post.createdAt.toISOString().slice(0, 10);
    const existing = dailyTrendsMap.get(dateStr) ?? {
      date: dateStr,
      postCount: 0,
      totalLikes: 0,
      totalImpressions: 0,
    };
    existing.postCount++;
    const a = postAnalyticsMap.get(post.id);
    if (a) {
      existing.totalLikes += a.likes ?? 0;
      existing.totalImpressions += a.impressions ?? 0;
    }
    dailyTrendsMap.set(dateStr, existing);
  }
  const trends = [...dailyTrendsMap.values()].sort((a, b) => a.date.localeCompare(b.date));

  // Generate automated analytical insights
  const insights: ReportInsight[] = [];
  const avgEngagementRate =
    analyticsRows.length > 0 ? totals.engagementSum / analyticsRows.length : 0;

  if (platformBreakdown.length > 0) {
    const bestPlatform = [...platformBreakdown].sort((a, b) => b.totalLikes - a.totalLikes)[0];
    if (bestPlatform && bestPlatform.totalLikes > 0) {
      insights.push({
        type: 'platform_leader',
        message: `${bestPlatform.platform.toUpperCase()} led all platforms with ${bestPlatform.totalLikes} total likes across ${bestPlatform.postCount} posts.`,
      });
    }
  }

  if (postsPublished > 0) {
    const successRate = ((postsPublished / posts.length) * 100).toFixed(1);
    insights.push({
      type: 'publishing_health',
      message: `Publishing success rate was ${successRate}% (${postsPublished} published, ${postsFailed} failed out of ${posts.length} generated).`,
    });
  }

  if (avgEngagementRate > 0) {
    insights.push({
      type: 'engagement_benchmark',
      message: `Average engagement rate across tracked posts was ${avgEngagementRate.toFixed(2)}%.`,
    });
  }

  const metrics: ReportMetrics = {
    totalPosts: posts.length,
    postsPublished,
    postsFailed,
    totalLikes: totals.likes,
    totalComments: totals.comments,
    totalShares: totals.shares,
    totalImpressions: totals.impressions,
    avgEngagementRate: Number(avgEngagementRate.toFixed(2)),
  };

  const summary = `Generated analysis report for period ${label}: ${posts.length} posts, ${totals.likes} likes, ${totals.impressions} impressions.`;

  let reportId: string | undefined;

  // Persist report to database if requested
  if (options.saveToDb !== false) {
    try {
      const [inserted] = await db
        .insert(schema.analyticsReports)
        .values({
          projectId: options.projectId ?? null,
          reportType,
          period: options.period ?? `${days}d`,
          startDate,
          endDate,
          summary,
          metrics,
          topPosts,
          accountBreakdowns,
          platformBreakdown,
          trends,
          insights,
        })
        .returning({ id: schema.analyticsReports.id });

      reportId = inserted?.id;
      logger.info('Analytics report stored in database', { reportId, period: label });
    } catch (err) {
      logger.warn('Failed to persist analytics report to database', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const report: AnalyticsReport = {
    id: reportId,
    reportType,
    period: label,
    startDate,
    endDate,
    totalPosts: posts.length,
    postsPublished,
    postsFailed,
    totalLikes: totals.likes,
    totalComments: totals.comments,
    totalShares: totals.shares,
    totalImpressions: totals.impressions,
    avgEngagementRate: Number(avgEngagementRate.toFixed(2)),
    topPosts,
    accountBreakdowns,
    platformBreakdown,
    trends,
    insights,
  };

  logger.info('Report generated', { period: report.period, totalPosts: report.totalPosts });
  return report;
}

export async function getStoredReports(filter: {
  projectId?: string;
  period?: string;
  reportType?: string;
  limit?: number;
  offset?: number;
}): Promise<{ reports: AnalyticsReportRecord[]; total: number }> {
  const conditions = [];
  if (filter.projectId) {
    conditions.push(eq(schema.analyticsReports.projectId, filter.projectId));
  }
  if (filter.period) {
    conditions.push(eq(schema.analyticsReports.period, filter.period));
  }
  if (filter.reportType) {
    conditions.push(eq(schema.analyticsReports.reportType, filter.reportType));
  }

  const limit = Math.min(100, Math.max(1, filter.limit ?? 20));
  const offset = Math.max(0, filter.offset ?? 0);

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  const reports = await db
    .select()
    .from(schema.analyticsReports)
    .where(whereClause)
    .orderBy(desc(schema.analyticsReports.createdAt))
    .limit(limit)
    .offset(offset);

  const [countResult] = await db
    .select({ count: sql<number>`COUNT(*)::int` })
    .from(schema.analyticsReports)
    .where(whereClause);

  return {
    reports: reports as AnalyticsReportRecord[],
    total: countResult?.count ?? 0,
  };
}

export async function getStoredReportById(id: string): Promise<AnalyticsReportRecord | null> {
  const [report] = await db
    .select()
    .from(schema.analyticsReports)
    .where(eq(schema.analyticsReports.id, id))
    .limit(1);

  return (report as AnalyticsReportRecord) ?? null;
}

export function formatReportText(report: AnalyticsReport): string {
  let text = `📊 *${report.period} Raporu*\n\n`;
  text += `📝 Toplam Post: ${report.totalPosts}\n`;
  text += `❤️ Toplam Beğeni: ${report.totalLikes}\n`;
  text += `💬 Toplam Yorum: ${report.totalComments}\n`;
  text += `🔄 Toplam Paylaşım: ${report.totalShares}\n`;
  text += `👁️ Toplam Gösterim: ${report.totalImpressions}\n`;
  text += `📈 Ort. Etkileşim: ${report.avgEngagementRate.toFixed(2)}%\n`;

  if (report.topPosts.length > 0) {
    text += `\n🏆 *En İyi Postlar*\n`;
    for (const post of report.topPosts) {
      text += `  • [${post.platform}] @${post.username} — ${post.text.slice(0, 50)}... (${post.likes} ❤️)\n`;
    }
  }

  if (report.accountBreakdowns.length > 0) {
    text += `\n📊 *Hesap Performansı*\n`;
    for (const ab of report.accountBreakdowns) {
      text += `  • @${ab.username} (${ab.platform}): ${ab.postCount} post, ${ab.totalLikes} ❤️\n`;
    }
  }

  if (report.insights && report.insights.length > 0) {
    text += `\n💡 *Analiz Bulguları*\n`;
    for (const insight of report.insights) {
      text += `  • ${insight.message}\n`;
    }
  }

  return text;
}
