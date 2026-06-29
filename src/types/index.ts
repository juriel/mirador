import type { Browser, BrowserContext, Page } from 'playwright';

export type ErrorCode =
  | 'AUTH_MISSING'
  | 'AUTH_INVALID'
  | 'AUTH_RATE_LIMITED'
  | 'AUTH_FORBIDDEN'
  | 'SESSION_NOT_FOUND'
  | 'SESSION_EXPIRED'
  | 'SESSION_LIMIT_EXCEEDED'
  | 'BROWSER_POOL_FULL'
  | 'NAVIGATION_TIMEOUT'
  | 'NAVIGATION_ERROR'
  | 'SELECTOR_NOT_FOUND'
  | 'INVALID_URL'
  | 'INVALID_PARAMS'
  | 'INTERNAL_ERROR';

export interface ApiError {
  error: true;
  code: ErrorCode;
  message: string;
  statusCode: number;
  requestId: string;
}

export class AppError extends Error {
  public code: ErrorCode;
  public statusCode: number;

  constructor(code: ErrorCode, message: string, statusCode: number) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

export interface RateLimit {
  requestsPerMinute: number;
  requestsPerHour: number;
}

export interface Token {
  id: string;
  name: string;
  secret: string;
  rateLimit: RateLimit;
  maxConcurrentSessions: number;
  permissions: string[];
}

export interface TokenFile {
  tokens: Token[];
}

export interface Viewport {
  width: number;
  height: number;
}

export type WaitUntil = 'load' | 'domcontentloaded' | 'networkidle' | 'commit';

export interface SessionRecord {
  sessionId: string;
  tokenId: string;
  page: Page;
  context: BrowserContext;
  browser: Browser;
  createdAt: Date;
  lastActivityAt: Date;
  expiresAt: Date;
  timeoutMinutes: number;
}

export interface NavigateBody {
  url: string;
  waitUntil?: string;
  timeout?: number;
}

export interface ClickBody {
  selector: string;
  selectorType?: string;
  waitAfter?: string | number;
  timeout?: number;
  position?: { x: number; y: number };
}

export interface FillBody {
  selector: string;
  value: string;
  clearFirst?: boolean;
  pressEnter?: boolean;
}

export interface ScrollBody {
  direction: string;
  pixels?: number;
  selector?: string;
  waitAfter?: number;
}

export interface WaitBody {
  type: string;
  value: string;
  timeout?: number;
  state?: string;
}

export interface SubmitBody {
  selector: string;
  waitAfter?: string | number;
  timeout?: number;
}
