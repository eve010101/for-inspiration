const { chromium } = require('playwright');

const ORIGIN = process.env.PREVIEW_ORIGIN || 'http://127.0.0.1:4417';
const PROFILE = process.env.PERF_PROFILE || 'native';
const CHROME = process.env.CHROME_PATH || (process.platform === 'win32' && require('fs').existsSync('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe') ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' : undefined);
const profiles = {
  native: null,
  mbps1: { offline: false, latency: 120, downloadThroughput: 125000, uploadThroughput: 62500, connectionType: 'cellular3g' },
  kbps512: { offline: false, latency: 180, downloadThroughput: 64000, uploadThroughput: 32000, connectionType: 'cellular3g' },
};

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: CHROME, args: ['--disable-quic'] });
  const context = await browser.newContext({ viewport: { width: 1292, height: 900 }, serviceWorkers: 'block' });
  const page = await context.newPage();
  const session = await context.newCDPSession(page);
  await session.send('Network.enable');
  if (profiles[PROFILE]) await session.send('Network.emulateNetworkConditions', profiles[PROFILE]);

  const records = new Map();
  let origin = 0;
  session.on('Network.requestWillBeSent', (event) => records.set(event.requestId, {
    url: event.request.url,
    startMs: performance.now() - origin,
  }));
  session.on('Network.loadingFinished', (event) => {
    const record = records.get(event.requestId);
    if (record) {
      record.endMs = performance.now() - origin;
      record.bytes = event.encodedDataLength;
    }
  });

  const startedAt = performance.now();
  origin = startedAt;
  await page.goto(`${ORIGIN}/?perf=${PROFILE}-${Date.now()}`, { waitUntil: 'domcontentloaded', timeout: 300000 });
  const domContentLoadedMs = performance.now() - startedAt;
  await page.waitForSelector('.preview:not(:disabled)', { timeout: 300000 });
  const firstClickableMs = performance.now() - startedAt;
  await page.waitForFunction(() => document.querySelectorAll('.preview:not(:disabled)').length === 5, null, { timeout: 300000 });
  const allFiveClickableMs = performance.now() - startedAt;
  await page.waitForTimeout(300);

  const finished = [...records.values()].filter((record) => record.endMs !== undefined);
  const previews = finished.filter((record) => record.url.includes('/assets/previews/'));
  const originals = finished.filter((record) => record.url.includes('/assets/stamps/'));
  const beforeInteractive = finished.filter((record) => record.endMs <= firstClickableMs);
  console.log(JSON.stringify({
    origin: ORIGIN,
    profile: PROFILE,
    domContentLoadedMs: Math.round(domContentLoadedMs),
    firstClickableMs: Math.round(firstClickableMs),
    allFiveClickableMs: Math.round(allFiveClickableMs),
    bytesFinishedAtFirstClickable: Math.round(beforeInteractive.reduce((sum, record) => sum + (record.bytes || 0), 0)),
    previewRequestsFinished: previews.length,
    previewBytesFinished: previews.reduce((sum, record) => sum + (record.bytes || 0), 0),
    originalRequestsFinished: originals.length,
  }, null, 2));
  await browser.close();
})().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
