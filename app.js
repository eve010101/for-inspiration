const field = document.querySelector('#stamp-field');
const reader = document.querySelector('#reader');
const large = document.querySelector('#large-stamp');
const count = document.querySelector('#reader-count');
const positions = ['stamp-1', 'stamp-2', 'stamp-3', 'stamp-4', 'stamp-5'];
const BOOK_COOLDOWN = 10;
const BUILD_VERSION = '20260909b';
let stamps = [], active = 0, busy = false;
let bookPools = new Map(), recentBooks = [], lastQuoteByBook = new Map();

function shuffle(items) {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

function refillBookPool(book) {
  const indexes = stamps.map((stamp, index) => stamp.book === book ? index : -1).filter((index) => index >= 0);
  let pool = shuffle(indexes);
  const previous = lastQuoteByBook.get(book);
  if (pool.length > 1 && pool[0] === previous) [pool[0], pool[1]] = [pool[1], pool[0]];
  bookPools.set(book, pool);
}

function rememberBook(book) {
  recentBooks.push(book);
  if (recentBooks.length > BOOK_COOLDOWN) recentBooks.shift();
}

function drawFromBook(book) {
  if (!bookPools.get(book)?.length) refillBookPool(book);
  const index = bookPools.get(book).shift();
  lastQuoteByBook.set(book, index);
  return index;
}

function drawNextIndex() {
  const allBooks = [...bookPools.keys()];
  const eligibleBooks = allBooks.filter((book) => !recentBooks.includes(book));
  if (!eligibleBooks.length) throw new Error('书籍数量不足，无法满足 10 次冷却规则');
  const book = eligibleBooks[Math.floor(Math.random() * eligibleBooks.length)];
  const index = drawFromBook(book);
  rememberBook(book);
  return index;
}
function render(index) {
  active = index;
  large.src = `${stamps[index].asset}?v=${BUILD_VERSION}`;
  count.textContent = `${String(index + 1).padStart(2, '0')} / ${String(stamps.length).padStart(2, '0')}`;
}
function openReader(index) {
  const book = stamps[index].book;
  const pool = bookPools.get(book) || [];
  bookPools.set(book, pool.filter((item) => item !== index));
  lastQuoteByBook.set(book, index);
  rememberBook(book);
  render(index);
  reader.classList.add('open'); reader.setAttribute('aria-hidden', 'false'); document.body.classList.add('reading');
}
function closeReader() { reader.classList.remove('open'); reader.setAttribute('aria-hidden', 'true'); document.body.classList.remove('reading'); }
function next() {
  if (busy) return;
  busy = true; large.classList.add('changing');
  setTimeout(() => { render(drawNextIndex()); large.classList.remove('changing'); busy = false; }, 260);
}
async function init() {
  const response = await fetch(`data/quotes.json?v=${BUILD_VERSION}`, { cache: 'no-store' });
  if (!response.ok) throw new Error(`数据加载失败：${response.status}`);
  const quotes = await response.json();
  stamps = quotes.map((quote) => ({ ...quote, asset: `assets/stamps/stamp-${String(quote.id).padStart(3, '0')}.png` }));
  [...new Set(stamps.map((stamp) => stamp.book))].forEach((book) => refillBookPool(book));
  document.querySelector('#count').textContent = `${String(stamps.length).padStart(2, '0')} PIECES`;
  document.querySelector('#reader-count').textContent = `01 / ${String(stamps.length).padStart(2, '0')}`;
  // 首页也从不同书籍中各抽一条，避免初始画面被同一本书占据。
  const homeBooks = shuffle([...bookPools.keys()]).slice(0, positions.length);
  const homeIndexes = homeBooks.map((book) => drawFromBook(book));
  homeIndexes.forEach((stampIndex, index) => {
    const stamp = stamps[stampIndex];
    const button = document.createElement('button');
    button.className = `preview ${positions[index]}`;
    button.setAttribute('aria-label', `打开第 ${stamp.id} 枚邮票`);
    button.innerHTML = `<img src="${stamp.asset}" alt="第 ${stamp.id} 枚文学邮票">`;
    button.addEventListener('click', () => openReader(stampIndex)); field.appendChild(button);
  });
}
init().catch((error) => {
  console.error(error);
  document.querySelector('#count').textContent = 'LOAD ERROR';
});
document.querySelector('#close').addEventListener('click', (event) => { event.stopPropagation(); closeReader(); });
// 点击阅读区域任意位置（包括当前邮票）都切换下一句。
document.querySelector('#reader-canvas').addEventListener('click', () => next());
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeReader(); if (reader.classList.contains('open') && (event.key === 'ArrowRight' || event.key === ' ')) next(); });
