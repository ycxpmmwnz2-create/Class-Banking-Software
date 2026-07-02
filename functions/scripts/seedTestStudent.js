import { getApps, initializeApp } from 'firebase-admin/app'
import { FieldValue, getFirestore } from 'firebase-admin/firestore'
import bcrypt from 'bcryptjs'

const TEST_LOGIN_ID = 'test-student'
const TEST_PIN = '7391'
const BCRYPT_COST = 12

if (getApps().length === 0) {
  initializeApp({ projectId: 'morgan-bank' })
}

const firestore = getFirestore()
const credentialRef = firestore
  .collection('studentCredentials')
  .doc(TEST_LOGIN_ID)
const pinHash = await bcrypt.hash(TEST_PIN, BCRYPT_COST)

await firestore.runTransaction(async transaction => {
  const snapshot = await transaction.get(credentialRef)
  const timestamp = FieldValue.serverTimestamp()

  transaction.set(credentialRef, {
    schemaVersion: 1,
    authUid: TEST_LOGIN_ID,
    classroomId: 'morgan',
    studentId: TEST_LOGIN_ID,
    pinHash,
    active: true,
    failedAttempts: 0,
    lockedUntil: null,
    updatedAt: timestamp,
    pinUpdatedAt: timestamp,
    ...(!snapshot.exists ? { createdAt: timestamp } : {}),
  }, { merge: true })
})
