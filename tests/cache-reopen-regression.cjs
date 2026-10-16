const { chromium } = require('playwright');

const ORIGIN = process.env.PREVIEW_ORIGIN || 'http://127.0.0.1:4417';
const CHROME = process.env.CHROME_PATH || (process.platform === 'win32' && require('fs').existsSync('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe') ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' : undefined);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function state(page) {
  return page.evaluate(() => {
    const image = document.querySelector('#large-stamp');
    return {
      readerOpen: document.querySelector('#reader')?.classList.contains('open'),
      src: image?.src || '',
      currentSrc: image?.currentSrc || '',
      index: Number(image?.dataset.index),
      width: image?.naturalWidth,
      height: image?.naturalHeight,
      count: document.querySelector('#reader-count')?.textContent || '',
      hint: document.querySelector('#reader-hint')?.textContent || '',
    };
  });
}

let browser;
(async () => {
  browser = await chromium.launch({ headless: true, executablePath: CHROME, args: ['--disable-quic'] });
  const context = await browser.newContext({ viewport: { width: 1292, height: 900 }, serviceWorkers: 'block' });
  const page = await context.newPage();
  const requests = [];
  const errors = [];
  page.on('request', (request) => {
    if (request.url().includes('/assets/stamps/')) requests.push(request.url());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') errors.push(`${message.type()}: ${message.text()}`);
  });
  await page.addInitScript(() => {
    let value = 0x5eed1234;
    Math.random = () => {
      value = (1664525 * value + 1013904223) >>> 0;
      return value / 0x100000000;
    };
  });

  await page.goto(`${ORIGIN}/?cache-reopen=${Date.now()}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  const button = page.locator('.preview:not(:disabled)').first();
  await button.waitFor({ timeout: 30000 });
  const index = Number(await button.getAttribute('data-index'));
  const expectedToken = `stamp-${String(index + 1).padStart(3, '0')}.png`;
  await button.click();
  await page.waitForFunction((expectedIndex) => {
    const image = document.querySelector('#large-stamp');
    return Number(image?.dataset.index) === expectedIndex
      && image.currentSrc.includes('/assets/stamps/')
      && image.naturalWidth === 1024;
  }, index, { timeout: 30000 });
  const first = await state(page);

  await page.locator('#close').click();
  await page.waitForFunction(() => !document.querySelector('#reader')?.classList.contains('open'));
  await button.click();
  await page.waitForTimeout(1500);
  const reopened = await state(page);
  const matchingRequests = requests.filter((url) => url.includes(expectedToken));
  console.log(JSON.stringify({ origin: ORIGIN, index, first, reopened, matchingRequests, errors }, null, 2));
  assert(reopened.readerOpen, 'The same home button did not reopen the reader');
  assert(reopened.currentSrc.includes('/assets/stamps/') && reopened.width === 1024 && reopened.height === 1536,
    `The decoded original was not restored: ${JSON.stringify(reopened)}`);
  assert(matchingRequests.length === 1, `The decoded original was downloaded again: ${JSON.stringify(matchingRequests)}`);
  assert(errors.length === 0, `Console errors: ${errors.join(' | ')}`);
})().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
}).finally(async () => {
  await browser?.close();
});
