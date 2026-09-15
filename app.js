const field = document.querySelector('#stamp-field');
const reader = document.querySelector('#reader');
const readerCanvas = document.querySelector('#reader-canvas');
const readerHint = document.querySelector('#reader-hint');
const instruction = document.querySelector('.instruction');
let large = document.querySelector('#large-stamp');
const count = document.querySelector('#reader-count');
const positions = ['stamp-1', 'stamp-2', 'stamp-3', 'stamp-4', 'stamp-5'];
const BOOK_COOLDOWN = 10;
const LOOKAHEAD = 4;
const MAX_DECODED_ASSETS = 12;
const ASSET_TIMEOUT_MS = 20000;
const BUILD_VERSION = '20260915h';

let stamps = [];
let active = 0;
let bookPools = new Map();
let recentBooks = [];
let lastQuoteByBook = new Map();
let homeIndexes = [];
let homeImages = new Map();

// Only decoded candidates may be committed to the reader. Keeping several
// ready in front means a click never has to wait for a 2.3 MB PNG download.
let decodedAssets = new Map();
let inflightAssets = new Map();
let candidateSlots = [];
let reservedIndexes = new Set();
let failedIndexes = new Set();
let pendingAdvance = false;
let queuedOpenIndex = null;
let retryTimer = 0;
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

function formatCount(index) {
  return `${String(index + 1).padStart(2, '0')} / ${String(stamps.length).padStart(2, '0')}`;
}

function render(index) {
  const decodedImage = decodedAssets.get(index);
  if (decodedImage && decodedImage !== large) {
    const previous = large;
    previous.removeAttribute('id');
    decodedImage.id = 'large-stamp';
    decodedImage.className = '';
    decodedImage.removeAttribute('style');
    previous.replaceWith(decodedImage);
    large = decodedImage;
    if (homeImages.get(index) === decodedImage) {
      const preview = field.querySelector(`.preview[data-index="${index}"]`);
      if (preview) {
        const replacement = decodedImage.cloneNode();
        replacement.removeAttribute('id');
        replacement.className = '';
        preview.appendChild(replacement);
        homeImages.set(index, replacement);
      }
    }
  } else if (!decodedImage) {
    large.src = assetUrl(index);
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

function rememberDecoded(index, image) {
  decodedAssets.delete(index);
  decodedAssets.set(index, image);

  queueMicrotask(refreshHomeAvailability);

  if (decodedAssets.size <= MAX_DECODED_ASSETS) return;
  for (const cachedIndex of decodedAssets.keys()) {
    if (decodedAssets.size <= MAX_DECODED_ASSETS) break;
    if (cachedIndex === active || reservedIndexes.has(cachedIndex) || homeImages.has(cachedIndex)) continue;
    decodedAssets.delete(cachedIndex);
  }
}

function readyHomeImage(index) {
  return decodedAssets.get(index) || null;
}

function preloadAsset(index, priority = 'auto') {
  const cached = decodedAssets.get(index) || readyHomeImage(index);
  if (cached) return Promise.resolve(cached);
  if (inflightAssets.has(index)) return inflightAssets.get(index);

  const promise = new Promise((resolve, reject) => {
    const image = new Image();
    let settled = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      callback();
    };
    const timeout = window.setTimeout(() => {
      finish(() => {
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
      finish(() => {
        rememberDecoded(index, image);
        resolve(image);
      });
    };
    image.onload = markLoaded;
    image.onerror = () => finish(() => reject(new Error(`图片加载失败：${assetUrl(index)}`)));
    image.src = assetUrl(index);
    if (image.complete && image.naturalWidth) queueMicrotask(markLoaded);
  });

  const tracked = promise.then(
    (image) => {
      inflightAssets.delete(index);
      return image;
    },
    (error) => {
      inflightAssets.delete(index);
      throw error;
    },
  );
  inflightAssets.set(index, tracked);
  return tracked;
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
    const isReady = Boolean(decodedAssets.get(index) || readyHomeImage(index));
    const isHomeAsset = homeIndexes.includes(index);
    const isInflight = inflightAssets.has(index);
    options.push({
      index,
      book,
      score: isReady ? 3 : (isHomeAsset ? 2 : (isInflight ? 1 : 0)),
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
    && Boolean(decodedAssets.get(index) || readyHomeImage(index))
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
  ensureLookahead(readerSession);
  return true;
}

function startCandidate(candidate, session) {
  preloadAsset(candidate.index, 'high').then(() => {
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

  while (candidateSlots.length < LOOKAHEAD) {
    const candidate = chooseCandidate();
    if (!candidate) break;
    candidateSlots.push(candidate);
    reservedIndexes.add(candidate.index);
    startCandidate(candidate, session);
  }

  if (pendingAdvance && !candidateSlots.length) {
    setWaiting(true, '网络较慢，正在重试…');
    scheduleRetry(session);
  }
}

function resetReaderWork() {
  candidateSlots = [];
  reservedIndexes.clear();
  failedIndexes.clear();
  setWaiting(false);
  large.classList.remove('changing');
  if (retryTimer) window.clearTimeout(retryTimer);
  retryTimer = 0;
}

function enterReader(index, initialCandidateIndex) {
  readerSession += 1;
  resetReaderWork();
  recentBooks = [];
  consumeIndex(index);
  render(index);
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
  ensureLookahead(readerSession);
}

async function openReader(index) {
  if (queuedOpenIndex !== null || reader.classList.contains('open')) return;
  const session = ++readerSession;
  queuedOpenIndex = index;
  setHomeOpening(true);

  // The clicked homepage stamp is already visible, but the visitor can beat
  // the other PNG loads on a slow connection. Do not enter reader mode until
  // one different, full-quality homepage stamp is ready for the first click.
  let initialCandidateIndex = chooseReadyHomeIndex(index);
  if (initialCandidateIndex === undefined) {
    const fallbacks = homeIndexes.filter((candidateIndex) => candidateIndex !== index);
    try {
      initialCandidateIndex = await Promise.any(
        fallbacks.map(async (candidateIndex) => {
          await preloadAsset(candidateIndex, 'high');
          return candidateIndex;
        }),
      );
    } catch (error) {
      console.warn('[reader] homepage reserve failed; preparing another stamp', error);
      initialCandidateIndex = null;
    }
  }

  if (initialCandidateIndex === null) {
    // All homepage reserves failed. Keep the visitor on the visible homepage
    // instead of opening a reader whose first click cannot succeed.
    if (session === readerSession && queuedOpenIndex === index) {
      queuedOpenIndex = null;
      setHomeOpening(false);
      instruction.textContent = '网络异常，请稍后再试';
    }
    return;
  }

  if (session !== readerSession || queuedOpenIndex !== index) return;
  queuedOpenIndex = null;
  setHomeOpening(false);
  enterReader(index, initialCandidateIndex);
}

function closeReader() {
  readerSession += 1;
  queuedOpenIndex = null;
  setHomeOpening(false);
  resetReaderWork();
  reader.classList.remove('open');
  reader.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('reading');
}

function next() {
  if (!stamps.length || !reader.classList.contains('open')) return;
  const candidate = takeReadyCandidate();
  if (candidate) {
    commitCandidate(candidate);
    return;
  }

  // Do not change only the page number. Keep the current image and counter
  // consistent, coalesce rapid clicks, then commit one fully decoded asset.
  setWaiting(true);
  ensureLookahead(readerSession);
}

function registerHomeImage(index, image) {
  homeImages.set(index, image);
  if (!image.complete) image.addEventListener('load', refreshHomeAvailability, { once: true });
}

function refreshHomeAvailability() {
  const readyIndexes = homeIndexes.filter((index) => {
    if (decodedAssets.has(index)) return true;
    const image = homeImages.get(index);
    if (!image?.naturalWidth) return false;
    const detachedCopy = image.cloneNode();
    detachedCopy.removeAttribute('id');
    rememberDecoded(index, detachedCopy);
    return true;
  });
  let hasEnabledButton = false;
  field.querySelectorAll('.preview').forEach((button) => {
    const index = Number(button.dataset.index);
    const canOpen = readyIndexes.includes(index) && readyIndexes.some((other) => (
      other !== index && stamps[other].book !== stamps[index].book
    ));
    button.disabled = !canOpen;
    button.setAttribute('aria-disabled', String(!canOpen));
    hasEnabledButton ||= canOpen;
  });
  if (!document.body.classList.contains('reader-preparing')) {
    instruction.textContent = hasEnabledButton ? '点击任意一枚邮票' : '高清邮票加载中…';
  }
}

function watchHomeAvailability() {
  if (field.querySelectorAll('.preview:not(:disabled)').length) return;
  refreshHomeAvailability();
  if (field.querySelectorAll('.preview:not(:disabled)').length) return;
  window.setTimeout(watchHomeAvailability, 250);
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

  // Reuse the already-loaded lossless homepage PNGs as the first lookahead.
  const homeBooks = shuffle([...bookPools.keys()]).slice(0, positions.length);
  homeIndexes = homeBooks.map((book) => bookPools.get(book)[0]);
  instruction.textContent = '高清邮票加载中…';
  homeIndexes.forEach((stampIndex, position) => {
    const stamp = stamps[stampIndex];
    const button = document.createElement('button');
    const image = document.createElement('img');
    button.className = `preview ${positions[position]}`;
    button.dataset.index = String(stampIndex);
    button.disabled = true;
    button.setAttribute('aria-label', `打开第 ${stamp.id} 枚邮票`);
    image.src = assetUrl(stampIndex);
    image.alt = `第 ${stamp.id} 枚文学邮票`;
    image.decoding = 'async';
    image.fetchPriority = position < 2 ? 'high' : 'auto';
    button.appendChild(image);
    button.addEventListener('click', () => openReader(stampIndex));
    field.appendChild(button);
    registerHomeImage(stampIndex, image);
    // This shares the browser cache with the DOM preview and gives the reader
    // an explicit readiness promise without changing or compressing the PNG.
    preloadAsset(stampIndex, position < 2 ? 'high' : 'auto')
      .then(refreshHomeAvailability)
      .catch(() => {});
  });
  refreshHomeAvailability();
  watchHomeAvailability();
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
