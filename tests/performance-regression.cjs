const { createHash } = require('crypto');
const { chromium } = require('playwright');

const ORIGIN = process.env.PREVIEW_ORIGIN || 'http://127.0.0.1:4417';
const CHROME = process.env.CHROME_PATH || (process.platform === 'win32' && require('fs').existsSync('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe') ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' : undefined);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function stampId(url) {
  return Number(/stamp-(\d+)\.(?:png|webp)/.exec(url || '')?.[1]);
}

async function readerState(page) {
  return page.evaluate(() => {
    const image = document.querySelector('#large-stamp');
    const current = Number(image?.dataset.index);
    const countText = document.querySelector('#reader-count')?.textContent || '';
    return {
      src: image?.currentSrc || image?.src || '',
      index: current,
      alt: image?.alt || '',
      countText,
      currentCount: Number(countText.split('/')[0]?.trim()),
      naturalWidth: image?.naturalWidth,
      naturalHeight: image?.naturalHeight,
      complete: image?.complete,
      busy: document.querySelector('#reader-canvas')?.getAttribute('aria-busy'),
    };
  });
}

function assertConsistent(state) {
  const id = stampId(state.src);
  assert(Number.isFinite(id), `Reader does not show an original stamp: ${state.src}`);
  assert(id === state.index + 1, `src/data-index mismatch: ${id} vs ${state.index}`);
  assert(id === state.currentCount, `src/count mismatch: ${id} vs ${state.countText}`);
  assert(state.alt === `第 ${id} 枚文学邮票`, `src/alt mismatch: ${id} vs ${state.alt}`);
  assert(state.complete && state.naturalWidth === 1024 && state.naturalHeight === 1536,
    `Reader image is not decoded original quality: ${state.naturalWidth}x${state.naturalHeight}`);
}

async function clickAndWaitForChange(page, x, y, previousSrc) {
  await page.mouse.click(x, y);
  await page.waitForFunction((oldSrc) => {
    const image = document.querySelector('#large-stamp');
    const counter = Number(document.querySelector('#reader-count')?.textContent.split('/')[0]?.trim());
    const current = Number(image?.dataset.index) + 1;
    return image?.complete && image.naturalWidth === 1024
      && image.currentSrc !== oldSrc && current === counter;
  }, previousSrc, { timeout: 180000 });
  const next = await readerState(page);
  assertConsistent(next);
  return next;
}

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: CHROME, args: ['--disable-quic'] });
  const context = await browser.newContext({ viewport: { width: 1292, height: 900 }, serviceWorkers: 'block' });
  const page = await context.newPage();
  const errors = [];
  const requests = [];
  const requestStarts = [];
  const responseStatuses = [];
  const failedRequests = [];
  let readerCloseStartedAt = Infinity;
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    requests.push(request.url());
    requestStarts.push({ url: request.url(), at: Date.now() });
  });
  page.on('response', (response) => responseStatuses.push({ url: response.url(), status: response.status() }));
  page.on('requestfailed', (request) => failedRequests.push({
    url: request.url(),
    error: request.failure()?.errorText,
    at: Date.now(),
  }));
  await page.addInitScript(() => {
    let value = 0x5eed1234;
    Math.random = () => {
      value = (1664525 * value + 1013904223) >>> 0;
      return value / 0x100000000;
    };
  });

  const startedAt = Date.now();
  await page.goto(`${ORIGIN}/?regression=${Date.now()}`, { waitUntil: 'domcontentloaded', timeout: 180000 });
  await page.waitForSelector('.preview:not(:disabled)', { timeout: 180000 });
  const firstClickableMs = Date.now() - startedAt;
  const originalsAtFirstClickable = requestStarts.filter((item) => (
    item.at - startedAt <= firstClickableMs && item.url.includes('/assets/stamps/')
  )).length;
  await page.waitForFunction(() => document.querySelectorAll('.preview:not(:disabled)').length === 5, null, { timeout: 180000 });

  const home = await page.evaluate(() => [...document.querySelectorAll('.preview img')].map((image) => ({
    src: image.currentSrc,
    width: image.naturalWidth,
    height: image.naturalHeight,
  })));
  assert(home.length === 5, `Expected five homepage previews, got ${home.length}`);
  assert(home.every((item) => item.src.includes('/assets/previews/') && item.width === 512 && item.height === 768),
    `Homepage did not use 512x768 derivatives: ${JSON.stringify(home)}`);
  assert(originalsAtFirstClickable === 0,
    `Homepage started ${originalsAtFirstClickable} original PNGs before becoming interactive`);

  const firstButton = page.locator('.preview:not(:disabled)').first();
  const firstIndex = Number(await firstButton.getAttribute('data-index'));
  await firstButton.click();
  const readerOpenStartedAt = Date.now();
  await page.waitForSelector('#reader.open', { timeout: 5000 });
  const readerOpenMs = Date.now() - readerOpenStartedAt;
  assert(readerOpenMs < 5000, `Reader shell opened too slowly: ${readerOpenMs}ms`);
  await page.waitForFunction(() => document.querySelector('#large-stamp')?.naturalWidth === 1024, null, { timeout: 180000 });
  let state = await readerState(page);
  assertConsistent(state);
  assert(state.index === firstIndex, `Reader did not open clicked preview: ${state.index} vs ${firstIndex}`);

  const beforeHash = createHash('sha256').update(await page.locator('#large-stamp').screenshot()).digest('hex');
  state = await clickAndWaitForChange(page, 646, 450, state.src);
  const afterHash = createHash('sha256').update(await page.locator('#large-stamp').screenshot()).digest('hex');
  assert(beforeHash !== afterHash, 'Center click changed state but rendered pixels did not change');

  const blankBeforeHash = createHash('sha256').update(await page.locator('#large-stamp').screenshot()).digest('hex');
  state = await clickAndWaitForChange(page, 1180, 260, state.src);
  const blankAfterHash = createHash('sha256').update(await page.locator('#large-stamp').screenshot()).digest('hex');
  assert(blankBeforeHash !== blankAfterHash, 'Blank click changed state but rendered pixels did not change');

  const fastBefore = state.src;
  for (let i = 0; i < 5; i += 1) {
    await page.mouse.click(646, 450);
    await page.waitForTimeout(100);
  }
  await page.waitForFunction((oldSrc) => {
    const image = document.querySelector('#large-stamp');
    const busy = document.querySelector('#reader-canvas')?.getAttribute('aria-busy');
    return image?.currentSrc !== oldSrc && busy === 'false';
  }, fastBefore, { timeout: 180000 });
  state = await readerState(page);
  assertConsistent(state);
  state = await clickAndWaitForChange(page, 646, 450, state.src);

  readerCloseStartedAt = Date.now();
  await page.locator('#close').click();
  await page.waitForFunction(() => !document.querySelector('#reader')?.classList.contains('open'));
  const secondButton = page.locator('.preview:not(:disabled)').nth(1);
  const secondIndex = Number(await secondButton.getAttribute('data-index'));
  await secondButton.click();
  await page.waitForSelector('#reader.open', { timeout: 180000 });
  await page.waitForFunction((expected) => Number(document.querySelector('#large-stamp')?.dataset.index) === expected, secondIndex, { timeout: 180000 });
  state = await readerState(page);
  assertConsistent(state);
  assert(state.index === secondIndex, 'Close/reopen showed a stale session image');
  state = await clickAndWaitForChange(page, 646, 450, state.src);
  const reopenedStableSrc = state.src;
  await page.waitForTimeout(1000);
  state = await readerState(page);
  assertConsistent(state);
  assert(state.src === reopenedStableSrc, 'A stale previous session overwrote the reopened reader');

  assert(errors.length === 0, `Console/page errors: ${errors.join(' | ')}`);
  const previewRequests = requests.filter((url) => url.includes('/assets/previews/'));
  const originalRequests = requests.filter((url) => url.includes('/assets/stamps/'));
  assert(previewRequests.length === 5, `Expected five preview requests, got ${previewRequests.length}`);
  const unexpectedFailures = failedRequests.filter((item) => !(
    item.error === 'net::ERR_ABORTED' && item.at >= readerCloseStartedAt
  ));
  assert(unexpectedFailures.length === 0, `Network request failures: ${JSON.stringify(unexpectedFailures)}`);
  assert(responseStatuses.filter((item) => item.url.includes('/assets/previews/') || item.url.includes('/assets/stamps/'))
    .every((item) => item.status === 200), 'An image request did not return HTTP 200');

  console.log(JSON.stringify({
    origin: ORIGIN,
    firstClickableMs,
    readerOpenMs,
    previewRequests: previewRequests.length,
    originalRequests: originalRequests.length,
    totalRequests: requests.length,
    originalsAtFirstClickable,
    errors,
    finalState: state,
  }, null, 2));
  await browser.close();
})().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
