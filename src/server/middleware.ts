import { timingSafeEqual } from 'crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { z, type ZodTypeAny } from 'zod';
import { logger } from '../config/logger.js';
import { errorMessage, isConnectionRefused } from '../core/errors.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

import { validateSession, getAdminCredentials } from './auth.js';

export interface AuthenticatedRequest extends Request {
  user?: { username: string };
}

/**
 * Authentication for the dashboard and API.
 * Supports:
 * - Session token (via Authorization: Bearer <token> or Cookie session_token)
 * - Basic Auth (for curl/CLI compatibility)
 * Does NOT emit WWW-Authenticate header by default, allowing in-page login instead of browser popups.
 */
export function appAuth(options: { publicPaths: string[] }): RequestHandler {
  const { publicPaths } = options;

  return (req: AuthenticatedRequest, res, next) => {
    const { username, password } = getAdminCredentials();

    // If no password is set, authentication is disabled
    if (!password) {
      req.user = { username: username || 'admin' };
      next();
      return;
    }

    // Public paths bypass auth
    if (publicPaths.some((p) => req.path === p || req.path.startsWith(`${p}/`))) {
      next();
      return;
    }

    // Check Bearer token or Cookie
    const authHeader = req.headers.authorization ?? '';
    if (authHeader.startsWith('Bearer ')) {
      const token = authHeader.slice(7).trim();
      const session = validateSession(token);
      if (session) {
        req.user = { username: session.username };
        next();
        return;
      }
    }

    // Check cookie
    const cookieHeader = req.headers.cookie ?? '';
    const cookieMatch = cookieHeader.match(/(?:^|;\s*)session_token=([^;]+)/);
    if (cookieMatch && cookieMatch[1]) {
      const session = validateSession(decodeURIComponent(cookieMatch[1]));
      if (session) {
        req.user = { username: session.username };
        next();
        return;
      }
    }

    // Check Basic auth for backward compatibility with curl
    if (authHeader.startsWith('Basic ')) {
      const encoded = authHeader.slice(6).trim();
      const decoded = Buffer.from(encoded, 'base64').toString('utf8');
      const sep = decoded.indexOf(':');
      if (sep >= 0 && safeEqual(decoded.slice(0, sep), username) && safeEqual(decoded.slice(sep + 1), password)) {
        req.user = { username };
        next();
        return;
      }
    }

    // If requesting the main page or static assets, allow page to load so Sign In UI can render
    if (!req.path.startsWith('/api')) {
      next();
      return;
    }

    // Unauthorized API request - NO WWW-Authenticate to avoid browser spoof/alert popup!
    res.status(401).json({ error: 'Authentication required' });
  };
}

export const basicAuth = appAuth;


/** Rejects requests whose `:id` route parameter is not a UUID (avoids leaking Postgres errors) */
export const requireUuidParam: RequestHandler = (req, res, next) => {
  if (req.params['id'] !== undefined && !isUuid(req.params['id'])) {
    res.status(400).json({ error: 'Invalid id' });
    return;
  }
  next();
};

/** Parses a request body with a zod schema, responding 400 with readable issues on failure */
export function parseBody<T extends ZodTypeAny>(schema: T, req: Request, res: Response): z.infer<T> | undefined {
  const result = schema.safeParse(req.body ?? {});
  if (!result.success) {
    res.status(400).json({
      error: 'Invalid request body',
      issues: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
    return undefined;
  }
  return result.data;
}

/** Wraps async route handlers so rejected promises reach the error handler */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  const status = (err as { status?: number; statusCode?: number })?.status
    ?? (err as { statusCode?: number })?.statusCode
    ?? 500;

  if (status >= 500) {
    logger.error(`${req.method} ${req.path} failed`, {
      error: errorMessage(err),
      ...(isConnectionRefused(err) ? {} : { stack: err instanceof Error ? err.stack : undefined }),
    });
  }

  if (res.headersSent) return;

  res.status(status).json({
    error: status >= 500 ? 'Internal server error' : (err instanceof Error ? err.message : 'Bad request'),
  });
}
