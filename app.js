'use strict';

const PRIORITIES = ['none', 'low', 'medium', 'high', 'urgent'];
const PRIORITY_LABELS = {
  none: 'Без важности',
  low: 'Низкая',
  medium: 'Средняя',
  high: 'Высокая',
  urgent: 'Срочно',
};
const CACHE_KEY = 'trello-lite:board';
const FILTER_KEY = 'trello-lite:filter';

const state = {
  user: null,
  board: null,
  online: null,        // null — ещё не знаем
  filter: 'all',
  pending: 0,          // записи в облако в полёте
  writeSeq: 0,         // сколько записей завершилось — чтобы отбрасывать устаревшие ответы
  seeded: false,
  channel: null,
  channelStatus: null,
  channelSince: 0,
  queuedBoard: null,   // доска из облака, отложенная до конца записи или перетаскивания
  dragging: false,
  rendering: false,
  composer: null,      // { columnId, text, priority }
  addingColumn: null,  // { text }
  renaming: null,      // { columnId, text }
  openCardId: null,
};

const $ = (sel, root = document) => root.querySelector(sel);
const boardEl = $('#board');
const modal = $('#cardModal');

// ---------- Утилиты ----------

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else el.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child != null && child !== false) el.append(child);
  }
  return el;
}

function storageGet(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

function storageSet(key, value) {
  try { localStorage.setItem(key, value); } catch { /* приватный режим и т.п. */ }
}

function storageRemove(key) {
  try { localStorage.removeItem(key); } catch { /* приватный режим и т.п. */ }
}

let toastTimer;
function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3500);
}

function formatDate(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString('ru-RU', {
    day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

function pluralTasks(n) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return `${n} задача`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return `${n} задачи`;
  return `${n} задач`;
}

function findColumn(id) {
  return state.board.columns.find((c) => c.id === id);
}

function columnOfCard(cardId) {
  return state.board.columns.find((c) => c.cardIds.includes(cardId));
}

function clampIndex(index, length) {
  return Math.max(0, Math.min(index, length));
}

// ---------- Облако (Supabase) ----------

const config = window.TRELLO_LITE_CONFIG || {};
const isConfigured = /^https:\/\/\S+$/.test(config.supabaseUrl || '') &&
  typeof config.supabaseKey === 'string' && config.supabaseKey.length > 20 &&
  !/ВАШ/.test(config.supabaseUrl + config.supabaseKey);
const sb = isConfigured && window.supabase ? window.supabase.createClient(config.supabaseUrl, config.supabaseKey) : null;

const STEP = 1024;            // шаг между позициями карточек и колонок
const RELOAD_EVERY_MS = 30000; // страховочная перезагрузка, если живое обновление потерялось
const DEFAULT_COLUMNS = ['Нужно сделать', 'В процессе', 'Выполнено'];

function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function cacheKey() {
  return `${CACHE_KEY}:${state.user?.id}`;
}

function isNetworkError(err) {
  return /fetch|network|load failed|timeout/i.test(`${err?.message || err}`);
}

function describeError(err) {
  if (isNetworkError(err)) return 'Нет связи с облаком — изменение не сохранено';
  if (/jwt|token|auth/i.test(err?.message || '')) return 'Сессия истекла — войдите заново';
  return `Ошибка: ${err?.message || err}`;
}

function buildBoard(columnRows, cardRows) {
  const columns = columnRows.map((c) => ({ id: c.id, title: c.title, position: c.position, cardIds: [] }));
  const byId = new Map(columns.map((c) => [c.id, c]));
  const cards = {};
  for (const r of cardRows) {
    const col = byId.get(r.column_id);
    if (!col) continue;
    cards[r.id] = {
      id: r.id,
      columnId: r.column_id,
      title: r.title,
      description: r.description,
      priority: r.priority,
      position: r.position,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
    col.cardIds.push(r.id);
  }
  return { columns, cards };
}

async function fetchBoard() {
  const [cols, cards] = await Promise.all([
    sb.from('columns').select('id,title,position').order('position').order('created_at'),
    sb.from('cards')
      .select('id,column_id,title,description,priority,position,created_at,updated_at')
      .order('position').order('created_at'),
  ]);
  if (cols.error) throw cols.error;
  if (cards.error) throw cards.error;
  return buildBoard(cols.data, cards.data);
}

function setBoard(board) {
  state.board = board;
  storageSet(cacheKey(), JSON.stringify(board));
  render();
  syncModal();
}

// Пока идёт запись или перетаскивание, свежую доску из облака придерживаем,
// чтобы не «дёргать» интерфейс и не откатывать то, что пользователь только что сделал.
function flushQueuedBoard() {
  if (state.pending > 0 || state.dragging || !state.queuedBoard) return;
  const board = state.queuedBoard;
  state.queuedBoard = null;
  setBoard(board);
}

let reloadTimer = null;
let reloadRunning = false;
let reloadAgain = false;

function scheduleReload(delay = 150) {
  if (!state.user) return;
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(reload, delay);
}

async function reload() {
  if (!state.user) return;
  if (reloadRunning) { reloadAgain = true; return; }
  reloadRunning = true;
  const userId = state.user.id;
  const writeSeq = state.writeSeq;
  try {
    let board = await fetchBoard();
    if (!board.columns.length && !Object.keys(board.cards).length && !state.seeded) {
      state.seeded = true;
      await createDefaultColumns();
      board = await fetchBoard();
    }
    // Ответ устарел, если за это время пользователь сменился или успел что-то записать.
    if (state.user?.id !== userId || state.pending > 0 || writeSeq !== state.writeSeq) return;
    state.queuedBoard = board;
    flushQueuedBoard();
  } catch (err) {
    if (isNetworkError(err)) setOnline(false);
    else toast(describeError(err));
  } finally {
    reloadRunning = false;
    if (reloadAgain) { reloadAgain = false; scheduleReload(); }
  }
}

async function createDefaultColumns() {
  const rows = DEFAULT_COLUMNS.map((title, i) => ({ id: uuid(), title, position: (i + 1) * STEP }));
  const { error } = await sb.from('columns').insert(rows);
  if (error) throw error;
}

// Записывает изменение в облако. Если не получилось — показываем ошибку
// и перечитываем доску, чтобы откатить изменение на экране.
async function send(request) {
  state.pending += 1;
  let failed = false;
  try {
    const result = await request();
    const error = Array.isArray(result) ? result.find((r) => r.error)?.error : result?.error;
    if (error) throw error;
  } catch (err) {
    failed = true;
    toast(describeError(err));
  } finally {
    state.pending -= 1;
    state.writeSeq += 1;
    scheduleReload(failed ? 0 : 400);
  }
}

function setOnline(online) {
  if (state.online === online) return;
  state.online = online;
  const sync = $('#sync');
  sync.dataset.state = online ? 'online' : 'offline';
  $('.sync-text', sync).textContent = online ? 'Синхронизировано' : 'Нет связи';
  $('#offlineBanner').hidden = online;
  document.body.classList.toggle('is-readonly', !online);
  if (!online) cancelDrag();
}

// Живые обновления: облако сообщает об изменениях с других устройств.
function subscribe() {
  unsubscribe();
  state.channelSince = Date.now();
  state.channel = sb.channel(`board-${state.user.id}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'columns' }, () => scheduleReload())
    .on('postgres_changes', { event: '*', schema: 'public', table: 'cards' }, () => scheduleReload())
    .subscribe((status) => {
      state.channelStatus = status;
      state.channelSince = Date.now();
      if (status === 'SUBSCRIBED') {
        setOnline(true);
        scheduleReload(0); // догоняем то, что могли пропустить без связи
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
        setOnline(false);
      }
    });
}

function unsubscribe() {
  if (state.channel) sb.removeChannel(state.channel);
  state.channel = null;
  state.channelStatus = null;
}

// Страховка: переподключаемся, если канал «завис», и периодически сверяем доску.
setInterval(() => {
  if (!state.user || document.hidden) return;
  const stuck = state.channelStatus !== 'SUBSCRIBED' && Date.now() - state.channelSince > 15000;
  if (stuck && navigator.onLine) subscribe();
  else if (state.channelStatus === 'SUBSCRIBED') scheduleReload(0);
}, RELOAD_EVERY_MS);

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) scheduleReload(0);
});
window.addEventListener('online', () => { if (state.user) subscribe(); });
window.addEventListener('offline', () => setOnline(false));

// ---------- Изменения: сразу на экране, затем в облако ----------

// list — элементы в новом порядке, включая перемещённый. Обычно меняется позиция
// только у перемещённого элемента; если места между соседями не осталось — нумеруем всех заново.
function planPositions(list, moved) {
  const i = list.indexOf(moved);
  const prev = list[i - 1]?.position;
  const next = list[i + 1]?.position;
  let position;
  if (prev == null && next == null) position = STEP;
  else if (prev == null) position = next - STEP;
  else if (next == null) position = prev + STEP;
  else position = (prev + next) / 2;
  const fits = (prev == null || position - prev > 1e-6) && (next == null || next - position > 1e-6);
  if (fits) return [{ item: moved, position }];
  return list.map((item, k) => ({ item, position: (k + 1) * STEP }));
}

function moveCard(cardId, toColumnId, index) {
  const card = state.board.cards[cardId];
  const from = columnOfCard(cardId);
  const to = findColumn(toColumnId);
  if (!card || !to) return;
  if (from) from.cardIds = from.cardIds.filter((id) => id !== cardId);
  to.cardIds.splice(clampIndex(index, to.cardIds.length), 0, cardId);
  card.columnId = toColumnId;

  const changes = planPositions(to.cardIds.map((id) => state.board.cards[id]), card);
  for (const { item, position } of changes) item.position = position;
  render();
  send(() => Promise.all(changes.map(({ item, position }) => sb.from('cards')
    .update(item === card ? { column_id: toColumnId, position } : { position })
    .eq('id', item.id))));
}

function moveColumn(columnId, index) {
  const col = findColumn(columnId);
  if (!col) return;
  state.board.columns = state.board.columns.filter((c) => c.id !== columnId);
  state.board.columns.splice(clampIndex(index, state.board.columns.length), 0, col);

  const changes = planPositions(state.board.columns, col);
  for (const { item, position } of changes) item.position = position;
  render();
  send(() => Promise.all(changes.map(({ item, position }) => sb.from('columns')
    .update({ position }).eq('id', item.id))));
}

function addCard(columnId, title, priority) {
  const col = findColumn(columnId);
  if (!col) return;
  const last = state.board.cards[col.cardIds[col.cardIds.length - 1]];
  const now = new Date().toISOString();
  const card = {
    id: uuid(), columnId, title, description: '', priority,
    position: (last?.position ?? 0) + STEP, createdAt: now, updatedAt: now,
  };
  state.board.cards[card.id] = card;
  col.cardIds.push(card.id);
  render();
  send(() => sb.from('cards').insert({
    id: card.id, column_id: columnId, title, priority, position: card.position,
  }));
}

function updateCard(cardId, patch) {
  const card = state.board.cards[cardId];
  if (!card) return;
  const changed = Object.keys(patch).some((key) => card[key] !== patch[key]);
  if (!changed) return;
  Object.assign(card, patch);
  render();
  send(() => sb.from('cards').update(patch).eq('id', cardId));
}

function deleteCard(cardId) {
  const col = columnOfCard(cardId);
  if (col) col.cardIds = col.cardIds.filter((id) => id !== cardId);
  delete state.board.cards[cardId];
  render();
  send(() => sb.from('cards').delete().eq('id', cardId));
}

function addColumn(title) {
  const last = state.board.columns[state.board.columns.length - 1];
  const col = { id: uuid(), title, position: (last?.position ?? 0) + STEP, cardIds: [] };
  state.board.columns.push(col);
  render();
  send(() => sb.from('columns').insert({ id: col.id, title, position: col.position }));
}

function renameColumn(columnId, title) {
  const col = findColumn(columnId);
  if (!col || !title || col.title === title) return;
  col.title = title;
  render();
  send(() => sb.from('columns').update({ title }).eq('id', columnId));
}

function deleteColumn(columnId) {
  const col = findColumn(columnId);
  if (!col) return;
  const count = col.cardIds.length;
  if (count && !confirm(`Удалить колонку «${col.title}» вместе с задачами (${pluralTasks(count)})?`)) return;
  for (const id of col.cardIds) delete state.board.cards[id];
  state.board.columns = state.board.columns.filter((c) => c.id !== columnId);
  if (state.composer?.columnId === columnId) state.composer = null;
  render();
  // Карточки колонки база удалит сама (on delete cascade).
  send(() => sb.from('columns').delete().eq('id', columnId));
}

// ---------- Вход и выход ----------

const loginForm = $('#loginForm');
const loginError = $('#loginError');

function showLogin(message) {
  document.body.classList.add('is-auth');
  loginError.hidden = !message;
  loginError.textContent = message || '';
}

function onSignedIn(user) {
  state.user = user;
  state.seeded = false;
  document.body.classList.remove('is-auth');
  $('#logoutButton').title = `Вы вошли как ${user.email}`;
  $('#loginPassword').value = '';

  const cached = storageGet(cacheKey());
  if (cached) {
    try { setBoard(JSON.parse(cached)); } catch { /* испорченный кэш — дождёмся облака */ }
  }
  subscribe();
  scheduleReload(0);
}

function onSignedOut() {
  storageRemove(cacheKey());
  unsubscribe();
  cancelDrag();
  if (modal.open) modal.close();
  Object.assign(state, {
    user: null, board: null, queuedBoard: null, online: null,
    composer: null, addingColumn: null, renaming: null, openCardId: null,
  });
  boardEl.replaceChildren();
  $('#sync').dataset.state = 'connecting';
  $('.sync-text').textContent = 'Подключение…';
  $('#offlineBanner').hidden = true;
  document.body.classList.remove('is-readonly');
  showLogin();
}

loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const button = $('#loginButton');
  button.disabled = true;
  loginError.hidden = true;
  const { error } = await sb.auth.signInWithPassword({
    email: $('#loginEmail').value.trim(),
    password: $('#loginPassword').value,
  });
  button.disabled = false;
  if (!error) return; // дальше сработает onAuthStateChange
  if (/invalid login credentials/i.test(error.message)) showLogin('Неверная почта или пароль');
  else if (/email not confirmed/i.test(error.message)) showLogin('Почта не подтверждена — подтвердите её в Supabase (Authentication → Users)');
  else if (isNetworkError(error)) showLogin('Нет связи с интернетом');
  else showLogin(error.message);
});

$('#logoutButton').addEventListener('click', async () => {
  if (!confirm('Выйти из аккаунта на этом устройстве?')) return;
  await sb.auth.signOut();
});

function startAuth() {
  if (!sb) {
    showLogin();
    $('#authHint').textContent = 'Приложение ещё не подключено к Supabase: заполните файл config.js (см. README).';
    for (const el of loginForm.elements) el.disabled = true;
    return;
  }
  let first = true;
  sb.auth.onAuthStateChange((event, session) => {
    const user = session?.user ?? null;
    const wasFirst = first;
    first = false;
    // Внутри этого обработчика нельзя ждать запросы Supabase — откладываем.
    setTimeout(() => {
      if (user && user.id !== state.user?.id) onSignedIn(user);
      else if (!user && state.user) onSignedOut();
      else if (!user && wasFirst) showLogin();
    }, 0);
  });
}

// ---------- Отрисовка ----------

function render() {
  if (!state.board) return;
  state.rendering = true;

  // Запоминаем прокрутку и фокус, чтобы перерисовка была незаметной.
  const scrollLeft = boardEl.scrollLeft;
  const listScroll = {};
  for (const col of boardEl.querySelectorAll('.column')) {
    listScroll[col.dataset.id] = $('.card-list', col)?.scrollTop ?? 0;
  }
  const active = document.activeElement;
  const focusKey = boardEl.contains(active) ? active.dataset.focusKey : null;
  const selection = focusKey && 'selectionStart' in active
    ? [active.selectionStart, active.selectionEnd] : null;

  boardEl.replaceChildren(...state.board.columns.map(renderColumn), renderAddColumn());

  boardEl.scrollLeft = scrollLeft;
  for (const col of boardEl.querySelectorAll('.column')) {
    const list = $('.card-list', col);
    if (list && listScroll[col.dataset.id]) list.scrollTop = listScroll[col.dataset.id];
  }
  if (focusKey) {
    const el = boardEl.querySelector(`[data-focus-key="${focusKey}"]`);
    if (el) {
      el.focus({ preventScroll: true });
      if (selection) el.setSelectionRange(...selection);
    }
  }
  state.rendering = false;
}

function visibleCards(col) {
  const cards = col.cardIds.map((id) => state.board.cards[id]).filter(Boolean);
  return state.filter === 'all' ? cards : cards.filter((c) => c.priority === state.filter);
}

function renderColumn(col) {
  const total = col.cardIds.length;
  const visible = visibleCards(col);
  const isRenaming = state.renaming?.columnId === col.id;

  const title = isRenaming
    ? renderRenameInput(col)
    : h('h2', { class: 'column-title', title: 'Двойной клик — переименовать' }, col.title);

  return h('section', { class: 'column', dataset: { id: col.id } },
    h('div', { class: 'column-head' },
      title,
      h('span', { class: 'column-count' }, state.filter === 'all' ? total : `${visible.length} из ${total}`),
      h('button', {
        type: 'button', class: 'icon-btn', 'aria-label': 'Действия с колонкой',
        dataset: { action: 'column-menu' },
      }, '⋯'),
    ),
    h('div', { class: 'card-list' }, visible.map(renderCard)),
    h('div', { class: 'column-foot' },
      state.composer?.columnId === col.id
        ? renderComposer(col)
        : h('button', { type: 'button', class: 'add-btn', dataset: { action: 'add-card' } }, '+ Добавить задачу'),
    ),
  );
}

function renderCard(card) {
  const hasDescription = card.description && card.description.trim();
  return h('article', {
    class: `card p-${card.priority}`, tabindex: 0, dataset: { id: card.id },
  },
    h('div', { class: 'card-tags' },
      card.priority !== 'none'
        ? h('span', { class: `priority-tag p-${card.priority}` }, PRIORITY_LABELS[card.priority])
        : null,
    ),
    h('div', { class: 'card-title' }, card.title),
    h('div', { class: 'card-meta' },
      hasDescription ? h('span', { title: 'Есть описание' }, '☰ описание') : null,
    ),
  );
}

function renderComposer(col) {
  const composer = state.composer;
  const input = h('textarea', {
    class: 'composer-input', rows: 2, maxlength: 300,
    placeholder: 'Введите название задачи…', dataset: { focusKey: `composer-${col.id}` },
  });
  input.value = composer.text;
  input.addEventListener('input', () => { composer.text = input.value; });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submitComposer();
    } else if (e.key === 'Escape') {
      closeComposer();
    }
  });

  const priorityButtons = PRIORITIES.map((p) => h('button', {
    type: 'button',
    class: p === composer.priority ? 'is-active' : null,
    title: PRIORITY_LABELS[p],
    'aria-label': `Важность: ${PRIORITY_LABELS[p]}`,
    onclick: (e) => {
      composer.priority = p;
      for (const btn of e.currentTarget.parentElement.children) btn.classList.toggle('is-active', btn === e.currentTarget);
      input.focus();
    },
  }, h('i', { class: `dot p-${p}` })));

  return h('div', { class: 'composer' },
    input,
    h('div', { class: 'composer-row' },
      h('button', { type: 'button', class: 'primary-btn', onclick: submitComposer }, 'Добавить'),
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Отмена', onclick: closeComposer }, '✕'),
      h('div', { class: 'composer-priority' }, priorityButtons),
    ),
  );
}

function renderRenameInput(col) {
  const input = h('input', {
    class: 'column-title-input', maxlength: 300, 'aria-label': 'Название колонки',
    dataset: { focusKey: `rename-${col.id}` },
  });
  input.value = state.renaming.text;
  input.addEventListener('input', () => { state.renaming.text = input.value; });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finishRename(true); }
    else if (e.key === 'Escape') finishRename(false);
  });
  input.addEventListener('blur', () => {
    if (!state.rendering && input.isConnected) finishRename(true);
  });
  return input;
}

function renderAddColumn() {
  if (!state.addingColumn) {
    return h('div', { class: 'add-column' },
      h('button', { type: 'button', class: 'add-btn', dataset: { action: 'add-column' } }, '+ Добавить колонку'),
    );
  }
  const input = h('input', {
    maxlength: 300, placeholder: 'Название колонки…', dataset: { focusKey: 'add-column' },
  });
  input.value = state.addingColumn.text;
  input.addEventListener('input', () => { state.addingColumn.text = input.value; });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); submitColumn(); }
    else if (e.key === 'Escape') { state.addingColumn = null; render(); }
  });
  return h('div', { class: 'add-column composer' },
    input,
    h('div', { class: 'composer-row' },
      h('button', { type: 'button', class: 'primary-btn', onclick: submitColumn }, 'Добавить колонку'),
      h('button', {
        type: 'button', class: 'icon-btn', 'aria-label': 'Отмена',
        onclick: () => { state.addingColumn = null; render(); },
      }, '✕'),
    ),
  );
}

// ---------- Добавление и переименование ----------

function focusByKey(key) {
  boardEl.querySelector(`[data-focus-key="${key}"]`)?.focus();
}

function openComposer(columnId) {
  state.composer = {
    columnId,
    text: '',
    priority: state.filter === 'all' ? 'none' : state.filter,
  };
  render();
  focusByKey(`composer-${columnId}`);
  scrollListToEnd(columnId);
}

function closeComposer() {
  state.composer = null;
  render();
}

function scrollListToEnd(columnId) {
  const list = boardEl.querySelector(`.column[data-id="${columnId}"] .card-list`);
  if (list) list.scrollTop = list.scrollHeight;
}

function submitComposer() {
  const composer = state.composer;
  const title = composer?.text.trim();
  if (!title) return;
  composer.text = '';
  addCard(composer.columnId, title, composer.priority);
  scrollListToEnd(composer.columnId);
  focusByKey(`composer-${composer.columnId}`);
}

function submitColumn() {
  const title = state.addingColumn?.text.trim();
  if (!title) return;
  state.addingColumn.text = '';
  addColumn(title);
  boardEl.scrollLeft = boardEl.scrollWidth;
  focusByKey('add-column');
}

function startRename(columnId) {
  const col = findColumn(columnId);
  if (!col || !state.online) return;
  state.renaming = { columnId, text: col.title };
  render();
  const input = boardEl.querySelector(`[data-focus-key="rename-${columnId}"]`);
  input?.focus();
  input?.select();
}

function finishRename(save) {
  const renaming = state.renaming;
  if (!renaming) return;
  state.renaming = null;
  const title = renaming.text.trim();
  if (save && title) renameColumn(renaming.columnId, title);
  else render();
}

// ---------- Меню колонки ----------

let openMenu = null;

function closeColumnMenu() {
  openMenu?.remove();
  openMenu = null;
}

function showColumnMenu(button, columnId) {
  closeColumnMenu();
  const rect = button.getBoundingClientRect();
  openMenu = h('div', { class: 'column-menu', role: 'menu' },
    h('button', { type: 'button', onclick: () => { closeColumnMenu(); openComposer(columnId); } }, 'Добавить задачу'),
    h('button', { type: 'button', onclick: () => { closeColumnMenu(); startRename(columnId); } }, 'Переименовать'),
    h('button', { type: 'button', class: 'danger', onclick: () => { closeColumnMenu(); deleteColumn(columnId); } }, 'Удалить колонку'),
  );
  document.body.append(openMenu);
  const left = Math.min(rect.left, window.innerWidth - openMenu.offsetWidth - 8);
  openMenu.style.left = `${Math.max(8, left) + window.scrollX}px`;
  openMenu.style.top = `${rect.bottom + 4 + window.scrollY}px`;
}

document.addEventListener('pointerdown', (e) => {
  if (openMenu && !openMenu.contains(e.target) && !e.target.closest('[data-action="column-menu"]')) closeColumnMenu();
});

// ---------- Клики по доске ----------

let suppressClick = false;

boardEl.addEventListener('click', (e) => {
  if (suppressClick) return;
  const actionEl = e.target.closest('[data-action]');
  if (actionEl) {
    const columnId = actionEl.closest('.column')?.dataset.id;
    switch (actionEl.dataset.action) {
      case 'add-card': return openComposer(columnId);
      case 'column-menu':
        if (openMenu) return closeColumnMenu();
        return showColumnMenu(actionEl, columnId);
      case 'add-column':
        state.addingColumn = { text: '' };
        render();
        boardEl.scrollLeft = boardEl.scrollWidth;
        return focusByKey('add-column');
    }
  }
  const card = e.target.closest('.card');
  if (card) openCard(card.dataset.id);
});

boardEl.addEventListener('dblclick', (e) => {
  const title = e.target.closest('.column-title');
  if (title) startRename(title.closest('.column').dataset.id);
});

boardEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.classList.contains('card')) openCard(e.target.dataset.id);
});

// Колесо мыши над фоном доски прокручивает колонки по горизонтали.
boardEl.addEventListener('wheel', (e) => {
  if (e.target.closest('.card-list') || e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
  boardEl.scrollLeft += e.deltaY;
}, { passive: true });

// ---------- Перетаскивание (мышь, тачпад, сенсорный экран) ----------

let drag = null;

const DRAG_THRESHOLD = 5;
const LONG_PRESS_MS = 250;
const EDGE = 60;

boardEl.addEventListener('pointerdown', (e) => {
  if (!state.online || drag || e.button !== 0) return;
  if (e.target.closest('button, input, textarea, select, a')) return;

  const cardEl = e.target.closest('.card');
  const headEl = !cardEl && e.target.closest('.column-head');
  const el = cardEl || headEl?.closest('.column');
  if (!el) return;

  drag = {
    kind: cardEl ? 'card' : 'column',
    el,
    id: el.dataset.id,
    pointerId: e.pointerId,
    touch: e.pointerType === 'touch',
    startX: e.clientX,
    startY: e.clientY,
    x: e.clientX,
    y: e.clientY,
    started: false,
    timer: null,
  };
  if (drag.touch) {
    drag.timer = setTimeout(() => { if (drag && !drag.started) beginDrag(); }, LONG_PRESS_MS);
  }

  window.addEventListener('pointermove', onDragMove);
  window.addEventListener('pointerup', onDragEnd);
  window.addEventListener('pointercancel', onDragCancel);
});

// Встроенное перетаскивание браузера (выделенного текста, картинок) перехватило бы мышь
// и сорвало наше — отключаем его на доске.
boardEl.addEventListener('dragstart', (e) => e.preventDefault());

// На сенсорном экране во время перетаскивания запрещаем прокрутку страницы.
window.addEventListener('touchmove', (e) => {
  if (drag?.started) e.preventDefault();
}, { passive: false });

window.addEventListener('contextmenu', (e) => {
  if (drag) e.preventDefault();
});

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && drag) cancelDrag();
});

function onDragMove(e) {
  if (!drag || e.pointerId !== drag.pointerId) return;
  drag.x = e.clientX;
  drag.y = e.clientY;
  if (!drag.started) {
    const moved = Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) > DRAG_THRESHOLD;
    if (!moved) return;
    if (drag.touch) return cleanupDrag(); // палец сдвинулся до долгого нажатия — это прокрутка
    beginDrag();
  }
  positionGhost();
  updatePlaceholder();
}

function onDragEnd(e) {
  if (!drag || e.pointerId !== drag.pointerId) return;
  if (drag.started) finishDrag(false);
  else cleanupDrag();
}

function onDragCancel(e) {
  if (!drag || e.pointerId !== drag.pointerId) return;
  cancelDrag();
}

function cancelDrag() {
  if (!drag) return;
  if (drag.started) finishDrag(true);
  else cleanupDrag();
}

function beginDrag() {
  closeColumnMenu();
  const rect = drag.el.getBoundingClientRect();
  drag.started = true;
  drag.offsetX = drag.startX - rect.left;
  drag.offsetY = drag.startY - rect.top;

  const ghost = drag.el.cloneNode(true);
  ghost.classList.add('drag-ghost');
  ghost.style.width = `${rect.width}px`;
  ghost.style.height = `${rect.height}px`;
  ghost.style.left = '0';
  ghost.style.top = '0';
  drag.ghost = ghost;

  const placeholder = document.createElement('div');
  placeholder.className = drag.kind === 'column' ? 'column placeholder' : 'placeholder';
  placeholder.style.height = `${rect.height}px`;
  drag.placeholder = placeholder;

  drag.el.before(placeholder);
  drag.el.style.display = 'none';
  document.body.append(ghost);
  document.body.classList.add('is-dragging');
  state.dragging = true;
  if (navigator.vibrate && drag.touch) navigator.vibrate(15);

  positionGhost();
  drag.raf = requestAnimationFrame(autoScroll);
}

function positionGhost() {
  drag.ghost.style.transform =
    `translate(${drag.x - drag.offsetX}px, ${drag.y - drag.offsetY}px) rotate(3deg)`;
}

function nextVisibleSibling(el, selector) {
  let next = el.nextElementSibling;
  while (next && (next === drag.el || !next.matches(selector))) next = next.nextElementSibling;
  return next;
}

function updatePlaceholder() {
  const { placeholder, x, y } = drag;

  if (drag.kind === 'column') {
    const columns = [...boardEl.querySelectorAll('.column:not(.placeholder)')].filter((c) => c !== drag.el);
    const before = columns.find((c) => {
      const r = c.getBoundingClientRect();
      return x < r.left + r.width / 2;
    }) || boardEl.querySelector('.add-column');
    if (nextVisibleSibling(placeholder, '.column:not(.placeholder), .add-column') !== before) {
      boardEl.insertBefore(placeholder, before);
    }
    return;
  }

  const columnEl = [...boardEl.querySelectorAll('.column')].find((c) => {
    const r = c.getBoundingClientRect();
    return x >= r.left - 6 && x <= r.right + 6;
  });
  if (!columnEl) return;
  const list = $('.card-list', columnEl);
  const cards = [...list.querySelectorAll('.card')].filter((c) => c !== drag.el);
  const before = cards.find((c) => {
    const r = c.getBoundingClientRect();
    return y < r.top + r.height / 2;
  }) || null;
  const current = placeholder.parentElement === list ? nextVisibleSibling(placeholder, '.card') : undefined;
  if (current !== before) list.insertBefore(placeholder, before);
}

function autoScroll() {
  if (!drag?.started) return;
  const { x, y } = drag;
  let scrolled = false;

  const boardRect = boardEl.getBoundingClientRect();
  if (x < boardRect.left + EDGE) { boardEl.scrollLeft -= speed(boardRect.left + EDGE - x); scrolled = true; }
  else if (x > boardRect.right - EDGE) { boardEl.scrollLeft += speed(x - (boardRect.right - EDGE)); scrolled = true; }

  if (drag.kind === 'card') {
    const list = drag.placeholder.parentElement;
    if (list?.classList.contains('card-list')) {
      const r = list.getBoundingClientRect();
      if (y < r.top + EDGE / 2 && y > r.top - EDGE) { list.scrollTop -= speed(r.top + EDGE / 2 - y); scrolled = true; }
      else if (y > r.bottom - EDGE / 2 && y < r.bottom + EDGE) { list.scrollTop += speed(y - (r.bottom - EDGE / 2)); scrolled = true; }
    }
  }

  if (scrolled) updatePlaceholder();
  drag.raf = requestAnimationFrame(autoScroll);
}

function speed(depth) {
  return Math.min(20, Math.max(2, depth / 3));
}

function finishDrag(cancelled) {
  const d = drag;
  let target = null;

  if (!cancelled) {
    if (d.kind === 'card') {
      const columnId = d.placeholder.closest('.column')?.dataset.id;
      const next = nextVisibleSibling(d.placeholder, '.card');
      const col = columnId && findColumn(columnId);
      if (col) {
        const ids = col.cardIds.filter((id) => id !== d.id);
        const index = next ? ids.indexOf(next.dataset.id) : ids.length;
        const from = columnOfCard(d.id);
        const unchanged = from === col && from.cardIds.indexOf(d.id) === index;
        if (!unchanged) target = () => moveCard(d.id, col.id, index);
      }
    } else {
      const next = nextVisibleSibling(d.placeholder, '.column:not(.placeholder)');
      const ids = state.board.columns.map((c) => c.id).filter((id) => id !== d.id);
      const index = next ? ids.indexOf(next.dataset.id) : ids.length;
      if (state.board.columns.findIndex((c) => c.id === d.id) !== index) target = () => moveColumn(d.id, index);
    }
  }

  cancelAnimationFrame(d.raf);
  d.ghost.remove();
  d.placeholder.remove();
  d.el.style.display = '';
  document.body.classList.remove('is-dragging');
  cleanupDrag();
  state.dragging = false;

  // Клик после отпускания не должен открывать карточку.
  suppressClick = true;
  setTimeout(() => { suppressClick = false; }, 0);

  if (target) target();
  else render();
  flushQueuedBoard();
}

function cleanupDrag() {
  if (!drag) return;
  clearTimeout(drag.timer);
  window.removeEventListener('pointermove', onDragMove);
  window.removeEventListener('pointerup', onDragEnd);
  window.removeEventListener('pointercancel', onDragCancel);
  drag = null;
}

// ---------- Окно задачи ----------

const titleInput = $('#cardTitle');
const descriptionInput = $('#cardDescription');
const columnSelect = $('#cardColumn');
const priorityPicker = $('#cardPriority');

function autosizeTitle() {
  titleInput.style.height = 'auto';
  titleInput.style.height = `${titleInput.scrollHeight}px`;
}

function openCard(cardId) {
  const card = state.board?.cards[cardId];
  if (!card) return;
  state.openCardId = cardId;
  titleInput.value = card.title;
  descriptionInput.value = card.description || '';
  syncModal();
  modal.showModal();
  autosizeTitle();
  titleInput.blur();
}

// Обновляет открытое окно, если задачу изменили на другом устройстве.
function syncModal() {
  if (!state.openCardId) return;
  const card = state.board.cards[state.openCardId];
  if (!card) {
    state.openCardId = null;
    if (modal.open) modal.close();
    toast('Эту задачу удалили на другом устройстве');
    return;
  }
  if (document.activeElement !== titleInput) {
    titleInput.value = card.title;
    autosizeTitle();
  }
  if (document.activeElement !== descriptionInput) descriptionInput.value = card.description || '';

  const currentColumn = columnOfCard(card.id);
  columnSelect.replaceChildren(...state.board.columns.map((c) => h('option', {
    value: c.id, selected: c === currentColumn,
  }, c.title)));

  for (const btn of priorityPicker.children) {
    btn.classList.toggle('is-active', btn.dataset.priority === card.priority);
  }

  const meta = [`Создана ${formatDate(card.createdAt)}`];
  if (card.updatedAt && card.updatedAt !== card.createdAt) meta.push(`изменена ${formatDate(card.updatedAt)}`);
  $('#cardMeta').textContent = meta.join(' · ');
}

function saveModalText() {
  const card = state.board?.cards[state.openCardId];
  if (!card || !state.online) return;
  const title = titleInput.value.replace(/\s+/g, ' ').trim();
  const patch = {};
  if (title && title !== card.title) patch.title = title;
  if (descriptionInput.value !== (card.description || '')) patch.description = descriptionInput.value;
  if (Object.keys(patch).length) updateCard(card.id, patch);
  if (!title) titleInput.value = card.title;
}

titleInput.addEventListener('input', autosizeTitle);
titleInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    titleInput.blur();
  }
});
titleInput.addEventListener('blur', saveModalText);
descriptionInput.addEventListener('blur', saveModalText);

priorityPicker.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-priority]');
  if (!btn || !state.online) return;
  updateCard(state.openCardId, { priority: btn.dataset.priority });
  syncModal();
});

columnSelect.addEventListener('change', () => {
  const card = state.board.cards[state.openCardId];
  const to = findColumn(columnSelect.value);
  if (!card || !to || !state.online) return;
  moveCard(card.id, to.id, to.cardIds.length);
  syncModal();
});

$('#cardDelete').addEventListener('click', () => {
  const card = state.board.cards[state.openCardId];
  if (!card || !state.online) return;
  if (!confirm(`Удалить задачу «${card.title}»?`)) return;
  state.openCardId = null;
  modal.close();
  deleteCard(card.id);
});

modal.addEventListener('close', () => {
  saveModalText();
  state.openCardId = null;
});

// Клик по затемнённому фону закрывает окно.
modal.addEventListener('click', (e) => {
  if (e.target === modal) modal.close();
});

// ---------- Фильтр по важности ----------

function applyFilter(value) {
  state.filter = value === 'all' || PRIORITIES.includes(value) ? value : 'all';
  for (const chip of document.querySelectorAll('[data-filter]')) {
    chip.classList.toggle('is-active', chip.dataset.filter === state.filter);
  }
  storageSet(FILTER_KEY, state.filter);
  render();
}

document.querySelector('.filter').addEventListener('click', (e) => {
  const chip = e.target.closest('[data-filter]');
  if (chip) applyFilter(chip.dataset.filter);
});

// ---------- Запуск ----------

applyFilter(storageGet(FILTER_KEY) || 'all');
startAuth();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
