import { Router } from 'express';
import { eq, inArray } from 'drizzle-orm';
import { db, schema } from '../../db/index.js';
import { engine } from '../../core/engine.js';
import { syncAccountCrons } from '../../core/account-scheduler.js';
import { logger } from '../../config/logger.js';
import type { AccountStrategy } from '../../types/index.js';
import { asyncHandler, isUuid, parseBody, requireUuidParam } from '../middleware.js';
import { createAccountSchema, updateAccountSchema } from '../schemas.js';

import { settingsStore } from '../../config/settings-store.js';
import { env } from '../../config/env.js';
import { Platform } from '../../config/constants.js';

export const accountsRouter = Router();

accountsRouter.param('id', (req, res, next) => requireUuidParam(req, res, next));

type AccountRow = typeof schema.accounts.$inferSelect;

function checkPlatformSystemCredentials(platform: string): boolean {
  switch (platform) {
    case 'instagram':
      return Boolean(
        (settingsStore.get('INSTAGRAM_ACCESS_TOKEN') || env.INSTAGRAM_ACCESS_TOKEN) &&
        (settingsStore.get('INSTAGRAM_BUSINESS_ACCOUNT_ID') || env.INSTAGRAM_BUSINESS_ACCOUNT_ID),
      );
    case 'twitter':
      return Boolean(
        (settingsStore.get('TWITTER_API_KEY') || env.TWITTER_API_KEY) &&
        (settingsStore.get('TWITTER_API_SECRET') || env.TWITTER_API_SECRET) &&
        (settingsStore.get('TWITTER_ACCESS_TOKEN') || env.TWITTER_ACCESS_TOKEN) &&
        (settingsStore.get('TWITTER_ACCESS_SECRET') || env.TWITTER_ACCESS_SECRET),
      );
    case 'youtube':
      return Boolean(
        (settingsStore.get('YOUTUBE_CLIENT_ID') || env.YOUTUBE_CLIENT_ID) &&
        (settingsStore.get('YOUTUBE_CLIENT_SECRET') || env.YOUTUBE_CLIENT_SECRET) &&
        (settingsStore.get('YOUTUBE_REFRESH_TOKEN') || env.YOUTUBE_REFRESH_TOKEN),
      );
    case 'tiktok':
      return Boolean(settingsStore.get('TIKTOK_ACCESS_TOKEN') || env.TIKTOK_ACCESS_TOKEN);
    default:
      return false;
  }
}

/** Never send stored credentials back to the browser — only status and whether they are active */
function sanitize({ credentials, ...rest }: AccountRow) {
  const creds = (credentials ?? {}) as Record<string, string>;
  const hasCustomCredentials = Object.values(creds).some((v) => typeof v === 'string' && v.trim().length > 0);
  const hasSystemCredentials = checkPlatformSystemCredentials(rest.platform);
  const hasEffectiveCredentials = hasCustomCredentials || hasSystemCredentials;
  const credentialSource = hasCustomCredentials ? 'account' : (hasSystemCredentials ? 'system' : 'none');

  return {
    ...rest,
    hasCredentials: hasCustomCredentials,
    hasEffectiveCredentials,
    credentialSource,
  };
}

/** Keeps cron jobs and cached API clients in step with account changes */
async function afterAccountChange(accountId: string): Promise<void> {
  engine.invalidateAccount(accountId);
  try {
    await syncAccountCrons();
  } catch (err) {
    logger.error('Failed to resync account crons', { error: err instanceof Error ? err.message : String(err) });
  }
}

accountsRouter.get('/', asyncHandler(async (req, res) => {
  const { projectId } = req.query as { projectId?: string };

  if (projectId !== undefined && !isUuid(projectId)) {
    res.status(400).json({ error: 'Invalid projectId' });
    return;
  }

  const accounts = await db
    .select()
    .from(schema.accounts)
    .where(projectId ? eq(schema.accounts.projectId, projectId) : undefined)
    .orderBy(schema.accounts.createdAt);

  res.json(accounts.map(sanitize));
}));

accountsRouter.post('/', asyncHandler(async (req, res) => {
  const body = parseBody(createAccountSchema, req, res);
  if (!body) return;

  const [project] = await db
    .select({ id: schema.projects.id })
    .from(schema.projects)
    .where(eq(schema.projects.id, body.projectId))
    .limit(1);

  if (!project) {
    res.status(400).json({ error: 'Project not found' });
    return;
  }

  const [account] = await db
    .insert(schema.accounts)
    .values({
      projectId: body.projectId,
      platform: body.platform,
      role: body.role ?? 'primary',
      username: body.username,
      credentials: body.credentials,
      active: body.active ?? true,
      ...(body.strategy ? { strategy: body.strategy as AccountStrategy } : {}),
    })
    .returning();

  await afterAccountChange(account!.id);
  res.status(201).json(sanitize(account!));
}));

const updateAccountHandler = asyncHandler(async (req, res) => {
  const id = req.params['id'] as string;
  const updates = parseBody(updateAccountSchema, req, res);
  if (!updates) return;

  const setValues: Record<string, unknown> = {
    ...(updates.projectId ? { projectId: updates.projectId } : {}),
    ...(updates.active !== undefined ? { active: updates.active } : {}),
    ...(updates.role ? { role: updates.role } : {}),
    ...(updates.username ? { username: updates.username } : {}),
    ...(updates.platform ? { platform: updates.platform } : {}),
    ...(updates.credentials ? { credentials: updates.credentials } : {}),
    ...(updates.strategy !== undefined ? { strategy: updates.strategy as AccountStrategy | null } : {}),
  };

  if (Object.keys(setValues).length === 0) {
    const [existing] = await db
      .select()
      .from(schema.accounts)
      .where(eq(schema.accounts.id, id))
      .limit(1);
    if (!existing) {
      res.status(404).json({ error: 'Account not found' });
      return;
    }
    res.json(sanitize(existing));
    return;
  }

  const [updated] = await db
    .update(schema.accounts)
    .set(setValues)
    .where(eq(schema.accounts.id, id))
    .returning();

  if (!updated) {
    res.status(404).json({ error: 'Account not found' });
    return;
  }

  await afterAccountChange(id);
  res.json(sanitize(updated));
});

accountsRouter.patch('/:id', updateAccountHandler);
accountsRouter.put('/:id', updateAccountHandler);

accountsRouter.delete('/:id', asyncHandler(async (req, res) => {
  const id = req.params['id'] as string;
  const force = req.query['force'] === 'true';

  const posts = await db
    .select({ id: schema.posts.id })
    .from(schema.posts)
    .where(eq(schema.posts.accountId, id));

  if (posts.length > 0 && !force) {
    res.status(409).json({
      error: `This account has ${posts.length} post(s). Delete with ?force=true to remove them as well.`,
      postCount: posts.length,
    });
    return;
  }

  const deleted = await db.transaction(async (tx) => {
    if (posts.length > 0) {
      const postIds = posts.map((p) => p.id);
      await tx.delete(schema.postAnalytics).where(inArray(schema.postAnalytics.postId, postIds));
      await tx.delete(schema.posts).where(inArray(schema.posts.id, postIds));
    }
    const [row] = await tx
      .delete(schema.accounts)
      .where(eq(schema.accounts.id, id))
      .returning({ id: schema.accounts.id });
    return row;
  });

  if (!deleted) {
    res.status(404).json({ error: 'Account not found' });
    return;
  }

  await afterAccountChange(id);
  res.json({ success: true });
}));

accountsRouter.post('/:id/test', asyncHandler(async (req, res) => {
  const id = req.params['id'] as string;
  const [account] = await db
    .select()
    .from(schema.accounts)
    .where(eq(schema.accounts.id, id))
    .limit(1);

  if (!account) {
    res.status(404).json({ success: false, error: 'Account not found' });
    return;
  }

  const adapter = engine.getAdapter(account.platform as Platform);
  if (!adapter) {
    res.status(400).json({ success: false, error: `No adapter registered for platform "${account.platform}"` });
    return;
  }

  if (typeof adapter.testConnection === 'function') {
    const result = await adapter.testConnection(account.id);
    res.json(result);
  } else {
    res.json({ success: true, message: `Adapter for ${account.platform} is registered` });
  }
}));

