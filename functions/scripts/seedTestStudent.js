import { getApps, initializeApp } from 'firebase-admin/app'
import { FieldValue, getFirestore } from 'firebase-admin/firestore'
import bcrypt from 'bcryptjs'

const CLASSROOM_ID = 'morgan'
const TEST_STUDENT_NAMES = ['Andrew Test', 'Edge Test']
const TEST_PIN = '1234'
const BCRYPT_COST = 12

if (getApps().length === 0) {
  initializeApp({ projectId: 'morgan-bank' })
}

const firestore = getFirestore()
const rosterSnapshot = await firestore
  .collection('morganBank')
  .doc('classroomData')
  .get()
const rosterStudents = rosterSnapshot.data()?.students
const rosterStudent = Array.isArray(rosterStudents)
  ? TEST_STUDENT_NAMES
      .map(name => rosterStudents.find(student => student?.name === name))
      .find(Boolean)
  : undefined

if (!rosterStudent || !['string', 'number'].includes(typeof rosterStudent.id)) {
  throw new Error('Andrew Test or Edge Test was not found in the roster.')
}

const studentId = String(rosterStudent.id)
const loginIdSource = typeof rosterStudent.loginId === 'string'
  && rosterStudent.loginId.trim()
  ? rosterStudent.loginId
  : rosterStudent.name.replaceAll(' ', '-')
const loginId = loginIdSource.trim().toLowerCase()

const credentialRef = firestore
  .collection('studentCredentials')
  .doc(loginId)
const pinHash = await bcrypt.hash(TEST_PIN, BCRYPT_COST)

await firestore.runTransaction(async transaction => {
  const snapshot = await transaction.get(credentialRef)
  const existingCredential = snapshot.data()
  const timestamp = FieldValue.serverTimestamp()

  transaction.set(credentialRef, {
    schemaVersion: 1,
    authUid: loginId,
    classroomId: CLASSROOM_ID,
    studentId,
    pinHash,
    active: true,
    failedAttempts: 0,
    lockedUntil: null,
    updatedAt: timestamp,
    pinUpdatedAt: timestamp,
    ...(!existingCredential?.createdAt ? { createdAt: timestamp } : {}),
  }, { merge: true })
})
