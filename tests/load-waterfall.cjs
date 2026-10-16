const { chromium } = require('playwright');
const path = require('path');

const ORIGIN = process.env.PREVIEW_ORIGIN || 'https://for-inspiration.pages.dev';
const CHROME = process.env.CHROME_PATH || (process.platform === 'win32' && require('fs').existsSync('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe') ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' : undefined);
const PROFILE = process.env.WATERFALL_PROFILE || 'native';

const profiles = {
  native: null,
  mbps1: { offline: false, latency: 120, downloadThroughput: 125000, uploadThroughput: 62500, connectionType: 'cellular3g' },
  kbps256: { offline: false, latency: 180, downloadThroughput: 32000, uploadThroughput: 16000, connectionType: 'cellular3g' },
};

const now = () => Number(process.hrtime.bigint() / 1000000n);

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: CHROME, args: ['--disable-quic'] });
  const context = await browser.newContext({
    viewport: { width: 1292, height: 1544 },
    deviceScaleFactor: 1,
    serviceWorkers: 'block',
  });
  await context.clearCookies();
  const page = await context.newPage();
  const session = await context.newCDPSession(page);
  await session.send('Network.enable');
  if (profiles[PROFILE]) await session.send('Network.emulateNetworkConditions', profiles[PROFILE]);

  const requests = new Map();
  const responses = [];
  const failed = [];
  const consoleLogs = [];
  const startMono = now();
  const relative = () => now() - startMono;

  session.on('Network.requestWillBeSent', (event) => {
    const prior = requests.get(event.requestId);
    requests.set(event.requestId, {
      id: event.requestId,
      url: event.request.url,
      method: event.request.method,
      startMs: relative(),
      redirects: prior?.redirects || [],
      resourceType: event.type,
      initiatorType: event.initiator?.type,
    });
  });
  session.on('Network.responseReceived', (event) => {
    const record = requests.get(event.requestId);
    if (!record) return;
    Object.assign(record, {
      status: event.response.status,
      mimeType: event.response.mimeType,
      protocol: event.response.protocol,
      fromDiskCache: event.response.fromDiskCache,
      fromServiceWorker: event.response.fromServiceWorker,
      responseMs: relative(),
      encodedDataLengthAtHeaders: event.response.encodedDataLength,
      timing: event.response.timing,
    });
  });
  session.on('Network.loadingFinished', (event) => {
    const record = requests.get(event.requestId);
    if (!record) return;
    record.endMs = relative();
    record.encodedBytes = event.encodedDataLength;
    responses.push(record);
  });
  session.on('Network.loadingFailed', (event) => {
    const record = requests.get(event.requestId) || { id: event.requestId };
    record.endMs = relative();
    record.failed = true;
    record.errorText = event.errorText;
    failed.push(record);
  });
  page.on('console', (message) => {
    if (['error', 'warning', 'warn'].includes(message.type())) consoleLogs.push({ atMs: relative(), type: message.type(), text: message.text() });
  });

  const marks = {};
  const samples = [];
  const target = `${ORIGIN}/?waterfall=${PROFILE}-${Date.now()}`;
  await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 300000 });
  marks.domContentLoadedMs = relative();

  const deadline = Date.now() + 300000;
  let last = {};
  while (Date.now() < deadline) {
    last = await page.evaluate(() => {
      const buttons = [...document.querySelectorAll('.preview')];
      const images = buttons.map((button) => button.querySelector('img'));
      const complete = images.filter((image) => image?.complete && image.naturalWidth > 0).length;
      const visible = images.filter((image) => {
        if (!image?.complete || !image.naturalWidth) return false;
        const style = getComputedStyle(image);
        const rect = image.getBoundingClientRect();
        return style.visibility !== 'hidden' && Number(style.opacity) > 0 && rect.width > 0 && rect.height > 0;
      }).length;
      return {
        countText: document.querySelector('#count')?.textContent,
        buttonCount: buttons.length,
        enabledCount: buttons.filter((button) => !button.disabled).length,
        imageCompleteCount: complete,
        imageVisibleCount: visible,
        ids: buttons.map((button) => Number(button.dataset.index) + 1),
        sources: images.map((image) => image?.currentSrc || image?.src),
        instruction: document.querySelector('.instruction')?.textContent,
      };
    });
    const at = relative();
    samples.push({ atMs: at, ...last });
    if (marks.fiveButtonsCreatedMs == null && last.buttonCount === 5) marks.fiveButtonsCreatedMs = at;
    if (marks.firstImageVisibleMs == null && last.imageVisibleCount >= 1) marks.firstImageVisibleMs = at;
    if (marks.twoButtonsEnabledMs == null && last.enabledCount >= 2) marks.twoButtonsEnabledMs = at;
    if (marks.allFiveImagesCompleteMs == null && last.imageCompleteCount === 5) marks.allFiveImagesCompleteMs = at;
    if (marks.allFiveImagesCompleteMs != null && marks.twoButtonsEnabledMs != null) break;
    await page.waitForTimeout(25);
  }
  marks.finishedSamplingMs = relative();

  const main = responses.filter((item) => item.url.startsWith(ORIGIN));
  const mainGrouped = new Map();
  for (const item of main) {
    const clean = item.url.replace(ORIGIN, '');
    const key = clean.replace(/([?&])waterfall=[^&]+/, '$1waterfall=*');
    if (!mainGrouped.has(key)) mainGrouped.set(key, []);
    mainGrouped.get(key).push({
      url: clean,
      type: item.resourceType,
      status: item.status,
      startMs: item.startMs,
      responseMs: item.responseMs,
      endMs: item.endMs,
      durationMs: item.endMs - item.startMs,
      encodedBytes: item.encodedBytes,
      mimeType: item.mimeType,
      protocol: item.protocol,
      fromDiskCache: item.fromDiskCache,
      fromServiceWorker: item.fromServiceWorker,
      initiatorType: item.initiatorType,
    });
  }

  const homePngs = main.filter((item) => /\/assets\/stamps\/stamp-\d+\.png/.test(item.url));
  const duplicateUrls = [...mainGrouped.entries()]
    .filter(([, items]) => items.length > 1)
    .map(([key, items]) => ({ key, count: items.length, items }));

  console.log(JSON.stringify({
    profile: PROFILE,
    target,
    marks,
    finalState: last,
    mainRequests: main.map((item) => ({
      url: item.url.replace(ORIGIN, ''),
      type: item.resourceType,
      status: item.status,
      startMs: item.startMs,
      responseMs: item.responseMs,
      endMs: item.endMs,
      durationMs: item.endMs - item.startMs,
      encodedBytes: item.encodedBytes,
      protocol: item.protocol,
      fromDiskCache: item.fromDiskCache,
    })),
    homePngSummary: {
      count: homePngs.length,
      totalEncodedBytes: homePngs.reduce((sum, item) => sum + (item.encodedBytes || 0), 0),
      earliestStartMs: Math.min(...homePngs.map((item) => item.startMs)),
      latestEndMs: Math.max(...homePngs.map((item) => item.endMs)),
    },
    duplicateUrls,
    failed,
    consoleLogs,
  }, null, 2));
  await browser.close();
})().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
