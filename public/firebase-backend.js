// Google sign-in and Firestore storage. Loaded only when not in ?local mode.
import { initializeApp } from 'https://www.gstatic.com/firebasejs/13.2.0/firebase-app.js';
import {
  getAuth, GoogleAuthProvider, onAuthStateChanged, signInWithPopup, signInWithRedirect,
  getRedirectResult, signOut, connectAuthEmulator, signInWithCredential,
} from 'https://www.gstatic.com/firebasejs/13.2.0/firebase-auth.js';
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  collection, doc, onSnapshot, writeBatch, serverTimestamp, connectFirestoreEmulator,
} from 'https://www.gstatic.com/firebasejs/13.2.0/firebase-firestore.js';
import { firebaseConfig } from './firebase-config.js';

// Testing only: ?emulator on localhost talks to the local Firebase emulators instead of the real project.
const EMULATOR = location.hostname === 'localhost' && new URLSearchParams(location.search).has('emulator');

const app = initializeApp(EMULATOR ? { ...firebaseConfig, projectId: 'demo-todo', apiKey: 'demo-key' } : firebaseConfig);
const auth = getAuth(app);

// Keep a copy of the data in IndexedDB so the app opens and edits offline; changes sync when back online.
const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
});

if (EMULATOR) {
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  connectFirestoreEmulator(db, '127.0.0.1', 8085);
}

export function watchAuth(callback) {
  getRedirectResult(auth).catch((e) => console.warn('Redirect sign-in failed', e));
  return onAuthStateChanged(auth, callback);
}

export async function signIn() {
  if (EMULATOR) {
    // The Auth emulator accepts an unsigned Google identity.
    await signInWithCredential(auth, GoogleAuthProvider.credential(
      JSON.stringify({ sub: 'tester', email: 'tester@example.com', email_verified: true })));
    return;
  }
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });
  try {
    await signInWithPopup(auth, provider);
  } catch (e) {
    if (e.code === 'auth/popup-blocked' || e.code === 'auth/operation-not-supported-in-this-environment') {
      await signInWithRedirect(auth, provider);
    } else if (e.code !== 'auth/popup-closed-by-user' && e.code !== 'auth/cancelled-popup-request') {
      throw e;
    }
  }
}

export const signOutUser = () => signOut(auth);

/** All of a user's items live in users/{uid}/nodes/{nodeId}. */
export function createStore(uid) {
  const col = collection(db, 'users', uid, 'nodes');
  return {
    local: false,
    newId: () => doc(col).id,
    subscribe(onData, onError) {
      return onSnapshot(col, { includeMetadataChanges: true }, (snap) => {
        const nodes = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        onData(nodes, { fromCache: snap.metadata.fromCache, pending: snap.metadata.hasPendingWrites });
      }, onError);
    },
    // Writes show up in the snapshot listener immediately (even offline); the commit
    // promise only settles once the server confirms, so callers should not wait on it.
    apply(ops) {
      const chunks = [];
      for (let i = 0; i < ops.length; i += 450) chunks.push(ops.slice(i, i + 450));
      return Promise.all(chunks.map((chunk) => {
        const batch = writeBatch(db);
        for (const op of chunk) {
          const ref = doc(col, op.id);
          if (op.type === 'set') batch.set(ref, { ...op.data, updatedAt: serverTimestamp() });
          else if (op.type === 'update') batch.update(ref, { ...op.patch, updatedAt: serverTimestamp() });
          else if (op.type === 'delete') batch.delete(ref);
        }
        return batch.commit();
      })).catch((e) => console.error('Save failed', e));
    },
  };
}
