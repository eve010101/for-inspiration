const field = document.querySelector('#stamp-field');
const reader = document.querySelector('#reader');
const readerCanvas = document.querySelector('#reader-canvas');
const readerHint = document.querySelector('#reader-hint');
const instruction = document.querySelector('.instruction');
let large = document.querySelector('#large-stamp');
const count = document.querySelector('#reader-count');
const positions = ['stamp-1', 'stamp-2', 'stamp-3', 'stamp-4', 'stamp-5'];
const BOOK_COOLDOWN = 10;
const LOOKAHEAD = 2;
const MAX_DECODED_ASSETS = 12;
const ASSET_TIMEOUT_MS = 180000;
const BUILD_VERSION = '20260918-prod-a';
const LOOKAHEAD_DELAY_MS = 400;
const SECONDARY_PREVIEW_DELAY_MS = 12000;

let stamps = [];
let active = 0;
let bookPools = new Map();
let recentBooks = [];
let lastQuoteByBook = new Map();
let homeIndexes = [];
let homeWarmIndexes = [];

// Only decoded candidates may be committed to the reader. Keeping several
// ready in front means a click never has to wait for a 2.3 MB PNG download.
let decodedAssets = new Map();
let inflightAssets = new Map();
let inflightRecords = new Map();
let candidateSlots = [];
let reservedIndexes = new Set();
let failedIndexes = new Set();
let pendingAdvance = false;
let queuedOpenIndex = null;
let retryTimer = 0;
let lookaheadTimer = 0;
let secondaryPreviewTimer = 0;
let entryRequestSettled = false;
let activeOriginalFailed = false;
let readerSession = 0;
let lastPointerActivationAt = -Infinity;

function canDecodeImages() {
  return typeof Image.prototype.decode === 'function';
}

function shuffle(items) {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

function refillBookPool(book) {
  const indexes = stamps
    .map((stamp, index) => stamp.book === book ? index : -1)
    .filter((index) => index >= 0);
  const pool = shuffle(indexes);
  const previous = lastQuoteByBook.get(book);
  if (pool.length > 1 && pool[0] === previous) [pool[0], pool[1]] = [pool[1], pool[0]];
  bookPools.set(book, pool);
}

function rememberBook(book) {
  recentBooks.push(book);
  if (recentBooks.length > BOOK_COOLDOWN) recentBooks.shift();
}

function assetUrl(index) {
  return `${stamps[index].asset}?v=${BUILD_VERSION}`;
}

function previewUrl(index) {
  return `assets/previews/stamp-${String(stamps[index].id).padStart(3, '0')}.webp?v=${BUILD_VERSION}`;
}

function formatCount(index) {
  return `${String(index + 1).padStart(2, '0')} / ${String(stamps.length).padStart(2, '0')}`;
}

function isDecodedOriginal(index, image) {
  if (!image) return false;
  const expected = new URL(assetUrl(index), window.location.href).href;
  return image.complete
    && image.naturalWidth === 1024
    && image.naturalHeight === 1536
    && image.src === expected;
}

function render(index) {
  const decodedImage = decodedAssets.get(index);
  if (!isDecodedOriginal(index, decodedImage)) {
    decodedAssets.delete(index);
    throw new Error(`原图缓存无效：${assetUrl(index)}`);
  }
  if (decodedImage && decodedImage !== large) {
    const previous = large;
    previous.removeAttribute('id');
    decodedImage.id = 'large-stamp';
    decodedImage.className = '';
    decodedImage.removeAttribute('style');
    previous.replaceWith(decodedImage);
    large = decodedImage;
  }
  active = index;
  large.dataset.index = String(index);
  large.alt = `第 ${stamps[index].id} 枚文学邮票`;
  large.draggable = false;
  count.textContent = formatCount(index);
}

function setWaiting(waiting, message = '正在准备下一张…') {
  pendingAdvance = waiting;
  readerCanvas.setAttribute('aria-busy', String(waiting));
  readerHint.textContent = waiting ? message : '点击任意位置，阅读下一张';
}

function setHomeOpening(opening) {
  document.body.classList.toggle('reader-preparing', opening);
  field.toggleAttribute('aria-busy', opening);
}

function cancelSecondaryPreviewStart() {
  if (secondaryPreviewTimer) window.clearTimeout(secondaryPreviewTimer);
  secondaryPreviewTimer = 0;
}

function rememberDecoded(index, image) {
  decodedAssets.delete(index);
  decodedAssets.set(index, image);

  if (decodedAssets.size <= MAX_DECODED_ASSETS) return;
  for (const cachedIndex of decodedAssets.keys()) {
    if (decodedAssets.size <= MAX_DECODED_ASSETS) break;
    if (cachedIndex === active || reservedIndexes.has(cachedIndex) || homeWarmIndexes.includes(cachedIndex)) continue;
    decodedAssets.delete(cachedIndex);
  }
}

function preloadAsset(index, priority = 'auto') {
  const cached = decodedAssets.get(index);
  if (isDecodedOriginal(index, cached)) return Promise.resolve(cached);
  if (cached) decodedAssets.delete(index);
  if (inflightAssets.has(index)) return inflightAssets.get(index);

  let record;
  const promise = new Promise((resolve, reject) => {
    const image = new Image();
    let settled = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      callback();
    };
    const cancel = () => finish(() => {
      image.onload = null;
      image.onerror = null;
      image.src = '';
      const error = new Error(`图片加载已取消：${assetUrl(index)}`);
      error.name = 'AbortError';
      reject(error);
    });
    const timeout = window.setTimeout(() => {
      finish(() => {
        image.onload = null;
        image.onerror = null;
        image.src = '';
        reject(new Error(`图片加载超时：${assetUrl(index)}`));
      });
    }, ASSET_TIMEOUT_MS);
    image.decoding = 'async';
    if ('fetchPriority' in image) image.fetchPriority = priority;
    const markLoaded = async () => {
      try {
        if (canDecodeImages()) await image.decode();
      } catch {
        // load already proves that the complete PNG can be rendered.
      }
      if (settled) return;
      if (!isDecodedOriginal(index, image)) {
        finish(() => reject(new Error(`原图校验失败：${assetUrl(index)}`)));
        return;
      }
      finish(() => {
        rememberDecoded(index, image);
        resolve(image);
      });
    };
    image.onload = markLoaded;
    image.onerror = () => finish(() => reject(new Error(`图片加载失败：${assetUrl(index)}`)));
    record = { image, cancel, promise: null };
    inflightRecords.set(index, record);
    image.src = assetUrl(index);
    if (image.complete && image.naturalWidth) queueMicrotask(markLoaded);
  });

  let tracked;
  const cleanup = () => {
    if (inflightAssets.get(index) === tracked) inflightAssets.delete(index);
    if (inflightRecords.get(index) === record) inflightRecords.delete(index);
  };
  tracked = promise.then(
    (image) => {
      cleanup();
      return image;
    },
    (error) => {
      cleanup();
      throw error;
    },
  );
  record.promise = tracked;
  inflightAssets.set(index, tracked);
  return tracked;
}

function cancelInflightAssets() {
  for (const [index, record] of [...inflightRecords.entries()]) {
    if (inflightRecords.get(index) !== record) continue;
    inflightRecords.delete(index);
    if (inflightAssets.get(index) === record.promise) inflightAssets.delete(index);
    record.cancel();
  }
}

function consumeIndex(index) {
  const book = stamps[index].book;
  if (!bookPools.get(book)?.length) refillBookPool(book);
  const pool = bookPools.get(book);
  const position = pool.indexOf(index);
  if (position >= 0) pool.splice(position, 1);
  lastQuoteByBook.set(book, index);
  rememberBook(book);
}

function peekAvailableIndex(book) {
  if (!bookPools.get(book)?.length) refillBookPool(book);
  return bookPools.get(book).find((index) => (
    index !== active && !reservedIndexes.has(index) && !failedIndexes.has(index)
  ));
}

function chooseCandidate() {
  const projectedRecent = [
    ...recentBooks,
    ...candidateSlots.map((candidate) => candidate.book),
  ];
  const options = [];
  for (const book of bookPools.keys()) {
    if (projectedRecent.includes(book)) continue;
    const index = peekAvailableIndex(book);
    if (index === undefined) continue;
    const isReady = Boolean(decodedAssets.get(index));
    const isInflight = inflightAssets.has(index);
    options.push({
      index,
      book,
      score: isReady ? 3 : (isInflight ? 2 : 0),
      status: 'loading',
    });
  }

  if (!options.length) return null;
  const highestScore = Math.max(...options.map((option) => option.score));
  return shuffle(options.filter((option) => option.score === highestScore))[0];
}

function chooseReadyHomeIndex(excludedIndex) {
  return shuffle(homeIndexes).find((index) => (
    index !== excludedIndex
    && stamps[index].book !== stamps[excludedIndex].book
    && Boolean(decodedAssets.get(index))
  ));
}

function removeCandidate(candidate) {
  const position = candidateSlots.indexOf(candidate);
  if (position >= 0) candidateSlots.splice(position, 1);
  reservedIndexes.delete(candidate.index);
}

function discardCandidate(candidate) {
  removeCandidate(candidate);
}

function takeReadyCandidate() {
  candidateSlots
    .filter((candidate) => candidate.status === 'ready' && recentBooks.includes(candidate.book))
    .forEach(discardCandidate);
  return candidateSlots.find((candidate) => candidate.status === 'ready') || null;
}

function scheduleRetry(session) {
  if (retryTimer || session !== readerSession || !reader.classList.contains('open')) return;
  retryTimer = window.setTimeout(() => {
    retryTimer = 0;
    if (session !== readerSession || !reader.classList.contains('open')) return;
    failedIndexes.clear();
    ensureLookahead(session);
  }, 1800);
}

function commitCandidate(candidate) {
  if (!candidate || !reader.classList.contains('open')) return false;
  if (recentBooks.includes(candidate.book)) {
    discardCandidate(candidate);
    ensureLookahead(readerSession);
    return false;
  }
  removeCandidate(candidate);
  candidateSlots
    .filter((slot) => slot.book === candidate.book)
    .forEach(removeCandidate);
  consumeIndex(candidate.index);

  // The image source, state, and counter change together. Its identical URL
  // is already decoded, so the old stamp never lingers behind a new counter.
  render(candidate.index);
  setWaiting(false);
  if (lookaheadTimer) {
    window.clearTimeout(lookaheadTimer);
    lookaheadTimer = 0;
  }
  scheduleLookahead(readerSession);
  return true;
}

function startCandidate(candidate, session, priority = 'auto') {
  preloadAsset(candidate.index, priority).then(() => {
    if (
      session !== readerSession
      || !reader.classList.contains('open')
      || !candidateSlots.includes(candidate)
    ) return;

    candidate.status = 'ready';
    if (pendingAdvance) commitCandidate(takeReadyCandidate());
  }).catch((error) => {
    if (session !== readerSession || !candidateSlots.includes(candidate)) return;
    removeCandidate(candidate);
    failedIndexes.add(candidate.index);
    console.warn('[reader] candidate preload failed; trying another stamp', error);
    ensureLookahead(session);
  });
}

function ensureLookahead(session = readerSession) {
  if (session !== readerSession || !reader.classList.contains('open')) return;

  const targetSlots = entryRequestSettled ? LOOKAHEAD : 1;
  while (candidateSlots.length < targetSlots) {
    const candidate = chooseCandidate();
    if (!candidate) break;
    candidateSlots.push(candidate);
    reservedIndexes.add(candidate.index);
    startCandidate(candidate, session, pendingAdvance ? 'high' : 'auto');
  }

  if (pendingAdvance && !candidateSlots.length) {
    setWaiting(true, '网络较慢，正在重试…');
    scheduleRetry(session);
  }
}

function scheduleLookahead(session = readerSession) {
  if (lookaheadTimer || session !== readerSession || !reader.classList.contains('open')) return;
  lookaheadTimer = window.setTimeout(() => {
    lookaheadTimer = 0;
    if (session !== readerSession || !reader.classList.contains('open')) return;
    ensureLookahead(session);
  }, LOOKAHEAD_DELAY_MS);
}

function resetReaderWork() {
  candidateSlots = [];
  reservedIndexes.clear();
  failedIndexes.clear();
  setWaiting(false);
  large.classList.remove('changing');
  if (retryTimer) window.clearTimeout(retryTimer);
  retryTimer = 0;
  if (lookaheadTimer) window.clearTimeout(lookaheadTimer);
  lookaheadTimer = 0;
}

function enterReader(index, initialCandidateIndex) {
  readerSession += 1;
  resetReaderWork();
  recentBooks = [];
  entryRequestSettled = false;
  activeOriginalFailed = false;
  consumeIndex(index);
  renderPreview(index);
  if (initialCandidateIndex !== null && initialCandidateIndex !== undefined) {
    candidateSlots.push({
      index: initialCandidateIndex,
      book: stamps[initialCandidateIndex].book,
      score: 3,
      status: 'ready',
    });
    reservedIndexes.add(initialCandidateIndex);
  }
  reader.classList.add('open');
  reader.setAttribute('aria-hidden', 'false');
  document.body.classList.add('reading');
}

function renderPreview(index) {
  const previewImage = new Image(1024, 1536);
  previewImage.id = 'large-stamp';
  previewImage.alt = `第 ${stamps[index].id} 枚文学邮票`;
  previewImage.dataset.index = String(index);
  previewImage.decoding = 'async';
  previewImage.draggable = false;
  previewImage.src = previewUrl(index);
  const previous = large;
  previous.removeAttribute('id');
  previous.replaceWith(previewImage);
  large = previewImage;
  active = index;
  count.textContent = formatCount(index);
}

function reserveOptions(index, localFailures = new Set()) {
  const isEligible = (candidateIndex) => (
    candidateIndex !== index
    && stamps[candidateIndex].book !== stamps[index].book
    && !localFailures.has(candidateIndex)
  );
  const ready = homeIndexes.filter((candidateIndex) => (
    isEligible(candidateIndex) && decodedAssets.has(candidateIndex)
  ));
  const warming = homeWarmIndexes.filter((candidateIndex) => (
    isEligible(candidateIndex) && !ready.includes(candidateIndex)
  ));
  const remainingHome = homeIndexes.filter((candidateIndex) => (
    isEligible(candidateIndex)
    && !ready.includes(candidateIndex)
    && !warming.includes(candidateIndex)
  ));
  const remainingBooks = shuffle([...bookPools.keys()])
    .filter((book) => book !== stamps[index].book)
    .map((book) => peekAvailableIndex(book))
    .filter((candidateIndex) => (
      candidateIndex !== undefined
      && isEligible(candidateIndex)
      && !ready.includes(candidateIndex)
      && !warming.includes(candidateIndex)
      && !remainingHome.includes(candidateIndex)
    ));
  return [...ready, ...warming, ...shuffle(remainingHome), ...remainingBooks];
}

function loadVisibleOriginal(index, session, retrying = false) {
  entryRequestSettled = false;
  activeOriginalFailed = false;
  if (retrying) readerHint.textContent = '正在重新加载高清原图…';
  preloadAsset(index, 'high').then(() => {
    if (session !== readerSession || !reader.classList.contains('open')) return;
    entryRequestSettled = true;
    if (active === index) {
      render(index);
      if (!pendingAdvance) setWaiting(false);
    }
    scheduleLookahead(session);
  }).catch((error) => {
    if (session !== readerSession || !reader.classList.contains('open')) return;
    entryRequestSettled = true;
    if (error.name === 'AbortError') return;
    console.warn('[reader] visible original preload failed', error);
    if (active === index && !pendingAdvance) {
      activeOriginalFailed = true;
      readerHint.textContent = '原图加载失败，点击重试';
      return;
    }
    scheduleLookahead(session);
  });
}

async function openReader(index) {
  if (queuedOpenIndex !== null || reader.classList.contains('open')) return;
  cancelSecondaryPreviewStart();
  queuedOpenIndex = index;
  setHomeOpening(false);
  queuedOpenIndex = null;
  enterReader(index, null);
  loadVisibleOriginal(index, readerSession);
}

function closeReader() {
  readerSession += 1;
  queuedOpenIndex = null;
  setHomeOpening(false);
  cancelInflightAssets();
  entryRequestSettled = false;
  activeOriginalFailed = false;
  resetReaderWork();
  failedIndexes.clear();
  reader.classList.remove('open');
  reader.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('reading');
}

function next() {
  if (!stamps.length || !reader.classList.contains('open')) return;
  if (activeOriginalFailed) {
    loadVisibleOriginal(active, readerSession, true);
    return;
  }
  const candidate = takeReadyCandidate();
  if (candidate) {
    commitCandidate(candidate);
    return;
  }

  // Do not change only the page number. Keep the current image and counter
  // consistent, coalesce rapid clicks, then commit one fully decoded asset.
  setWaiting(true);
  if (lookaheadTimer) {
    window.clearTimeout(lookaheadTimer);
    lookaheadTimer = 0;
  }
  ensureLookahead(readerSession);
}

async function init() {
  const response = await fetch(`data/quotes.json?v=${BUILD_VERSION}`, { cache: 'no-store' });
  if (!response.ok) throw new Error(`数据加载失败：${response.status}`);
  const quotes = await response.json();
  stamps = quotes.map((quote) => ({
    ...quote,
    asset: `assets/stamps/stamp-${String(quote.id).padStart(3, '0')}.png`,
  }));
  [...new Set(stamps.map((stamp) => stamp.book))].forEach((book) => refillBookPool(book));
  document.querySelector('#count').textContent = `${String(stamps.length).padStart(2, '0')} PIECES`;
  count.textContent = `01 / ${String(stamps.length).padStart(2, '0')}`;

  // The homepage uses lightweight derivatives. Full-resolution originals are
  // a separate channel and never block the five preview buttons.
  const homeBooks = shuffle([...bookPools.keys()]).slice(0, positions.length);
  homeIndexes = homeBooks.map((book) => bookPools.get(book)[0]);
  homeWarmIndexes = [homeIndexes[2], homeIndexes[0]].filter((index) => index !== undefined);
  instruction.textContent = '邮票加载中…';
  let secondaryPreviewsStarted = false;
  const secondaryPreviewImages = [];
  const startSecondaryPreviews = () => {
    if (secondaryPreviewsStarted || queuedOpenIndex !== null || reader.classList.contains('open')) return;
    secondaryPreviewsStarted = true;
    secondaryPreviewImages.forEach((image) => {
      image.src = image.dataset.src;
      delete image.dataset.src;
    });
    if (secondaryPreviewTimer) window.clearTimeout(secondaryPreviewTimer);
    secondaryPreviewTimer = 0;
  };
  homeIndexes.forEach((stampIndex, position) => {
    const stamp = stamps[stampIndex];
    const button = document.createElement('button');
    const image = document.createElement('img');
    button.className = `preview ${positions[position]}`;
    button.dataset.index = String(stampIndex);
    button.disabled = true;
    button.setAttribute('aria-disabled', 'true');
    button.setAttribute('aria-label', `打开第 ${stamp.id} 枚邮票`);
    image.alt = `第 ${stamp.id} 枚文学邮票`;
    image.decoding = 'async';
    image.width = 512;
    image.height = 768;
    image.fetchPriority = position === 2 ? 'high' : 'auto';
    image.addEventListener('load', () => {
      button.disabled = false;
      button.setAttribute('aria-disabled', 'false');
      if (!document.body.classList.contains('reader-preparing')) {
        instruction.textContent = '点击任意一枚邮票';
      }
      if (position === 2) startSecondaryPreviews();
    }, { once: true });
    image.addEventListener('error', () => {
      button.setAttribute('aria-label', `第 ${stamp.id} 枚邮票预览加载失败`);
      if (position === 2) startSecondaryPreviews();
    }, { once: true });
    button.appendChild(image);
    button.addEventListener('click', () => openReader(stampIndex));
    field.appendChild(button);
    if (position === 2) {
      image.src = previewUrl(stampIndex);
    } else {
      image.dataset.src = previewUrl(stampIndex);
      secondaryPreviewImages.push(image);
    }
  });
  secondaryPreviewTimer = window.setTimeout(startSecondaryPreviews, SECONDARY_PREVIEW_DELAY_MS);

  // Originals intentionally start only after a visitor chooses a preview.
  // This keeps the homepage fast and prevents speculative PNGs competing
  // with the clicked stamp on constrained connections.
}

init().catch((error) => {
  console.error(error);
  document.querySelector('#count').textContent = 'LOAD ERROR';
});

document.querySelector('#close').addEventListener('click', (event) => {
  event.stopPropagation();
  closeReader();
});

function activateReader(event) {
  const target = event.target instanceof Element ? event.target : null;
  if (target?.closest('#close')) return;
  if (event.type === 'pointerup' || event.type === 'touchend') {
    if (event.type === 'pointerup' && event.pointerType === 'mouse' && event.button !== 0) return;
    lastPointerActivationAt = performance.now();
    next();
    return;
  }
  if (performance.now() - lastPointerActivationAt < 650) return;
  next();
}

reader.addEventListener('pointerup', activateReader, true);
reader.addEventListener('click', activateReader);
if (!window.PointerEvent) reader.addEventListener('touchend', activateReader, { passive: true });

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeReader();
  if (reader.classList.contains('open') && event.key === 'ArrowRight') next();
});
