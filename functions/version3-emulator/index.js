import process from 'node:process'

import { getApps, initializeApp } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'
import { HttpsError, onCall } from 'firebase-functions/v2/https'

import {
  assertVersion3GeminiEmulatorRuntime,
  callableErrorCode,
  callableErrorDetails,
  callableLogCategory,
  createVersion3GeminiEmulatorHandler,
} from '../insights/emulatorCallable.js'

// This source is intentionally undiscoverable outside the Functions emulator.
// The default deployable Functions config also excludes this entire directory.
if (process.env.FUNCTIONS_EMULATOR !== 'true') {
  throw new Error('Version 3 emulator Functions discovery is disabled.')
}

if (getApps().length === 0) initializeApp()

// Version 3 Checkpoints A/B: an emulator-only callable with no live provider,
// model, key, SDK, network, price lookup, or production override path.
export const analyzeTeacherInsightsV3 = onCall(async (request) => {
  try {
    assertVersion3GeminiEmulatorRuntime({
      environment: process.env,
      projectId: process.env.GCLOUD_PROJECT,
      adminAppCount: getApps().length,
      adminProjectId: getApps()[0]?.options?.projectId,
    })
    // This repository-local calculator import remains behind every runtime
    // guard and exists only in the dedicated emulator source.
    const { buildClassInsightsReport } = await import('../../src/insights/classInsights.js')
    const analyze = createVersion3GeminiEmulatorHandler({
      firestore: getFirestore(),
      calculateReport: buildClassInsightsReport,
    })
    return await analyze({ auth: request.auth, data: request.data })
  } catch (error) {
    globalThis.console.warn('Version 3 emulator analysis refused.', {
      operation: 'analyzeTeacherInsightsV3',
      category: callableLogCategory(error),
    })
    throw new HttpsError(
      callableErrorCode(error),
      'Version 3 emulator analysis is unavailable.',
      callableErrorDetails(error),
    )
  }
})
