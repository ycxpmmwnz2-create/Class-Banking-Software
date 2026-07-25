import process from 'node:process'
process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080'

import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'

import { Timestamp } from 'firebase-admin/firestore'

import {
  migrateClassroomData,
  MigrateClassroomDataError,
  MIGRATE_CLASSROOM_DATA_ERROR_CATEGORIES,
} from './migrateClassroomData.js'
import { deriveCanonicalManifestSlot } from './manifestSlot.js'
import { MANIFEST_MODES } from './manifest.js'
import { serializeCanonicalState } from './canonicalState.js'

const PROJECT_ID = 'cli-test-project-id'
const CLASSROOM_ID = 'cli-test-classroom'

function cleanManifestFile(teacherUid) {
  const slot = deriveCanonicalManifestSlot({ emulatorProjectId: PROJECT_ID, teacherUid })
  if (fs.existsSync(slot.manifestPath)) {
    fs.unlinkSync(slot.manifestPath)
  }
}

function envelope(collection, id, data, second = 10) {
  return {
    id,
    path: `${collection}/${id}`,
    data,
    updateTime: new Timestamp(second, 100000000),
  }
}

function fixtureData(teacherUid = 'cli-test-teacher-uid') {
  const teacher = envelope('teachers', teacherUid, {
    uid: teacherUid,
    classroomId: CLASSROOM_ID,
    status: 'active',
  }, 1)

  const classroom = envelope('classrooms', CLASSROOM_ID, {
    ownerUid: teacherUid,
    name: 'CLI Test Class',
    createdAt: new Timestamp(10, 0),
    updatedAt: new Timestamp(20, 0),
    version: 1,
    settings: {},
  }, 2)

  const legacyClassroomData = envelope('morganBank', 'classroomData', {
    students: [
      { id: 's1', name: 'Alice', balance: 10, frozen: false },
    ],
    transactions: [],
    loginHistory: [],
    settings: { currencyName: 'Bucks' },
    lastBackupAt: new Timestamp(30, 0),
  }, 3)

  const studentCredentials = [
    envelope('studentCredentials', 's1-login', {
      classroomId: 'morgan',
      studentId: 's1',
      active: true,
      pinHash: 'hash-s1-pin',
    }, 4),
  ]

  const studentAuthLogs = []

  return {
    teacher,
    classroom,
    legacyClassroomData,
    studentCredentials,
    studentAuthLogs,
  }
}

class FakeQuery {
  constructor(firestore, path, cursorId = null, limitVal = null) {
    this.firestore = firestore
    this.path = path
    this.cursorId = cursorId
    this.limitVal = limitVal
  }

  doc(docId) {
    return this.firestore.doc(`${this.path}/${docId}`)
  }

  orderBy() {
    return this
  }

  startAfter(snapshot) {
    const id = typeof snapshot === 'object' && snapshot !== null ? snapshot.id : snapshot
    return new FakeQuery(this.firestore, this.path, id, this.limitVal)
  }

  limit(val) {
    return new FakeQuery(this.firestore, this.path, this.cursorId, val)
  }

  async get() {
    const all = []
    for (const [p, doc] of this.firestore.docsMap.entries()) {
      if (p.startsWith(`${this.path}/`) && p.split('/').length === this.path.split('/').length + 1) {
        all.push({
          exists: true,
          id: doc.id ?? p.split('/').pop(),
          ref: this.firestore.doc(p),
          data: () => doc.data,
          updateTime: doc.updateTime ?? new Timestamp(100, 0),
        })
      }
    }
    all.sort((a, b) => a.id.localeCompare(b.id))
    let filtered = all
    if (this.cursorId !== null) {
      const idx = all.findIndex(d => d.id === this.cursorId)
      if (idx !== -1) {
        filtered = all.slice(idx + 1)
      }
    }
    if (this.limitVal !== null) {
      filtered = filtered.slice(0, this.limitVal)
    }
    return {
      docs: filtered,
      empty: filtered.length === 0,
      size: filtered.length,
    }
  }
}

function fakeFirestore(initialDocs = {}) {
  const docs = new Map(Object.entries(initialDocs))
  const writeHistory = []

  const self = {
    docsMap: docs,
    writeHistory,
    doc(path) {
      return {
        id: path.split('/').pop(),
        path,
        async get() {
          if (!docs.has(path)) {
            return { exists: false, id: path.split('/').pop(), ref: self.doc(path), data: () => undefined }
          }
          const entry = docs.get(path)
          return {
            exists: true,
            id: entry.id ?? path.split('/').pop(),
            ref: self.doc(path),
            data: () => entry.data,
            updateTime: entry.updateTime ?? new Timestamp(100, 0),
          }
        },
        async set(data, options) {
          writeHistory.push({ type: 'set', path, data, options })
          docs.set(path, { id: path.split('/').pop(), path, data, updateTime: new Timestamp(200, 0) })
        },
        async update(data) {
          writeHistory.push({ type: 'update', path, data })
          const existing = docs.get(path)?.data ?? {}
          docs.set(path, { id: path.split('/').pop(), path, data: { ...existing, ...data }, updateTime: new Timestamp(200, 0) })
        },
      }
    },
    collection(collectionPath) {
      return new FakeQuery(self, collectionPath)
    },
    batch() {
      const batchWrites = []
      return {
        create(docRef, data) {
          batchWrites.push({ type: 'create', ref: docRef, data })
        },
        set(docRef, data, options) {
          batchWrites.push({ type: 'set', ref: docRef, data, options })
        },
        update(docRef, data, options) {
          batchWrites.push({ type: 'update', ref: docRef, data, options })
        },
        async commit() {
          for (const op of batchWrites) {
            if (op.type === 'create') {
              await op.ref.set(op.data)
            } else if (op.type === 'set') {
              await op.ref.set(op.data, op.options)
            } else if (op.type === 'update') {
              await op.ref.update(op.data)
            }
          }
        },
      }
    },
  }

  return self
}

function buildFirestoreMap(fix) {
  const map = {}
  map[fix.teacher.path] = fix.teacher
  map[fix.classroom.path] = fix.classroom
  map[fix.legacyClassroomData.path] = fix.legacyClassroomData
  for (const cred of fix.studentCredentials) {
    map[cred.path] = cred
  }
  for (const log of fix.studentAuthLogs) {
    map[log.path] = log
  }
  return map
}

test('canonical slot inspected before fresh source planning and dry run makes zero destination writes', async () => {
  const teacherUid = 'teacher-dryrun-1'
  cleanManifestFile(teacherUid)
  const fix = fixtureData(teacherUid)
  const db = fakeFirestore(buildFirestoreMap(fix))
  const slot = deriveCanonicalManifestSlot({ emulatorProjectId: PROJECT_ID, teacherUid })

  const result = await migrateClassroomData({
    firestore: db,
    teacherUid,
    projectId: PROJECT_ID,
    write: false,
  })

  assert.equal(result.mode, MANIFEST_MODES.DRY_RUN)
  assert.equal(result.canonicalPath, slot.manifestPath)
  assert.equal(result.writesApplied, 0)
  assert.equal(result.manifest.mode, MANIFEST_MODES.DRY_RUN)
  assert.equal(result.manifest.writePhaseStarted, false)

  assert.ok(fs.existsSync(slot.manifestPath))

  // Verify ZERO destination collection writes were performed
  const destinationPaths = Array.from(db.docsMap.keys()).filter(p => p !== slot.manifestPath)
  for (const path of destinationPaths) {
    assert.ok(!path.includes(`classrooms/${CLASSROOM_ID}/students`), `No student write expected at ${path}`)
  }
})

test('write mode consumes retained planned manifest', async () => {
  const teacherUid = 'teacher-write-1'
  cleanManifestFile(teacherUid)
  const fix = fixtureData(teacherUid)
  const db = fakeFirestore(buildFirestoreMap(fix))

  // Step 1: Dry run creates planned manifest
  const dryRunResult = await migrateClassroomData({
    firestore: db,
    teacherUid,
    projectId: PROJECT_ID,
    write: false,
  })

  assert.equal(dryRunResult.manifest.runState, 'planned')

  // Step 2: Write run consumes retained planned manifest
  const writeResult = await migrateClassroomData({
    firestore: db,
    teacherUid,
    projectId: PROJECT_ID,
    write: true,
  })

  assert.equal(writeResult.mode, MANIFEST_MODES.WRITE)
  assert.equal(writeResult.manifest.runState, 'completed')
  assert.equal(writeResult.manifest.writePhaseStarted, true)
  assert.equal(writeResult.writesApplied, 3)
})

test('planned-manifest drift blocks execution', async () => {
  const teacherUid = 'teacher-drift-1'
  cleanManifestFile(teacherUid)
  const fix = fixtureData(teacherUid)
  const db = fakeFirestore(buildFirestoreMap(fix))

  // Step 1: Dry run
  await migrateClassroomData({
    firestore: db,
    teacherUid,
    projectId: PROJECT_ID,
    write: false,
  })

  // Mutate source classroom settings
  db.docsMap.get('morganBank/classroomData').data.settings.currencyName = 'Altered Currency'

  // Step 2: Attempt write with drifted source
  await assert.rejects(
    async () => {
      await migrateClassroomData({
        firestore: db,
        teacherUid,
        projectId: PROJECT_ID,
        write: true,
      })
    },
    err => {
      assert.ok(err instanceof MigrateClassroomDataError)
      assert.equal(err.category, MIGRATE_CLASSROOM_DATA_ERROR_CATEGORIES.STALE_MANIFEST_DRIFT)
      return true
    },
  )
})

test('failed + writePhaseStarted:false same-slot replacement', async () => {
  const teacherUid = 'teacher-replace-1'
  cleanManifestFile(teacherUid)
  const fix = fixtureData(teacherUid)
  const slot = deriveCanonicalManifestSlot({ emulatorProjectId: PROJECT_ID, teacherUid })

  // Dry run first
  const db = fakeFirestore(buildFirestoreMap(fix))
  const initialResult = await migrateClassroomData({
    firestore: db,
    teacherUid,
    projectId: PROJECT_ID,
    write: false,
  })

  // Mutate file on disk to be failed dry-run manifest (writePhaseStarted === false)
  const diskManifest = JSON.parse(fs.readFileSync(slot.manifestPath, 'utf8'))
  diskManifest.runState = 'failed'
  diskManifest.writePhaseStarted = false
  fs.writeFileSync(slot.manifestPath, serializeCanonicalState(diskManifest))

  // Next run should replace the failed dry-run manifest cleanly
  const freshResult = await migrateClassroomData({
    firestore: db,
    teacherUid,
    projectId: PROJECT_ID,
    write: false,
  })

  assert.equal(freshResult.manifest.runState, 'planned')
  assert.notEqual(freshResult.manifest.runId, initialResult.manifest.runId)
})

test('replacement validation failure preserves old failed manifest', async () => {
  const teacherUid = 'teacher-preserve-1'
  cleanManifestFile(teacherUid)
  const fix = fixtureData(teacherUid)
  const slot = deriveCanonicalManifestSlot({ emulatorProjectId: PROJECT_ID, teacherUid })

  const db = fakeFirestore(buildFirestoreMap(fix))
  const initialResult = await migrateClassroomData({
    firestore: db,
    teacherUid,
    projectId: PROJECT_ID,
    write: false,
  })

  // Mutate manifest file on disk to failed dry run
  const diskManifest = JSON.parse(fs.readFileSync(slot.manifestPath, 'utf8'))
  diskManifest.runState = 'failed'
  diskManifest.writePhaseStarted = false
  fs.writeFileSync(slot.manifestPath, serializeCanonicalState(diskManifest))

  // Make source invalid (e.g. credential classroomId invalid)
  db.docsMap.get('studentCredentials/s1-login').data.classroomId = 'invalid-classroom'

  await assert.rejects(
    async () => {
      await migrateClassroomData({
        firestore: db,
        teacherUid,
        projectId: PROJECT_ID,
        write: false,
      })
    },
    err => {
      assert.ok(err instanceof MigrateClassroomDataError)
      assert.equal(err.category, MIGRATE_CLASSROOM_DATA_ERROR_CATEGORIES.CREDENTIAL_CLASSROOM_ID_INVALID)
      return true
    },
  )

  // Old failed manifest remains intact on disk
  const preserved = JSON.parse(fs.readFileSync(slot.manifestPath, 'utf8'))
  assert.equal(preserved.runId, initialResult.manifest.runId)
  assert.equal(preserved.runState, 'failed')
})

test('writePhaseStarted:true state is never replaced by fresh planning', async () => {
  const teacherUid = 'teacher-write-started-1'
  cleanManifestFile(teacherUid)
  const fix = fixtureData(teacherUid)
  const db = fakeFirestore(buildFirestoreMap(fix))

  // Execute write mode
  const writeResult = await migrateClassroomData({
    firestore: db,
    teacherUid,
    projectId: PROJECT_ID,
    write: true,
  })

  assert.equal(writeResult.manifest.writePhaseStarted, true)

  // Reverification should run on completed manifest, never fresh replacement
  const reResult = await migrateClassroomData({
    firestore: db,
    teacherUid,
    projectId: PROJECT_ID,
    write: false,
  })

  assert.equal(reResult.reverified, true)
})

test('completed manifests are read-only reverification', async () => {
  const teacherUid = 'teacher-reverify-1'
  cleanManifestFile(teacherUid)
  const fix = fixtureData(teacherUid)
  const db = fakeFirestore(buildFirestoreMap(fix))

  // Complete a write run
  await migrateClassroomData({
    firestore: db,
    teacherUid,
    projectId: PROJECT_ID,
    write: true,
  })

  // Run again with write: false
  const reverifyResult = await migrateClassroomData({
    firestore: db,
    teacherUid,
    projectId: PROJECT_ID,
    write: false,
  })

  assert.equal(reverifyResult.reverified, true)
  assert.equal(reverifyResult.manifest.runState, 'completed')
  assert.equal(reverifyResult.writesApplied, 0)
})

test('no secret credential leakage in manifest or error output', async () => {
  const teacherUid = 'teacher-secret-1'
  cleanManifestFile(teacherUid)
  const fix = fixtureData(teacherUid)
  const db = fakeFirestore(buildFirestoreMap(fix))

  const result = await migrateClassroomData({
    firestore: db,
    teacherUid,
    projectId: PROJECT_ID,
    write: false,
  })

  const manifestJson = JSON.stringify(result.manifest)
  assert.ok(!manifestJson.includes('hash-s1-pin'), 'PIN hash must not be present in manifest')
})
