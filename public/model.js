// Pure data logic for the ToDo tree. No DOM, no Firebase, so it can be unit tested in Node.
//
// Every item is a flat "node" record:
//   { id, parentId, type, title, state, order, collapsed, desc, descOpen,
//     createdAt, startedAt, completedAt, deletedAt }   (dates are millisecond timestamps, or null)
// Deleting only sets deletedAt, so the history is kept; indexNodes leaves deleted items out.
//   type 'category' – a heading (e.g. Work, Home, Church at the top level); it has no state of its own
//   type 'task'     – state is 'todo' | 'in_progress' | 'done'

export const TODO = 'todo';
export const IN_PROGRESS = 'in_progress';
export const DONE = 'done';

const byOrder = (a, b) =>
  (a.order ?? 0) - (b.order ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Group nodes by parent, each child list sorted by `order`. Nodes whose parent is missing are dropped. */
export function indexNodes(nodes) {
  const byId = new Map();
  const kids = new Map();
  nodes = nodes.filter((n) => n.deletedAt == null);
  for (const n of nodes) byId.set(n.id, n);
  for (const n of nodes) {
    const p = n.parentId ?? null;
    if (p !== null && !byId.has(p)) continue; // orphan (parent deleted elsewhere)
    if (!kids.has(p)) kids.set(p, []);
    kids.get(p).push(n);
  }
  for (const list of kids.values()) list.sort(byOrder);
  return { byId, children: (id) => kids.get(id) ?? [] };
}

/**
 * The state a task *shows*:
 *  - explicitly done        → done
 *  - explicitly in progress → in progress
 *  - otherwise, if any task beneath it (through categories too) is in progress or done → in progress
 *  - otherwise              → to do
 * Categories and contexts return null.
 */
export function makeStateResolver(index) {
  const memo = new Map();
  function started(id) {
    return index.children(id).some((c) =>
      c.type === 'task' ? effective(c) !== TODO : started(c.id));
  }
  function effective(node) {
    if (!node || node.type !== 'task') return null;
    if (memo.has(node.id)) return memo.get(node.id);
    const s = node.state === DONE ? DONE
      : node.state === IN_PROGRESS ? IN_PROGRESS
      : started(node.id) ? IN_PROGRESS
      : TODO;
    memo.set(node.id, s);
    return s;
  }
  return { effective, started };
}

/**
 * New explicit state after a checkbox gesture.
 *  click:                         done ↔ to do (an in‑progress task becomes done)
 *  shift‑click / long‑press:      in progress ↔ to do (a done task goes back to in progress)
 */
export function nextState(explicit, effective, inProgressGesture) {
  if (inProgressGesture) return explicit === IN_PROGRESS ? TODO : IN_PROGRESS;
  return effective === DONE ? TODO : DONE;
}

/** An order value that sorts between a and b (either may be null/undefined for "no neighbor"). */
export function orderBetween(a, b) {
  return spread(a, b, 1)[0];
}

/** k increasing order values strictly between a and b (null = open-ended). */
export function spread(a, b, k) {
  const out = [];
  for (let i = 1; i <= k; i++) {
    if (a == null && b == null) out.push(i * 1000);
    else if (a == null) out.push(b - (k - i + 1) * 1000);
    else if (b == null) out.push(a + i * 1000);
    else out.push(a + ((b - a) * i) / (k + 1));
  }
  return out;
}

/** True if id is one of ancestorIds or lies anywhere beneath one of them. */
export function isInside(index, id, ancestorIds) {
  const seen = new Set();
  for (let cur = id; cur != null && !seen.has(cur); cur = index.byId.get(cur)?.parentId ?? null) {
    if (ancestorIds.has(cur)) return true;
    seen.add(cur);
  }
  return false;
}

/** The ids that have no ancestor also in ids (so moving/copying them carries the rest along). */
export function topLevelOf(index, ids) {
  const set = new Set(ids);
  return ids.filter((id) => {
    for (let p = index.byId.get(id)?.parentId; p != null; p = index.byId.get(p)?.parentId) {
      if (set.has(p)) return false;
    }
    return true;
  });
}

/** Plain-text outline of the given subtrees: one title per line, a tab per level. */
export function outlineText(index, rootIds) {
  const lines = [];
  const walk = (id, depth) => {
    const n = index.byId.get(id);
    if (!n) return;
    lines.push('\t'.repeat(depth) + (n.title ?? ''));
    for (const c of index.children(id)) walk(c.id, depth + 1);
  };
  for (const id of rootIds) walk(id, 0);
  return lines.join('\n');
}

/**
 * Parse pasted text into outline items { title, level, state }. Indentation (tabs or spaces) sets the level;
 * leading bullets ("-", "*", "•", "1.") are dropped and "[ ]", "[/]", "[x]" set the state.
 */
export function parseOutline(text) {
  const out = [];
  const widths = [];
  for (const raw of String(text).replace(/\r\n?/g, '\n').split('\n')) {
    if (!raw.trim()) continue;
    const ws = raw.match(/^[ \t]*/)[0].replace(/\t/g, '    ').length;
    while (widths.length && ws <= widths.at(-1)) widths.pop();
    const level = widths.length;
    widths.push(ws);
    let title = raw.trim();
    let state = TODO;
    const box = title.match(/^(?:[-*•]\s+)?\[( |x|X|\/|\\)\]\s*/);
    if (box) {
      state = /x/i.test(box[1]) ? DONE : box[1] === ' ' ? TODO : IN_PROGRESS;
      title = title.slice(box[0].length);
    } else {
      title = title.replace(/^(?:[-*•]|\d+[.)])\s+/, '');
    }
    out.push({ title, level, state });
  }
  return out;
}

/** The id plus all descendant ids. */
export function subtreeIds(index, id) {
  const out = [id];
  for (let i = 0; i < out.length; i++) for (const c of index.children(out[i])) out.push(c.id);
  return out;
}

/** Flattened, display-ordered rows under rootId, honoring collapse and a `visible(node)` filter. */
export function visibleRows(index, rootId, { visible = () => true } = {}) {
  const out = [];
  (function walk(pid, depth) {
    for (const n of index.children(pid)) {
      if (!visible(n)) continue;
      const kids = index.children(n.id).filter(visible);
      out.push({ node: n, depth, hasKids: kids.length > 0 });
      if (kids.length && !n.collapsed) walk(n.id, depth + 1);
    }
  })(rootId, 0);
  return out;
}

/** Start of the local day containing `ms`. */
export function dayStart(ms = Date.now()) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** A task checked off before `todayStart` (or with no completion date): hidden unless showing history. */
export function isOldDone(n, todayStart) {
  return n.type === 'task' && n.state === DONE && !(n.completedAt >= todayStart);
}

/** Earliest start or completion anywhere beneath id: when work on a parent task effectively began. */
export function firstActivity(index, id) {
  let first = null;
  for (const c of index.children(id)) {
    for (const t of [c.startedAt, c.completedAt, firstActivity(index, c.id)]) {
      if (t != null && (first == null || t < first)) first = t;
    }
  }
  return first;
}

/** Field changes that go with a state change: stamp started/completed dates, clear completed when undone. */
export function statePatch(n, state, now = Date.now()) {
  const patch = { state };
  if (state === DONE) {
    if (n.state !== DONE || n.completedAt == null) patch.completedAt = now;
  } else {
    if (n.completedAt != null) patch.completedAt = null;
    if (state === IN_PROGRESS && n.startedAt == null) patch.startedAt = now;
    if (state === TODO && n.state === IN_PROGRESS) patch.startedAt = null; // un-starting undoes the start
  }
  return patch;
}

/** Done / total among a task's direct child tasks. */
export function childProgress(index, node, effective) {
  let total = 0, done = 0;
  for (const c of index.children(node.id)) {
    if (c.type !== 'task') continue;
    total++;
    if (effective(c) === DONE) done++;
  }
  return { total, done };
}
