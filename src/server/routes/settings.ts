import { Router } from 'express';
import { settingsStore } from '../../config/settings-store.js';
import { logger } from '../../config/logger.js';
import { asyncHandler } from '../middleware.js';

export const settingsRouter = Router();

// Keys that are sensitive and should be masked on GET unless empty
const SENSITIVE_KEYS = new Set([
  'GEMINI_API_KEY',
  'PEXELS_API_KEY',
  'TWITTER_API_SECRET',
  'TWITTER_ACCESS_SECRET',
  'INSTAGRAM_ACCESS_TOKEN',
  'YOUTUBE_CLIENT_SECRET',
  'YOUTUBE_REFRESH_TOKEN',
  'TIKTOK_ACCESS_TOKEN',
  'DASHBOARD_PASSWORD',
]);

function maskValue(val: string): string {
  if (!val) return '';
  if (val.length <= 8) return '********';
  return `${val.slice(0, 4)}...${val.slice(-4)}`;
}

settingsRouter.get('/', asyncHandler(async (_req, res) => {
  const allSettings = settingsStore.getAll();
  const response: Record<string, { value: string; masked: string; isSet: boolean }> = {};

  for (const [key, rawValue] of Object.entries(allSettings)) {
    const isSet = Boolean(rawValue && rawValue !== 'REPLACE_WITH_YOUR_GEMINI_KEY');
    response[key] = {
      value: SENSITIVE_KEYS.has(key) ? '' : rawValue,
      masked: SENSITIVE_KEYS.has(key) && isSet ? maskValue(rawValue) : rawValue,
      isSet,
    };
  }

  res.json(response);
}));

settingsRouter.post('/', asyncHandler(async (req, res) => {
  const updates: Record<string, string> = req.body?.settings ?? req.body ?? {};
  if (typeof updates !== 'object' || updates === null) {
    res.status(400).json({ error: 'Expected settings object' });
    return;
  }

  const savedKeys: string[] = [];
  for (const [key, value] of Object.entries(updates)) {
    if (typeof value === 'string') {
      // Don't overwrite with empty string if user left masked input untouched
      if (value.trim() === '' && SENSITIVE_KEYS.has(key)) {
        continue;
      }
      await settingsStore.set(key, value.trim());
      savedKeys.push(key);
    }
  }

  logger.info(`Updated system settings: ${savedKeys.join(', ')}`);
  res.json({ success: true, updated: savedKeys });
}));
