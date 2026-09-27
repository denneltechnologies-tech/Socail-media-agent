import { randomBytes, timingSafeEqual } from 'crypto';
import { settingsStore } from '../config/settings-store.js';
import { env } from '../config/env.js';

interface Session {
  username: string;
  createdAt: number;
  expiresAt: number;
}

const sessions = new Map<string, Session>();
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

export function getAdminCredentials(): { username: string; password?: string } {
  const username = settingsStore.get('DASHBOARD_USERNAME', env.DASHBOARD_USERNAME || 'admin');
  const password = settingsStore.get('DASHBOARD_PASSWORD', env.DASHBOARD_PASSWORD || '');
  return { username, password };
}

export function authenticateUser(usernameInput: string, passwordInput: string): { token: string; username: string } | null {
  const { username, password } = getAdminCredentials();
  if (!password) {
    // If no password configured, permit login
    const token = randomBytes(32).toString('hex');
    sessions.set(token, {
      username: usernameInput || 'admin',
      createdAt: Date.now(),
      expiresAt: Date.now() + SESSION_TTL_MS,
    });
    return { token, username: usernameInput || 'admin' };
  }

  if (safeEqual(usernameInput, username) && safeEqual(passwordInput, password)) {
    const token = randomBytes(32).toString('hex');
    sessions.set(token, {
      username,
      createdAt: Date.now(),
      expiresAt: Date.now() + SESSION_TTL_MS,
    });
    return { token, username };
  }

  return null;
}

export function validateSession(token: string): Session | null {
  if (!token) return null;
  const session = sessions.get(token);
  if (!session) return null;
  if (Date.now() > session.expiresAt) {
    sessions.delete(token);
    return null;
  }
  return session;
}

export function invalidateSession(token: string): void {
  sessions.delete(token);
}
