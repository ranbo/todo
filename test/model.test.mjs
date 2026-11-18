import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TODO, IN_PROGRESS, DONE, indexNodes, makeStateResolver, nextState, orderBetween, subtreeIds,
  visibleRows, childProgress, spread, isInside, topLevelOf, outlineText, parseOutline,
  dayStart, isOldDone, firstActivity, statePatch,
} from '../public/model.js';

let n = 0;
const ctx = (id) => ({ id, parentId: null, type: 'category', title: id, order: ++n });
const task = (id, parentId, state = TODO, extra = {}) => ({ id, parentId, type: 'task', title: id, state, order: ++n, ...extra });
const cat = (id, parentId, extra = {}) => ({ id, parentId, type: 'category', title: id, order: ++n, ...extra });

function setup(nodes) {
  const index = indexNodes(nodes);
  return { index, ...makeStateResolver(index) };
}

test('task with no started children stays to do', () => {
  const { index, effective } = setup([ctx('w'), task('a', 'w'), task('a1', 'a'), task('a2', 'a')]);
  assert.equal(effective(index.byId.get('a')), TODO);
});

test('a done or in-progress child makes the parent in progress', () => {
  for (const s of [DONE, IN_PROGRESS]) {
    const { index, effective } = setup([ctx('w'), task('a', 'w'), task('a1', 'a', s), task('a2', 'a')]);
    assert.equal(effective(index.byId.get('a')), IN_PROGRESS, s);
  }
});

test('started grandchild propagates up through tasks and categories', () => {
  const { index, effective } = setup([
    ctx('w'), task('a', 'w'), cat('c', 'a'), task('b', 'c'), task('b1', 'b', DONE),
  ]);
  assert.equal(effective(index.byId.get('b')), IN_PROGRESS);
  assert.equal(effective(index.byId.get('a')), IN_PROGRESS);
  assert.equal(effective(index.byId.get('c')), null);
});

test('explicit done on the parent wins over children', () => {
  const { index, effective } = setup([ctx('w'), task('a', 'w', DONE), task('a1', 'a', TODO)]);
  assert.equal(effective(index.byId.get('a')), DONE);
});

test('click and shift-click transitions', () => {
  // plain click
  assert.equal(nextState(TODO, TODO, false), DONE);
  assert.equal(nextState(IN_PROGRESS, IN_PROGRESS, false), DONE);
  assert.equal(nextState(TODO, IN_PROGRESS, false), DONE);     // derived in-progress parent → done
  assert.equal(nextState(DONE, DONE, false), TODO);
  // shift-click / long-press
  assert.equal(nextState(TODO, TODO, true), IN_PROGRESS);
  assert.equal(nextState(IN_PROGRESS, IN_PROGRESS, true), TODO);
  assert.equal(nextState(DONE, DONE, true), IN_PROGRESS);
});

test('orderBetween', () => {
  assert.equal(orderBetween(null, null), 1000);
  assert.equal(orderBetween(1000, null), 2000);
  assert.equal(orderBetween(null, 1000), 0);
  assert.equal(orderBetween(1000, 2000), 1500);
});

test('children sorted by order; orphans dropped', () => {
  const index = indexNodes([
    ctx('w'), { ...task('b', 'w'), order: 20 }, { ...task('a', 'w'), order: 10 }, task('x', 'missing'),
  ]);
  assert.deepEqual(index.children('w').map((c) => c.id), ['a', 'b']);
  assert.deepEqual(index.children(null).map((c) => c.id), ['w']);
  assert.ok(!subtreeIds(index, 'w').includes('x'));
});

test('subtreeIds includes all descendants', () => {
  const { index } = setup([ctx('w'), task('a', 'w'), task('a1', 'a'), task('a11', 'a1'), task('b', 'w')]);
  assert.deepEqual(subtreeIds(index, 'a').sort(), ['a', 'a1', 'a11']);
});

test('visibleRows honors collapse and a visibility filter', () => {
  const { index } = setup([
    ctx('w'), task('a', 'w', TODO, { collapsed: true }), task('a1', 'a'), task('b', 'w', DONE), task('c', 'w'),
  ]);
  const ids = (rows) => rows.map((r) => `${r.node.id}@${r.depth}${r.hasKids ? '+' : ''}`);
  assert.deepEqual(ids(visibleRows(index, 'w')), ['a@0+', 'b@0', 'c@0']);
  assert.deepEqual(ids(visibleRows(index, 'w', { visible: (n) => n.state !== DONE })), ['a@0+', 'c@0']);
  index.byId.get('a').collapsed = false;
  assert.deepEqual(ids(visibleRows(index, 'w')), ['a@0+', 'a1@1', 'b@0', 'c@0']);
});

test('bold tasks show under a collapsed parent or category, but not a collapsed grandparent category', () => {
  const { index } = setup([
    ctx('w'), cat('h', 'w', { collapsed: true }),
    task('p', 'h', TODO, { collapsed: true }), task('t', 'p', TODO, { bold: true }), task('u', 't', TODO, { bold: true }),
    task('q', 'h'), cat('sub', 'h'), task('s', 'sub', TODO, { bold: true }),
  ]);
  const ids = (rows) => rows.map((r) => `${r.node.id}@${r.depth}${r.peek ? '*' : ''}`);
  assert.deepEqual(ids(visibleRows(index, null)), ['w@0', 'h@1', 't@2*', 'u@3*']);
  index.byId.get('h').collapsed = false;
  assert.deepEqual(ids(visibleRows(index, null)), ['w@0', 'h@1', 'p@2', 't@3*', 'u@4*', 'q@2', 'sub@2', 's@3']);
  index.byId.get('w').collapsed = true;
  assert.deepEqual(ids(visibleRows(index, null)), ['w@0']);
});

test('childProgress counts direct child tasks', () => {
  const { index, effective } = setup([ctx('w'), task('a', 'w'), task('a1', 'a', DONE), task('a2', 'a'), cat('c', 'a')]);
  assert.deepEqual(childProgress(index, index.byId.get('a'), effective), { total: 2, done: 1 });
});

test('spread gives increasing values strictly between neighbors', () => {
  assert.deepEqual(spread(null, null, 2), [1000, 2000]);
  assert.deepEqual(spread(1000, null, 2), [2000, 3000]);
  assert.deepEqual(spread(null, 1000, 2), [-1000, 0]);
  assert.deepEqual(spread(1000, 2000, 3), [1250, 1500, 1750]);
});

test('isInside and topLevelOf', () => {
  const { index } = setup([ctx('w'), task('a', 'w'), task('a1', 'a'), task('b', 'w')]);
  assert.ok(isInside(index, 'a1', new Set(['a'])));
  assert.ok(isInside(index, 'a', new Set(['a'])));
  assert.ok(!isInside(index, 'b', new Set(['a'])));
  assert.deepEqual(topLevelOf(index, ['a1', 'a', 'b']), ['a', 'b']);
});

test('outlineText and parseOutline round-trip', () => {
  const { index } = setup([ctx('w'), task('a', 'w'), task('a1', 'a'), task('b', 'w')]);
  const text = outlineText(index, ['w']);
  assert.equal(text, 'w\n\ta\n\t\ta1\n\tb');
  assert.deepEqual(parseOutline(text).map((i) => [i.title, i.level]), [['w', 0], ['a', 1], ['a1', 2], ['b', 1]]);
});

test('parseOutline handles bullets, spaces and checkbox markers', () => {
  const items = parseOutline('- [x] Done thing\n  * child one\n    1. grandchild\n  [/] child two\n\nTop again');
  assert.deepEqual(items, [
    { title: 'Done thing', level: 0, state: DONE },
    { title: 'child one', level: 1, state: TODO },
    { title: 'grandchild', level: 2, state: TODO },
    { title: 'child two', level: 1, state: IN_PROGRESS },
    { title: 'Top again', level: 0, state: TODO },
  ]);
});

test('deleted items are left out of the index (but parents stay)', () => {
  const index = indexNodes([ctx('w'), task('a', 'w', TODO, { deletedAt: 5 }), task('a1', 'a'), task('b', 'w')]);
  assert.deepEqual(index.children('w').map((c) => c.id), ['b']);
  assert.ok(!index.byId.has('a'));
  assert.deepEqual(index.children('a'), []);
});

test('isOldDone: done before today, or done with no date', () => {
  const today = dayStart(new Date(2026, 10, 10, 15).getTime());
  assert.equal(today, new Date(2026, 10, 10).getTime());
  assert.ok(!isOldDone(task('t', 'w', DONE, { completedAt: today + 3600e3 }), today));
  assert.ok(isOldDone(task('t', 'w', DONE, { completedAt: today - 1 }), today));
  assert.ok(isOldDone(task('t', 'w', DONE), today));
  assert.ok(!isOldDone(task('t', 'w', TODO, { completedAt: 1 }), today));
  assert.ok(!isOldDone(cat('c', 'w'), today));
});

test('statePatch stamps and clears dates', () => {
  const now = 1000;
  assert.deepEqual(statePatch(task('t', 'w'), DONE, now), { state: DONE, completedAt: now });
  assert.deepEqual(statePatch(task('t', 'w'), IN_PROGRESS, now), { state: IN_PROGRESS, startedAt: now });
  assert.deepEqual(statePatch(task('t', 'w', IN_PROGRESS, { startedAt: 5 }), DONE, now), { state: DONE, completedAt: now });
  assert.deepEqual(statePatch(task('t', 'w', DONE, { startedAt: 5, completedAt: 9 }), TODO, now), { state: TODO, completedAt: null });
  assert.deepEqual(statePatch(task('t', 'w', DONE, { completedAt: 9 }), IN_PROGRESS, now), { state: IN_PROGRESS, completedAt: null, startedAt: now });
  assert.deepEqual(statePatch(task('t', 'w', IN_PROGRESS, { startedAt: 5 }), TODO, now), { state: TODO, startedAt: null });
  assert.deepEqual(statePatch(task('t', 'w', DONE, { completedAt: 9 }), DONE, now), { state: DONE }); // keeps its date
});

test('firstActivity finds the earliest start/completion beneath a task', () => {
  const { index } = setup([
    ctx('w'), task('a', 'w'), task('a1', 'a', DONE, { completedAt: 50 }), cat('c', 'a'), task('a2', 'c', IN_PROGRESS, { startedAt: 20 }),
    task('a3', 'a'),
  ]);
  assert.equal(firstActivity(index, 'a'), 20);
  assert.equal(firstActivity(index, 'a3'), null);
});
