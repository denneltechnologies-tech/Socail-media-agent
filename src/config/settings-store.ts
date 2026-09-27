import { eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { env } from './env.js';
import { logger } from './logger.js';

class SettingsStore {
  private cache = new Map<string, string>();
  private initialized = false;

  async init(): Promise<void> {
    try {
      const rows = await db.select().from(schema.systemSettings);
      for (const row of rows) {
        this.cache.set(row.key, row.value);
      }
      this.initialized = true;
      logger.info(`Loaded ${rows.length} settings from database store`);
    } catch (err) {
      logger.warn('Could not load system_settings from database, falling back to env', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  get(key: string, defaultValue?: string): string {
    if (this.cache.has(key)) {
      return this.cache.get(key)!;
    }
    // Fall back to process.env or env config
    const envVal = process.env[key] ?? (env as unknown as Record<string, unknown>)[key];
    if (envVal !== undefined && envVal !== null) {
      return String(envVal);
    }
    return defaultValue ?? '';
  }

  async set(key: string, value: string): Promise<void> {
    this.cache.set(key, value);
    try {
      await db
        .insert(schema.systemSettings)
        .values({ key, value, updatedAt: new Date() })
        .onConflictDoUpdate({
          target: schema.systemSettings.key,
          set: { value, updatedAt: new Date() },
        });
    } catch (err) {
      logger.error(`Failed to persist setting ${key} to database`, {
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  async setMany(entries: Record<string, string>): Promise<void> {
    for (const [key, value] of Object.entries(entries)) {
      await this.set(key, value);
    }
  }

  getAll(): Record<string, string> {
    const keys = [
      'GEMINI_API_KEY',
      'GEMINI_MODEL',
      'GEMINI_IMAGE_MODEL',
      'PEXELS_API_KEY',
      'WHATSAPP_ADMIN_NUMBER',
      'TWITTER_API_KEY',
      'TWITTER_API_SECRET',
      'TWITTER_ACCESS_TOKEN',
      'TWITTER_ACCESS_SECRET',
      'TWITTER_CALLBACK_URL',
      'INSTAGRAM_ACCESS_TOKEN',
      'INSTAGRAM_BUSINESS_ACCOUNT_ID',
      'YOUTUBE_CLIENT_ID',
      'YOUTUBE_CLIENT_SECRET',
      'YOUTUBE_REFRESH_TOKEN',
      'TIKTOK_ACCESS_TOKEN',
      'PUBLIC_BASE_URL',
      'QUALITY_CHECK_ENABLED',
      'QUALITY_MIN_SCORE',
      'DASHBOARD_USERNAME',
      'DASHBOARD_PASSWORD',
    ];

    const result: Record<string, string> = {};
    for (const key of keys) {
      result[key] = this.get(key);
    }
    return result;
  }
}

export const settingsStore = new SettingsStore();
