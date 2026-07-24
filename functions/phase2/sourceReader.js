import { FieldPath } from 'firebase-admin/firestore'

export const DEFAULT_SOURCE_PAGE_SIZE = 250

export const LEGACY_SOURCE_PATHS = Object.freeze({
  CLASSROOM_DATA: 'morganBank/classroomData',
  STUDENT_AUTH_LOGS: 'studentAuthLogs',
  STUDENT_CREDENTIALS: 'studentCredentials',
})

export const SOURCE_READER_ERROR_CATEGORIES = Object.freeze({
  DUPLICATE_DOCUMENT: 'duplicate-document',
  INVALID_ARGUMENTS: 'invalid-arguments',
  INVALID_DOCUMENT_SNAPSHOT: 'invalid-document-snapshot',
  INVALID_FIRESTORE: 'invalid-firestore',
  INVALID_PAGE_SIZE: 'invalid-page-size',
  INVALID_QUERY: 'invalid-query',
  INVALID_QUERY_SNAPSHOT: 'invalid-query-snapshot',
  UNKNOWN_ARGUMENT: 'unknown-argument',
})

export class SourceReaderError extends Error {
  constructor(category, message, details = {}) {
    super(message)
    this.name = 'SourceReaderError'
    this.code = 'PHASE2A_SOURCE_READER_ERROR'
    this.category = category
    this.blocking = true
    this.details = Object.freeze({ ...details })
  }
}

function sourceReaderError(category, message, details = {}) {
  return new SourceReaderError(category, message, details)
}

function validateOptions(options) {
  if (options === null || typeof options !== 'object' ||
      Array.isArray(options)) {
    throw sourceReaderError(
      SOURCE_READER_ERROR_CATEGORIES.INVALID_ARGUMENTS,
      'readLegacySources requires an options object.',
    )
  }

  const allowedKeys = new Set(['firestore', 'pageSize'])
  const unknownKey = Reflect.ownKeys(options).find(key =>
    typeof key !== 'string' || !allowedKeys.has(key),
  )

  if (unknownKey !== undefined) {
    throw sourceReaderError(
      SOURCE_READER_ERROR_CATEGORIES.UNKNOWN_ARGUMENT,
      `Unknown source-reader argument: ${String(unknownKey)}.`,
      { argument: String(unknownKey) },
    )
  }

  const { firestore, pageSize = DEFAULT_SOURCE_PAGE_SIZE } = options

  if (firestore === null ||
      (typeof firestore !== 'object' && typeof firestore !== 'function') ||
      typeof firestore.doc !== 'function' ||
      typeof firestore.collection !== 'function') {
    throw sourceReaderError(
      SOURCE_READER_ERROR_CATEGORIES.INVALID_FIRESTORE,
      'firestore must provide read-capable doc() and collection() methods.',
    )
  }

  // The injectable value exists to force pagination in focused tests. It may
  // make pages smaller, but it cannot silently expand the production bound.
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 ||
      pageSize > DEFAULT_SOURCE_PAGE_SIZE) {
    throw sourceReaderError(
      SOURCE_READER_ERROR_CATEGORIES.INVALID_PAGE_SIZE,
      `pageSize must be a positive integer no greater than ${DEFAULT_SOURCE_PAGE_SIZE}.`,
      { pageSize },
    )
  }

  return { firestore, pageSize }
}

function requireMethod(value, methodName, context) {
  if (value === null ||
      (typeof value !== 'object' && typeof value !== 'function') ||
      typeof value[methodName] !== 'function') {
    throw sourceReaderError(
      SOURCE_READER_ERROR_CATEGORIES.INVALID_QUERY,
      `${context} must provide ${methodName}().`,
      { context, methodName },
    )
  }

  return value
}

function documentEnvelope(snapshot, expectedPath) {
  if (snapshot === null || typeof snapshot !== 'object' ||
      snapshot.exists !== true || typeof snapshot.id !== 'string' ||
      snapshot.id.length === 0 || snapshot.ref === null ||
      typeof snapshot.ref !== 'object' ||
      snapshot.ref.path !== expectedPath ||
      typeof snapshot.data !== 'function' ||
      snapshot.updateTime == null) {
    throw sourceReaderError(
      SOURCE_READER_ERROR_CATEGORIES.INVALID_DOCUMENT_SNAPSHOT,
      `Firestore returned an invalid document snapshot for ${expectedPath}.`,
      { path: expectedPath },
    )
  }

  const data = snapshot.data()
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw sourceReaderError(
      SOURCE_READER_ERROR_CATEGORIES.INVALID_DOCUMENT_SNAPSHOT,
      `Firestore returned invalid document data for ${expectedPath}.`,
      { path: expectedPath },
    )
  }

  return {
    id: snapshot.id,
    path: snapshot.ref.path,
    data,
    updateTime: snapshot.updateTime,
  }
}

async function readOptionalDocument(firestore, path) {
  const reference = firestore.doc(path)
  requireMethod(reference, 'get', `Document reference ${path}`)

  const snapshot = await reference.get()
  if (snapshot === null || typeof snapshot !== 'object' ||
      typeof snapshot.exists !== 'boolean') {
    throw sourceReaderError(
      SOURCE_READER_ERROR_CATEGORIES.INVALID_DOCUMENT_SNAPSHOT,
      `Firestore returned an invalid document snapshot for ${path}.`,
      { path },
    )
  }

  if (!snapshot.exists) {
    return null
  }

  return documentEnvelope(snapshot, path)
}

function querySnapshotDocuments(snapshot, collectionPath, pageNumber) {
  if (snapshot === null || typeof snapshot !== 'object' ||
      !Array.isArray(snapshot.docs)) {
    throw sourceReaderError(
      SOURCE_READER_ERROR_CATEGORIES.INVALID_QUERY_SNAPSHOT,
      `Firestore returned an invalid query snapshot for ${collectionPath}.`,
      { collectionPath, pageNumber },
    )
  }

  return snapshot.docs
}

async function readPaginatedCollection(firestore, collectionPath, pageSize) {
  const collection = firestore.collection(collectionPath)
  requireMethod(collection, 'orderBy', `Collection ${collectionPath}`)

  const documents = []
  const seenPaths = new Set()
  let cursor = null
  let pageNumber = 1

  while (true) {
    let query = collection.orderBy(FieldPath.documentId())
    requireMethod(query, 'limit', `Ordered query for ${collectionPath}`)

    if (cursor !== null) {
      requireMethod(query, 'startAfter', `Ordered query for ${collectionPath}`)
      query = query.startAfter(cursor)
      requireMethod(query, 'limit', `Cursor query for ${collectionPath}`)
    }

    query = query.limit(pageSize)
    requireMethod(query, 'get', `Limited query for ${collectionPath}`)

    const querySnapshot = await query.get()
    const page = querySnapshotDocuments(
      querySnapshot,
      collectionPath,
      pageNumber,
    )

    if (page.length > pageSize) {
      throw sourceReaderError(
        SOURCE_READER_ERROR_CATEGORIES.INVALID_QUERY_SNAPSHOT,
        `Firestore returned more than ${pageSize} documents for ${collectionPath}.`,
        { collectionPath, pageNumber, returnedCount: page.length },
      )
    }

    for (const snapshot of page) {
      const expectedPath = `${collectionPath}/${snapshot?.id ?? ''}`
      const envelope = documentEnvelope(snapshot, expectedPath)

      if (seenPaths.has(envelope.path)) {
        throw sourceReaderError(
          SOURCE_READER_ERROR_CATEGORIES.DUPLICATE_DOCUMENT,
          `Firestore returned ${envelope.path} more than once while paginating.`,
          { collectionPath, pageNumber, path: envelope.path },
        )
      }

      seenPaths.add(envelope.path)
      documents.push(envelope)
    }

    if (page.length < pageSize) {
      return documents
    }

    cursor = page.at(-1)
    pageNumber += 1
  }
}

/**
 * Reads every legacy migration source without initializing Firestore or
 * exposing any Firestore write surface. The caller injects an already-guarded
 * emulator Firestore instance.
 *
 * A missing legacy singleton is represented as `null`; source validation is
 * deliberately outside this reader's boundary. Empty collections are `[]`.
 */
export async function readLegacySources(options) {
  const { firestore, pageSize } = validateOptions(options)

  const classroomData = await readOptionalDocument(
    firestore,
    LEGACY_SOURCE_PATHS.CLASSROOM_DATA,
  )
  const studentCredentials = await readPaginatedCollection(
    firestore,
    LEGACY_SOURCE_PATHS.STUDENT_CREDENTIALS,
    pageSize,
  )
  const studentAuthLogs = await readPaginatedCollection(
    firestore,
    LEGACY_SOURCE_PATHS.STUDENT_AUTH_LOGS,
    pageSize,
  )

  return {
    classroomData,
    studentCredentials,
    studentAuthLogs,
  }
}
