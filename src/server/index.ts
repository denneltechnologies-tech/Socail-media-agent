import express from 'express';
import type { Server } from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import cookieParser from 'cookie-parser';
import { rateLimit } from 'express-rate-limit';
import { sql } from 'drizzle-orm';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { db } from '../db/index.js';
import { engine } from '../core/engine.js';
import { PUBLIC_DIR } from '../core/media.js';
import { dashboardRouter } from './routes/dashboard.js';
import { accountsRouter } from './routes/accounts.js';
import { postsRouter } from './routes/posts.js';
import { projectsRouter } from './routes/projects.js';
import { twitterAuthRouter } from './routes/twitter-auth.js';
import { instagramAuthRouter } from './routes/instagram-auth.js';
import { authRouter } from './routes/auth.js';
import { settingsRouter } from './routes/settings.js';
import { historyRouter } from './routes/history.js';
import { appAuth, errorHandler } from './middleware.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createServer(): express.Express {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback');

  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    next();
  });

  // Health check stays public so Docker / load balancers can probe it
  app.get('/api/health', async (_req, res) => {
    try {
      await db.execute(sql`SELECT 1`);
      res.json({ status: 'ok', engine: engine.isRunning() ? 'running' : 'stopped' });
    } catch {
      res.status(503).json({ status: 'error', database: 'unreachable' });
    }
  });

  app.use(cookieParser());
  app.use(express.json({ limit: '1mb' }));

  // Strict Brute-Force Rate Limiter for Login
  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    limit: 10, // Max 10 login attempts per window
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: 'Too many login attempts. Please wait 15 minutes before trying again.' },
  });
  app.use('/api/auth/login', loginLimiter);

  // General API Rate Limiter
  const apiLimiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 minute
    limit: 300,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    skip: (req) => req.path === '/api/health' || req.path.startsWith('/public/'),
  });
  app.use('/api', apiLimiter);

  app.use(appAuth({
    publicPaths: [
      '/api/health',
      '/api/auth/login',
      '/api/auth/me',
      '/api/twitter/callback',
      '/api/instagram/callback',
    ],
  }));

  app.use(express.static(path.join(__dirname, 'views')));
  app.use('/public', express.static(PUBLIC_DIR));

  app.use('/api/auth', authRouter);
  app.use('/api/settings', settingsRouter);
  app.use('/api/history', historyRouter);
  app.use('/api/projects', projectsRouter);
  app.use('/api/dashboard', dashboardRouter);
  app.use('/api/accounts', accountsRouter);
  app.use('/api/posts', postsRouter);
  app.use('/api/twitter', twitterAuthRouter);
  app.use('/api/instagram', instagramAuthRouter);

  app.get('/', (_req, res) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.sendFile(path.join(__dirname, 'views', 'index.html'));
  });

  app.use('/api', (req, res) => {
    logger.warn(`API route not found: ${req.method} ${req.originalUrl}`);
    res.status(404).json({ error: 'Not found' });
  });

  app.use(errorHandler);

  return app;
}

export function startServer(): Server {
  if (env.NODE_ENV === 'production' && !env.DASHBOARD_PASSWORD) {
    const errorMsg = 'FATAL SECURITY CONFIGURATION: DASHBOARD_PASSWORD must be configured in production environment to prevent unauthorized access.';
    logger.error(errorMsg);
    throw new Error(errorMsg);
  } else if (!env.DASHBOARD_PASSWORD) {
    logger.info('DASHBOARD_PASSWORD is not set — running in development mode without authentication.');
  }

  const app = createServer();
  return app.listen(env.PORT, '0.0.0.0', () => {
    logger.info(`Web UI running on http://0.0.0.0:${env.PORT}`);
  });
}
