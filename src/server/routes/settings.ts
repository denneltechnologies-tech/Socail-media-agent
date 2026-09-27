import { Router } from 'express';
import { GoogleGenAI } from '@google/genai';
import { settingsStore } from '../../config/settings-store.js';
import { env } from '../../config/env.js';
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

// Quick update specifically for Gemini AI API Key & Models
settingsRouter.post('/ai-key', asyncHandler(async (req, res) => {
  const apiKey = typeof req.body?.apiKey === 'string' ? req.body.apiKey.trim() : '';
  const model = typeof req.body?.model === 'string' ? req.body.model.trim() : '';
  const imageModel = typeof req.body?.imageModel === 'string' ? req.body.imageModel.trim() : '';

  if (!apiKey) {
    res.status(400).json({ success: false, error: 'Gemini API key cannot be empty' });
    return;
  }

  await settingsStore.set('GEMINI_API_KEY', apiKey);
  if (model) await settingsStore.set('GEMINI_MODEL', model);
  if (imageModel) await settingsStore.set('GEMINI_IMAGE_MODEL', imageModel);

  logger.info('Updated Gemini AI configuration via AI Key manager');
  res.json({ success: true, message: 'AI Key saved and activated successfully!' });
}));

// Test/Verify Gemini API Key connection
settingsRouter.post('/test-ai', asyncHandler(async (req, res) => {
  const customKey = typeof req.body?.apiKey === 'string' ? req.body.apiKey.trim() : '';
  const keyToTest = customKey || settingsStore.get('GEMINI_API_KEY') || env.GEMINI_API_KEY;
  const modelToTest = (typeof req.body?.model === 'string' && req.body.model.trim()) || settingsStore.get('GEMINI_MODEL') || 'gemini-2.5-flash';

  if (!keyToTest || keyToTest === 'REPLACE_WITH_YOUR_GEMINI_KEY') {
    res.status(400).json({ success: false, error: 'No Gemini API key provided or configured' });
    return;
  }

  const startTime = Date.now();
  try {
    const ai = new GoogleGenAI({ apiKey: keyToTest });
    const response = await ai.models.generateContent({
      model: modelToTest,
      contents: 'Respond with the single word: "READY"',
      config: { maxOutputTokens: 10 },
    });
    const latencyMs = Date.now() - startTime;
    res.json({
      success: true,
      message: 'Gemini AI API connection successful!',
      model: modelToTest,
      latencyMs,
      response: response.text?.trim() || 'READY',
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(400).json({
      success: false,
      error: `Gemini verification failed: ${message}`,
      latencyMs: Date.now() - startTime,
    });
  }
}));

