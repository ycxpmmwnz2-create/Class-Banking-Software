// Browser-only test probes. Use the application's rebound demo handles and the
// same Firestore Lite SDK (its getDoc always goes to the server, with no cache).
import { initializeApp, deleteApp } from 'firebase/app';
import { getAuth, connectAuthEmulator, signInWithCustomToken } from 'firebase/auth';
import { getFirestore, connectFirestoreEmulator, doc, getDoc, updateDoc } from 'firebase/firestore/lite';
import { httpsCallable } from 'firebase/functions';
import { app, db, functions } from '../../src/firebase/firebase.js';
const projectId = 'demo-morgan-bank-phase2b-server-test';
function requireDemo() {
  if (location.hostname !== '127.0.0.1' || app.options.projectId !== projectId ||
      window.PHASE2B_EMULATOR_TEST_CONFIG?.enabled !== true) throw new Error('Local demo browser required.');
}
export async function invokeCallable(name, data) {
  requireDemo();
  try { return { data: (await httpsCallable(functions, name)(data)).data }; }
  catch (error) { return { code: error.code }; }
}
export async function directFirestore(operation, path, body) {
  requireDemo();
  try {
    if (operation === 'read') return { exists: (await getDoc(doc(db, path))).exists() };
    if (operation !== 'write') throw new Error('Unknown test operation');
    await updateDoc(doc(db, path), body); return { wrote: true };
  } catch (error) { return { code: error.code }; }
}
export async function probeLateToken(token, path) {
  requireDemo();
  // Independent Auth observer: a UI-triggered sign-out must not accidentally
  // turn a late-token test into an anonymous-read test.
  const isolated = initializeApp({ projectId, apiKey: 'fake-api-key' }, 'late-token-proof');
  try {
    const auth = getAuth(isolated); connectAuthEmulator(auth, 'http://127.0.0.1:9099');
    const database = getFirestore(isolated); connectFirestoreEmulator(database, '127.0.0.1', 8080);
    const signed = await signInWithCustomToken(auth, token);
    try { await getDoc(doc(database, path)); return { signedIn: !!signed.user.uid, read: true }; }
    catch (error) { return { signedIn: !!signed.user.uid, code: error.code }; }
  } finally { await deleteApp(isolated); }
}
