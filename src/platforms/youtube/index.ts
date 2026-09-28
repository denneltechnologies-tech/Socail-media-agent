import { google, type youtube_v3 } from 'googleapis';
import * as fs from 'fs';
import { eq } from 'drizzle-orm';
import { Platform } from '../../config/constants.js';
import { env } from '../../config/env.js';
import { settingsStore } from '../../config/settings-store.js';
import { db, schema } from '../../db/index.js';
import { NonRetryableError } from '../../core/errors.js';
import type { GeneratedContent, PlatformPostResult, PostAnalyticsData, ConnectionTestResult } from '../../types/index.js';
import { BasePlatformAdapter } from '../base.js';
import { normalizeHashtag } from '../../core/safety-guard.js';
import { resolveMediaFile } from '../../core/media.js';

function firstSentence(text: string): string {
  const match = text.trim().match(/^[^.!?\n]+[.!?]?/);
  return (match?.[0] ?? text).trim();
}

export class YouTubeAdapter extends BasePlatformAdapter {
  platform = Platform.YOUTUBE as const;
  private fallbackClient: youtube_v3.Youtube | null = null;
  private clientCache = new Map<string, youtube_v3.Youtube>();

  async init(): Promise<void> {
    const clientId = env.YOUTUBE_CLIENT_ID || settingsStore.get('YOUTUBE_CLIENT_ID');
    const clientSecret = env.YOUTUBE_CLIENT_SECRET || settingsStore.get('YOUTUBE_CLIENT_SECRET');
    const refreshToken = env.YOUTUBE_REFRESH_TOKEN || settingsStore.get('YOUTUBE_REFRESH_TOKEN');

    if (!clientId || !clientSecret || !refreshToken) {
      this.log('Adapter initialized (credentials will be resolved per account or from Settings)');
      return;
    }

    const oauth2Client = new google.auth.OAuth2(clientId, clientSecret);
    oauth2Client.setCredentials({ refresh_token: refreshToken });
    this.fallbackClient = google.youtube({ version: 'v3', auth: oauth2Client });
    this.log('Adapter initialized with system credentials');
  }

  async destroy(): Promise<void> {
    this.fallbackClient = null;
    this.clientCache.clear();
    this.log('Adapter destroyed');
  }

  invalidateAccount(accountId: string): void {
    this.clientCache.delete(accountId);
  }

  private async getClientForAccount(accountId?: string): Promise<youtube_v3.Youtube> {
    if (accountId) {
      const cached = this.clientCache.get(accountId);
      if (cached) return cached;

      const [account] = await db
        .select({ username: schema.accounts.username, credentials: schema.accounts.credentials })
        .from(schema.accounts)
        .where(eq(schema.accounts.id, accountId))
        .limit(1);

      const creds = account?.credentials as Record<string, string> | undefined;
      const clientId = creds?.clientId;
      const clientSecret = creds?.clientSecret;
      const refreshToken = creds?.refreshToken;

      if (clientId && clientSecret && refreshToken) {
        const oauth2Client = new google.auth.OAuth2(clientId, clientSecret);
        oauth2Client.setCredentials({ refresh_token: refreshToken });
        const client = google.youtube({ version: 'v3', auth: oauth2Client });
        this.clientCache.set(accountId, client);
        return client;
      }
    }

    if (this.fallbackClient) {
      return this.fallbackClient;
    }

    const clientId = settingsStore.get('YOUTUBE_CLIENT_ID') || env.YOUTUBE_CLIENT_ID;
    const clientSecret = settingsStore.get('YOUTUBE_CLIENT_SECRET') || env.YOUTUBE_CLIENT_SECRET;
    const refreshToken = settingsStore.get('YOUTUBE_REFRESH_TOKEN') || env.YOUTUBE_REFRESH_TOKEN;

    if (clientId && clientSecret && refreshToken) {
      const oauth2Client = new google.auth.OAuth2(clientId, clientSecret);
      oauth2Client.setCredentials({ refresh_token: refreshToken });
      const client = google.youtube({ version: 'v3', auth: oauth2Client });
      if (accountId) this.clientCache.set(accountId, client);
      return client;
    }

    throw new NonRetryableError(
      `No YouTube credentials configured${accountId ? ` for account ${accountId}` : ''}. Configure Client ID, Secret, and Refresh Token in Connected Accounts, Settings, or .env`
    );
  }

  async testConnection(accountId?: string): Promise<ConnectionTestResult> {
    try {
      const client = await this.getClientForAccount(accountId);
      const res = await client.channels.list({ part: ['snippet'], mine: true });
      const item = res.data.items?.[0];
      const title = item?.snippet?.title ?? 'Connected Channel';
      return {
        success: true,
        message: `Successfully connected to YouTube channel: ${title}`,
        details: item as Record<string, unknown> | undefined,
      };
    } catch (err) {
      return {
        success: false,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  protected async doPost(content: GeneratedContent, accountId: string): Promise<PlatformPostResult> {
    const youtube = await this.getClientForAccount(accountId);
    const mediaUrl = content.mediaUrls?.[0];

    if (!mediaUrl) {
      return { success: false, error: 'YouTube requires a video file' };
    }

    let media: Awaited<ReturnType<typeof resolveMediaFile>>;
    try {
      media = await resolveMediaFile(mediaUrl);
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }

    const hashtags = content.hashtags.map(normalizeHashtag);
    const description = [content.text, '', hashtags.join(' ')].join('\n').slice(0, 5000);
    // YouTube rejects titles over 100 chars or containing angle brackets
    const title = firstSentence(content.text).replace(/[<>]/g, '').slice(0, 100) || 'Untitled';
    const language = content.metadata?.['language'];

    let res;
    try {
      res = await youtube.videos.insert({
        part: ['snippet', 'status'],
        requestBody: {
          snippet: {
            title,
            description,
            tags: hashtags.map((h) => h.slice(1)),
            categoryId: '22', // People & Blogs
            ...(typeof language === 'string' ? { defaultLanguage: language } : {}),
          },
          status: {
            privacyStatus: 'public',
            selfDeclaredMadeForKids: false,
          },
        },
        media: {
          body: fs.createReadStream(media.filePath),
        },
      });
    } finally {
      media.cleanup();
    }

    const videoId = res.data.id;
    if (!videoId) {
      return { success: false, error: 'YouTube upload returned no video ID' };
    }

    this.log('Video uploaded', { videoId });
    return {
      success: true,
      platformPostId: videoId,
      url: `https://www.youtube.com/watch?v=${videoId}`,
    };
  }

  protected async doDelete(platformPostId: string, accountId: string): Promise<boolean> {
    const youtube = await this.getClientForAccount(accountId);
    await youtube.videos.delete({ id: platformPostId });
    this.log('Video deleted', { platformPostId });
    return true;
  }

  protected async doGetAnalytics(platformPostId: string, accountId: string): Promise<PostAnalyticsData> {
    const youtube = await this.getClientForAccount(accountId);

    const res = await youtube.videos.list({
      part: ['statistics'],
      id: [platformPostId],
    });

    const stats = res.data.items?.[0]?.statistics;

    const views = parseInt(stats?.viewCount ?? '0');
    const likes = parseInt(stats?.likeCount ?? '0');
    const comments = parseInt(stats?.commentCount ?? '0');

    return {
      likes,
      comments,
      shares: 0,
      impressions: views,
      reach: views,
      engagementRate: views > 0 ? ((likes + comments) / views) * 100 : 0,
    };
  }
}
