import process from 'node:process'
import { pathToFileURL } from 'node:url'

import { deleteApp, getApps, initializeApp } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'

import { requireFirestoreEmulatorHost } from '../phase2/emulatorEnvironment.js'

export const CHECK_DATA_APP_PREFIX = 'phase2a-check-data-'

export const CHECK_DATA_PATHS = Object.freeze({
  ROSTER: 'morganBank/classroomData',
  CREDENTIAL: 'studentCredentials/edge-test',
})

export class CheckDataArgumentError extends Error {
  constructor(category, message, details = {}) {
    super(message)
    this.name = 'CheckDataArgumentError'
    this.code = 'CHECK_DATA_ARGUMENT_ERROR'
    this.category = category
    Object.assign(this, details)
  }
}

function failArgument(category, message, details) {
  throw new CheckDataArgumentError(category, message, details)
}

export function parseCheckDataArguments(argv) {
  if (!Array.isArray(argv)) {
    failArgument('invalid-arguments', 'Arguments must be provided as an array.')
  }

  let projectId

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]

    if (typeof token !== 'string') {
      failArgument('invalid-argument', 'Every argument must be a string.', { index })
    }

    if (token !== '--project-id') {
      if (token.startsWith('--')) {
        failArgument('unknown-flag', `Unknown flag: ${token}.`, { index, token })
      }

      failArgument(
        'positional-argument',
        `Positional arguments are not supported: ${token}.`,
        { index, token },
      )
    }

    if (projectId !== undefined) {
      failArgument('duplicate-flag', 'Duplicate flag: --project-id.', {
        index,
        token,
      })
    }

    const valueIndex = index + 1
    const value = argv[valueIndex]

    if (
      valueIndex >= argv.length ||
      typeof value !== 'string' ||
      value.length === 0 ||
      value.trim().length === 0 ||
      value.startsWith('--')
    ) {
      failArgument('missing-value', '--project-id requires a value.', {
        flag: '--project-id',
        index,
      })
    }

    if (value.trim() !== value) {
      failArgument(
        'invalid-value',
        '--project-id must not have leading or trailing whitespace.',
        { flag: '--project-id', index: valueIndex },
      )
    }

    projectId = value
    index += 1
  }

  if (projectId === undefined) {
    failArgument(
      'missing-required-flag',
      'Missing required flag: --project-id.',
      { flag: '--project-id' },
    )
  }

  return Object.freeze({ projectId })
}

export function createCheckDataFirestore(projectId, dependencies = {}) {
  requireFirestoreEmulatorHost()

  const listApps = dependencies.getApps ?? getApps
  const initialize = dependencies.initializeApp ?? initializeApp
  const createFirestore = dependencies.getFirestore ?? getFirestore
  const appName = `${CHECK_DATA_APP_PREFIX}${projectId}`
  const existingApp = listApps().find(app => app.name === appName)
  const app = existingApp ?? initialize({ projectId }, appName)

  return Object.freeze({
    app,
    appName,
    firestore: createFirestore(app),
    ownsApp: existingApp === undefined,
  })
}

function formatDocument(snapshot, selectData) {
  if (!snapshot.exists) {
    return '(document missing)'
  }

  return JSON.stringify(selectData(snapshot.data()) ?? null, null, 2)
}

export async function readAndReportCheckData({ firestore, logger }) {
  requireFirestoreEmulatorHost()

  const roster = await firestore.doc(CHECK_DATA_PATHS.ROSTER).get()
  const credential = await firestore.doc(CHECK_DATA_PATHS.CREDENTIAL).get()

  logger.log('--- ROSTER STUDENTS ---')
  logger.log(formatDocument(roster, data => data?.students))
  logger.log('--- CREDENTIAL edge-test ---')
  logger.log(formatDocument(credential, data => data))

  return Object.freeze({ roster, credential })
}

export async function runCheckData(argv = process.argv.slice(2), dependencies = {}) {
  requireFirestoreEmulatorHost()

  const parsed = parseCheckDataArguments(argv)
  const logger = dependencies.logger ?? globalThis.console
  const firestoreFactory = dependencies.firestoreFactory ?? createCheckDataFirestore
  const resources = dependencies.firestore === undefined
    ? firestoreFactory(parsed.projectId)
    : Object.freeze({
      app: undefined,
      appName: undefined,
      firestore: dependencies.firestore,
      ownsApp: false,
    })

  dependencies.onResources?.(resources)

  const result = await readAndReportCheckData({
    firestore: resources.firestore,
    logger,
  })

  return Object.freeze({ parsed, resources, result })
}

export async function closeOwnedCheckDataApp(resources, dependencies = {}) {
  if (!resources?.ownsApp) {
    return false
  }

  const terminate = dependencies.terminate ??
    (firestore => firestore.terminate())
  const removeApp = dependencies.deleteApp ?? deleteApp

  try {
    await terminate(resources.firestore)
  } finally {
    await removeApp(resources.app)
  }

  return true
}

const isDirectExecution = process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url

if (isDirectExecution) {
  let ownedResources

  try {
    await runCheckData(undefined, {
      onResources(resources) {
        ownedResources = resources
      },
    })
  } catch (error) {
    globalThis.console.error(`checkData failed: ${error.message}`)
    process.exitCode = 1
  } finally {
    if (ownedResources?.ownsApp) {
      try {
        await closeOwnedCheckDataApp(ownedResources)
      } catch (error) {
        globalThis.console.error(`checkData cleanup failed: ${error.message}`)
        process.exitCode = 1
      }
    }
  }
}
