import crypto from 'node:crypto';
import { Browser, BrowserContext, Page } from 'playwright';
import { AppError, SessionRecord, Viewport } from '../types';
import { BrowserPool } from '../browser/pool';

export interface CreateSessionOptions {
  timeoutMinutes?: number;
  viewport?: Viewport;
  userAgent?: string;
  extraHTTPHeaders?: Record<string, string>;
  locale?: string;
}

export class SessionManager {
  private sessions: Map<string, SessionRecord> = new Map();
  private pool: BrowserPool;
  private defaultTimeoutMinutes: number;

  constructor(pool: BrowserPool, defaultTimeoutMinutes: number) {
    this.pool = pool;
    this.defaultTimeoutMinutes = defaultTimeoutMinutes;
  }

  async create(tokenId: string, options: CreateSessionOptions): Promise<SessionRecord> {
    const timeoutMinutes = options.timeoutMinutes || this.defaultTimeoutMinutes;
    const browser = await this.pool.acquire();

    try {
      const context = await browser.newContext({
        viewport: options.viewport,
        userAgent: options.userAgent,
        extraHTTPHeaders: options.extraHTTPHeaders,
        locale: options.locale,
      });
      const page = await context.newPage();

      const sessionId = crypto.randomUUID().slice(0, 12).replace(/-/g, '');
      const now = new Date();

      const session: SessionRecord = {
        sessionId,
        tokenId,
        page,
        context,
        browser,
        createdAt: now,
        lastActivityAt: now,
        expiresAt: new Date(now.getTime() + timeoutMinutes * 60000),
        timeoutMinutes,
      };

      this.sessions.set(sessionId, session);
      return session;
    } catch (err) {
      this.pool.release(browser);
      throw err;
    }
  }

  get(sessionId: string): SessionRecord | undefined {
    return this.sessions.get(sessionId);
  }

  getSessionsByToken(tokenId: string): SessionRecord[] {
    const result: SessionRecord[] = [];
    for (const session of this.sessions.values()) {
      if (session.tokenId === tokenId) {
        result.push(session);
      }
    }
    return result;
  }

  updateActivity(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.lastActivityAt = new Date();
      session.expiresAt = new Date(Date.now() + session.timeoutMinutes * 60000);
    }
  }

  async destroy(sessionId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    try {
      await session.page.close().catch(() => {});
      await session.context.close().catch(() => {});
    } catch {}

    this.pool.release(session.browser);
    this.sessions.delete(sessionId);
    return true;
  }

  async cleanup(): Promise<void> {
    const now = new Date();
    const expired: string[] = [];
    for (const [id, session] of this.sessions) {
      if (session.expiresAt <= now) {
        expired.push(id);
      }
    }
    for (const id of expired) {
      await this.destroy(id);
    }
    if (expired.length > 0) {
      console.info(`Cleaned up ${expired.length} expired sessions`);
    }
  }

  async destroyAll(): Promise<void> {
    const ids = Array.from(this.sessions.keys());
    for (const id of ids) {
      await this.destroy(id);
    }
  }

  get activeCount(): number {
    return this.sessions.size;
  }
}
