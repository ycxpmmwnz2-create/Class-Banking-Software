import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

initializeApp({ projectId: 'morgan-bank' });
const db = getFirestore();

async function check() {
  const roster = await db.collection('morganBank').doc('classroomData').get();
  const cred = await db.collection('studentCredentials').doc('edge-test').get();
  console.log('--- ROSTER STUDENTS ---');
  console.log(JSON.stringify(roster.data()?.students, null, 2));
  console.log('--- CREDENTIAL edge-test ---');
  console.log(JSON.stringify(cred.data(), null, 2));
}

check().catch(console.error);
