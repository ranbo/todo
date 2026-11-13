// Storage that keeps everything in this browser only (used with ?local for trying the app out).
// It has the same shape as the Firestore store in firebase-backend.js:
//   newId()                     → a fresh id
//   subscribe(onData, onError)  → calls onData(nodes, { fromCache, pending }) on every change; returns unsubscribe
//   apply(ops)                  → ops: { type: 'set', id, data } | { type: 'update', id, patch } | { type: 'delete', id }

// `lag` (testing only) mimics Firestore delivering an update that was already in flight: after each write it
// first re-sends the data as it was *before* the write, then the real data a moment later.
export function createLocalStore(key = 'todo.local.v1', { lag = false } = {}) {
  const subs = new Set();
  let data = read();

  function read() {
    try { return JSON.parse(localStorage.getItem(key)) ?? {}; } catch { return {}; }
  }
  function write() {
    try { localStorage.setItem(key, JSON.stringify(data)); } catch { /* storage unavailable */ }
  }
  function list() {
    return Object.entries(data).map(([id, v]) => ({ id, ...v }));
  }
  function emit() {
    const nodes = list();
    for (const cb of subs) cb(nodes, { fromCache: false, pending: false });
  }

  // Keep several open tabs in step.
  window.addEventListener('storage', (e) => {
    if (e.key === key) { data = read(); emit(); }
  });

  return {
    local: true,
    newId() {
      const rand = globalThis.crypto?.randomUUID?.() ?? String(Math.random()).slice(2) + Date.now();
      return rand.replace(/-/g, '').slice(0, 20);
    },
    subscribe(onData) {
      subs.add(onData);
      queueMicrotask(() => onData(list(), { fromCache: false, pending: false }));
      return () => subs.delete(onData);
    },
    apply(ops) {
      if (lag) {
        const stale = list();
        setTimeout(() => { for (const cb of subs) cb(stale, { fromCache: false, pending: true }); }, 0);
        const done = new Promise((r) => setTimeout(r, 60));
        const now = Date.now();
        for (const op of ops) {
          if (op.type === 'set') data[op.id] = { ...op.data, updatedAt: now };
          else if (op.type === 'update') { if (data[op.id]) Object.assign(data[op.id], op.patch, { updatedAt: now }); }
          else if (op.type === 'delete') delete data[op.id];
        }
        write();
        return done.then(emit);
      }
      const now = Date.now();
      for (const op of ops) {
        if (op.type === 'set') data[op.id] = { ...op.data, updatedAt: now };
        else if (op.type === 'update') { if (data[op.id]) Object.assign(data[op.id], op.patch, { updatedAt: now }); }
        else if (op.type === 'delete') delete data[op.id];
      }
      write();
      queueMicrotask(emit);
      return Promise.resolve();
    },
  };
}
