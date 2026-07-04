import { initializeApp } from 'firebase/app'
import { getFunctions, httpsCallable } from 'firebase/functions'

const firebaseConfig = {
  apiKey: 'AIzaSyC-96VLdKfwtQ-WaFT6BA2q1WLnk8hDe1A',
  authDomain: 'morgan-bank.firebaseapp.com',
  projectId: 'morgan-bank',
  storageBucket: 'morgan-bank.firebasestorage.app',
  messagingSenderId: '242031426628',
  appId: '1:242031426628:web:5caa4640a7eb7e3576d011',
  measurementId: 'G-FG1ZHTHF7G'
}

const app = initializeApp(firebaseConfig)
const functions = getFunctions(app)
const generateTeacherToken = httpsCallable(functions, 'generateTeacherTokenForDev')

try {
  console.log('Calling generateTeacherTokenForDev...')
  const result = await generateTeacherToken()
  console.log('TEACHER_CUSTOM_TOKEN:', result.data.token)
} catch (error) {
  console.error('Error calling function:', error)
}
