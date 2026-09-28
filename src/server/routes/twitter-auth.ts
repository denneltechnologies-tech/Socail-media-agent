import { Router } from 'express';
import { TwitterApi } from 'twitter-api-v2';
import { eq } from 'drizzle-orm';
import { env } from '../../config/env.js';
import { settingsStore } from '../../config/settings-store.js';
import { db, schema } from '../../db/index.js';
import { logger } from '../../config/logger.js';
import { engine } from '../../core/engine.js';
import { Platform, AccountRole, Tone, ContentType } from '../../config/constants.js';
import { isUuid } from '../middleware.js';

export const twitterAuthRouter = Router();

const PENDING_TTL_MS = 10 * 60 * 1000;

interface PendingTwitterState {
  secret: string;
  accountId?: string;
  projectId?: string;
  expiresAt: number;
}

// Temporary store for OAuth request tokens
const pendingTokens = new Map<string, PendingTwitterState>();

function prunePending(): void {
  const now = Date.now();
  for (const [token, entry] of pendingTokens) {
    if (entry.expiresAt < now) pendingTokens.delete(token);
  }
}

function getCallbackUrl(req: import('express').Request): string {
  const custom = settingsStore.get('TWITTER_CALLBACK_URL') || env.TWITTER_CALLBACK_URL;
  if (custom) return custom;
  const protocol = req.headers['x-forwarded-proto'] || req.protocol;
  const host = req.headers['x-forwarded-host'] || req.get('host');
  return `${protocol}://${host}/api/twitter/callback`;
}

twitterAuthRouter.get('/auth', async (req, res) => {
  try {
    const { accountId, projectId } = req.query as { accountId?: string; projectId?: string };

    const apiKey = settingsStore.get('TWITTER_API_KEY') || env.TWITTER_API_KEY;
    const apiSecret = settingsStore.get('TWITTER_API_SECRET') || env.TWITTER_API_SECRET;

    if (!apiKey || !apiSecret) {
      res.status(400).send(closePopupHtml(false, 'Twitter API Key & Secret not configured in Settings or environment'));
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

    if (!accountId && !projectId) {
      res.status(400).send(closePopupHtml(false, 'Either accountId or projectId is required'));
      return;
    }

    if (accountId) {
      const [account] = await db
        .select({ id: schema.accounts.id })
        .from(schema.accounts)
        .where(eq(schema.accounts.id, accountId))
        .limit(1);

      if (!account) {
        res.status(404).send(closePopupHtml(false, 'Account not found'));
        return;
      }
    }

    const client = new TwitterApi({
      appKey: apiKey,
      appSecret: apiSecret,
    });

    const callbackUrl = getCallbackUrl(req);
    const { url, oauth_token, oauth_token_secret } = await client.generateAuthLink(
      callbackUrl,
      { linkMode: 'authorize' },
    );

    prunePending();
    pendingTokens.set(oauth_token, {
      secret: oauth_token_secret,
      accountId: accountId || undefined,
      projectId: projectId || undefined,
      expiresAt: Date.now() + PENDING_TTL_MS,
    });

    res.redirect(url);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('Twitter OAuth auth error', { error: msg });
    res.status(500).send(closePopupHtml(false, 'Failed to start OAuth flow: ' + msg));
  }
});

twitterAuthRouter.get('/callback', async (req, res) => {
  try {
    const { oauth_token, oauth_verifier } = req.query as {
      oauth_token?: string;
      oauth_verifier?: string;
    };

    if (!oauth_token || !oauth_verifier) {
      res.status(400).send(closePopupHtml(false, 'OAuth verification failed: missing parameters'));
      return;
    }

    const pending = pendingTokens.get(oauth_token);
    pendingTokens.delete(oauth_token);
    if (!pending || pending.expiresAt < Date.now()) {
      res.status(400).send(closePopupHtml(false, 'OAuth session expired, please try again'));
      return;
    }

    const apiKey = settingsStore.get('TWITTER_API_KEY') || env.TWITTER_API_KEY;
    const apiSecret = settingsStore.get('TWITTER_API_SECRET') || env.TWITTER_API_SECRET;

    if (!apiKey || !apiSecret) {
      res.status(500).send(closePopupHtml(false, 'Twitter API key/secret not configured'));
      return;
    }

    const client = new TwitterApi({
      appKey: apiKey,
      appSecret: apiSecret,
      accessToken: oauth_token,
      accessSecret: pending.secret,
    });

    const { accessToken, accessSecret, screenName } = await client.login(oauth_verifier);

    const credentials: Record<string, string> = {
      apiKey,
      apiSecret,
      accessToken,
      accessSecret,
    };

    if (pending.accountId) {
      await db
        .update(schema.accounts)
        .set({
          credentials,
          ...(screenName ? { username: screenName } : {}),
        })
        .where(eq(schema.accounts.id, pending.accountId));

      engine.invalidateAccount(pending.accountId);
    } else if (pending.projectId) {
      const projectId = pending.projectId;
      const accountValues: typeof schema.accounts.$inferInsert = {
        projectId,
        platform: Platform.TWITTER,
        role: AccountRole.PRIMARY,
        username: screenName || 'twitter_user',
        credentials,
        active: true,
        strategy: {
          tone: Tone.FRIENDLY,
          contentTypes: [ContentType.TEXT, ContentType.IMAGE],
          active: true,
          cronExpression: '0 */3 * * *',
          promptTemplate: 'Insightful thoughts, industry updates, and engaging commentary.',
          contentMix: { original: 70, repost: 20, reply: 10 },
        },
      };

      const [newAcc] = await db
        .insert(schema.accounts)
        .values(accountValues)
        .returning();

      if (newAcc) {
        engine.invalidateAccount(newAcc.id);
      }
    }

    logger.info('Twitter OAuth completed', { accountId: pending.accountId, screenName });

    res.send(closePopupHtml(true, '', screenName));
  } catch (err) {
    logger.error('Twitter OAuth callback error', { error: err instanceof Error ? err.message : String(err) });
    res.status(500).send(closePopupHtml(false, 'OAuth connection failed: ' + (err instanceof Error ? err.message : String(err))));
  }
});

/** JSON that is safe to embed inside a <script> tag */
function scriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
}

function closePopupHtml(success: boolean, error?: string, screenName?: string): string {
  const unifiedMsg = scriptJson({
    type: 'social-oauth',
    platform: 'twitter',
    success,
    username: screenName ?? '',
    screenName: screenName ?? '',
    error: error ?? '',
  });

  const legacyMsg = scriptJson({
    type: 'twitter-oauth',
    success,
    screenName: screenName ?? '',
    error: error ?? '',
  });

  const fallbackText = scriptJson(
    success ? `Twitter / X @${screenName ?? ''} connected successfully! You can close this window.` : (error || 'Something went wrong')
  );

  return `<!DOCTYPE html><html><head><title>Twitter OAuth</title><style>body{font-family:sans-serif;background:#0d1117;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center;padding:20px}h2{font-size:1.2rem;margin-bottom:8px}</style></head><body>
<div id="content">
  <h2>${success ? '✅ Twitter / X Connected!' : '❌ Connection Failed'}</h2>
  <p>${success ? `Connected as @${screenName ?? ''}. Closing window...` : (error || 'Something went wrong')}</p>
</div>
<script>
  if (window.opener) {
    window.opener.postMessage(${unifiedMsg}, window.location.origin);
    window.opener.postMessage(${legacyMsg}, window.location.origin);
    setTimeout(function() { window.close(); }, 1200);
  } else {
    document.getElementById('content').innerHTML = ${fallbackText};
  }
</script>
</body></html>`;
}
