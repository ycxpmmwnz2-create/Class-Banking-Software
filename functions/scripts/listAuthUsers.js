import fs from 'fs'
import path from 'path'
import os from 'os'
import { getApps, initializeApp } from 'firebase-admin/app'
import { getAuth } from 'firebase-admin/auth'

const cliConfigPath = path.join(os.homedir(), '.config', 'configstore', 'firebase-tools.json')
const tempAdcPath = path.resolve('scripts/temp_adc.json')

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

  console.log('Listing Firebase Auth users...')
  const listUsersResult = await getAuth().listUsers(1000)
  listUsersResult.users.forEach((userRecord) => {
    console.log('USER:', {
      uid: userRecord.uid,
      email: userRecord.email,
      displayName: userRecord.displayName,
    })
  })
} catch (error) {
  console.error('Error listing users:', error)
} finally {
  if (fs.existsSync(tempAdcPath)) {
    fs.unlinkSync(tempAdcPath)
  }
}
