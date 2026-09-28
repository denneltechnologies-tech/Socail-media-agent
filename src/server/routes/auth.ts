import { Router } from 'express';
import { authenticateUser, invalidateSession, getAdminCredentials } from '../auth.js';
import type { AuthenticatedRequest } from '../middleware.js';

export const authRouter = Router();

authRouter.post('/login', (req, res) => {
  const { username, password } = req.body ?? {};
  if (!username || typeof username !== 'string') {
    res.status(400).json({ error: 'Username is required' });
    return;
  }

  const result = authenticateUser(username.trim(), typeof password === 'string' ? password : '');
  if (!result) {
    res.status(401).json({ error: 'Invalid username or password' });
    return;
  }

  // Set HTTP-only session cookie (30 days)
  res.cookie('session_token', result.token, {
    httpOnly: true,
    secure: req.secure || req.headers['x-forwarded-proto'] === 'https',
    sameSite: 'lax',
    maxAge: 30 * 24 * 60 * 60 * 1000,
    path: '/',
  });

  res.json({
    success: true,
    token: result.token,
    user: { username: result.username },
  });
});

authRouter.post('/logout', (req, res) => {
  const cookieHeader = typeof req.headers.cookie === 'string' ? req.headers.cookie : '';
  const cookieMatch = cookieHeader.match(/(?:^|;\s*)session_token=([^;]+)/);
  const matchedCookie = cookieMatch?.[1] ? decodeURIComponent(cookieMatch[1]) : undefined;
  const token = req.headers.authorization?.replace(/^Bearer\s+/, '')
    ?? req.cookies?.['session_token']
    ?? matchedCookie;
  if (token) {
    invalidateSession(token);
  }
  res.clearCookie('session_token', { path: '/' });
  res.json({ success: true });
});

authRouter.get('/me', (req: AuthenticatedRequest, res) => {
  const { password } = getAdminCredentials();
  // If no password is set on the server, anyone is considered authenticated
  if (!password) {
    res.json({ authenticated: true, user: { username: 'admin' }, authRequired: false });
    return;
  }

  if (req.user) {
    res.json({ authenticated: true, user: req.user, authRequired: true });
    return;
  }

  res.json({ authenticated: false, authRequired: true });
});
