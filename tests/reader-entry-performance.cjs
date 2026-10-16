const { chromium } = require('playwright');

const ORIGIN = process.env.PREVIEW_ORIGIN || 'http://127.0.0.1:4417';
const PROFILE = process.env.PERF_PROFILE || 'mbps1';
const CHROME = process.env.CHROME_PATH || (process.platform === 'win32' && require('fs').existsSync('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe') ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' : undefined);
const profiles = {
  mbps1: { offline: false, latency: 120, downloadThroughput: 125000, uploadThroughput: 62500, connectionType: 'cellular3g' },
  kbps512: { offline: false, latency: 180, downloadThroughput: 64000, uploadThroughput: 32000, connectionType: 'cellular3g' },
};

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: CHROME, args: ['--disable-quic'] });
  const context = await browser.newContext({ viewport: { width: 1292, height: 900 }, serviceWorkers: 'block' });
  const page = await context.newPage();
  const session = await context.newCDPSession(page);
  await session.send('Network.enable');
  await session.send('Network.emulateNetworkConditions', profiles[PROFILE]);
  const originalRequests = [];
  session.on('Network.requestWillBeSent', (event) => {
    if (event.request.url.includes('/assets/stamps/')) originalRequests.push(event.request.url);
  });
  await page.addInitScript(() => {
    let value = 0x5eed1234;
    Math.random = () => {
      value = (1664525 * value + 1013904223) >>> 0;
      return value / 0x100000000;
    };
  });

  await page.goto(`${ORIGIN}/?entry=${PROFILE}-${Date.now()}`, { waitUntil: 'domcontentloaded', timeout: 300000 });
  await page.waitForSelector('.preview:not(:disabled)', { timeout: 300000 });
  const button = page.locator('.preview:not(:disabled)').first();
  const clickAt = performance.now();
  await button.click();
  await page.waitForSelector('#reader.open', { timeout: 300000 });
  const openMs = performance.now() - clickAt;
  const state = await page.evaluate(() => ({
    width: document.querySelector('#large-stamp')?.naturalWidth,
    height: document.querySelector('#large-stamp')?.naturalHeight,
    busy: document.querySelector('#reader-canvas')?.getAttribute('aria-busy'),
  }));
  console.log(JSON.stringify({
    profile: PROFILE,
    clickToReaderOpenMs: Math.round(openMs),
    originalRequestsBeforeOpen: originalRequests.length,
    uniqueOriginalRequestsBeforeOpen: new Set(originalRequests).size,
    state,
  }, null, 2));
  await browser.close();
})().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
