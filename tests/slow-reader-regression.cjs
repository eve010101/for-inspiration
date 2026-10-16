const { chromium } = require('playwright');

const ORIGIN = process.env.PREVIEW_ORIGIN || 'http://127.0.0.1:4417';
const PROFILE = process.env.PERF_PROFILE || 'mbps1';
const CHROME = process.env.CHROME_PATH || (process.platform === 'win32' && require('fs').existsSync('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe') ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' : undefined);
const profiles = {
  mbps1: { offline: false, latency: 120, downloadThroughput: 125000, uploadThroughput: 62500, connectionType: 'cellular3g' },
  kbps512: { offline: false, latency: 180, downloadThroughput: 64000, uploadThroughput: 32000, connectionType: 'cellular3g' },
};

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assetId(url) {
  return Number(/stamp-(\d+)\.(?:png|webp)/.exec(url || '')?.[1]);
}

async function readerState(page) {
  return page.evaluate(() => {
    const image = document.querySelector('#large-stamp');
    const text = document.querySelector('#reader-count')?.textContent || '';
    return {
      src: image?.currentSrc || image?.src || '',
      index: Number(image?.dataset.index),
      count: Number(text.split('/')[0]?.trim()),
      alt: image?.alt || '',
      width: image?.naturalWidth,
      height: image?.naturalHeight,
      busy: document.querySelector('#reader-canvas')?.getAttribute('aria-busy'),
    };
  });
}

function assertCoherent(state, expectedKind) {
  const id = assetId(state.src);
  assert(Number.isFinite(id), `Visible reader asset has no stamp id: ${JSON.stringify(state)}`);
  assert(id === state.index + 1 && id === state.count, `Reader state is inconsistent: ${JSON.stringify(state)}`);
  assert(state.alt === `第 ${id} 枚文学邮票`, `Reader alt is inconsistent: ${JSON.stringify(state)}`);
  if (expectedKind === 'preview') {
    assert(state.src.includes('/assets/previews/') && state.width === 512 && state.height === 768,
      `Expected a 512x768 WebP preview: ${JSON.stringify(state)}`);
  } else {
    assert(state.src.includes('/assets/stamps/') && state.width === 1024 && state.height === 1536,
      `Expected a decoded 1024x1536 PNG: ${JSON.stringify(state)}`);
  }
}

async function createHarness(browser) {
  const context = await browser.newContext({ viewport: { width: 1292, height: 900 }, serviceWorkers: 'block' });
  const page = await context.newPage();
  const session = await context.newCDPSession(page);
  await session.send('Network.enable');
  await session.send('Network.emulateNetworkConditions', profiles[PROFILE]);

  const activeOriginals = new Set();
  const originalStarts = [];
  const errors = [];
  let maxConcurrentOriginals = 0;
  page.on('request', (request) => {
    if (!request.url().includes('/assets/stamps/')) return;
    originalStarts.push(request.url());
    activeOriginals.add(request);
    maxConcurrentOriginals = Math.max(maxConcurrentOriginals, activeOriginals.size);
  });
  const finish = (request) => activeOriginals.delete(request);
  page.on('requestfinished', finish);
  page.on('requestfailed', finish);
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.addInitScript(() => {
    let value = 0x5eed1234;
    Math.random = () => {
      value = (1664525 * value + 1013904223) >>> 0;
      return value / 0x100000000;
    };
  });

  return {
    context,
    page,
    errors,
    originalStarts,
    maxConcurrent: () => maxConcurrentOriginals,
  };
}

async function openFirstPreview(harness, suffix) {
  const { page } = harness;
  await page.goto(`${ORIGIN}/?slow=${suffix}-${Date.now()}`, { waitUntil: 'domcontentloaded', timeout: 300000 });
  const firstEnabled = page.locator('.preview:not(:disabled)').first();
  await firstEnabled.waitFor({ timeout: 300000 });
  const initialIndex = Number(await firstEnabled.getAttribute('data-index'));
  const button = page.locator(`.preview[data-index="${initialIndex}"]`);
  const clickAt = Date.now();
  await button.click();
  await page.waitForSelector('#reader.open', { timeout: 5000 });
  const readerOpenMs = Date.now() - clickAt;
  assert(readerOpenMs < 5000, `Reader shell took ${readerOpenMs}ms to open`);
  await page.waitForFunction(() => {
    const image = document.querySelector('#large-stamp');
    return image?.currentSrc.includes('/assets/previews/') && image.naturalWidth === 512;
  }, null, { timeout: 5000 });
  const preview = await readerState(page);
  assertCoherent(preview, 'preview');
  assert(preview.index === initialIndex, `Reader opened the wrong home preview: ${JSON.stringify(preview)}`);
  return { button, initialIndex, preview, readerOpenMs };
}

async function runEarlyClickFlow(browser) {
  const harness = await createHarness(browser);
  const { context, page, errors } = harness;
  try {
    const { initialIndex, readerOpenMs } = await openFirstPreview(harness, 'early-click');
    for (let i = 0; i < 5; i += 1) {
      await page.mouse.click(646, 450);
      await page.waitForTimeout(60);
    }
    const waiting = await readerState(page);
    assertCoherent(waiting, 'preview');
    assert(waiting.index === initialIndex && waiting.busy === 'true',
      `Rapid clicks changed visible state before a candidate decoded: ${JSON.stringify(waiting)}`);

    await page.waitForFunction((oldIndex) => {
      const image = document.querySelector('#large-stamp');
      const count = Number(document.querySelector('#reader-count')?.textContent.split('/')[0]?.trim());
      return image?.currentSrc.includes('/assets/stamps/')
        && image.naturalWidth === 1024
        && Number(image.dataset.index) !== oldIndex
        && Number(image.dataset.index) + 1 === count
        && document.querySelector('#reader-canvas')?.getAttribute('aria-busy') === 'false';
    }, initialIndex, { timeout: 180000 });
    const committed = await readerState(page);
    assertCoherent(committed, 'original');
    await page.waitForTimeout(1200);
    const stable = await readerState(page);
    assertCoherent(stable, 'original');
    assert(stable.index === committed.index && stable.src === committed.src,
      'A rapid-click batch advanced more than once without another user action');
    assert(harness.maxConcurrent() <= 2,
      `More than two original PNGs downloaded concurrently: ${harness.maxConcurrent()}`);
    assert(errors.length === 0, `Console/page errors: ${errors.join(' | ')}`);
    return { readerOpenMs, final: stable, maxConcurrentOriginals: harness.maxConcurrent() };
  } finally {
    await context.close();
  }
}

async function runCancelReopenFlow(browser) {
  const harness = await createHarness(browser);
  const { context, page, errors, originalStarts } = harness;
  try {
    const { button, initialIndex, readerOpenMs } = await openFirstPreview(harness, 'cancel-reopen');
    const fileToken = `stamp-${String(initialIndex + 1).padStart(3, '0')}.png`;
    await page.waitForTimeout(250);
    assert(originalStarts.filter((url) => url.includes(fileToken)).length === 1,
      `The first session did not start exactly one visible PNG request: ${JSON.stringify(originalStarts)}`);
    await page.locator('#close').click();
    await page.waitForFunction(() => !document.querySelector('#reader')?.classList.contains('open'));
    await button.click();
    await page.waitForSelector('#reader.open', { timeout: 5000 });
    await page.waitForFunction((expectedIndex) => {
      const image = document.querySelector('#large-stamp');
      return Number(image?.dataset.index) === expectedIndex
        && image.currentSrc.includes('/assets/stamps/')
        && image.naturalWidth === 1024
        && image.naturalHeight === 1536;
    }, initialIndex, { timeout: 180000 });
    const reopened = await readerState(page);
    assertCoherent(reopened, 'original');
    assert(originalStarts.filter((url) => url.includes(fileToken)).length >= 2,
      `Reopening the same stamp reused a cancelled request: ${JSON.stringify(originalStarts)}`);
    await page.waitForTimeout(1200);
    const stable = await readerState(page);
    assertCoherent(stable, 'original');
    assert(stable.index === initialIndex && stable.src === reopened.src,
      'A cancelled previous session overwrote the reopened reader');

    // Reopen once more after the original is decoded. This catches accidental
    // mutation of the cached original Image node when the preview is rendered.
    await page.locator('#close').click();
    await page.waitForFunction(() => !document.querySelector('#reader')?.classList.contains('open'));
    await button.click();
    await page.waitForFunction((expectedIndex) => {
      const image = document.querySelector('#large-stamp');
      return Number(image?.dataset.index) === expectedIndex
        && image.currentSrc.includes('/assets/stamps/')
        && image.naturalWidth === 1024
        && image.naturalHeight === 1536;
    }, initialIndex, { timeout: 5000 });
    const cachedReopen = await readerState(page);
    assertCoherent(cachedReopen, 'original');
    assert(originalStarts.filter((url) => url.includes(fileToken)).length === 2,
      `A decoded original was unexpectedly requested again: ${JSON.stringify(originalStarts)}`);
    assert(harness.maxConcurrent() <= 2,
      `More than two original PNGs downloaded concurrently: ${harness.maxConcurrent()}`);
    assert(errors.length === 0, `Console/page errors: ${errors.join(' | ')}`);
    return {
      readerOpenMs,
      sameStampRequestCount: originalStarts.filter((url) => url.includes(fileToken)).length,
      final: cachedReopen,
      maxConcurrentOriginals: harness.maxConcurrent(),
    };
  } finally {
    await context.close();
  }
}

let browser;
(async () => {
  assert(profiles[PROFILE], `Unknown PERF_PROFILE: ${PROFILE}`);
  browser = await chromium.launch({ headless: true, executablePath: CHROME, args: ['--disable-quic'] });
  const earlyClick = await runEarlyClickFlow(browser);
  const cancelReopen = await runCancelReopenFlow(browser);
  console.log(JSON.stringify({ origin: ORIGIN, profile: PROFILE, earlyClick, cancelReopen }, null, 2));
})().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
}).finally(async () => {
  await browser?.close();
});
