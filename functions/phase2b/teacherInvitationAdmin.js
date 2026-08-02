import { FieldValue, Timestamp } from 'firebase-admin/firestore'
import { HttpsError } from 'firebase-functions/v2/https'

import {
  FIRESTORE_COLLECTIONS,
  INVITATION_STATUS,
} from '../phase1/firestoreSchema.js'
import {
  hashEmailDigest,
  normalizeEmail,
  validateCanonicalDocumentId,
} from './identityNormalization.js'

export const DEFAULT_INVITATION_EXPIRY_HOURS = 48
export const MIN_INVITATION_EXPIRY_HOURS = 1
export const MAX_INVITATION_EXPIRY_HOURS = 168
export const FOUNDING_PLATFORM_ADMIN_UID = 'YkYUzIzy0aW7roolM1VaLcIJPuN2'

export class TeacherInvitationAdminError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'TeacherInvitationAdminError'
    this.code = code
  }
}

function requirePlatformAdmin(auth) {
  if (!auth || typeof auth !== 'object') {
    throw new TeacherInvitationAdminError('unauthenticated', 'Authentication required.')
  }

  try {
    validateCanonicalDocumentId(auth.uid, 'auth.uid')
  } catch {
    throw new TeacherInvitationAdminError('unauthenticated', 'Authentication UID is malformed.')
  }

  // Both accepted authorities come from the signed Firebase token: the
  // founding UID bootstraps the existing owner without a separate production
  // Auth mutation, while the exact custom claim permits a later reviewed admin
  // assignment. Request data, local storage, query parameters, and classroom
  // ownership are never substitutes for either authority.
  if (
    auth.token?.role === 'student' ||
    (
      auth.uid !== FOUNDING_PLATFORM_ADMIN_UID &&
      auth.token?.platformAdmin !== true
    )
  ) {
    throw new TeacherInvitationAdminError(
      'permission-denied',
      'Platform administrator access required.',
    )
  }

  return auth.uid
}

function requireFirestore(firestore) {
  if (
    !firestore ||
    typeof firestore.collection !== 'function' ||
    typeof firestore.runTransaction !== 'function'
  ) {
    throw new TypeError('firestore with collection and runTransaction methods is required.')
  }
}

function requireExactData(data, allowedKeys) {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new TeacherInvitationAdminError('invalid-argument', 'Request data must be an object.')
  }

  for (const key of Object.keys(data)) {
    if (!allowedKeys.includes(key)) {
      throw new TeacherInvitationAdminError(
        'invalid-argument',
        `Unknown request field: ${key}`,
      )
    }
  }
}

function requireEmail(rawEmail) {
  try {
    return normalizeEmail(rawEmail)
  } catch {
    throw new TeacherInvitationAdminError('invalid-argument', 'A valid teacher email is required.')
  }
}

function requireExpiryHours(rawHours) {
  const hours = rawHours === undefined
    ? DEFAULT_INVITATION_EXPIRY_HOURS
    : rawHours

  if (
    !Number.isInteger(hours) ||
    hours < MIN_INVITATION_EXPIRY_HOURS ||
    hours > MAX_INVITATION_EXPIRY_HOURS
  ) {
    throw new TeacherInvitationAdminError(
      'invalid-argument',
      `expiresInHours must be an integer from ${MIN_INVITATION_EXPIRY_HOURS} to ${MAX_INVITATION_EXPIRY_HOURS}.`,
    )
  }

  return hours
}

function epochMillis(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null
  }
  if (value instanceof Date) {
    const millis = value.getTime()
    return Number.isFinite(millis) ? millis : null
  }
  if (value && typeof value.toMillis === 'function') {
    const millis = value.toMillis()
    return typeof millis === 'number' && Number.isFinite(millis) ? millis : null
  }
  return null
}

function requireNowMillis(now) {
  if (typeof now !== 'function') {
    throw new TypeError('now must be a function returning the current time.')
  }
  const millis = epochMillis(now())
  if (millis === null) {
    throw new TypeError('now must return a finite time value.')
  }
  return millis
}

function validateStoredInvitationIdentity(invitation, normalizedEmail) {
  if (!invitation || typeof invitation !== 'object') {
    throw new TeacherInvitationAdminError(
      'failed-precondition',
      'Stored invitation is malformed.',
    )
  }

  let storedEmail
  try {
    storedEmail = normalizeEmail(invitation.email)
  } catch {
    throw new TeacherInvitationAdminError(
      'failed-precondition',
      'Stored invitation identity is malformed.',
    )
  }

  if (storedEmail !== normalizedEmail || invitation.email !== normalizedEmail) {
    throw new TeacherInvitationAdminError(
      'failed-precondition',
      'Stored invitation identity does not match its document key.',
    )
  }
}

function validateStoredReusableInvitationShape(invitation) {
  const keys = Object.keys(invitation).sort()
  const expectedKeys = ['createdAt', 'email', 'expiresAt', 'status']
  if (
    keys.length !== expectedKeys.length ||
    !keys.every((key, index) => key === expectedKeys[index])
  ) {
    throw new TeacherInvitationAdminError(
      'failed-precondition',
      'Stored invitation has unexpected fields.',
    )
  }

  const createdAtMillis = epochMillis(invitation.createdAt)
  const expiresAtMillis = epochMillis(invitation.expiresAt)
  if (
    createdAtMillis === null ||
    expiresAtMillis === null ||
    expiresAtMillis <= createdAtMillis
  ) {
    throw new TeacherInvitationAdminError(
      'failed-precondition',
      'Stored invitation timestamps are malformed.',
    )
  }
}

function invitationDocument({ normalizedEmail, timestamp, expiresAt }) {
  return {
    email: normalizedEmail,
    status: INVITATION_STATUS.ACTIVE,
    createdAt: timestamp,
    expiresAt,
  }
}

function mapRetryableTransactionError(error) {
  if (error instanceof TeacherInvitationAdminError) return error
  const code = error?.code
  if (code === 10 || code === 'aborted' || code === 'ABORTED') {
    return new TeacherInvitationAdminError(
      'aborted',
      'Invitation transaction contention requires a retry.',
    )
  }
  return error
}

export async function createTeacherInvitationService({
  firestore,
  auth,
  data,
  now = () => Date.now(),
  serverTimestamp = FieldValue.serverTimestamp,
  timestampFromMillis = Timestamp.fromMillis,
}) {
  requirePlatformAdmin(auth)
  requireFirestore(firestore)
  requireExactData(data, ['email', 'expiresInHours'])

  if (typeof serverTimestamp !== 'function') {
    throw new TypeError('serverTimestamp must be a function returning a write timestamp.')
  }
  if (typeof timestampFromMillis !== 'function') {
    throw new TypeError('timestampFromMillis must be a function.')
  }

  const normalizedEmail = requireEmail(data.email)
  const expiresInHours = requireExpiryHours(data.expiresInHours)
  const nowMillis = requireNowMillis(now)
  const expiresMillis = nowMillis + (expiresInHours * 60 * 60 * 1000)
  if (!Number.isSafeInteger(expiresMillis)) {
    throw new TeacherInvitationAdminError('invalid-argument', 'Invitation expiry is invalid.')
  }

  const invitationRef = firestore
    .collection(FIRESTORE_COLLECTIONS.TEACHER_INVITATIONS)
    .doc(hashEmailDigest(normalizedEmail))

  try {
    return await firestore.runTransaction(async transaction => {
      const invitationSnapshot = await transaction.get(invitationRef)

      if (invitationSnapshot.exists) {
        const existing = invitationSnapshot.data() ?? {}
        validateStoredInvitationIdentity(existing, normalizedEmail)

        if (existing.status === INVITATION_STATUS.CONSUMED) {
          throw new TeacherInvitationAdminError(
            'failed-precondition',
            'A consumed invitation can never be reactivated.',
          )
        }

        validateStoredReusableInvitationShape(existing)

        if (existing.status === INVITATION_STATUS.ACTIVE) {
          const existingExpiry = epochMillis(existing.expiresAt)
          if (existingExpiry === null) {
            throw new TeacherInvitationAdminError(
              'failed-precondition',
              'Active invitation expiry is malformed.',
            )
          }
          if (existingExpiry > nowMillis) {
            return { success: true, status: INVITATION_STATUS.ACTIVE, created: false }
          }
        } else if (existing.status !== INVITATION_STATUS.REVOKED) {
          throw new TeacherInvitationAdminError(
            'failed-precondition',
            'Stored invitation status is invalid.',
          )
        }
      }

      const document = invitationDocument({
        normalizedEmail,
        timestamp: serverTimestamp(),
        expiresAt: timestampFromMillis(expiresMillis),
      })

      if (invitationSnapshot.exists) {
        // Replaces a revoked or expired invitation with the exact four-field
        // active schema. Consumption metadata can therefore never survive into
        // a reissued invitation.
        transaction.set(invitationRef, document)
      } else {
        transaction.create(invitationRef, document)
      }

      return { success: true, status: INVITATION_STATUS.ACTIVE, created: true }
    })
  } catch (error) {
    throw mapRetryableTransactionError(error)
  }
}

export async function revokeTeacherInvitationService({
  firestore,
  auth,
  data,
}) {
  requirePlatformAdmin(auth)
  requireFirestore(firestore)
  requireExactData(data, ['email'])

  const normalizedEmail = requireEmail(data.email)
  const invitationRef = firestore
    .collection(FIRESTORE_COLLECTIONS.TEACHER_INVITATIONS)
    .doc(hashEmailDigest(normalizedEmail))

  try {
    return await firestore.runTransaction(async transaction => {
      const invitationSnapshot = await transaction.get(invitationRef)

      if (!invitationSnapshot.exists) {
        return { success: true, status: 'not-found', revoked: false }
      }

      const existing = invitationSnapshot.data() ?? {}
      validateStoredInvitationIdentity(existing, normalizedEmail)

      if (existing.status === INVITATION_STATUS.CONSUMED) {
        throw new TeacherInvitationAdminError(
          'failed-precondition',
          'A consumed invitation cannot be revoked.',
        )
      }


      validateStoredReusableInvitationShape(existing)

      if (existing.status === INVITATION_STATUS.REVOKED) {
        return { success: true, status: INVITATION_STATUS.REVOKED, revoked: false }
      }

      if (existing.status !== INVITATION_STATUS.ACTIVE) {
        throw new TeacherInvitationAdminError(
          'failed-precondition',
          'Stored invitation status is invalid.',
        )
      }

      transaction.update(invitationRef, { status: INVITATION_STATUS.REVOKED })
      return { success: true, status: INVITATION_STATUS.REVOKED, revoked: true }
    })
  } catch (error) {
    throw mapRetryableTransactionError(error)
  }
}

const SAFE_ADMIN_MESSAGES = Object.freeze({
  'unauthenticated': 'Sign in required.',
  'permission-denied': 'Platform administrator access is required.',
  'invalid-argument': 'Enter a valid teacher email and invitation expiration.',
  'failed-precondition': 'This invitation cannot be changed automatically.',
  'aborted': 'The invitation could not be changed. Please try again.',
  'internal': 'An unexpected internal error occurred.',
})

function safeHttpsError(error) {
  const rawCode = error instanceof TeacherInvitationAdminError
    ? error.code
    : error instanceof HttpsError
      ? error.code
      : 'internal'
  const code = Object.prototype.hasOwnProperty.call(SAFE_ADMIN_MESSAGES, rawCode)
    ? rawCode
    : 'internal'
  return new HttpsError(code, SAFE_ADMIN_MESSAGES[code])
}

async function invitationAdminCallable(request, options, service) {
  try {
    return await service({
      firestore: options.firestore,
      auth: request?.auth,
      data: request?.data,
      now: options.now,
      serverTimestamp: options.serverTimestamp,
      timestampFromMillis: options.timestampFromMillis,
    })
  } catch (error) {
    throw safeHttpsError(error)
  }
}

export async function createTeacherInvitationCallable(request, options = {}) {
  return invitationAdminCallable(
    request,
    options,
    options.createTeacherInvitationService ?? createTeacherInvitationService,
  )
}

export async function revokeTeacherInvitationCallable(request, options = {}) {
  return invitationAdminCallable(
    request,
    options,
    options.revokeTeacherInvitationService ?? revokeTeacherInvitationService,
  )
}
