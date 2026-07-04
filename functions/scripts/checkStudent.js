import fs from 'fs'
import path from 'path'
import os from 'os'
import { getApps, initializeApp } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'

const cliConfigPath = path.join(os.homedir(), '.config', 'configstore', 'firebase-tools.json')
const tempAdcPath = path.resolve('temp_adc.json')

try {
  if (!fs.existsSync(cliConfigPath)) {
    throw new Error(`Firebase CLI config not found at ${cliConfigPath}.`)
  }

  const cliConfig = JSON.parse(fs.readFileSync(cliConfigPath, 'utf8'))
  const refreshToken = cliConfig?.tokens?.refresh_token

  if (!refreshToken) {
    throw new Error('Refresh token not found in Firebase CLI config.')
  }

  const adcContent = {
    type: 'authorized_user',
    client_id: '563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com',
    client_secret: 'j9iVZfS8kkCEFUPaAeJV0sAi',
    refresh_token: refreshToken,
  }

  fs.writeFileSync(tempAdcPath, JSON.stringify(adcContent, null, 2), 'utf8')
  process.env.GOOGLE_APPLICATION_CREDENTIALS = tempAdcPath
  
  if (getApps().length === 0) {
    initializeApp({ projectId: 'morgan-bank' })
  }

  const db = getFirestore()
  const docRef = db.collection('studentCredentials').doc('edge-test')
  const doc = await docRef.get()
  
  if (doc.exists) {
    console.log('edge-test document:', doc.data())
  } else {
    console.log('edge-test document DOES NOT EXIST.')
  }
} catch (error) {
  console.error('Error:', error)
} finally {
  if (fs.existsSync(tempAdcPath)) {
    fs.unlinkSync(tempAdcPath)
  }
}
