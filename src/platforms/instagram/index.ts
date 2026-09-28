import { eq } from 'drizzle-orm';
import { Platform } from '../../config/constants.js';
import { env } from '../../config/env.js';
import { settingsStore } from '../../config/settings-store.js';
import { db, schema } from '../../db/index.js';
import { NonRetryableError } from '../../core/errors.js';
import type { GeneratedContent, PlatformPostResult, PostAnalyticsData, ConnectionTestResult } from '../../types/index.js';
import { BasePlatformAdapter } from '../base.js';
import { composePostText } from '../../core/safety-guard.js';
import { toAbsoluteUrl } from '../../core/media.js';

const GRAPH_URL = 'https://graph.facebook.com/v21.0';
const CONTAINER_POLL_INTERVAL_MS = 5000;
const CONTAINER_MAX_WAIT_MS = 5 * 60 * 1000;

interface IGIdResponse {
  id: string;
}

interface IGContainerStatus {
  status_code?: 'EXPIRED' | 'ERROR' | 'FINISHED' | 'IN_PROGRESS' | 'PUBLISHED';
  status?: string;
}

interface IGInsightsResponse {
  data: Array<{ name: string; values: Array<{ value: number }> }>;
}

export class InstagramAdapter extends BasePlatformAdapter {
  platform = Platform.INSTAGRAM as const;
  private credsCache = new Map<string, { token: string; accountId: string; username?: string }>();

  async init(): Promise<void> {
    const hasEnv = Boolean(env.INSTAGRAM_ACCESS_TOKEN && env.INSTAGRAM_BUSINESS_ACCOUNT_ID);
    const hasSettings = Boolean(settingsStore.get('INSTAGRAM_ACCESS_TOKEN') && settingsStore.get('INSTAGRAM_BUSINESS_ACCOUNT_ID'));
    if (!hasEnv && !hasSettings) {
      this.log('Adapter initialized (credentials will be resolved per account or from Settings)');
      return;
    }
    this.log('Adapter initialized');
  }

  async destroy(): Promise<void> {
    this.credsCache.clear();
    this.log('Adapter destroyed');
  }

  invalidateAccount(accountId: string): void {
    this.credsCache.delete(accountId);
  }

  async getCredentialsForAccount(accountId?: string): Promise<{ token: string; accountId: string; username?: string }> {
    let token: string | undefined;
    let businessAccountId: string | undefined;
    let username: string | undefined;

    if (accountId) {
      const cached = this.credsCache.get(accountId);
      if (cached) return cached;

      const [acc] = await db
        .select({ username: schema.accounts.username, credentials: schema.accounts.credentials })
        .from(schema.accounts)
        .where(eq(schema.accounts.id, accountId))
        .limit(1);

      if (acc) {
        username = acc.username;
        const creds = acc.credentials as Record<string, string> | undefined;
        const rawToken = creds?.accessToken ?? creds?.token;
        if (typeof rawToken === 'string') {
          token = rawToken.trim();
        }
        const rawId = creds?.businessAccountId ?? creds?.accountId ?? creds?.igBusinessAccountId;
        if (typeof rawId === 'string') {
          businessAccountId = rawId.trim();
        }
      }
    }

    // Fall back to settings store
    if (!token) {
      const st = settingsStore.get('INSTAGRAM_ACCESS_TOKEN')?.trim();
      if (st) token = st;
    }
    if (!businessAccountId) {
      const sb = settingsStore.get('INSTAGRAM_BUSINESS_ACCOUNT_ID')?.trim();
      if (sb) businessAccountId = sb;
    }

    // Fall back to environment variables
    if (!token && env.INSTAGRAM_ACCESS_TOKEN) {
      token = env.INSTAGRAM_ACCESS_TOKEN.trim();
    }
    if (!businessAccountId && env.INSTAGRAM_BUSINESS_ACCOUNT_ID) {
      businessAccountId = env.INSTAGRAM_BUSINESS_ACCOUNT_ID.trim();
    }

    if (!token || !businessAccountId) {
      const missing = [
        !token && 'Instagram Access Token',
        !businessAccountId && 'Instagram Business Account ID',
      ].filter(Boolean).join(' and ');

      const accountLabel = username ? ` for @${username}` : (accountId ? ` for account ${accountId}` : '');
      throw new NonRetryableError(
        `Missing ${missing}${accountLabel}. Please configure credentials in Connected Accounts, Settings, or .env.`
      );
    }

    const resolved = { token, accountId: businessAccountId, username };
    if (accountId) {
      this.credsCache.set(accountId, resolved);
    }
    return resolved;
  }

  async testConnection(accountId?: string): Promise<ConnectionTestResult> {
    try {
      const { token, accountId: igId } = await this.getCredentialsForAccount(accountId);
      const res = await fetch(`${GRAPH_URL}/${igId}?fields=id,name,username,profile_picture_url&access_token=${encodeURIComponent(token)}`);
      if (!res.ok) {
        const errJson = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        const msg = errJson?.error?.message || `HTTP ${res.status}: ${res.statusText}`;
        return {
          success: false,
          message: `Instagram verification failed: ${msg}`,
        };
      }
      const data = (await res.json()) as { id: string; name?: string; username?: string };
      const display = data.username ? `@${data.username}` : (data.name || data.id);
      return {
        success: true,
        message: `Successfully connected to Instagram account ${display} (ID: ${data.id})`,
        details: data,
      };
    } catch (err) {
      return {
        success: false,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  protected async doPost(content: GeneratedContent, accountId: string): Promise<PlatformPostResult> {
    const { token, accountId: igAccountId } = await this.getCredentialsForAccount(accountId);
    const caption = composePostText(content);

    const mediaUrl = content.mediaUrls?.[0];
    if (!mediaUrl) {
      return { success: false, error: 'Instagram requires an image or video' };
    }

    const publicBaseUrl = settingsStore.get('PUBLIC_BASE_URL') || env.PUBLIC_BASE_URL;
    const publicUrl = toAbsoluteUrl(mediaUrl, publicBaseUrl);
    if (!publicUrl) {
      return {
        success: false,
        error: 'Instagram fetches media by URL — set PUBLIC_BASE_URL in Settings so locally generated media is reachable',
      };
    }

    const isVideo = /\.(mp4|mov)(\?|$)/i.test(publicUrl);

    // Step 1: Create media container
    const createRes = await fetch(`${GRAPH_URL}/${igAccountId}/media`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...(isVideo ? { media_type: 'REELS', video_url: publicUrl } : { image_url: publicUrl }),
        caption,
        access_token: token,
      }),
    });

    if (!createRes.ok) {
      const err = await createRes.text();
      return { success: false, error: `Instagram create media failed: ${err}` };
    }

    const { id: containerId } = (await createRes.json()) as IGIdResponse;

    // Videos are processed asynchronously — wait until the container is ready
    if (isVideo) {
      const ready = await this.waitForContainer(containerId, token);
      if (!ready.ok) {
        return { success: false, error: `Instagram video processing failed: ${ready.reason}` };
      }
    }

    // Step 2: Publish
    const publishRes = await fetch(`${GRAPH_URL}/${igAccountId}/media_publish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        creation_id: containerId,
        access_token: token,
      }),
    });

    if (!publishRes.ok) {
      const err = await publishRes.text();
      return { success: false, error: `Instagram publish failed: ${err}` };
    }

    const { id: postId } = (await publishRes.json()) as IGIdResponse;

    this.log('Post published', { postId });
    return {
      success: true,
      platformPostId: postId,
      url: await this.getPermalink(postId, token),
    };
  }

  private async waitForContainer(containerId: string, token: string): Promise<{ ok: boolean; reason?: string }> {
    const deadline = Date.now() + CONTAINER_MAX_WAIT_MS;
    while (Date.now() < deadline) {
      const res = await fetch(`${GRAPH_URL}/${containerId}?fields=status_code,status&access_token=${encodeURIComponent(token)}`);
      if (res.ok) {
        const data = (await res.json()) as IGContainerStatus;
        if (data.status_code === 'FINISHED') return { ok: true };
        if (data.status_code === 'ERROR' || data.status_code === 'EXPIRED') {
          return { ok: false, reason: data.status ?? data.status_code };
        }
      }
      await new Promise((resolve) => setTimeout(resolve, CONTAINER_POLL_INTERVAL_MS));
    }
    return { ok: false, reason: 'timed out waiting for media processing' };
  }

  private async getPermalink(mediaId: string, token: string): Promise<string | undefined> {
    try {
      const res = await fetch(`${GRAPH_URL}/${mediaId}?fields=permalink&access_token=${encodeURIComponent(token)}`);
      if (!res.ok) return undefined;
      const data = (await res.json()) as { permalink?: string };
      return data.permalink;
    } catch {
      return undefined;
    }
  }

  protected async doDelete(platformPostId: string, accountId: string): Promise<boolean> {
    const { token } = await this.getCredentialsForAccount(accountId);

    const res = await fetch(
      `${GRAPH_URL}/${platformPostId}?access_token=${encodeURIComponent(token)}`,
      { method: 'DELETE' },
    );

    return res.ok;
  }

  protected async doGetAnalytics(platformPostId: string, accountId: string): Promise<PostAnalyticsData> {
    const { token } = await this.getCredentialsForAccount(accountId);

    const res = await fetch(
      `${GRAPH_URL}/${platformPostId}/insights?metric=impressions,reach,likes,comments,shares&access_token=${encodeURIComponent(token)}`,
    );

    if (!res.ok) {
      return { likes: 0, comments: 0, shares: 0, impressions: 0, reach: 0, engagementRate: 0 };
    }

    const data = (await res.json()) as IGInsightsResponse;
    const metrics: Record<string, number> = {};

    for (const metric of data.data) {
      metrics[metric.name] = metric.values[0]?.value ?? 0;
    }

    const impressions = metrics['impressions'] ?? 0;
    const engagement = (metrics['likes'] ?? 0) + (metrics['comments'] ?? 0) + (metrics['shares'] ?? 0);

    return {
      likes: metrics['likes'] ?? 0,
      comments: metrics['comments'] ?? 0,
      shares: metrics['shares'] ?? 0,
      impressions,
      reach: metrics['reach'] ?? 0,
      engagementRate: impressions > 0 ? (engagement / impressions) * 100 : 0,
    };
  }
}
