const { createHash } = require('crypto');
const { chromium } = require('playwright');

const ORIGIN = process.env.PREVIEW_ORIGIN || 'http://127.0.0.1:4417';
const CHROME = process.env.CHROME_PATH || (process.platform === 'win32' && require('fs').existsSync('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe') ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' : undefined);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function state(page) {
  return page.evaluate(() => {
    const image = document.querySelector('#large-stamp');
    const id = Number(/stamp-(\d+)\.png/.exec(image?.currentSrc || '')?.[1]);
    const index = Number(image?.dataset.index);
    const count = Number(document.querySelector('#reader-count')?.textContent.split('/')[0]?.trim());
    return {
      src: image?.currentSrc || '', id, index, count,
      alt: image?.alt || '', width: image?.naturalWidth, height: image?.naturalHeight,
    };
  });
}

function assertState(value) {
  assert(value.id === value.index + 1 && value.id === value.count, `Touch state mismatch: ${JSON.stringify(value)}`);
  assert(value.alt === `第 ${value.id} 枚文学邮票`, `Touch alt mismatch: ${value.alt}`);
  assert(value.width === 1024 && value.height === 1536, `Touch reader is not original quality: ${value.width}x${value.height}`);
}

async function tapAndVerify(page, x, y, before) {
  const hashBefore = createHash('sha256').update(await page.locator('#large-stamp').screenshot()).digest('hex');
  await page.touchscreen.tap(x, y);
  await page.waitForFunction((oldSrc) => {
    const image = document.querySelector('#large-stamp');
    return image?.currentSrc !== oldSrc && image.naturalWidth === 1024;
  }, before.src, { timeout: 180000 });
  const after = await state(page);
  assertState(after);
  const hashAfter = createHash('sha256').update(await page.locator('#large-stamp').screenshot()).digest('hex');
  assert(hashBefore !== hashAfter, 'Touch changed state without changing rendered pixels');
  return after;
}

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: CHROME, args: ['--disable-quic'] });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 2,
    serviceWorkers: 'block',
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await page.addInitScript(() => {
    let value = 0x5eed1234;
    Math.random = () => {
      value = (1664525 * value + 1013904223) >>> 0;
      return value / 0x100000000;
    };
  });
  await page.goto(`${ORIGIN}/?touch=${Date.now()}`, { waitUntil: 'domcontentloaded', timeout: 180000 });
  await page.waitForSelector('.preview:not(:disabled)', { timeout: 180000 });
  await page.locator('.preview:not(:disabled)').first().tap();
  const readerOpenStartedAt = Date.now();
  await page.waitForSelector('#reader.open', { timeout: 5000 });
  const readerOpenMs = Date.now() - readerOpenStartedAt;
  assert(readerOpenMs < 5000, `Touch reader shell opened too slowly: ${readerOpenMs}ms`);
  await page.waitForFunction(() => document.querySelector('#large-stamp')?.naturalWidth === 1024, null, { timeout: 180000 });

  let current = await state(page);
  assertState(current);
  current = await tapAndVerify(page, 195, 422, current);

  const imageBox = await page.locator('#large-stamp').boundingBox();
  const blankPoint = { x: 375, y: 120 };
  assert(!imageBox || blankPoint.x < imageBox.x || blankPoint.x > imageBox.x + imageBox.width
    || blankPoint.y < imageBox.y || blankPoint.y > imageBox.y + imageBox.height,
  'Selected mobile blank point overlaps the stamp image');
  current = await tapAndVerify(page, blankPoint.x, blankPoint.y, current);
  assert(errors.length === 0, `Mobile touch errors: ${errors.join(' | ')}`);
  console.log(JSON.stringify({ origin: ORIGIN, mobileTouch: 'passed', readerOpenMs, finalState: current }, null, 2));
  await browser.close();
})().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
