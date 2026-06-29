import { Page, errors } from 'playwright';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';
import { AppError, NavigateBody } from '../types';

const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  emDelimiter: '*',
  bulletListMarker: '-',
});
turndown.use(gfm);
turndown.remove(['script', 'style', 'nav', 'footer', 'header']);

export async function removeHiddenElements(page: Page): Promise<void> {
  await page.evaluate(() => {
    document.querySelectorAll('[style*="display: none"], [style*="visibility: hidden"], [hidden], [aria-hidden="true"]')
      .forEach(el => el.remove());
  });
}

export function htmlToMarkdown(html: string): string {
  return turndown.turndown(html);
}

export function estimateTokens(text: string): number {
  return Math.round(text.length / 4);
}

export async function navigatePage(
  page: Page,
  body: { url: string; waitUntil?: string; timeout?: number },
): Promise<{ url: string; title: string; statusCode: number; loadTimeMs: number }> {
  const start = Date.now();
  let response;
  try {
    response = await page.goto(body.url, {
      waitUntil: (body.waitUntil || 'networkidle') as any,
      timeout: body.timeout || 30000,
    });
  } catch (err: any) {
    if (err instanceof errors.TimeoutError) {
      throw new AppError('NAVIGATION_TIMEOUT', `Navigation timeout after ${body.timeout || 30000}ms`, 504);
    }
    if (err.message?.includes('NS_ERROR') || err.message?.includes('net::')) {
      throw new AppError('NAVIGATION_ERROR', `Navigation failed: ${err.message}`, 502);
    }
    throw new AppError('NAVIGATION_ERROR', `Navigation failed: ${err.message}`, 502);
  }

  const loadTimeMs = Date.now() - start;
  const title = await page.title();
  const finalUrl = page.url();
  const statusCode = response?.status() || 200;

  return { url: finalUrl, title, statusCode, loadTimeMs };
}

export async function extractMetadata(page: Page) {
  return page.evaluate(() => {
    const getMeta = (name: string): string | null => {
      const el = document.querySelector(
        `meta[name="${name}"], meta[property="${name}"], meta[property="og:${name}"]`,
      );
      return el?.getAttribute('content') || null;
    };

    return {
      title: document.title || null,
      description: getMeta('description'),
      og: {
        title: getMeta('og:title'),
        description: getMeta('og:description'),
        image: getMeta('og:image'),
        type: getMeta('og:type'),
      },
      canonical: document.querySelector('link[rel="canonical"]')?.getAttribute('href') || null,
      lang: document.documentElement.lang || null,
    };
  });
}

export async function handleWaitAfter(page: Page, waitAfter?: string | number | null): Promise<void> {
  if (waitAfter == null) return;
  if (typeof waitAfter === 'number') {
    if (waitAfter > 0) {
      await page.waitForTimeout(waitAfter);
    }
    return;
  }
  if (['load', 'domcontentloaded', 'networkidle', 'commit'].includes(waitAfter)) {
    await page.waitForLoadState(waitAfter as any);
  }
}

export function getLocator(page: Page, selector: string, selectorType?: string) {
  if (selectorType === 'xpath') {
    return page.locator(`xpath=${selector}`);
  }
  return page.locator(selector);
}
