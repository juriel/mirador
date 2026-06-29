import Fastify from 'fastify';
import cors from '@fastify/cors';
import crypto from 'node:crypto';
import { config } from './config';
import { TokenManager } from './auth/tokens';
import { createAuthMiddleware, RateLimiter } from './auth/middleware';
import { BrowserPool } from './browser/pool';
import { SessionManager } from './sessions/manager';
import { registerStatelessRoutes } from './routes/stateless';
import { registerSessionRoutes } from './routes/sessions';
import { AppError } from './types';

async function main(): Promise<void> {
  const tokenManager = new TokenManager(config.tokensFilePath);
  const rateLimiter = new RateLimiter();
  const pool = new BrowserPool(config.maxBrowserInstances);
  const sessionManager = new SessionManager(pool, config.sessionDefaultTimeoutMinutes);
  const authMiddleware = createAuthMiddleware(tokenManager, rateLimiter);

  const server = Fastify({
    logger: {
      level: config.logLevel,
      ...(config.nodeEnv !== 'production'
        ? { transport: { target: 'pino-pretty', options: { colorize: true } } }
        : {}),
    },
    genReqId: () => crypto.randomUUID().slice(0, 8),
    requestTimeout: 60000,
  });

  await server.register(cors, {
    origin: config.corsOrigin,
  });

  server.addHook('onSend', async (_request, reply, payload) => {
    reply.header('X-Request-Id', _request.id);
  });

  server.addHook('onResponse', async (request, reply) => {
    const token = (request as any).token;
    request.log.info({
      requestId: request.id,
      tokenId: token?.id || 'anonymous',
      method: request.method,
      path: request.url,
      statusCode: reply.statusCode,
      durationMs: reply.elapsedTime,
    });
  });

  server.setErrorHandler((error, request, reply) => {
    const requestId = request.id;

    if (error instanceof AppError) {
      return reply.status(error.statusCode).send({
        error: true,
        code: error.code,
        message: error.message,
        statusCode: error.statusCode,
        requestId,
      });
    }

    if ((error as any).validation) {
      return reply.status(400).send({
        error: true,
        code: 'INVALID_PARAMS',
        message: error.message,
        statusCode: 400,
        requestId,
      });
    }

    request.log.error({ err: error, requestId }, 'Unhandled error');
    return reply.status(500).send({
      error: true,
      code: 'INTERNAL_ERROR',
      message: 'Internal server error',
      statusCode: 500,
      requestId,
    });
  });

  // Health endpoint (no auth)
  server.get('/health', async (_request, _reply) => {
    return {
      status: 'ok',
      version: '1.0.0',
      uptime: Math.floor(process.uptime()),
      browserPool: pool.stats,
      activeSessions: sessionManager.activeCount,
    };
  });

  // Register routes
  registerStatelessRoutes(server, pool, authMiddleware);
  registerSessionRoutes(server, pool, sessionManager, authMiddleware);

  // Session cleanup interval
  const cleanupInterval = setInterval(() => {
    sessionManager.cleanup().catch(err => {
      server.log.error({ err }, 'Session cleanup failed');
    });
  }, 30000);

  // Graceful shutdown
  const shutdown = async (signal: string): Promise<void> => {
    server.log.info(`Received ${signal}, shutting down gracefully...`);
    clearInterval(cleanupInterval);

    server.log.info('Closing all sessions...');
    await sessionManager.destroyAll();

    server.log.info('Closing browser pool...');
    await pool.destroyAll();

    server.log.info('Closing server...');
    await server.close();

    server.log.info('Shutdown complete');
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  await server.listen({ port: config.port, host: '0.0.0.0' });
  console.info(`Mirador server listening on port ${config.port}`);
}

main().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
