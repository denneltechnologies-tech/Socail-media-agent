import * as fs from 'fs';
import { eq } from 'drizzle-orm';
import { Platform } from '../../config/constants.js';
import { env } from '../../config/env.js';
import { settingsStore } from '../../config/settings-store.js';
import { db, schema } from '../../db/index.js';
import { NonRetryableError } from '../../core/errors.js';
import type { GeneratedContent, PlatformPostResult, PostAnalyticsData, ConnectionTestResult } from '../../types/index.js';
import { BasePlatformAdapter } from '../base.js';
import { logger } from '../../config/logger.js';
import { composePostText } from '../../core/safety-guard.js';
import { resolveMediaFile } from '../../core/media.js';

export class TikTokAdapter extends BasePlatformAdapter {
  platform = Platform.TIKTOK as const;
  private fallbackToken: string | null = null;
  private tokenCache = new Map<string, string>();
  private readonly baseUrl = 'https://open.tiktokapis.com/v2';

  async init(): Promise<void> {
    const token = env.TIKTOK_ACCESS_TOKEN || settingsStore.get('TIKTOK_ACCESS_TOKEN');
    if (!token) {
      this.log('Adapter initialized (credentials will be resolved per account or from Settings)');
      return;
    }

    this.fallbackToken = token;
    this.log('Adapter initialized with system token');
  }

  async destroy(): Promise<void> {
    this.fallbackToken = null;
    this.tokenCache.clear();
    this.log('Adapter destroyed');
  }

  invalidateAccount(accountId: string): void {
    this.tokenCache.delete(accountId);
  }

  private async getTokenForAccount(accountId?: string): Promise<string> {
    if (accountId) {
      const cached = this.tokenCache.get(accountId);
      if (cached) return cached;

      const [account] = await db
        .select({ username: schema.accounts.username, credentials: schema.accounts.credentials })
        .from(schema.accounts)
        .where(eq(schema.accounts.id, accountId))
        .limit(1);

      const creds = account?.credentials as Record<string, string> | undefined;
      const token = creds?.accessToken || creds?.token;
      if (token) {
        this.tokenCache.set(accountId, token);
        return token;
      }
    }

    if (this.fallbackToken) {
      return this.fallbackToken;
    }

    const token = settingsStore.get('TIKTOK_ACCESS_TOKEN') || env.TIKTOK_ACCESS_TOKEN;
    if (token) {
      if (accountId) this.tokenCache.set(accountId, token);
      return token;
    }

    throw new NonRetryableError(
      `No TikTok access token configured${accountId ? ` for account ${accountId}` : ''}. Configure in Connected Accounts, Settings, or .env`
    );
  }

  async testConnection(accountId?: string): Promise<ConnectionTestResult> {
    try {
      const token = await this.getTokenForAccount(accountId);
      const res = await fetch(`${this.baseUrl}/user/info/?fields=open_id,union_id,avatar_url,display_name`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const errJson = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        const msg = errJson?.error?.message || `HTTP ${res.status}: ${res.statusText}`;
        return { success: false, message: `TikTok verification failed: ${msg}` };
      }
      const data = (await res.json()) as { data?: { user?: { display_name?: string; open_id?: string } } };
      const user = data.data?.user;
      return {
        success: true,
        message: `Successfully connected to TikTok account: ${user?.display_name ?? 'OK'}`,
        details: user as Record<string, unknown> | undefined,
      };
    } catch (err) {
      return {
        success: false,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  protected async doPost(content: GeneratedContent, accountId: string): Promise<PlatformPostResult> {
    const token = await this.getTokenForAccount(accountId);
    const mediaUrl = content.mediaUrls?.[0];

    if (!mediaUrl) {
      return { success: false, error: 'TikTok requires a video file' };
    }

    let media: Awaited<ReturnType<typeof resolveMediaFile>>;
    try {
      media = await resolveMediaFile(mediaUrl);
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }

    try {
      return await this.uploadVideo(token, media.filePath, composePostText(content));
    } finally {
      media.cleanup();
    }
  }

  private async uploadVideo(token: string, videoPath: string, caption: string): Promise<PlatformPostResult> {
    const videoSize = fs.statSync(videoPath).size;

    // Step 1: Initialize upload (single chunk — TikTok allows up to 64MB per chunk)
    const initRes = await fetch(`${this.baseUrl}/post/publish/video/init/`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        post_info: {
          title: caption.slice(0, 150),
          privacy_level: 'PUBLIC_TO_EVERYONE',
          disable_duet: false,
          disable_comment: false,
          disable_stitch: false,
        },
        source_info: {
          source: 'FILE_UPLOAD',
          video_size: videoSize,
          chunk_size: videoSize,
          total_chunk_count: 1,
        },
      }),
    });

    if (!initRes.ok) {
      const err = await initRes.text();
      return { success: false, error: `TikTok init failed: ${err}` };
    }

    const initData = (await initRes.json()) as { data: { upload_url: string; publish_id: string } };
    const { upload_url, publish_id } = initData.data;

    // Step 2: Upload video
    const videoBuffer = fs.readFileSync(videoPath);
    const uploadRes = await fetch(upload_url, {
      method: 'PUT',
      headers: {
        'Content-Type': 'video/mp4',
        'Content-Range': `bytes 0-${videoBuffer.length - 1}/${videoBuffer.length}`,
      },
      body: videoBuffer,
    });

    if (!uploadRes.ok) {
      return { success: false, error: 'TikTok video upload failed' };
    }

    this.log('Video uploaded', { publish_id });

    return {
      success: true,
      platformPostId: publish_id,
    };
  }

  protected async doDelete(_platformPostId: string, _accountId: string): Promise<boolean> {
    logger.warn('TikTok API does not support programmatic deletion');
    return false;
  }

  protected async doGetAnalytics(platformPostId: string, accountId: string): Promise<PostAnalyticsData> {
    const token = await this.getTokenForAccount(accountId);

    const res = await fetch(`${this.baseUrl}/video/query/`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        filters: { video_ids: [platformPostId] },
        fields: ['like_count', 'comment_count', 'share_count', 'view_count'],
      }),
    });

    if (!res.ok) {
      return { likes: 0, comments: 0, shares: 0, impressions: 0, reach: 0, engagementRate: 0 };
    }

    const data = (await res.json()) as {
      data: { videos: Array<{ like_count: number; comment_count: number; share_count: number; view_count: number }> };
    };

    const video = data.data.videos[0];
    if (!video) {
      return { likes: 0, comments: 0, shares: 0, impressions: 0, reach: 0, engagementRate: 0 };
    }

    const engagement = video.like_count + video.comment_count + video.share_count;

    return {
      likes: video.like_count,
      comments: video.comment_count,
      shares: video.share_count,
      impressions: video.view_count,
      reach: video.view_count,
      engagementRate: video.view_count > 0 ? ((engagement / video.view_count) * 100) : 0,
    };
  }
}
