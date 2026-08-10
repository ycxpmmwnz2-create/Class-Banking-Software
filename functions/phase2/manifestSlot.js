import { fileURLToPath, URL } from 'node:url'
import path from 'node:path'

import { hashCanonicalState } from './canonicalState.js'

export const PHASE2A_MIGRATION_ID =
  'class-banking-phase2a-legacy-classroom-migration'
export const MANIFEST_SCHEMA_VERSION = 1
export const CANONICAL_STATE_DIRECTORY = fileURLToPath(
  new URL('./.state/', import.meta.url),
)

const IDENTITY_KEYS = new Set(['emulatorProjectId', 'teacherUid'])

function requireIdentityOptions(options) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('Manifest slot identity options are required.')
  }

  const suppliedKeys = Reflect.ownKeys(options)
  const unsupportedKeys = suppliedKeys.filter(key =>
    typeof key !== 'string' || !IDENTITY_KEYS.has(key),
  )

  if (unsupportedKeys.length > 0) {
    throw new TypeError('Manifest slot does not accept override inputs.')
  }

  for (const key of IDENTITY_KEYS) {
    if (!Object.hasOwn(options, key) ||
        typeof options[key] !== 'string' ||
        options[key].length === 0 ||
        options[key].trim() !== options[key]) {
      throw new TypeError(`${key} must be a non-empty canonical string.`)
    }
  }
}

export function deriveCanonicalManifestSlot(options) {
  requireIdentityOptions(options)

  const filenameHash = hashCanonicalState({
    migrationId: PHASE2A_MIGRATION_ID,
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    emulatorProjectId: options.emulatorProjectId,
    teacherUid: options.teacherUid,
  })
  const filename = `${filenameHash}.manifest.json`

  return Object.freeze({
    stateDirectory: CANONICAL_STATE_DIRECTORY,
    filename,
    manifestPath: path.join(CANONICAL_STATE_DIRECTORY, filename),
  })
}
