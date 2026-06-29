import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { BrowserPool } from '../browser/pool';
import { SessionManager } from '../sessions/manager';
import { AppError, SessionRecord } from '../types';
import {
  navigatePage,
  removeHiddenElements,
  htmlToMarkdown,
  estimateTokens,
  extractMetadata,
  handleWaitAfter,
  getLocator,
} from '../browser/utils';

function validateBody<T>(schema: z.ZodSchema<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    const messages = result.error.issues
      .map(i => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    throw new AppError('INVALID_PARAMS', messages, 400);
  }
  return result.data;
}

function resolveSession(request: FastifyRequest, sessionManager: SessionManager): SessionRecord {
  const { sessionId } = request.params as { sessionId: string };
  const token = (request as any).token;

  const session = sessionManager.get(sessionId);
  if (!session) {
    throw new AppError('SESSION_NOT_FOUND', `Session ${sessionId} not found`, 404);
  }
  if (session.tokenId !== token.id) {
    throw new AppError('AUTH_FORBIDDEN', 'This session belongs to a different token', 403);
  }
  if (session.expiresAt <= new Date()) {
    throw new AppError('SESSION_EXPIRED', `Session ${sessionId} has expired`, 410);
  }

  sessionManager.updateActivity(sessionId);
  return session;
}

function validateQuery<T>(schema: z.ZodType<T, any, any>, query: unknown): T {
  const result = schema.safeParse(query);
  if (!result.success) {
    const messages = result.error.issues
      .map(i => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    throw new AppError('INVALID_PARAMS', messages, 400);
  }
  return result.data;
}

export function registerSessionRoutes(
  server: FastifyInstance,
  pool: BrowserPool,
  sessionManager: SessionManager,
  authMiddleware: any,
): void {
  // POST /api/v1/session/create
  const createSessionSchema = z.object({
    timeoutMinutes: z.number().positive().max(60).optional(),
    viewport: z.object({
      width: z.number().int().positive(),
      height: z.number().int().positive(),
    }).optional(),
    userAgent: z.string().optional(),
    extraHTTPHeaders: z.record(z.string()).optional(),
    locale: z.string().optional(),
  });

  server.post('/api/v1/session/create', {
    preHandler: [authMiddleware],
    config: { permission: 'session:create' },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const body = validateBody(createSessionSchema, request.body);
    const token = (request as any).token;

    const activeSessions = sessionManager.getSessionsByToken(token.id);
    if (activeSessions.length >= token.maxConcurrentSessions) {
      throw new AppError(
        'SESSION_LIMIT_EXCEEDED',
        `Maximum concurrent sessions (${token.maxConcurrentSessions}) exceeded`,
        429,
      );
    }

    const session = await sessionManager.create(token.id, body);
    return {
      sessionId: session.sessionId,
      createdAt: session.createdAt.toISOString(),
      expiresAt: session.expiresAt.toISOString(),
      timeoutMinutes: session.timeoutMinutes,
    };
  });

  // POST /api/v1/session/:sessionId/navigate
  const navigateSchema = z.object({
    url: z.string().url('Must be a valid URL'),
    waitUntil: z.enum(['load', 'domcontentloaded', 'networkidle', 'commit']).optional().default('networkidle'),
    timeout: z.number().int().positive().max(60000).optional().default(30000),
  });

  server.post('/api/v1/session/:sessionId/navigate', {
    preHandler: [authMiddleware],
    config: { permission: 'session:navigate' },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const body = validateBody(navigateSchema, request.body);
    const session = resolveSession(request, sessionManager);

    const nav = await navigatePage(session.page, body);
    return {
      sessionId: session.sessionId,
      url: body.url,
      finalUrl: nav.url,
      title: nav.title,
      statusCode: nav.statusCode,
    };
  });

  // POST /api/v1/session/:sessionId/click
  const clickSchema = z.object({
    selector: z.string().min(1),
    selectorType: z.enum(['css', 'xpath']).optional().default('css'),
    waitAfter: z.union([z.string(), z.number()]).optional(),
    timeout: z.number().int().positive().optional().default(10000),
    position: z.object({ x: z.number(), y: z.number() }).optional(),
  });

  server.post('/api/v1/session/:sessionId/click', {
    preHandler: [authMiddleware],
    config: { permission: 'session:click' },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const body = validateBody(clickSchema, request.body);
    const session = resolveSession(request, sessionManager);

    const previousUrl = session.page.url();
    const locator = getLocator(session.page, body.selector, body.selectorType);

    try {
      await locator.click({
        timeout: body.timeout,
        position: body.position,
      });
    } catch (err: any) {
      if (err.message?.includes('Timeout') || err.name === 'TimeoutError') {
        throw new AppError('SELECTOR_NOT_FOUND', `Click target "${body.selector}" not found or not clickable`, 404);
      }
      throw err;
    }

    await handleWaitAfter(session.page, body.waitAfter);

    const newUrl = session.page.url();
    return {
      sessionId: session.sessionId,
      clicked: true,
      newUrl,
      urlChanged: newUrl !== previousUrl,
    };
  });

  // POST /api/v1/session/:sessionId/fill
  const fillSchema = z.object({
    selector: z.string().min(1),
    value: z.string(),
    clearFirst: z.boolean().optional().default(true),
    pressEnter: z.boolean().optional().default(false),
  });

  server.post('/api/v1/session/:sessionId/fill', {
    preHandler: [authMiddleware],
    config: { permission: 'session:fill' },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const body = validateBody(fillSchema, request.body);
    const session = resolveSession(request, sessionManager);

    const locator = getLocator(session.page, body.selector);

    try {
      if (body.clearFirst) {
        await locator.fill(body.value);
      } else {
        await locator.click();
        await locator.fill(body.value);
      }

      if (body.pressEnter) {
        await locator.press('Enter');
      }
    } catch (err: any) {
      throw new AppError('SELECTOR_NOT_FOUND', `Fill target "${body.selector}" not found`, 404);
    }

    return {
      sessionId: session.sessionId,
      filled: true,
      selector: body.selector,
    };
  });

  // POST /api/v1/session/:sessionId/scroll
  const scrollSchema = z.object({
    direction: z.enum(['top', 'bottom', 'pixels', 'selector']),
    pixels: z.number().int().optional(),
    selector: z.string().optional(),
    waitAfter: z.number().optional(),
  });

  server.post('/api/v1/session/:sessionId/scroll', {
    preHandler: [authMiddleware],
    config: { permission: 'session:scroll' },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const body = validateBody(scrollSchema, request.body);
    const session = resolveSession(request, sessionManager);

    let currentScrollY = 0;

    switch (body.direction) {
      case 'top':
        currentScrollY = await session.page.evaluate(() => {
          window.scrollTo(0, 0);
          return window.scrollY;
        });
        break;
      case 'bottom':
        currentScrollY = await session.page.evaluate(() => {
          window.scrollTo(0, document.body.scrollHeight);
          return window.scrollY;
        });
        break;
      case 'pixels':
        if (body.pixels === undefined) {
          throw new AppError('INVALID_PARAMS', 'pixels is required when direction is "pixels"', 400);
        }
        currentScrollY = await session.page.evaluate((y: number) => {
          window.scrollTo(0, y);
          return window.scrollY;
        }, body.pixels);
        break;
      case 'selector':
        if (!body.selector) {
          throw new AppError('INVALID_PARAMS', 'selector is required when direction is "selector"', 400);
        }
        await getLocator(session.page, body.selector).scrollIntoViewIfNeeded();
        currentScrollY = await session.page.evaluate(() => window.scrollY);
        break;
    }

    if (body.waitAfter && body.waitAfter > 0) {
      await session.page.waitForTimeout(body.waitAfter);
    }

    return {
      sessionId: session.sessionId,
      scrolled: true,
      currentScrollY,
    };
  });

  // POST /api/v1/session/:sessionId/wait
  const waitSchema = z.object({
    type: z.enum(['selector', 'timeout', 'networkidle', 'navigation']),
    value: z.string().optional().default(''),
    timeout: z.number().int().positive().optional().default(15000),
    state: z.enum(['attached', 'visible', 'hidden', 'detached']).optional().default('visible'),
  });

  server.post('/api/v1/session/:sessionId/wait', {
    preHandler: [authMiddleware],
    config: { permission: 'session:wait' },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const body = validateBody(waitSchema, request.body);
    const session = resolveSession(request, sessionManager);

    const start = Date.now();

    switch (body.type) {
      case 'selector':
        await session.page.waitForSelector(body.value!, {
          state: body.state as any,
          timeout: body.timeout,
        });
        break;
      case 'timeout':
        const ms = parseInt(body.value!, 10);
        if (isNaN(ms) || ms <= 0) {
          throw new AppError('INVALID_PARAMS', 'value must be a positive number for timeout wait type', 400);
        }
        await session.page.waitForTimeout(ms);
        break;
      case 'networkidle':
        await session.page.waitForLoadState('networkidle', { timeout: body.timeout });
        break;
      case 'navigation':
        await session.page.waitForURL('**', { timeout: body.timeout });
        break;
    }

    const elapsedMs = Date.now() - start;
    return {
      sessionId: session.sessionId,
      waited: true,
      type: body.type,
      elapsedMs,
    };
  });

  // POST /api/v1/session/:sessionId/submit
  const submitSchema = z.object({
    selector: z.string().min(1),
    waitAfter: z.union([z.string(), z.number()]).optional(),
    timeout: z.number().int().positive().optional().default(15000),
  });

  server.post('/api/v1/session/:sessionId/submit', {
    preHandler: [authMiddleware],
    config: { permission: 'session:submit' },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const body = validateBody(submitSchema, request.body);
    const session = resolveSession(request, sessionManager);

    const previousUrl = session.page.url();
    const locator = getLocator(session.page, body.selector);

    try {
      await locator.evaluate((el: HTMLFormElement) => {
        if (el.tagName === 'FORM') {
          el.submit();
        }
      });
    } catch (err: any) {
      throw new AppError('SELECTOR_NOT_FOUND', `Submit target "${body.selector}" not found`, 404);
    }

    if (body.waitAfter) {
      await handleWaitAfter(session.page, body.waitAfter);
    }

    const newUrl = session.page.url();
    return {
      sessionId: session.sessionId,
      submitted: true,
      newUrl,
      urlChanged: newUrl !== previousUrl,
    };
  });

  // GET /api/v1/session/:sessionId/html
  server.get('/api/v1/session/:sessionId/html', {
    preHandler: [authMiddleware],
    config: { permission: 'session:html' },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const session = resolveSession(request, sessionManager);

    await removeHiddenElements(session.page);
    const html = await session.page.content();
    const title = await session.page.title();

    return {
      sessionId: session.sessionId,
      url: session.page.url(),
      html,
      title,
      statusCode: 200,
    };
  });

  // GET /api/v1/session/:sessionId/markdown
  server.get('/api/v1/session/:sessionId/markdown', {
    preHandler: [authMiddleware],
    config: { permission: 'session:markdown' },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const session = resolveSession(request, sessionManager);

    await removeHiddenElements(session.page);
    const html = await session.page.content();
    const title = await session.page.title();
    const markdown = htmlToMarkdown(html);

    return {
      sessionId: session.sessionId,
      url: session.page.url(),
      markdown,
      title,
      tokenEstimate: estimateTokens(markdown),
    };
  });

  // GET /api/v1/session/:sessionId/screenshot
  const screenshotQuerySchema = z.object({
    format: z.enum(['png', 'jpeg']).optional().default('png'),
    fullPage: z.string().optional().default('true').transform(v => v === 'true'),
    selector: z.string().optional(),
  });

  server.get('/api/v1/session/:sessionId/screenshot', {
    preHandler: [authMiddleware],
    config: { permission: 'session:screenshot' },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const query = validateQuery(screenshotQuerySchema, request.query);
    const session = resolveSession(request, sessionManager);

    let buffer: Buffer;
    if (query.selector) {
      const element = getLocator(session.page, query.selector);
      buffer = await element.screenshot({ type: query.format as any });
    } else {
      buffer = await session.page.screenshot({
        fullPage: query.fullPage,
        type: query.format as any,
      });
    }

    reply.type(`image/${query.format}`).send(buffer);
    return reply;
  });

  // GET /api/v1/session/:sessionId/extract
  const extractQuerySchema = z.object({
    selector: z.string().min(1),
    selectorType: z.enum(['css', 'xpath']).optional().default('css'),
    multiple: z.string().optional().default('true').transform(v => v === 'true'),
  });

  server.get('/api/v1/session/:sessionId/extract', {
    preHandler: [authMiddleware],
    config: { permission: 'session:extract' },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const query = validateQuery(extractQuerySchema, request.query);
    const session = resolveSession(request, sessionManager);

    const locator = getLocator(session.page, query.selector, query.selectorType);
    const count = await locator.count();

    if (count === 0) {
      throw new AppError('SELECTOR_NOT_FOUND', `Selector "${query.selector}" not found on page`, 404);
    }

    const results: any[] = [];
    if (query.multiple) {
      for (let i = 0; i < count; i++) {
        const el = locator.nth(i);
        results.push({
          html: await el.innerHTML(),
          text: await el.innerText(),
          attributes: await el.evaluate((el: Element) => {
            const attrs: Record<string, string> = {};
            for (const attr of Array.from(el.attributes)) {
              attrs[attr.name] = attr.value;
            }
            return attrs;
          }),
        });
      }
    } else {
      const el = locator.first();
      results.push({
        html: await el.innerHTML(),
        text: await el.innerText(),
        attributes: await el.evaluate((el: Element) => {
          const attrs: Record<string, string> = {};
          for (const attr of Array.from(el.attributes)) {
            attrs[attr.name] = attr.value;
          }
          return attrs;
        }),
      });
    }

    return {
      sessionId: session.sessionId,
      selector: query.selector,
      count: results.length,
      results,
    };
  });

  // GET /api/v1/session/:sessionId/table
  const tableQuerySchema = z.object({
    selector: z.string().optional(),
    format: z.enum(['json', 'csv']).optional().default('json'),
  });

  server.get('/api/v1/session/:sessionId/table', {
    preHandler: [authMiddleware],
    config: { permission: 'session:table' },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const query = validateQuery(tableQuerySchema, request.query);
    const session = resolveSession(request, sessionManager);

    const tables: any[] = await session.page.evaluate((sel: string | null) => {
      const tableEls = sel
        ? document.querySelectorAll(sel)
        : document.querySelectorAll('table');
      return Array.from(tableEls).map((table, index) => {
        const headers = Array.from(table.querySelectorAll('th')).map(th => th.textContent?.trim() || '');
        const rows = Array.from(table.querySelectorAll('tr')).map(tr =>
          Array.from(tr.querySelectorAll('td')).map(td => td.textContent?.trim() || ''),
        ).filter(row => row.length > 0);
        return { index, headers, rows };
      });
    }, query.selector || null);

    if (query.format === 'csv') {
      const csvRows: string[] = [];
      const escapeCsv = (s: string) => `"${s.replace(/"/g, '""')}"`;
      for (const table of tables) {
        if (table.headers.length > 0) {
          csvRows.push(table.headers.map(escapeCsv).join(','));
        }
        for (const row of table.rows) {
          csvRows.push(row.map(escapeCsv).join(','));
        }
      }
      reply.type('text/csv').send(csvRows.join('\n'));
      return reply;
    }

    return {
      sessionId: session.sessionId,
      tablesFound: tables.length,
      tables,
    };
  });

  // GET /api/v1/session/:sessionId/metadata
  server.get('/api/v1/session/:sessionId/metadata', {
    preHandler: [authMiddleware],
    config: { permission: 'session:metadata' },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const session = resolveSession(request, sessionManager);

    const meta = await extractMetadata(session.page);
    return {
      sessionId: session.sessionId,
      url: session.page.url(),
      ...meta,
    };
  });

  // DELETE /api/v1/session/:sessionId
  server.delete('/api/v1/session/:sessionId', {
    preHandler: [authMiddleware],
    config: { permission: 'session:create' },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { sessionId } = request.params as { sessionId: string };
    const token = (request as any).token;

    const session = sessionManager.get(sessionId);
    if (!session) {
      throw new AppError('SESSION_NOT_FOUND', `Session ${sessionId} not found`, 404);
    }
    if (session.tokenId !== token.id) {
      throw new AppError('AUTH_FORBIDDEN', 'This session belongs to a different token', 403);
    }

    await sessionManager.destroy(sessionId);
    reply.status(204).send();
    return reply;
  });
}
