import { FastifyRequest, FastifyReply, preHandlerHookHandler } from 'fastify';
import { AppError, Token, RateLimit } from '../types';
import { TokenManager } from './tokens';

export class RateLimiter {
  private requests: Map<string, number[]> = new Map();

  check(tokenId: string, limits: RateLimit): boolean {
    const now = Date.now();
    let timestamps = this.requests.get(tokenId) || [];

    timestamps = timestamps.filter(t => now - t < 3600000);

    const lastMinute = timestamps.filter(t => now - t < 60000).length;
    const lastHour = timestamps.length;

    if (lastMinute >= limits.requestsPerMinute || lastHour >= limits.requestsPerHour) {
      return false;
    }

    timestamps.push(now);
    this.requests.set(tokenId, timestamps);
    return true;
  }

  getRetryAfter(tokenId: string): number {
    const timestamps = this.requests.get(tokenId) || [];
    const now = Date.now();
    const oldestInWindow = timestamps.filter(t => now - t < 60000);
    if (oldestInWindow.length === 0) return 60;
    const oldest = Math.min(...oldestInWindow);
    return Math.ceil((oldest + 60000 - now) / 1000);
  }
}

export function createAuthMiddleware(
  tokenManager: TokenManager,
  rateLimiter: RateLimiter,
): preHandlerHookHandler {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new AppError('AUTH_MISSING', 'Missing or invalid Authorization header', 401);
    }

    const secret = authHeader.slice(7);
    const token = tokenManager.findBySecret(secret);
    if (!token) {
      throw new AppError('AUTH_INVALID', 'Invalid authorization token', 401);
    }

    if (!rateLimiter.check(token.id, token.rateLimit)) {
      const retryAfter = rateLimiter.getRetryAfter(token.id);
      reply.header('Retry-After', String(retryAfter));
      throw new AppError('AUTH_RATE_LIMITED', 'Rate limit exceeded. Please wait before retrying.', 429);
    }

    const permission = (request as any).routeConfig?.permission as string | undefined;
    if (permission && !token.permissions.includes('full') && !token.permissions.includes(permission)) {
      throw new AppError('AUTH_FORBIDDEN', `Missing required permission: ${permission}`, 403);
    }

    (request as any).token = token;
  };
}
