import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { BrowserPool } from '../browser/pool';
import { AppError } from '../types';
import {
  navigatePage,
  removeHiddenElements,
  htmlToMarkdown,
  estimateTokens,
  extractMetadata,
  getLocator,
} from '../browser/utils';

const waitUntilSchema = z.enum(['load', 'domcontentloaded', 'networkidle', 'commit']).optional().default('networkidle');
const viewportSchema = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
}).optional();

const browseBaseSchema = z.object({
  url: z.string().url('Must be a valid URL'),
  waitUntil: waitUntilSchema,
  timeout: z.number().int().positive().max(60000).optional().default(30000),
  viewport: viewportSchema,
  userAgent: z.string().optional(),
});

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

async function withPage<T>(
  pool: BrowserPool,
  options: { viewport?: { width: number; height: number }; userAgent?: string },
  fn: (page: any, url?: string) => Promise<T>,
): Promise<T> {
  const browser = await pool.acquire();
  let context: any = null;
  let page: any = null;
  try {
    if (options.viewport || options.userAgent) {
      context = await browser.newContext({
        viewport: options.viewport || undefined,
        userAgent: options.userAgent || undefined,
      });
      page = await context.newPage();
    } else {
      page = await browser.newPage();
    }
    return await fn(page, options.userAgent);
  } finally {
    if (page && context) {
      await context.close().catch(() => {});
    } else if (page) {
      await page.close().catch(() => {});
    }
    pool.release(browser);
  }
}

export function registerStatelessRoutes(
  server: FastifyInstance,
  pool: BrowserPool,
  authMiddleware: any,
): void {
  // POST /api/v1/browse/html
  server.post('/api/v1/browse/html', {
    preHandler: [authMiddleware],
    config: { permission: 'browse:html' },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const body = validateBody(browseBaseSchema, request.body);
    return withPage(pool, { viewport: body.viewport, userAgent: body.userAgent }, async (page) => {
      const nav = await navigatePage(page, body);
      await removeHiddenElements(page);
      const html = await page.content();
      return {
        url: nav.url,
        html,
        title: nav.title,
        statusCode: nav.statusCode,
        loadTimeMs: nav.loadTimeMs,
      };
    });
  });

  // POST /api/v1/browse/markdown
  server.post('/api/v1/browse/markdown', {
    preHandler: [authMiddleware],
    config: { permission: 'browse:markdown' },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const body = validateBody(browseBaseSchema, request.body);
    return withPage(pool, { viewport: body.viewport, userAgent: body.userAgent }, async (page) => {
      const nav = await navigatePage(page, body);
      await removeHiddenElements(page);
      const html = await page.content();
      const markdown = htmlToMarkdown(html);
      return {
        url: nav.url,
        markdown,
        title: nav.title,
        statusCode: nav.statusCode,
        loadTimeMs: nav.loadTimeMs,
        tokenEstimate: estimateTokens(markdown),
      };
    });
  });

  // POST /api/v1/browse/screenshot
  const screenshotSchema = browseBaseSchema.extend({
    format: z.enum(['png', 'jpeg']).optional().default('png'),
    quality: z.number().int().min(1).max(100).optional(),
    fullPage: z.boolean().optional().default(true),
    selector: z.string().optional(),
  });

  server.post('/api/v1/browse/screenshot', {
    preHandler: [authMiddleware],
    config: { permission: 'browse:screenshot' },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const body = validateBody(screenshotSchema, request.body);
    return withPage(pool, { viewport: body.viewport, userAgent: body.userAgent }, async (page) => {
      await navigatePage(page, body);

      let buffer: Buffer;
      if (body.selector) {
        const element = getLocator(page, body.selector);
        buffer = await element.screenshot({ type: body.format as any });
      } else {
        buffer = await page.screenshot({
          fullPage: body.fullPage,
          type: body.format as any,
          quality: body.format === 'jpeg' ? body.quality : undefined,
        });
      }

      reply.type(`image/${body.format}`).send(buffer);
      return reply;
    });
  });

  // POST /api/v1/browse/metadata
  server.post('/api/v1/browse/metadata', {
    preHandler: [authMiddleware],
    config: { permission: 'browse:metadata' },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const body = validateBody(browseBaseSchema, request.body);
    return withPage(pool, { viewport: body.viewport, userAgent: body.userAgent }, async (page) => {
      const nav = await navigatePage(page, body);
      const meta = await extractMetadata(page);
      return {
        url: body.url,
        finalUrl: nav.url,
        ...meta,
        statusCode: nav.statusCode,
        loadTimeMs: nav.loadTimeMs,
      };
    });
  });

  // POST /api/v1/browse/extract
  const extractSchema = browseBaseSchema.extend({
    selector: z.string().min(1),
    selectorType: z.enum(['css', 'xpath']).optional().default('css'),
    multiple: z.boolean().optional().default(true),
  });

  server.post('/api/v1/browse/extract', {
    preHandler: [authMiddleware],
    config: { permission: 'browse:extract' },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const body = validateBody(extractSchema, request.body);
    return withPage(pool, { viewport: body.viewport, userAgent: body.userAgent }, async (page) => {
      await navigatePage(page, body);

      const locator = getLocator(page, body.selector, body.selectorType);
      const count = await locator.count();

      if (count === 0) {
        throw new AppError('SELECTOR_NOT_FOUND', `Selector "${body.selector}" not found on page`, 404);
      }

      const results: any[] = [];
      if (body.multiple) {
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
        url: page.url(),
        selector: body.selector,
        count: results.length,
        results,
      };
    });
  });

  // POST /api/v1/browse/table
  const tableSchema = browseBaseSchema.extend({
    selector: z.string().optional(),
    format: z.enum(['json', 'csv']).optional().default('json'),
  });

  server.post('/api/v1/browse/table', {
    preHandler: [authMiddleware],
    config: { permission: 'browse:table' },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const body = validateBody(tableSchema, request.body);
    return withPage(pool, { viewport: body.viewport, userAgent: body.userAgent }, async (page) => {
      await navigatePage(page, body);

      const tables: any[] = await page.evaluate((sel: string | null) => {
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
      }, body.selector || null);

      if (body.format === 'csv') {
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
        url: page.url(),
        tablesFound: tables.length,
        tables,
      };
    });
  });
}
