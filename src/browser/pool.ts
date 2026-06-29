import { chromium, Browser } from 'playwright';
import { AppError } from '../types';

export class BrowserPool {
  private maxInstances: number;
  private allBrowsers: Browser[] = [];
  private availableBrowsers: Browser[] = [];
  private waitingQueue: Array<{
    resolve: (b: Browser) => void;
    reject: (e: Error) => void;
    timer: NodeJS.Timeout;
  }> = [];
  private destroyed = false;

  constructor(maxInstances: number) {
    this.maxInstances = maxInstances;
  }

  get stats() {
    return {
      total: this.allBrowsers.length,
      active: this.allBrowsers.length - this.availableBrowsers.length,
      available: this.availableBrowsers.length,
    };
  }

  async acquire(): Promise<Browser> {
    if (this.destroyed) {
      throw new AppError('INTERNAL_ERROR', 'Server is shutting down', 503);
    }

    if (this.availableBrowsers.length > 0) {
      return this.availableBrowsers.pop()!;
    }

    if (this.allBrowsers.length < this.maxInstances) {
      const browser = await this.launch();
      this.allBrowsers.push(browser);
      return browser;
    }

    return new Promise<Browser>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.waitingQueue.findIndex(w => w.resolve === resolve);
        if (idx !== -1) this.waitingQueue.splice(idx, 1);
        reject(new AppError('BROWSER_POOL_FULL', 'All browser instances are busy. Try again later.', 503));
      }, 30000);
      this.waitingQueue.push({ resolve, reject, timer });
    });
  }

  release(browser: Browser): void {
    if (this.destroyed) return;

    if (this.waitingQueue.length > 0) {
      const next = this.waitingQueue.shift()!;
      clearTimeout(next.timer);
      next.resolve(browser);
    } else {
      this.availableBrowsers.push(browser);
    }
  }

  async destroyAll(): Promise<void> {
    this.destroyed = true;

    for (const w of this.waitingQueue) {
      clearTimeout(w.timer);
      w.reject(new Error('Server shutting down'));
    }
    this.waitingQueue = [];

    for (const browser of this.allBrowsers) {
      try {
        await browser.close();
      } catch {}
    }
    this.allBrowsers = [];
    this.availableBrowsers = [];
  }

  private async launch(): Promise<Browser> {
    return chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
  }
}
