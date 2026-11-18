import {
  TODO, IN_PROGRESS, DONE, indexNodes, makeStateResolver, nextState, spread, subtreeIds, visibleRows,
  childProgress, isInside, topLevelOf, outlineText, parseOutline, dayStart, isOldDone, firstActivity, statePatch,
} from './model.js';
import { createLocalStore } from './store.js';
import { sanitizeHtml, htmlIsEmpty, escapeHtml } from './richtext.js';

const $ = (sel) => document.querySelector(sel);
const params = new URLSearchParams(location.search);
const LOCAL = params.has('local');
const DEFAULT_CATEGORIES = ['Work', 'Home', 'Church'];
const START = Symbol('start');
const END = Symbol('end');
const MAC = /Mac|iPhone|iPad/.test(navigator.platform);

const ICONS = {
  check: '<svg viewBox="0 0 20 20" aria-hidden="true"><rect class="box" x="2.5" y="2.5" width="15" height="15" rx="3"/>'
    + '<path class="slash" d="M6.2 13.8L13.8 6.2"/><path class="cross" d="M6.2 6.2L13.8 13.8"/></svg>',
  caret: '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M1.5 3.5h9L6 9z"/></svg>',
  folder: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M2.5 5.5A1.5 1.5 0 0 1 4 4h3.6l1.8 1.8H16a1.5 1.5 0 0 1 1.5 1.5v7.2A1.5 1.5 0 0 1 16 16H4a1.5 1.5 0 0 1-1.5-1.5z"/></svg>',
  chevron: '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M3.5 1.5L9 6l-5.5 4.5z"/></svg>',
  plus: '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M6 2v8M2 6h8"/></svg>',
};
const STATE_LABEL = { [TODO]: 'To do', [IN_PROGRESS]: 'In progress', [DONE]: 'Done' };

// ---------------------------------------------------------------- state
let backend = null;               // firebase-backend.js module (null in local mode)
let store = null;
let user = null;
let unsubscribe = null;
let nodesById = new Map();        // working copy: last snapshot plus our own writes, applied immediately
let index = indexNodes([]);
let resolver = makeStateResolver(index);
let rows = [];                    // visible rows in display order
let showHistory = lsGet('todo.showHistory') === '1';
let journalOpen = false;
let todayStart = dayStart();
let seeded = false;
let migrated = false;

const selected = new Set();
let anchorId = null;              // where a Shift-click range starts
let cursorId = null;              // the row the keyboard acts on
let lastWorkedId = null;          // most recent cursor row, for adding items when nothing is selected
let editing = null;               // { id, isNew } while a title is being edited
let descFocusId = null;           // row whose (still empty) description editor is open
let descSession = 0;
let descTimer = null;

const unconfirmed = [];          // writes sent to the store but not yet confirmed (see exec)
const undoStack = [];
const redoStack = [];
let clip = null;                  // { text, docs, roots } from the last copy/cut, for structure-preserving paste
let suppressClickUntil = 0;
let wasEditingAtPress = false;    // whether a name was being typed when the current click began
const rowEls = new Map();         // id → row element record

function lsGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } }
const node = (id) => index.byId.get(id);

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
function iconButton(cls, icon, label) {
  const b = el('button', cls);
  b.type = 'button';
  b.innerHTML = icon;
  b.setAttribute('aria-label', label);
  b.title = label;
  return b;
}
const isTyping = (t) => t instanceof Element && !!t.closest('input, textarea, [contenteditable="true"]');

// ---------------------------------------------------------------- startup / sign-in
boot();

/** Re-render just after each midnight, so tasks checked off yesterday drop out of view. */
function scheduleMidnight() {
  const next = dayStart() + 864e5 + 1000;
  setTimeout(() => { render(); scheduleMidnight(); }, Math.max(1000, next - Date.now()));
}

async function boot() {
  registerServiceWorker();
  scheduleMidnight();
  document.addEventListener('visibilitychange', () => { if (!document.hidden && dayStart() !== todayStart) render(); });
  wireStaticUi();
  if (LOCAL) { start(createLocalStore(undefined, { lag: params.has('lag') }), null); return; }
  try {
    backend = await import('./firebase-backend.js');
  } catch (e) {
    console.error(e);
    $('#loading').textContent = 'Could not load Firebase. Check your connection and reload.';
    return;
  }
  backend.watchAuth((u) => (u ? start(backend.createStore(u.uid), u) : showSignIn()));
}

function showSignIn() {
  stop();
  $('#loading').hidden = true;
  $('#app').hidden = true;
  $('#signin').hidden = false;
}

function start(newStore, u) {
  stop();
  store = newStore;
  user = u;
  seeded = migrated = false;
  $('#loading').hidden = true;
  $('#signin').hidden = true;
  $('#app').hidden = false;
  unsubscribe = store.subscribe(onData, onError);
}

function stop() {
  unsubscribe?.();
  unsubscribe = null;
  store = null;
  for (const rec of rowEls.values()) rec.li.remove();
  rowEls.clear();
  selected.clear();
  undoStack.length = redoStack.length = 0;
  unconfirmed.length = 0;
  editing = null;
}

function onData(list, meta) {
  nodesById = new Map(list.map((n) => [n.id, n]));
  for (const { ops } of unconfirmed) applyLocally(ops);
  reindex();
  $('#banner').hidden = true;
  setSync(meta);
  if (!meta.fromCache) {
    if (!migrated) {
      // Earlier versions had a separate top-level "context" type; those are plain categories now.
      migrated = true;
      const ops = list.filter((n) => n.type === 'context')
        .map((n) => ({ type: 'update', id: n.id, patch: { type: 'category', collapsed: n.collapsed ?? false } }));
      // Items from before dates were tracked: fill in dates from when they were last saved.
      for (const n of list) {
        const when = toMillis(n.updatedAt) ?? n.createdAt ?? Date.now();
        const patch = {};
        if (n.createdAt == null) patch.createdAt = when;
        if (n.type === 'task' && n.state === DONE && n.completedAt == null) patch.completedAt = when;
        if (n.type === 'task' && n.state === IN_PROGRESS && n.startedAt == null) patch.startedAt = when;
        if (Object.keys(patch).length) ops.push({ type: 'update', id: n.id, patch });
      }
      if (ops.length) exec(ops, { record: false });
    }
    if (!seeded && list.length === 0) {
      seeded = true;
      exec(seedOps(), { record: false });
      return;
    }
  }
  render();
}

function onError(err) {
  console.error(err);
  const b = $('#banner');
  b.hidden = false;
  b.textContent = err?.code === 'permission-denied'
    ? 'Firestore refused access. Publish the rules from firestore.rules in the Firebase console.'
    : `Sync error: ${err?.message ?? err}`;
}

function setSync(meta) {
  const s = $('#sync');
  if (store?.local) { s.className = 'sync'; s.textContent = 'Local only'; s.title = 'Saved in this browser only'; return; }
  if (meta.pending) { s.className = 'sync pending'; s.textContent = ''; s.title = 'Saving…'; }
  else if (meta.fromCache) { s.className = 'sync'; s.textContent = 'Offline'; s.title = 'Offline — changes will sync later'; }
  else { s.className = 'sync ok'; s.textContent = ''; s.title = 'Synced'; }
}

function seedOps() {
  const ops = [];
  let n = 0;
  const add = (parentId, type, title, extra = {}) => {
    const id = store.newId();
    ops.push({ type: 'set', id, data: {
      parentId, type, title, order: ++n * 1000, collapsed: false, createdAt: Date.now(),
      ...(type === 'task' ? { state: TODO } : {}), ...extra,
    } });
    return id;
  };
  const cats = DEFAULT_CATEGORIES.map((t) => add(null, 'category', t));
  if (LOCAL && params.has('demo')) {
    const [work, home] = cats;
    const ago = (days, hour = 10) => { const d = new Date(Date.now() - days * 864e5); d.setHours(hour, 0, 0, 0); return d.getTime(); };
    const report = add(work, 'task', 'Quarterly report', {
      desc: '<div>Due <b>Friday</b>. Pieces:</div><ul><li>numbers from finance</li><li><i>short</i> summary</li></ul>',
      descOpen: true, createdAt: ago(9),
    });
    add(report, 'task', 'Gather numbers', { state: DONE, createdAt: ago(9), startedAt: ago(3), completedAt: Date.now() });
    add(report, 'task', 'Write summary', { createdAt: ago(9) });
    add(report, 'task', 'Review with team', { createdAt: ago(9) });
    add(work, 'task', 'Update onboarding docs', { state: IN_PROGRESS, createdAt: ago(20), startedAt: ago(1) });
    add(work, 'task', 'Book travel', { createdAt: ago(2) });
    add(work, 'task', 'Expense report', { state: DONE, createdAt: ago(5), completedAt: Date.now() });
    add(work, 'task', 'Submit timesheet', { state: DONE, createdAt: ago(8), startedAt: ago(8), completedAt: ago(7, 16) });
    const yard = add(home, 'category', 'Yard');
    add(yard, 'task', 'Rake leaves', { createdAt: ago(4) });
    add(home, 'task', 'Fix faucet', { desc: '<div>Kitchen, drips when off.</div>', createdAt: ago(12) });
    add(home, 'task', 'Renew passport', { state: DONE, createdAt: ago(400), completedAt: ago(40) });
  }
  return ops;
}

// ---------------------------------------------------------------- writes and undo/redo
function reindex() {
  const list = [...nodesById.values()].map((n) => (n.type === 'context' ? { ...n, type: 'category' } : n));
  index = indexNodes(list);
  resolver = makeStateResolver(index);
}

/** Firestore Timestamp, Date or number → milliseconds. */
function toMillis(t) {
  if (t == null) return null;
  if (typeof t === 'number') return t;
  if (typeof t.toMillis === 'function') return t.toMillis();
  if (t instanceof Date) return t.getTime();
  return null;
}

const docOf = (n) => {
  if (!n) return null;
  const { id, updatedAt, ...data } = n;
  return data;
};

/**
 * Apply ops to the store and to the working copy right away, then re-render.
 * Recorded ops go on the undo stack; ops sharing `key` with the top entry merge into it
 * (so creating an item and typing its name, or a run of description edits, undo as one step).
 */
function exec(ops, { record = true, key = null } = {}) {
  ops = ops.filter(Boolean);
  if (!ops.length || !store) return;
  if (record) recordHistory(ops, key);
  // Until the store confirms this write, re-apply it on top of every incoming snapshot: an update that was
  // already on its way can arrive without it, and must not make a just-created item vanish for a moment.
  const entry = { ops };
  unconfirmed.push(entry);
  Promise.resolve(store.apply(ops)).finally(() => {
    const i = unconfirmed.indexOf(entry);
    if (i >= 0) unconfirmed.splice(i, 1);
  });
  applyLocally(ops);
  reindex();
  render();
}

function applyLocally(ops) {
  for (const op of ops) {
    if (op.type === 'set') nodesById.set(op.id, { id: op.id, ...op.data });
    else if (op.type === 'update') {
      const n = nodesById.get(op.id);
      if (n) nodesById.set(op.id, { ...n, ...op.patch });
    } else nodesById.delete(op.id);
  }
}

function recordHistory(ops, key) {
  const before = new Map();
  const after = new Map();
  for (const op of ops) {
    if (!before.has(op.id)) before.set(op.id, docOf(nodesById.get(op.id)));
    const prev = after.has(op.id) ? after.get(op.id) : docOf(nodesById.get(op.id));
    after.set(op.id, op.type === 'set' ? { ...op.data }
      : op.type === 'update' ? (prev ? { ...prev, ...op.patch } : null)
      : null);
  }
  const top = undoStack.at(-1);
  if (key && top?.key === key) {
    for (const [id, v] of after) {
      if (!top.before.has(id)) top.before.set(id, before.get(id));
      top.after.set(id, v);
    }
  } else {
    undoStack.push({ key, before, after });
    if (undoStack.length > 500) undoStack.shift();
  }
  redoStack.length = 0;
}

const opsFrom = (m) => [...m].map(([id, d]) => (d ? { type: 'set', id, data: d } : { type: 'delete', id }));

function undo() {
  finishEditing();
  const e = undoStack.pop();
  if (!e) return;
  redoStack.push(e);
  exec(opsFrom(e.before), { record: false });
  selectIds([...e.before].filter(([, d]) => d).map(([id]) => id));
}

function redo() {
  finishEditing();
  const e = redoStack.pop();
  if (!e) return;
  undoStack.push(e);
  exec(opsFrom(e.after), { record: false });
  selectIds([...e.after].filter(([, d]) => d).map(([id]) => id));
}

function finishEditing() {
  commitEdit();
  const a = document.activeElement;
  if (a?.classList?.contains('desc')) a.blur();
}

// ---------------------------------------------------------------- rendering
function render() {
  if (!store) return;
  todayStart = dayStart();
  document.body.classList.toggle('history', showHistory);
  $('#tbHistory').setAttribute('aria-pressed', String(showHistory));
  rows = visibleRows(index, null, { visible: isShown });
  const visible = new Set(rows.map((r) => r.node.id));
  for (const id of [...selected]) if (!visible.has(id)) selected.delete(id);
  if (cursorId && !visible.has(cursorId)) cursorId = null;
  if (cursorId) lastWorkedId = cursorId;
  if (editing && !visible.has(editing.id)) editing = null;

  const keep = captureFocus();
  const ul = $('#tree');
  const seen = new Set();
  rows.forEach((row, i) => {
    let rec = rowEls.get(row.node.id);
    if (!rec) { rec = createRow(row.node.id); rowEls.set(row.node.id, rec); }
    updateRow(rec, row);
    seen.add(row.node.id);
    const at = ul.children[i];
    if (at !== rec.li) ul.insertBefore(rec.li, at ?? null);
  });
  for (const [id, rec] of rowEls) if (!seen.has(id)) { rec.li.remove(); rowEls.delete(id); }
  restoreFocus(keep);

  $('#empty').hidden = rows.length > 0;
  document.body.classList.toggle('journal-view', journalOpen);
  $('#tbJournal').setAttribute('aria-pressed', String(journalOpen));
  $('#journal').hidden = !journalOpen;
  if (journalOpen) renderJournal();
  $('#tbCopy').disabled = $('#tbCut').disabled = $('#tbDelete').disabled = selected.size === 0 || journalOpen;
  $('#tbNew').disabled = $('#tbPaste').disabled = $('#tbHistory').disabled = journalOpen;
  $('#tbUndo').disabled = undoStack.length === 0;
  $('#tbRedo').disabled = redoStack.length === 0;
}

function createRow(id) {
  const li = el('li', 'row');
  li.dataset.id = id;
  li.setAttribute('role', 'treeitem');
  const line = el('div', 'line');

  const caret = iconButton('caret', ICONS.caret, 'Collapse');
  caret.tabIndex = -1;
  caret.addEventListener('click', (e) => { e.stopPropagation(); toggleCollapsed(id); });

  const check = iconButton('check', ICONS.check, 'To do');
  check.tabIndex = -1;
  wireCheckbox(check, id);

  const icon = el('span', 'cat-icon');
  icon.innerHTML = ICONS.folder;

  const title = el('span', 'title');

  const descBtn = iconButton('desc-btn', ICONS.chevron, 'Show description');
  descBtn.tabIndex = -1;
  descBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const n = node(id);
    if (n) exec([{ type: 'update', id, patch: { descOpen: !n.descOpen } }], { record: false });
  });

  const progress = el('span', 'progress');

  const addDesc = iconButton('add-desc', ICONS.plus, 'Add a description');
  addDesc.tabIndex = -1;
  addDesc.addEventListener('click', (e) => { e.stopPropagation(); openDescription(id); });

  // Created / started / completed dates, shown on the right while "Show task history" is on.
  const dates = el('span', 'dates');
  const dateCells = {};
  for (const field of DATE_FIELDS) {
    const b = el('button', 'date');
    b.type = 'button';
    b.tabIndex = -1;
    b.addEventListener('click', (e) => { e.stopPropagation(); editDate(id, field, b); });
    dates.append(b);
    dateCells[field] = b;
  }

  line.append(caret, check, icon, title, descBtn, progress, addDesc, dates);
  line.addEventListener('pointerdown', (e) => dragPointerDown(e, id));
  line.addEventListener('click', (e) => onRowClick(e, id));
  line.addEventListener('dblclick', (e) => { if (!e.target.closest('button, input')) startEdit(id); });
  line.addEventListener('contextmenu', (e) => onRowContextMenu(e, id));
  li.append(line);
  return { li, line, caret, check, title, descBtn, progress, addDesc, dateCells, input: null, desc: null, descWrap: null };
}

function updateRow(rec, { node: n, depth, hasKids, peek }) {
  const id = n.id;
  const st = resolver.effective(n);
  const isSel = selected.has(id);
  const hasDesc = !htmlIsEmpty(n.desc);
  const showDesc = (hasDesc && n.descOpen) || descFocusId === id;
  rec.li.className = ['row', n.type, st && `st-${st}`, isSel && 'selected', hasKids && n.collapsed && 'collapsed',
    drag?.moving?.has(id) && 'drag-src', n.type === 'task' && n.bold && 'bold', peek && 'peek']
    .filter(Boolean).join(' ');
  rec.li.setAttribute('aria-selected', String(isSel));
  rec.li.style.setProperty('--depth', depth);

  rec.caret.disabled = !hasKids;
  rec.caret.title = n.collapsed ? 'Expand' : 'Collapse';
  rec.caret.setAttribute('aria-label', rec.caret.title);
  if (st) {
    rec.check.title = `${STATE_LABEL[st]} — click: done · Shift-click or hold: in progress`;
    rec.check.setAttribute('aria-label', `${STATE_LABEL[st]}. Click for done, Shift-click for in progress`);
  }

  if (editing?.id === id) {
    if (!rec.input) {
      const input = el('input', 'title-edit');
      input.type = 'text';
      input.value = n.title ?? '';
      input.autocomplete = 'off';
      input.enterKeyHint = 'done';
      input.setAttribute('aria-label', n.type === 'task' ? 'Task name' : 'Category name');
      input.addEventListener('keydown', (e) => onEditKey(e, id, input));
      input.addEventListener('blur', () => setTimeout(() => {
        if (editing?.id === id && document.activeElement !== input) commitEdit();
      }, 0));
      rec.title.replaceWith(input);
      rec.input = input;
    }
  } else {
    if (rec.input) { const inp = rec.input; rec.input = null; inp.replaceWith(rec.title); }
    rec.title.textContent = n.title || 'Untitled';
    rec.title.classList.toggle('untitled', !n.title);
  }

  rec.descBtn.hidden = !hasDesc;
  rec.descBtn.setAttribute('aria-expanded', String(!!n.descOpen));
  rec.descBtn.title = n.descOpen ? 'Hide description' : 'Show description';
  rec.addDesc.hidden = !(isSel && !hasDesc && descFocusId !== id);

  if (n.type === 'task') {
    const p = childProgress(index, n, resolver.effective);
    rec.progress.textContent = p.total ? `${p.done}/${p.total}` : '';
  }
  if (showHistory) updateDates(rec, n, st);

  if (showDesc) {
    const ed = ensureDescEditor(rec, id);
    rec.descWrap.hidden = false;
    const html = n.desc ?? '';
    if (document.activeElement !== ed && ed.dataset.html !== html) {
      ed.innerHTML = sanitizeHtml(html);
      ed.dataset.html = html;
    }
  } else if (rec.descWrap) {
    rec.descWrap.hidden = true;
  }
}

const DATE_FIELDS = ['createdAt', 'startedAt', 'completedAt'];
const DATE_LABEL = { createdAt: 'Created', startedAt: 'Started', completedAt: 'Completed' };

function updateDates(rec, n, st) {
  for (const field of DATE_FIELDS) {
    const b = rec.dateCells[field];
    let value = n[field] ?? null;
    let derived = false;
    if (field === 'startedAt' && value == null && st && st !== TODO) {
      value = firstActivity(index, n.id); // a parent counts as started when its first subtask was
      derived = value != null;
    }
    if (field === 'completedAt' && st !== DONE) value = null;
    const editable = n.type === 'task' && (field !== 'completedAt' || st === DONE);
    b.textContent = value != null ? shortDate(value) : (editable ? '–' : '');
    b.classList.toggle('derived', derived);
    b.classList.toggle('unset', value == null);
    b.disabled = !editable;
    b.title = value != null
      ? `${DATE_LABEL[field]} ${new Date(value).toLocaleString()}${derived ? ' (from its subtasks)' : ''} — click to change`
      : editable ? `Set ${DATE_LABEL[field].toLowerCase()} date` : '';
  }
}

function shortDate(ms) {
  const d = new Date(ms);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  const md = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return sameYear ? md : `${md} '${String(d.getFullYear()).slice(2)}`;
}

const pad2 = (x) => String(x).padStart(2, '0');
const toDateInput = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; };

let dateSession = 0;

/** Edit one of a task's dates with the browser's date picker, keeping the original time of day. */
function editDate(id, field, cell) {
  const n = node(id);
  if (!n) return;
  commitEdit();
  closeDateEditor();
  const key = `date:${id}:${field}:${++dateSession}`;
  const input = el('input', 'date-editor');
  input.type = 'date';
  input.id = 'dateEditor';
  const shown = n[field] ?? (field === 'startedAt' ? firstActivity(index, id) : null);
  input.value = toDateInput(shown ?? Date.now());
  input.max = toDateInput(Date.now() + 366 * 864e5);
  const r = cell.getBoundingClientRect();
  input.style.left = `${Math.max(4, Math.min(r.right - 130, innerWidth - 134))}px`;
  input.style.top = `${r.top - 3}px`;
  document.body.append(input);

  const save = () => {
    const cur = node(id);
    if (!cur) return;
    let value = null;
    if (input.value) {
      const [y, m, d] = input.value.split('-').map(Number);
      const old = new Date(cur[field] ?? shown ?? new Date().setHours(12, 0, 0, 0));
      value = new Date(y, m - 1, d, old.getHours(), old.getMinutes(), old.getSeconds()).getTime();
    } else if (field !== 'startedAt') {
      return; // created and completed dates can be changed but not removed
    }
    if (value !== (cur[field] ?? null)) exec([{ type: 'update', id, patch: { [field]: value } }], { key });
  };
  input.addEventListener('change', save);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); save(); closeDateEditor(); }
    else if (e.key === 'Escape') {
      e.preventDefault();
      if (undoStack.at(-1)?.key === key) undo(); // put back what it was
      closeDateEditor();
    }
  });
  input.addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== input) closeDateEditor(); }, 0));
  input.focus();
  try { input.showPicker?.(); } catch { /* not allowed here; typing the date still works */ }
}

function closeDateEditor() {
  document.getElementById('dateEditor')?.remove();
}

/** Remember the focused editor so it can be refocused if re-rendering moved its row. */
function captureFocus() {
  const a = document.activeElement;
  if (!(a instanceof Element) || !a.closest('#tree')) return null;
  const s = getSelection();
  return { el: a, range: s.rangeCount ? s.getRangeAt(0).cloneRange() : null, start: a.selectionStart, end: a.selectionEnd };
}

function restoreFocus(keep) {
  if (!keep || document.activeElement === keep.el || !keep.el.isConnected) return;
  keep.el.focus({ preventScroll: true });
  if (keep.el.tagName === 'INPUT') {
    try { keep.el.setSelectionRange(keep.start, keep.end); } catch { /* ignore */ }
  } else if (keep.range) {
    const s = getSelection();
    s.removeAllRanges();
    s.addRange(keep.range);
  }
}

// ---------------------------------------------------------------- selection
function selectOnly(id) {
  selected.clear();
  if (id) selected.add(id);
  anchorId = cursorId = id ?? null;
}

function selectIds(ids) {
  const shown = new Set(rows.map((r) => r.node.id));
  ids = ids.filter((id) => shown.has(id));
  if (!ids.length) { render(); return; }
  selected.clear();
  for (const id of ids) selected.add(id);
  anchorId = ids[0];
  cursorId = ids.at(-1);
  render();
}

function selectRangeTo(id) {
  const a = rows.findIndex((r) => r.node.id === (anchorId ?? id));
  const b = rows.findIndex((r) => r.node.id === id);
  if (a < 0 || b < 0) { selectOnly(id); return; }
  selected.clear();
  for (let i = Math.min(a, b); i <= Math.max(a, b); i++) selected.add(rows[i].node.id);
  cursorId = id;
}

/** Selected items without their selected descendants, in display order. */
function selectionTops() {
  const pos = new Map(rows.map((r, i) => [r.node.id, i]));
  return topLevelOf(index, [...selected]).sort((a, b) => (pos.get(a) ?? 1e9) - (pos.get(b) ?? 1e9));
}

function onRowClick(e, id) {
  e.stopPropagation(); // the "click on empty space" handler must not see row clicks
  if (Date.now() < suppressClickUntil || e.target.closest('button, input')) return;
  if (editing && editing.id !== id) commitEdit();
  if (editing?.id === id) return;
  if (e.shiftKey) selectRangeTo(id);
  else if (e.metaKey || e.ctrlKey) {
    if (selected.has(id)) selected.delete(id); else selected.add(id);
    anchorId = cursorId = id;
  } else {
    // A second click on the name of the (only) selected item starts editing it, like renaming in Finder.
    if (selected.size === 1 && selected.has(id) && e.detail === 1 && e.target.closest('.title')) {
      startEdit(id);
      return;
    }
    selectOnly(id);
  }
  render();
}

function moveCursor(dir, extend) {
  if (!rows.length) return;
  let i = rows.findIndex((r) => r.node.id === cursorId);
  i = i < 0 ? (dir > 0 ? 0 : rows.length - 1) : Math.max(0, Math.min(rows.length - 1, i + dir));
  const id = rows[i].node.id;
  if (extend) selectRangeTo(id); else selectOnly(id);
  render();
  rowEls.get(id)?.li.scrollIntoView({ block: 'nearest' });
}

// ---------------------------------------------------------------- checkbox / state
function wireCheckbox(btn, id) {
  let timer = null;
  const cancel = () => { clearTimeout(timer); timer = null; };
  btn.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse') {
      if (e.shiftKey) e.preventDefault(); // keep Shift-click from selecting text
      return;
    }
    cancel();
    timer = setTimeout(() => {
      timer = null;
      suppressClickUntil = Date.now() + 800;
      navigator.vibrate?.(15);
      setStates([id], true);
    }, 450);
  });
  btn.addEventListener('pointerup', cancel);
  btn.addEventListener('pointercancel', cancel);
  btn.addEventListener('pointerleave', cancel);
  btn.addEventListener('contextmenu', (e) => e.preventDefault());
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (Date.now() < suppressClickUntil) return;
    setStates([id], e.shiftKey);
  });
}

/** Apply a click (done) or Shift-click (in progress) to tasks; the first task decides the new state. */
function setStates(ids, inProgressGesture) {
  const tasks = ids.map(node).filter((n) => n?.type === 'task');
  if (!tasks.length) return;
  commitEdit();
  const first = tasks[0];
  const s = nextState(first.state ?? TODO, resolver.effective(first), inProgressGesture);
  const now = Date.now();
  exec(tasks.map((n) => ({ type: 'update', id: n.id, patch: statePatch(n, s, now) })));
}

function toggleCollapsed(id, value) {
  const n = node(id);
  if (!n) return;
  const collapsed = value ?? !n.collapsed;
  if (!!n.collapsed !== collapsed) exec([{ type: 'update', id, patch: { collapsed } }], { record: false });
}

// ---------------------------------------------------------------- title editing
function startEdit(id, { isNew = false, caret = 'end' } = {}) {
  if (!node(id)) return;
  if (editing && editing.id !== id) commitEdit();
  editing = { id, isNew };
  selectOnly(id);
  render();
  const inp = rowEls.get(id)?.input;
  if (inp) {
    inp.focus();
    const pos = caret === 'start' ? 0 : inp.value.length;
    inp.setSelectionRange(pos, pos);
    inp.scrollIntoView({ block: 'nearest' });
  }
}

function commitEdit() {
  if (!editing) return;
  const { id, isNew } = editing;
  const inp = rowEls.get(id)?.input;
  editing = null;
  const n = node(id);
  if (!n || !inp) { render(); return; }
  const title = inp.value.trim();
  if (!title && !index.children(id).length && htmlIsEmpty(n.desc)) {
    // An item left with no name (and nothing under it) goes away, and the one above it becomes the selection,
    // so the next new task lands back in the same list. A brand-new one leaves no undo step behind.
    const above = neighborRow(id, -1);
    if (isNew && undoStack.at(-1)?.key === `new:${id}`) {
      undoStack.pop();
      exec([{ type: 'delete', id }], { record: false });
    } else {
      exec([{ type: 'delete', id }]);
    }
    if (above && node(above)) { selectOnly(above); render(); }
  } else if (title !== (n.title ?? '')) {
    exec([{ type: 'update', id, patch: { title } }], { key: isNew ? `new:${id}` : null });
  } else {
    render();
  }
}

/** Save the title being typed without leaving edit mode (before indenting, etc.). */
function saveTitleNow() {
  if (!editing) return;
  const { id, isNew } = editing;
  const inp = rowEls.get(id)?.input;
  const n = node(id);
  const title = inp?.value.trim();
  if (n && inp && title !== (n.title ?? '')) {
    exec([{ type: 'update', id, patch: { title } }], { key: isNew ? `new:${id}` : null });
  }
}

function onEditKey(e, id, input) {
  if (e.isComposing) return;
  const n = node(id);
  if (!n) return;
  const empty = input.value.trim() === '';
  const keepEditing = (pos = input.selectionStart) => {
    const inp = rowEls.get(id)?.input;
    if (inp && document.activeElement !== inp) { inp.focus(); inp.setSelectionRange(pos, pos); }
  };
  switch (e.key) {
    case 'Enter': {
      e.preventDefault();
      if (empty && !e.shiftKey) {
        // Like a list in a document: Return on an empty item moves it out a level, or ends the list.
        const parent = n.parentId && node(n.parentId);
        if (parent?.type === 'task') { selectOnly(id); outdentSelection(); keepEditing(0); }
        else commitEdit();
        return;
      }
      const { selectionStart: from, selectionEnd: to, value } = input;
      if (!e.shiftKey && from === 0 && to === 0) {
        // Return at the very start of a name opens a new row above it, as in a document.
        commitEdit();
        if (node(id)) createItem({ type: n.type, parentId: n.parentId ?? null, afterRef: siblingBefore(id) });
        return;
      }
      if (e.shiftKey && value.slice(0, from).trim() && value.slice(to).trim()) {
        splitItem(id, value.slice(0, from), value.slice(to));
        return;
      }
      commitEdit();
      if (!node(id)) return;
      if (e.shiftKey) createItem({ type: 'task', parentId: id, afterRef: END });
      else createItem({ type: 'task', ...placeBelow(id) });
      return;
    }
    case 'b': case 'B':
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey) {
        e.preventDefault();
        saveTitleNow();
        toggleBold([id]);
        keepEditing();
      }
      return;
    case 'Escape':
      e.preventDefault();
      commitEdit();
      return;
    case 'Tab':
      e.preventDefault();
      saveTitleNow();
      selectOnly(id);
      if (e.shiftKey) outdentSelection(); else indentSelection();
      keepEditing();
      return;
    case 'Backspace':
      if (empty && !index.children(id).length) {
        // Remove the empty item and carry on at the end of the one above.
        e.preventDefault();
        const prev = neighborRow(id, -1);
        commitEdit();
        if (prev && node(prev)) startEdit(prev);
      }
      return;
    case 'ArrowUp':
    case 'ArrowDown': {
      if (e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return;
      e.preventDefault();
      const target = neighborRow(id, e.key === 'ArrowUp' ? -1 : 1);
      commitEdit();
      if (target && node(target)) startEdit(target);
      return;
    }
  }
}

function neighborRow(id, dir) {
  const i = rows.findIndex((r) => r.node.id === id);
  return i < 0 ? null : rows[i + dir]?.node.id ?? null;
}

/** Where Return puts a new task: first inside a category or an expanded parent, otherwise right after. */
function placeBelow(id) {
  const n = id && node(id);
  if (!n) return { parentId: null, afterRef: END };
  const openKids = !n.collapsed && index.children(id).some(isShown);
  if (n.type === 'category' || openKids) return { parentId: id, afterRef: START };
  return { parentId: n.parentId ?? null, afterRef: id };
}

/** The sibling just before id (START if it's the first), for inserting a new item above it. */
function siblingBefore(id) {
  const n = node(id);
  const sibs = index.children(n.parentId ?? null);
  const i = sibs.findIndex((s) => s.id === id);
  return i > 0 ? sibs[i - 1].id : START;
}

/** Shift-Return inside a name: the text after the cursor becomes the next item, and typing carries on there. */
function splitItem(id, before, after) {
  const n = node(id);
  if (!n || !store) return;
  editing = null; // the name is saved below, so the editor mustn't save the whole text again
  const where = n.type === 'task' ? placeBelow(id) : { parentId: n.parentId ?? null, afterRef: id };
  const nid = store.newId();
  const [order] = placeOrders(where.parentId, where.afterRef, new Set(), 1);
  const data = { parentId: where.parentId, type: n.type, title: after.trim(), order, collapsed: false, createdAt: Date.now() };
  if (n.type === 'task') data.state = TODO;
  exec([
    { type: 'update', id, patch: { title: before.trim() } },
    { type: 'set', id: nid, data },
    expandOp(where.parentId),
  ], { key: `new:${nid}` });
  startEdit(nid, { isNew: true, caret: 'start' });
}

/** ⌘B: mark tasks bold (top priority, kept in view when their category is collapsed), or unmark them. */
function toggleBold(ids) {
  const tasks = ids.map(node).filter((n) => n?.type === 'task');
  if (!tasks.length) return;
  const bold = !tasks[0].bold;
  exec(tasks.map((n) => ({ type: 'update', id: n.id, patch: { bold } })));
}

// ---------------------------------------------------------------- structure edits
// Tasks checked off before today are hidden unless "Show task history" is on.
const isShown = (n) => showHistory || !isOldDone(n, todayStart);

/** k order values for items placed in parentId after afterRef (a sibling id, START or END), ignoring `exclude`. */
function placeOrders(parentId, afterRef, exclude, k) {
  const sibs = index.children(parentId).filter((s) => !exclude.has(s.id));
  let a = null;
  let b = null;
  if (afterRef === START) b = sibs[0]?.order;
  else if (afterRef === END) a = sibs.at(-1)?.order;
  else {
    const i = sibs.findIndex((s) => s.id === afterRef);
    a = sibs[i]?.order;
    b = sibs[i + 1]?.order;
  }
  return spread(a, b, k);
}

/** Where a new or pasted item goes relative to the selection: inside a category, or just after a task. */
function insertionFor(id) {
  const n = id && node(id);
  if (!n) return { parentId: null, afterRef: END };
  if (n.type === 'category') return { parentId: n.id, afterRef: END };
  return { parentId: n.parentId ?? null, afterRef: n.id };
}

/** The row new items go next to: the selection, or else the row you last worked on (so they stay in that list). */
function insertionTarget() {
  const sel = (cursorId && selected.has(cursorId)) ? cursorId : selectionTops().at(-1);
  if (sel) return sel;
  return lastWorkedId && rows.some((r) => r.node.id === lastWorkedId) ? lastWorkedId : null;
}

function expandOp(parentId) {
  const p = parentId && node(parentId);
  return p?.collapsed ? { type: 'update', id: parentId, patch: { collapsed: false } } : null;
}

function createItem({ type = 'task', parentId = null, afterRef = END }) {
  if (!store) return;
  commitEdit();
  const id = store.newId();
  const [order] = placeOrders(parentId, afterRef, new Set(), 1);
  const data = { parentId, type, title: '', order, collapsed: false, createdAt: Date.now() };
  if (type === 'task') data.state = TODO;
  exec([{ type: 'set', id, data }, expandOp(parentId)], { key: `new:${id}` });
  startEdit(id, { isNew: true });
}

function newItem(type = 'task') {
  const target = insertionTarget();
  if (type === 'category' || !target) createItem({ type, ...insertionFor(target) });
  else createItem({ type, ...placeBelow(target) });
}

function moveItems(ids, parentId, afterRef) {
  if (!ids.length) return;
  const moving = new Set(ids);
  if (parentId != null && isInside(index, parentId, moving)) return;
  const orders = placeOrders(parentId, afterRef, moving, ids.length);
  exec([
    ...ids.map((id, i) => ({ type: 'update', id, patch: { parentId, order: orders[i] } })),
    expandOp(parentId),
  ]);
}

function indentSelection() {
  const tops = selectionTops();
  const sel = new Set(tops);
  const plan = new Map(); // new parent id → ids to append, in order
  for (const id of tops) {
    const n = node(id);
    const sibs = index.children(n.parentId ?? null).filter(isShown);
    let j = sibs.findIndex((s) => s.id === id) - 1;
    while (j >= 0 && sel.has(sibs[j].id)) j--;
    if (j < 0) continue;
    const np = sibs[j].id;
    if (!plan.has(np)) plan.set(np, []);
    plan.get(np).push(id);
  }
  const ops = [];
  for (const [np, ids] of plan) {
    const orders = placeOrders(np, END, new Set(ids), ids.length);
    ids.forEach((id, i) => ops.push({ type: 'update', id, patch: { parentId: np, order: orders[i] } }));
    ops.push(expandOp(np));
  }
  exec(ops);
}

function outdentSelection() {
  const plan = new Map(); // old parent id → ids
  for (const id of selectionTops()) {
    const p = node(id).parentId;
    if (p == null) continue;
    if (!plan.has(p)) plan.set(p, []);
    plan.get(p).push(id);
  }
  const ops = [];
  for (const [p, ids] of plan) {
    const pp = node(p).parentId ?? null;
    const orders = placeOrders(pp, p, new Set(ids), ids.length);
    ids.forEach((id, i) => ops.push({ type: 'update', id, patch: { parentId: pp, order: orders[i] } }));
  }
  exec(ops);
}

function moveSelection(dir) {
  const tops = selectionTops();
  if (!tops.length) return;
  const parentId = node(tops[0]).parentId ?? null;
  if (tops.some((id) => (node(id).parentId ?? null) !== parentId)) return;
  const sel = new Set(tops);
  const sibs = index.children(parentId).filter(isShown);
  const idx = tops.map((id) => sibs.findIndex((s) => s.id === id)).sort((a, b) => a - b);
  if (dir < 0) {
    const prev = sibs[idx[0] - 1];
    if (!prev) return;
    const others = sibs.filter((s) => !sel.has(s.id));
    const k = others.indexOf(prev);
    moveItems(tops, parentId, k > 0 ? others[k - 1].id : START);
  } else {
    const next = sibs[idx.at(-1) + 1];
    if (!next) return;
    moveItems(tops, parentId, next.id);
  }
}

function convertSelection() {
  const ns = selectionTops().map(node);
  if (!ns.length) return;
  const toCategory = ns[0].type === 'task';
  exec(ns.map((n) => ({ type: 'update', id: n.id, patch: toCategory
    ? { type: 'category' }
    : { type: 'task', state: n.state ?? TODO } })));
}

function deleteSelection() {
  const tops = selectionTops();
  if (!tops.length) return;
  commitEdit();
  const all = tops.flatMap((id) => subtreeIds(index, id));
  const gone = new Set(all);
  let next = null;
  const last = rows.findIndex((r) => r.node.id === tops.at(-1));
  for (let i = last + 1; i < rows.length && !next; i++) if (!gone.has(rows[i].node.id)) next = rows[i].node.id;
  const first = rows.findIndex((r) => r.node.id === tops[0]);
  for (let i = first - 1; i >= 0 && !next; i--) if (!gone.has(rows[i].node.id)) next = rows[i].node.id;
  // Deleting keeps the record (with deletedAt) so history isn't lost; deleted items are simply not shown.
  const now = Date.now();
  exec(all.map((id) => ({ type: 'update', id, patch: { deletedAt: now } })));
  selectOnly(next);
  render();
}

function setAllCollapsed(collapsed) {
  const ops = [];
  for (const n of index.byId.values()) {
    if (index.children(n.id).length && !!n.collapsed !== collapsed) {
      ops.push({ type: 'update', id: n.id, patch: { collapsed } });
    }
  }
  exec(ops, { record: false });
}

// ---------------------------------------------------------------- clipboard
function copySelection() {
  const tops = selectionTops();
  if (!tops.length) return null;
  const text = outlineText(index, tops);
  const docs = tops.flatMap((id) => subtreeIds(index, id)).map((id) => ({ id, ...docOf(nodesById.get(id)) }));
  clip = { text, docs, roots: tops };
  return text;
}

async function writeClipboard(text) {
  if (text == null) return;
  try { await navigator.clipboard.writeText(text); } catch (e) { console.warn('Clipboard write failed', e); }
}

function cutSelection() {
  const text = copySelection();
  if (text == null) return;
  writeClipboard(text);
  deleteSelection();
}

const sameText = (a, b) => a != null && b != null && a.replace(/\r\n?/g, '\n').trim() === b.replace(/\r\n?/g, '\n').trim();

/**
 * Paste below the selection. Text this app copied comes back with its structure, states and
 * descriptions; any other text becomes tasks, one per line, nested by indentation.
 */
function pasteText(text) {
  if (!store) return;
  commitEdit();
  const { parentId, afterRef } = insertionFor(insertionTarget());
  const ops = [];
  const roots = [];
  if (clip && (text == null || sameText(text, clip.text))) {
    const ids = new Map(clip.docs.map((d) => [d.id, store.newId()]));
    const orders = placeOrders(parentId, afterRef, new Set(), clip.roots.length);
    for (const { id, ...data } of clip.docs) {
      const r = clip.roots.indexOf(id);
      ops.push({ type: 'set', id: ids.get(id), data: {
        ...data, deletedAt: null,
        parentId: r >= 0 ? parentId : ids.get(data.parentId),
        ...(r >= 0 ? { order: orders[r] } : {}),
      } });
      if (r >= 0) roots.push(ids.get(id));
    }
  } else {
    const items = parseOutline(text ?? '');
    if (!items.length) return;
    const orders = placeOrders(parentId, afterRef, new Set(), items.filter((it) => it.level === 0).length);
    const stack = [];
    const counts = new Map();
    let r = 0;
    for (const it of items) {
      const id = store.newId();
      const par = it.level === 0 ? parentId : stack[it.level - 1];
      const order = it.level === 0 ? orders[r++] : (counts.set(par, (counts.get(par) ?? 0) + 1), counts.get(par) * 1000);
      ops.push({ type: 'set', id, data: {
        parentId: par, type: 'task', title: it.title, state: it.state, order, collapsed: false, createdAt: Date.now(),
      } });
      stack.length = it.level;
      stack[it.level] = id;
      if (it.level === 0) roots.push(id);
    }
  }
  exec([...ops, expandOp(parentId)]);
  selectIds(roots);
}

async function pasteFromSystem() {
  let text = null;
  try { text = await navigator.clipboard.readText(); } catch { /* not allowed: fall back to our own clipboard */ }
  if (text == null && !clip) return;
  pasteText(text);
}

// ---------------------------------------------------------------- descriptions
function openDescription(id) {
  const n = node(id);
  if (!n) return;
  commitEdit();
  if (!htmlIsEmpty(n.desc)) {
    if (!n.descOpen) exec([{ type: 'update', id, patch: { descOpen: true } }], { record: false });
  } else {
    descFocusId = id;
    render();
  }
  const ed = rowEls.get(id)?.desc;
  if (ed) {
    ed.focus();
    const r = document.createRange();
    r.selectNodeContents(ed);
    r.collapse(false);
    const s = getSelection();
    s.removeAllRanges();
    s.addRange(r);
  }
}

function ensureDescEditor(rec, id) {
  if (rec.desc) return rec.desc;
  const wrap = el('div', 'desc-wrap');
  const ed = el('div', 'desc');
  ed.contentEditable = 'true';
  ed.dataset.placeholder = 'Description';
  ed.setAttribute('role', 'textbox');
  ed.setAttribute('aria-multiline', 'true');
  ed.setAttribute('aria-label', 'Description');

  ed.addEventListener('focus', () => {
    descSession++;
    if (!selected.has(id)) { commitEdit(); selectOnly(id); render(); }
  });
  ed.addEventListener('input', (e) => {
    if (e.inputType === 'insertText' && e.data === ' ') autoBullet();
    clearTimeout(descTimer);
    descTimer = setTimeout(() => saveDescription(id, ed), 800);
  });
  ed.addEventListener('blur', () => {
    saveDescription(id, ed);
    if (descFocusId === id) { descFocusId = null; render(); }
  });
  ed.addEventListener('keydown', (e) => {
    const mod = e.metaKey || e.ctrlKey;
    const k = e.key.toLowerCase();
    if (e.key === 'Escape') { e.preventDefault(); ed.blur(); }
    else if (mod && e.shiftKey && (e.code === 'Digit8' || e.key === '*')) {
      e.preventDefault();
      document.execCommand('insertUnorderedList');
    } else if (mod && !e.shiftKey && !e.altKey && (k === 'b' || k === 'i' || k === 'u')) {
      e.preventDefault();
      document.execCommand({ b: 'bold', i: 'italic', u: 'underline' }[k]);
    }
  });
  ed.addEventListener('paste', (e) => {
    e.preventDefault();
    const html = e.clipboardData.getData('text/html');
    const text = e.clipboardData.getData('text/plain');
    document.execCommand('insertHTML', false, html ? sanitizeHtml(html) : escapeHtml(text).replace(/\n/g, '<br>'));
  });
  ed.addEventListener('click', (e) => {
    const a = e.target.closest('a[href]');
    if (a && (e.metaKey || e.ctrlKey)) window.open(a.href, '_blank', 'noopener');
  });

  wrap.append(ed);
  rec.li.append(wrap);
  rec.desc = ed;
  rec.descWrap = wrap;
  return ed;
}

/** Typing "- " or "* " at the start of a line turns it into a bulleted list, as in Docs. */
function autoBullet() {
  const s = getSelection();
  if (!s.rangeCount || !s.isCollapsed) return;
  const caret = s.getRangeAt(0);
  const from = caret.startContainer.nodeType === Node.TEXT_NODE ? caret.startContainer.parentElement : caret.startContainer;
  const ed = from.closest('.desc');
  if (!ed) return;
  const li = from.closest('li');
  if (li && ed.contains(li)) return; // already in a list (the row itself is an <li> too, outside the editor)
  const block = from.closest('div, p');
  if (!block || !ed.contains(block) && block !== ed) return;
  // Text from the start of this line (block start, or the last <br>) up to the caret.
  const line = document.createRange();
  line.selectNodeContents(block);
  line.setEnd(caret.startContainer, caret.startOffset);
  const frag = line.cloneContents();
  const brs = frag.querySelectorAll('br');
  if (brs.length) return; // only handle the first line of a block; keeps this simple and predictable
  if (!/^[-*•][ \u00a0]$/.test(line.toString())) return;
  s.removeAllRanges();
  s.addRange(line);
  document.execCommand('delete');
  document.execCommand('insertUnorderedList');
}

function saveDescription(id, ed) {
  clearTimeout(descTimer);
  const n = node(id);
  if (!n) return;
  const html = htmlIsEmpty(ed.innerHTML) ? '' : sanitizeHtml(ed.innerHTML);
  ed.dataset.html = html;
  if ((n.desc ?? '') === html) return;
  const patch = { desc: html };
  if (html && !n.descOpen) patch.descOpen = true;
  exec([{ type: 'update', id, patch }], { key: `desc:${id}:${descSession}` });
}

// ---------------------------------------------------------------- drag and drop
let drag = null;

function dragPointerDown(e, id) {
  if (e.button !== 0 || e.target.closest('button, input') || editing?.id === id) return;
  drag = { id, x: e.clientX, y: e.clientY, lx: e.clientX, ly: e.clientY, pointerId: e.pointerId,
    touch: e.pointerType !== 'mouse', started: false, timer: null, target: null };
  if (drag.touch) {
    // On touch screens, press and hold a row to pick it up (a quick swipe still scrolls).
    drag.timer = setTimeout(() => {
      if (drag && !drag.started) { navigator.vibrate?.(15); beginDrag(); }
    }, 400);
  }
  addEventListener('pointermove', onDragMove, { passive: false });
  addEventListener('pointerup', onDragUp);
  addEventListener('pointercancel', endDrag);
}

function onDragMove(e) {
  if (!drag || e.pointerId !== drag.pointerId) return;
  drag.lx = e.clientX;
  drag.ly = e.clientY;
  if (!drag.started) {
    const d = Math.hypot(e.clientX - drag.x, e.clientY - drag.y);
    if (drag.touch) { if (d > 10) endDrag(); return; }
    if (d < 5) return;
    beginDrag();
  }
  e.preventDefault();
  trackDrag();
}

function beginDrag() {
  clearTimeout(drag.timer);
  if (!selected.has(drag.id)) { commitEdit(); selectOnly(drag.id); }
  drag.ids = selectionTops();
  drag.moving = new Set(drag.ids);
  drag.started = true;
  document.body.classList.add('is-dragging');
  getSelection()?.removeAllRanges();
  const g = $('#ghost');
  const t = node(drag.id)?.title || 'Untitled';
  g.textContent = drag.ids.length > 1 ? `${t}  +${drag.ids.length - 1} more` : t;
  g.hidden = false;
  render();
  trackDrag();
  autoScroll();
}

function trackDrag() {
  const { lx: x, ly: y } = drag;
  $('#ghost').style.transform = `translate(${x + 14}px, ${y + 10}px)`;
  drag.hilite?.classList.remove('drop-inside');
  drag.hilite = null;
  const line = $('#dropLine');
  line.hidden = true;
  drag.target = null;

  const tree = $('#tree');
  const indent = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--indent')) || 16;
  const treeRect = tree.getBoundingClientRect();
  const rowEl = document.elementFromPoint(x, y)?.closest?.('#tree .row');
  let t = null;
  if (rowEl) {
    const n = node(rowEl.dataset.id);
    const row = rows.find((r) => r.node.id === rowEl.dataset.id);
    if (n && row) {
      const lr = rowEl.querySelector('.line').getBoundingClientRect();
      const rel = (y - lr.top) / lr.height;
      const zone = y > lr.bottom || rel > 0.72 ? 'after' : rel < 0.28 ? 'before' : 'inside';
      t = resolveDrop(n, row, zone, lr, rowEl.getBoundingClientRect());
      if (t?.inside) { rowEl.classList.add('drop-inside'); drag.hilite = rowEl; }
    }
  } else if (rows.length && y > tree.lastElementChild.getBoundingClientRect().bottom) {
    t = { parentId: null, afterRef: END, y: tree.lastElementChild.getBoundingClientRect().bottom, depth: 0 };
  }
  if (t && !t.inside) {
    line.hidden = false;
    const left = treeRect.left + t.depth * indent + 18;
    line.style.left = `${left}px`;
    line.style.top = `${t.y - 1}px`;
    line.style.width = `${Math.max(40, treeRect.right - left - 8)}px`;
  }
  drag.target = t;
}

function resolveDrop(n, row, zone, lineRect, rowRect) {
  const moving = drag.moving;
  if (moving.has(n.id)) return null;
  let t;
  if (zone === 'inside') {
    t = { parentId: n.id, afterRef: END, inside: true };
  } else if (zone === 'before') {
    const parentId = n.parentId ?? null;
    const sibs = index.children(parentId).filter((s) => !moving.has(s.id));
    const i = sibs.findIndex((s) => s.id === n.id);
    t = { parentId, afterRef: i > 0 ? sibs[i - 1].id : START, y: lineRect.top, depth: row.depth };
  } else if (row.hasKids && !n.collapsed) {
    t = { parentId: n.id, afterRef: START, y: lineRect.bottom, depth: row.depth + 1 };
  } else {
    t = { parentId: n.parentId ?? null, afterRef: n.id, y: rowRect.bottom, depth: row.depth };
  }
  if (t.parentId != null && isInside(index, t.parentId, moving)) return null;
  return t;
}

function autoScroll() {
  if (!drag?.started) return;
  const top = $('.top').getBoundingClientRect().bottom;
  const edge = 36;
  let dy = 0;
  if (drag.ly < top + edge) dy = -Math.ceil((top + edge - drag.ly) / 4);
  else if (drag.ly > innerHeight - edge) dy = Math.ceil((drag.ly - innerHeight + edge) / 4);
  if (dy) { scrollBy(0, dy); trackDrag(); }
  requestAnimationFrame(autoScroll);
}

function onDragUp(e) {
  if (!drag || e.pointerId !== drag.pointerId) return;
  const { started, target, ids } = drag;
  endDrag();
  if (started) {
    suppressClickUntil = Date.now() + 300;
    if (target) moveItems(ids, target.parentId, target.afterRef);
  }
}

function endDrag() {
  if (!drag) return;
  clearTimeout(drag.timer);
  const wasStarted = drag.started;
  drag.hilite?.classList.remove('drop-inside');
  drag = null;
  removeEventListener('pointermove', onDragMove);
  removeEventListener('pointerup', onDragUp);
  removeEventListener('pointercancel', endDrag);
  $('#ghost').hidden = true;
  $('#dropLine').hidden = true;
  document.body.classList.remove('is-dragging');
  if (wasStarted) render();
}

// ---------------------------------------------------------------- menus
const KEY = MAC ? { mod: '⌘', shift: '⇧', alt: '⌥' } : { mod: 'Ctrl+', shift: 'Shift+', alt: 'Alt+' };

function selectionMenuItems() {
  const tops = selectionTops();
  const one = tops.length === 1 ? node(tops[0]) : null;
  const none = tops.length === 0;
  const first = tops[0] && node(tops[0]);
  return [
    { label: 'New subtask', disabled: !one, action: () => createItem({ type: 'task', parentId: one.id, afterRef: END }) },
    { label: 'New subcategory', disabled: !one, action: () => createItem({ type: 'category', parentId: one.id, afterRef: END }) },
    { label: one && !htmlIsEmpty(one.desc) ? 'Edit description' : 'Add description', disabled: !one,
      action: () => openDescription(one.id) },
    { label: 'Top priority (bold)', key: `${KEY.mod}B`, checked: !!(first?.type === 'task' && first.bold),
      disabled: !tops.some((id) => node(id)?.type === 'task'), action: () => toggleBold(tops) },
    { label: first?.type === 'category' ? 'Change to task' : 'Change to category', disabled: none, action: convertSelection },
    '-',
    { label: 'Indent', key: 'Tab', disabled: none, action: indentSelection },
    { label: 'Outdent', key: `${KEY.shift}Tab`, disabled: none, action: outdentSelection },
    { label: 'Move up', key: `${KEY.mod}↑`, disabled: none, action: () => moveSelection(-1) },
    { label: 'Move down', key: `${KEY.mod}↓`, disabled: none, action: () => moveSelection(1) },
    '-',
    { label: 'Copy', key: `${KEY.mod}C`, disabled: none, action: () => writeClipboard(copySelection()) },
    { label: 'Cut', key: `${KEY.mod}X`, disabled: none, action: cutSelection },
    { label: 'Paste', key: `${KEY.mod}V`, action: pasteFromSystem },
    { label: 'Delete', key: '⌫', danger: true, disabled: none, action: deleteSelection },
  ];
}

function mainMenuItems() {
  const items = [];
  if (user) items.push({ label: user.email ?? 'Signed in', info: true }, '-');
  else if (store?.local) items.push({ label: 'Local only — saved in this browser', info: true }, '-');
  if (journalOpen) {
    items.push({ label: 'Back to list', key: 'Esc', action: () => toggleJournal(false) });
    if (backend && user) items.push('-', { label: 'Sign out', action: () => backend.signOutUser() });
    return items;
  }
  items.push({ label: 'New category', action: () => newItem('category') });
  items.push(...selectionMenuItems());
  items.push('-',
    { label: 'Expand all', action: () => setAllCollapsed(false) },
    { label: 'Collapse all', action: () => setAllCollapsed(true) },
    { label: 'Show task history', checked: showHistory, action: toggleHistory },
    { label: journalOpen ? 'Back to list' : 'See Journal', action: () => toggleJournal() },
    '-',
    { label: 'Help & keyboard shortcuts', key: '?', action: openHelp });
  if (backend && user) items.push({ label: 'Sign out', action: () => backend.signOutUser() });
  return items;
}

// ---------------------------------------------------------------- journal
function toggleJournal(open = !journalOpen) {
  commitEdit();
  closeDateEditor();
  journalOpen = open;
  render();
  scrollTo(0, 0);
}

/** Completed tasks, newest first, grouped by the day they were checked off. */
function renderJournal() {
  const box = $('#journal');
  box.textContent = '';
  const done = [...index.byId.values()]
    .filter((n) => n.type === 'task' && n.state === DONE && n.completedAt != null && pathOf(n) != null)
    .sort((a, b) => b.completedAt - a.completedAt);
  if (!done.length) {
    box.append(el('p', 'j-empty', 'Nothing checked off yet. Completed tasks will be listed here by day.'));
    return;
  }
  let day = null;
  let list = null;
  let heading = null;
  let count = 0;
  const finishDay = () => { if (heading) heading.append(el('span', 'n', count === 1 ? '1 task' : `${count} tasks`)); };
  for (const n of done) {
    const d = dayStart(n.completedAt);
    if (d !== day) {
      finishDay();
      day = d;
      count = 0;
      heading = el('h2', '', dayLabel(d));
      list = el('ul');
      box.append(heading, list);
    }
    count++;
    const li = el('li');
    li.title = 'Show in the list';
    li.append(el('span', 'j-check', '✕'), el('span', 'j-title', n.title || 'Untitled'));
    const path = pathOf(n);
    if (path) li.append(el('span', 'j-path', path));
    li.append(el('span', 'j-time', new Date(n.completedAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })));
    li.addEventListener('click', (e) => { e.stopPropagation(); revealInList(n.id); });
    list.append(li);
  }
  finishDay();
}

/** "Work › Projects" for a task (its ancestors' names), or null if it sits under something deleted. */
function pathOf(n) {
  const names = [];
  for (let p = n.parentId; p != null; p = node(p)?.parentId) {
    const a = node(p);
    if (!a) return null;
    names.unshift(a.title || 'Untitled');
  }
  return names.join(' › ');
}

function dayLabel(d) {
  const today = dayStart();
  if (d === today) return 'Today';
  if (d === dayStart(today - 12 * 3600e3)) return 'Yesterday';
  const date = new Date(d);
  const opts = { weekday: 'long', month: 'short', day: 'numeric' };
  if (date.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
  return date.toLocaleDateString(undefined, opts);
}

/** Leave the journal and select a task in the list, opening whatever hides it. */
function revealInList(id) {
  const n = node(id);
  if (!n) return;
  journalOpen = false;
  if (!isShown(n) && !showHistory) {
    showHistory = true; // it was checked off before today, so only the history view shows it
    lsSet('todo.showHistory', '1');
  }
  const ops = [];
  for (let p = n.parentId; p != null; p = node(p)?.parentId) {
    if (node(p)?.collapsed) ops.push({ type: 'update', id: p, patch: { collapsed: false } });
  }
  if (ops.length) exec(ops, { record: false });
  selectOnly(id);
  render();
  rowEls.get(id)?.li.scrollIntoView({ block: 'center' });
}

function toggleHistory() {
  showHistory = !showHistory;
  lsSet('todo.showHistory', showHistory ? '1' : '0');
  render();
}

function onRowContextMenu(e, id) {
  e.preventDefault();
  if (!selected.has(id)) { commitEdit(); selectOnly(id); render(); }
  openMenu({ x: e.clientX, y: e.clientY }, selectionMenuItems());
}

function openMenu(at, items) {
  const m = $('#menu');
  m.textContent = '';
  for (const it of items) {
    if (it === '-') { if (m.lastChild && m.lastChild.tagName !== 'HR') m.append(el('hr')); continue; }
    const b = el('button', [it.danger && 'danger', it.info && 'info', it.checked && 'checked'].filter(Boolean).join(' '));
    b.type = 'button';
    b.setAttribute('role', 'menuitem');
    b.append(el('span', 'label', it.label));
    if (it.key) b.append(el('span', 'key', it.key));
    b.disabled = !!(it.disabled || it.info);
    b.addEventListener('click', () => { closeMenu(); it.action?.(); });
    m.append(b);
  }
  m.hidden = false;
  const r = at instanceof Element ? at.getBoundingClientRect() : { left: at.x, right: at.x, top: at.y, bottom: at.y };
  m.anchor = at instanceof Element ? at : null;
  const mw = m.offsetWidth;
  const mh = m.offsetHeight;
  const left = Math.max(8, Math.min(r.left, innerWidth - mw - 8));
  let top = r.bottom + 2;
  if (top + mh > innerHeight - 8) top = Math.max(8, r.top - mh - 2);
  m.style.left = `${left}px`;
  m.style.top = `${top}px`;
}

function closeMenu() { $('#menu').hidden = true; }

/** Instructions and keyboard shortcuts, in a window of their own so they can stay open beside the list. */
function openHelp() {
  const w = window.open('help.html', 'todo-help', 'popup,width=600,height=760');
  if (!w) location.assign('help.html'); // pop-ups blocked: show it here instead
  else w.focus();
}

// ---------------------------------------------------------------- keyboard
function onKeyDown(e) {
  if (e.key === 'Escape' && drag) { endDrag(); return; }
  if (!$('#menu').hidden) { if (e.key === 'Escape') closeMenu(); return; }
  if (!store || isTyping(e.target)) return;
  const mod = e.metaKey || e.ctrlKey;
  if (journalOpen) {
    if (e.key === 'Escape') { e.preventDefault(); toggleJournal(false); }
    return;
  }
  const k = e.key;
  const lower = k.length === 1 ? k.toLowerCase() : k;

  if (mod && lower === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
  if (mod && lower === 'y') { e.preventDefault(); redo(); return; }
  if (mod && lower === 'a') { e.preventDefault(); selectIds(rows.map((r) => r.node.id)); return; }
  if (mod && lower === 'c') { if (selected.size) { e.preventDefault(); writeClipboard(copySelection()); } return; }
  if (mod && lower === 'x') { if (selected.size) { e.preventDefault(); cutSelection(); } return; }
  if (mod && lower === 'v') {
    // Prefer the paste event (no permission prompt); fall back to the async clipboard API if it doesn't come.
    pasteEventSeen = false;
    setTimeout(() => { if (!pasteEventSeen) pasteFromSystem(); }, 150);
    return;
  }
  if (mod && k === 'Enter') { e.preventDefault(); newItem('task'); return; }
  if (mod && lower === 'b' && !e.shiftKey && !e.altKey) {
    if (selected.size) { e.preventDefault(); toggleBold(selectionTops()); }
    return;
  }
  if (mod && (k === 'ArrowUp' || k === 'ArrowDown')) { e.preventDefault(); moveSelection(k === 'ArrowUp' ? -1 : 1); return; }
  if (mod || e.altKey) return;

  switch (k) {
    case 'ArrowUp': case 'ArrowDown':
      e.preventDefault();
      moveCursor(k === 'ArrowUp' ? -1 : 1, e.shiftKey);
      break;
    case 'ArrowLeft': case 'ArrowRight': {
      const n = cursorId && node(cursorId);
      if (!n) return;
      e.preventDefault();
      const kids = index.children(n.id).filter(isShown);
      if (k === 'ArrowLeft') {
        if (kids.length && !n.collapsed) toggleCollapsed(n.id, true);
        else if (n.parentId) { selectOnly(n.parentId); render(); }
      } else if (kids.length && n.collapsed) toggleCollapsed(n.id, false);
      else if (kids.length) { selectOnly(kids[0].id); render(); }
      break;
    }
    case 'Enter':
      // Return adds a task below the selected row; Shift-Return adds a subtask under it.
      e.preventDefault();
      if (!cursorId) newItem('task');
      else if (e.shiftKey) createItem({ type: 'task', parentId: cursorId, afterRef: END });
      else createItem({ type: 'task', ...placeBelow(cursorId) });
      break;
    case 'F2':
      if (cursorId) { e.preventDefault(); startEdit(cursorId); }
      break;
    case ' ':
      if (selected.size) {
        e.preventDefault();
        const ids = [...selected].sort((a, b) => (b === cursorId) - (a === cursorId));
        setStates(ids, e.shiftKey);
      }
      break;
    case 'Backspace': case 'Delete':
      if (selected.size) { e.preventDefault(); deleteSelection(); }
      break;
    case 'Tab':
      if (selected.size) { e.preventDefault(); if (e.shiftKey) outdentSelection(); else indentSelection(); }
      break;
    case 'Escape':
      selected.clear();
      render();
      break;
    case '?':
      e.preventDefault();
      openHelp();
      break;
  }
}
let pasteEventSeen = false;

// ---------------------------------------------------------------- static wiring
function wireStaticUi() {
  $('#signinBtn').addEventListener('click', async () => {
    const err = $('#signinError');
    err.hidden = true;
    try { await backend.signIn(); } catch (e) {
      console.error(e);
      err.hidden = false;
      err.textContent = e.code === 'auth/unauthorized-domain'
        ? `This site (${location.hostname}) isn't in Firebase Authentication → Settings → Authorized domains yet.`
        : `Sign-in failed: ${e.message}`;
    }
  });

  const tb = (id, fn) => {
    const b = $(id);
    b.addEventListener('mousedown', (e) => e.preventDefault()); // don't steal focus from an editor
    b.addEventListener('click', fn);
  };
  tb('#tbNew', () => newItem('task'));
  tb('#tbCopy', () => writeClipboard(copySelection()));
  tb('#tbCut', cutSelection);
  tb('#tbPaste', pasteFromSystem);
  tb('#tbDelete', deleteSelection);
  tb('#tbUndo', undo);
  tb('#tbRedo', redo);
  tb('#tbHistory', toggleHistory);
  tb('#tbJournal', () => toggleJournal());
  tb('#tbHelp', openHelp);
  tb('#menuBtn', (e) => {
    if (!$('#menu').hidden && $('#menu').anchor === e.currentTarget) { closeMenu(); return; }
    openMenu(e.currentTarget, mainMenuItems());
  });

  // Clicking empty space finishes typing a name (keeping that row selected); clicking it again clears the selection.
  $('#main').addEventListener('click', (e) => {
    if (e.target.closest('.row, #journal') || Date.now() < suppressClickUntil) return;
    if (editing || wasEditingAtPress) { commitEdit(); return; }
    if (selected.size) { selected.clear(); render(); }
  });

  document.addEventListener('keydown', onKeyDown);
  document.addEventListener('paste', (e) => {
    if (!store || isTyping(e.target)) return;
    pasteEventSeen = true;
    e.preventDefault();
    pasteText(e.clipboardData.getData('text/plain'));
  });
  // Click suppression (after a drop or a long-press) only applies to the click ending that same press.
  document.addEventListener('pointerdown', () => {
    suppressClickUntil = 0;
    wasEditingAtPress = !!editing;
  }, { capture: true });
  document.addEventListener('pointerdown', (e) => {
    const m = $('#menu');
    if (!m.hidden && !m.contains(e.target) && !m.anchor?.contains(e.target)) closeMenu();
  });
  // While a row is being dragged on a touch screen, don't let the page scroll instead.
  document.addEventListener('touchmove', (e) => { if (drag?.started) e.preventDefault(); }, { passive: false });
  addEventListener('resize', closeMenu);
  addEventListener('pagehide', () => {
    commitEdit();
    const a = document.activeElement;
    if (a?.classList?.contains('desc')) a.blur();
  });
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  if (location.protocol !== 'https:' && location.hostname !== 'localhost') return;
  navigator.serviceWorker.register('sw.js').catch((e) => console.warn('Service worker not registered', e));
}
