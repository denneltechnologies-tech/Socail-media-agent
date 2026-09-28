import { Router } from 'express';
import { eq } from 'drizzle-orm';
import { env } from '../../config/env.js';
import { settingsStore } from '../../config/settings-store.js';
import { db, schema } from '../../db/index.js';
import { logger } from '../../config/logger.js';
import { engine } from '../../core/engine.js';
import { Platform, AccountRole, Tone, ContentType } from '../../config/constants.js';
import { isUuid } from '../middleware.js';

export const instagramAuthRouter = Router();

const GRAPH_URL = 'https://graph.facebook.com/v21.0';
const PENDING_TTL_MS = 10 * 60 * 1000;

interface PendingState {
  accountId?: string;
  projectId?: string;
  expiresAt: number;
}

const pendingStates = new Map<string, PendingState>();

function prunePending(): void {
  const now = Date.now();
  for (const [state, entry] of pendingStates) {
    if (entry.expiresAt < now) pendingStates.delete(state);
  }
}

function getCallbackUrl(req: import('express').Request): string {
  const custom = settingsStore.get('INSTAGRAM_CALLBACK_URL') || env.INSTAGRAM_CALLBACK_URL;
  if (custom) return custom;
  const protocol = req.headers['x-forwarded-proto'] || req.protocol;
  const host = req.headers['x-forwarded-host'] || req.get('host');
  return `${protocol}://${host}/api/instagram/callback`;
}

instagramAuthRouter.get('/auth', async (req, res) => {
  try {
    const { accountId, projectId } = req.query as { accountId?: string; projectId?: string };

    const appId = settingsStore.get('FACEBOOK_APP_ID') || env.FACEBOOK_APP_ID;
    const appSecret = settingsStore.get('FACEBOOK_APP_SECRET') || env.FACEBOOK_APP_SECRET;

    if (!appId || !appSecret) {
      res.status(400).send(closePopupHtml(
        false,
        'Meta App ID and Secret are not configured. Please add them in the Settings tab under "Instagram & Meta App Setup".',
      ));
      return;
    }

    if (accountId && !isUuid(accountId)) {
      res.status(400).send(closePopupHtml(false, 'Invalid accountId'));
      return;
    }

    if (projectId && !isUuid(projectId)) {
      res.status(400).send(closePopupHtml(false, 'Invalid projectId'));
      return;
    }

    prunePending();
    const state = crypto.randomUUID();
    pendingStates.set(state, {
      accountId: accountId || undefined,
      projectId: projectId || undefined,
      expiresAt: Date.now() + PENDING_TTL_MS,
    });

    const callbackUrl = getCallbackUrl(req);
    const authUrl = new URL('https://www.facebook.com/v21.0/dialog/oauth');
    authUrl.searchParams.set('client_id', appId);
    authUrl.searchParams.set('redirect_uri', callbackUrl);
    authUrl.searchParams.set('state', state);
    authUrl.searchParams.set('scope', 'instagram_basic,instagram_content_publish,pages_show_list,pages_read_engagement,business_management');
    authUrl.searchParams.set('response_type', 'code');

    res.redirect(authUrl.toString());
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('Instagram OAuth start failed', { error: msg });
    res.status(500).send(closePopupHtml(false, `Failed to start Instagram authorization: ${msg}`));
  }
});

instagramAuthRouter.get('/callback', async (req, res) => {
  try {
    const { code, state, error, error_description } = req.query as {
      code?: string;
      state?: string;
      error?: string;
      error_description?: string;
    };

    if (error) {
      res.send(closePopupHtml(false, error_description || error));
      return;
    }

    if (!state || !pendingStates.has(state)) {
      res.status(400).send(closePopupHtml(false, 'Invalid or expired authorization session. Please try again.'));
      return;
    }

    const pending = pendingStates.get(state)!;
    pendingStates.delete(state);

    if (!code) {
      res.status(400).send(closePopupHtml(false, 'No authorization code returned from Meta'));
      return;
    }

    const appId = settingsStore.get('FACEBOOK_APP_ID') || env.FACEBOOK_APP_ID;
    const appSecret = settingsStore.get('FACEBOOK_APP_SECRET') || env.FACEBOOK_APP_SECRET;
    const callbackUrl = getCallbackUrl(req);

    // 1. Exchange authorization code for short-lived user token
    const tokenUrl = new URL(`${GRAPH_URL}/oauth/access_token`);
    tokenUrl.searchParams.set('client_id', appId!);
    tokenUrl.searchParams.set('client_secret', appSecret!);
    tokenUrl.searchParams.set('redirect_uri', callbackUrl);
    tokenUrl.searchParams.set('code', code);

    const tokenRes = await fetch(tokenUrl.toString());
    if (!tokenRes.ok) {
      const err = await tokenRes.text();
      logger.error('Meta token exchange failed', { error: err });
      res.status(500).send(closePopupHtml(false, `Token exchange failed: ${err}`));
      return;
    }

    const tokenData = (await tokenRes.json()) as { access_token: string };
    const shortLivedToken = tokenData.access_token;

    // 2. Exchange short-lived token for long-lived user token (60 days)
    const longLivedUrl = new URL(`${GRAPH_URL}/oauth/access_token`);
    longLivedUrl.searchParams.set('grant_type', 'fb_exchange_token');
    longLivedUrl.searchParams.set('client_id', appId!);
    longLivedUrl.searchParams.set('client_secret', appSecret!);
    longLivedUrl.searchParams.set('fb_exchange_token', shortLivedToken);

    const longLivedRes = await fetch(longLivedUrl.toString());
    const longLivedData = (await longLivedRes.json()) as { access_token?: string };
    const userAccessToken = longLivedData.access_token || shortLivedToken;

    // 3. Query managed Facebook Pages and connected Instagram Business accounts
    const accountsUrl = `${GRAPH_URL}/me/accounts?fields=id,name,access_token,instagram_business_account{id,username,name,profile_picture_url}&access_token=${encodeURIComponent(userAccessToken)}`;
    const pagesRes = await fetch(accountsUrl);

    if (!pagesRes.ok) {
      const err = await pagesRes.text();
      res.status(500).send(closePopupHtml(false, `Failed to retrieve Facebook Pages: ${err}`));
      return;
    }

    const pagesData = (await pagesRes.json()) as {
      data?: Array<{
        id: string;
        name: string;
        access_token: string;
        instagram_business_account?: {
          id: string;
          username: string;
          name?: string;
        };
      }>;
    };

    const pages = pagesData.data || [];
    const connectedPage = pages.find((p) => Boolean(p.instagram_business_account));

    if (!connectedPage || !connectedPage.instagram_business_account) {
      res.status(400).send(closePopupHtml(
        false,
        'Facebook login was successful, but no Instagram Business or Creator Account was found linked to your Facebook Pages. Please link your Instagram account to a Facebook Page in Meta Business Suite.',
      ));
      return;
    }

    const ig = connectedPage.instagram_business_account;
    const finalToken = connectedPage.access_token || userAccessToken;

    const credentials: Record<string, string> = {
      accessToken: finalToken,
      businessAccountId: ig.id,
      pageId: connectedPage.id,
      pageName: connectedPage.name,
    };

    let targetAccountId = pending.accountId;

    if (targetAccountId) {
      // Update existing account
      await db
        .update(schema.accounts)
        .set({
          username: ig.username,
          credentials,
        })
        .where(eq(schema.accounts.id, targetAccountId));

      engine.invalidateAccount(targetAccountId);
    } else if (pending.projectId) {
      // Create new account for project
      const projectId = pending.projectId;
      const accountValues: typeof schema.accounts.$inferInsert = {
        projectId,
        platform: Platform.INSTAGRAM,
        role: AccountRole.PRIMARY,
        username: ig.username,
        credentials,
        active: true,
        strategy: {
          tone: Tone.FRIENDLY,
          active: true,
          cronExpression: '0 */4 * * *',
          promptTemplate: 'Engaging Instagram content sharing updates and highlights.',
          contentTypes: [ContentType.IMAGE, ContentType.REEL],
          contentMix: { original: 80, repost: 15, reply: 5 },
        },
      };

      const [newAcc] = await db
        .insert(schema.accounts)
        .values(accountValues)
        .returning();

      if (newAcc) {
        targetAccountId = newAcc.id;
        engine.invalidateAccount(newAcc.id);
      }
    }

    // Save as global system settings if not already set
    if (!settingsStore.get('INSTAGRAM_ACCESS_TOKEN')) {
      await settingsStore.set('INSTAGRAM_ACCESS_TOKEN', finalToken);
    }
    if (!settingsStore.get('INSTAGRAM_BUSINESS_ACCOUNT_ID')) {
      await settingsStore.set('INSTAGRAM_BUSINESS_ACCOUNT_ID', ig.id);
    }

    logger.info('Instagram OAuth successfully completed', { username: ig.username, id: ig.id });
    res.send(closePopupHtml(true, '', ig.username));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('Instagram OAuth callback error', { error: msg });
    res.status(500).send(closePopupHtml(false, `Authentication failed: ${msg}`));
  }
});

function scriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
}

function closePopupHtml(success: boolean, error?: string, screenName?: string): string {
  const message = scriptJson({
    type: 'social-oauth',
    platform: 'instagram',
    success,
    username: screenName ?? '',
    screenName: screenName ?? '',
    error: error ?? '',
  });

  const fallbackText = scriptJson(
    success ? `Instagram @${screenName ?? ''} connected successfully! You can close this window.` : (error || 'Something went wrong'),
  );

  return `<!DOCTYPE html><html><head><title>Instagram Connection</title><style>body{font-family:sans-serif;background:#0d1117;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center;padding:20px}h2{font-size:1.2rem;margin-bottom:8px}</style></head><body>
<div id="content">
  <h2>${success ? '✅ Instagram Connected!' : '❌ Connection Failed'}</h2>
  <p>${success ? `Connected as @${screenName ?? ''}. Closing window...` : (error || 'Something went wrong')}</p>
</div>
<script>
  if (window.opener) {
    window.opener.postMessage(${message}, window.location.origin);
    setTimeout(function() { window.close(); }, 1200);
  } else {
    document.getElementById('content').innerHTML = ${fallbackText};
  }
</script>
</body></html>`;
}
