import timers from 'node:timers'
import { performance } from 'node:perf_hooks'
import { Buffer } from 'node:buffer'
import { requireClassroomControl } from '../../phase3/classroomAccess.js'
import { DEMO_PROJECT, LIMITS, RESERVATION_MASK, DISPATCH_MASK, ROOT_MASK, QualificationError,
  demo, fail, id, digest, hash, exact, natural, positive, equal, version, compare, frozen } from './common.js'

function session(input, profile) {
  demo(input.projectId)
  const reader = input.reader, clock = input.clock ?? Date.now, tick = input.monotonic ?? (() => performance.now())
  if (reader?.kind !== 'cutover-loopback-reader' || reader.projectId !== DEMO_PROJECT ||
      reader.databaseId !== '(default)' || reader.profile !== profile || typeof reader.listPage !== 'function' ||
      typeof reader.get !== 'function' || typeof clock !== 'function' || typeof tick !== 'function') fail('scope')
  const start = tick(), observedAt = clock(); let previous = start, previousWall = observedAt, reads = 0, bytes = 0
  if (!natural(observedAt) || !Number.isFinite(start)) fail('expired')
  function check() {
    const current = tick(), wall = clock()
    if (!Number.isFinite(current) || current < previous || !natural(wall) || wall < previousWall ||
        current - start >= LIMITS.durationMs || wall - observedAt >= LIMITS.durationMs) fail('expired')
    previous = current; previousWall = wall
  }
  async function read(action) {
    check(); let timer
    try {
      const result = await Promise.race([Promise.resolve().then(action), new Promise((_, reject) => {
        timer = timers.setTimeout(() => reject(new QualificationError('expired')), Math.max(1, Math.min(10000, LIMITS.durationMs - (tick() - start))))
      })])
      check()
      const encoded = JSON.stringify(result)
      bytes += Buffer.byteLength(encoded ?? '')
      if (bytes > LIMITS.wireBytes) fail('budget')
      return JSON.parse(encoded) // detached trusted test-seam result, never a live credential adapter
    } finally { timers.clearTimeout(timer) }
  }
  function validate(doc) {
    if (++reads > LIMITS.reads) fail('budget')
    if (!exact(doc, ['path', 'exists', 'createVersion', 'updateVersion', 'data']) || typeof doc.path !== 'string' ||
        Buffer.byteLength(doc.path) > 512 || typeof doc.exists !== 'boolean') fail('transport')
    if (doc.exists ? !version(doc.createVersion) || !version(doc.updateVersion) || !doc.data || Array.isArray(doc.data) || typeof doc.data !== 'object'
      : doc.createVersion !== null || doc.updateVersion !== null || doc.data !== null) fail('transport')
    return doc
  }
  async function list(path, max = LIMITS.documents) {
    const found = [], tokens = new Set(); let token = '', last = ''
    do {
      const page = await read(() => reader.listPage(path, token))
      if (!exact(page, ['documents', 'nextPageToken']) || !Array.isArray(page.documents) || page.documents.length > LIMITS.page ||
          typeof page.nextPageToken !== 'string' || page.nextPageToken.length > 4096 ||
          (!page.documents.length && page.nextPageToken)) fail('transport')
      for (const raw of page.documents) {
        const doc = validate(raw), suffix = doc.path.slice(path.length + 1)
        if (!doc.path.startsWith(path + '/') || !suffix || suffix.includes('/') || (last && compare(last, doc.path) >= 0)) fail('scope')
        last = doc.path; found.push(doc)
        if (found.length > max) fail('budget')
      }
      token = page.nextPageToken
      if (token && tokens.has(token)) fail('transport')
      tokens.add(token)
    } while (token)
    return found
  }
  async function get(path) {
    const doc = validate(await read(() => reader.get(path)))
    if (doc.path !== path) fail('scope')
    return doc
  }
  return { list, get, check, observedAt }
}
const flags = { productionEligible: false, initializationAllowed: false, activationAllowed: false, snapshotConsistent: false }
function finished(report) {
  if (Buffer.byteLength(JSON.stringify(report)) > LIMITS.reportBytes) fail('budget')
  return frozen(report)
}
function stopped(kind, error) {
  return frozen({ kind, ...flags, completion: 'UNKNOWN', coverage: 'UNKNOWN', providerDrain: 'UNKNOWN',
    counts: null, category: error instanceof QualificationError ? error.category : 'transport' })
}
export async function inventoryClassrooms(input) {
  try {
    const s = session(input, 'inventory'), names = await s.list('classrooms', LIMITS.rooms)
    if (!names.length) fail('foundation')
    const owners = new Set(), rooms = [], snapshots = []
    for (const named of names) {
      const classroomId = named.path.split('/')[1]
      if (!named.exists || !id(classroomId)) fail('foundation')
      const root = await s.get(named.path), ownerUid = root.data?.ownerUid
      if (!root.exists || !equal(root.createVersion, named.createVersion) || !equal(root.updateVersion, named.updateVersion) ||
          !id(ownerUid) || owners.has(ownerUid) || Object.keys(root.data).some(key => !ROOT_MASK.includes(key)) ||
          (root.data.classroomId !== undefined && root.data.classroomId !== classroomId)) fail('foundation')
      owners.add(ownerUid)
      const owner = await s.get(`teachers/${ownerUid}`)
      if (!owner.exists || !exact(owner.data, ['uid', 'status', 'classroomId']) || owner.data.uid !== ownerUid ||
          owner.data.classroomId !== classroomId || owner.data.status !== 'active') fail('foundation')
      let mode = 'absent'
      if (Object.hasOwn(root.data, 'accessControl')) {
        try { mode = requireClassroomControl(root.data.accessControl).mode } catch { fail('foundation') }
      }
      snapshots.push(root, owner)
      rooms.push({ classroomId, ownerUid, mode, rootVersion: root.updateVersion, ownerVersion: owner.updateVersion })
    }
    if (!equal(names, await s.list('classrooms', LIMITS.rooms))) fail('drift')
    for (const doc of snapshots) if (!equal(doc, await s.get(doc.path))) fail('drift')
    s.check()
    return finished({ kind: 'fictional-classroom-inventory', ...flags, completion: 'COMPLETE', coverage: 'COMPLETE',
      privateArtifact: true, rooms, counts: { classrooms: rooms.length, absentControls: rooms.filter(row => row.mode === 'absent').length } })
  } catch (error) { return stopped('fictional-classroom-inventory', error) }
}

function reservationValid(doc, now) {
  const v = doc.data, key = doc.path.split('/')[1]
  if (!doc.exists || !digest(key) || !v || ![3, 4].includes(v.schemaVersion) ||
      !exact(v, RESERVATION_MASK.filter(field => field !== 'controlGeneration' || v.schemaVersion === 4)) ||
      !digest(v.scopeDigest) || !digest(v.requestIdDigest) || !digest(v.ledgerId) || !digest(v.rateLimitLedgerId) ||
      !/^\d{4}-(0[1-9]|1[0-2])$/.test(v.monthKey) || !natural(v.reservedAtMs) || v.reservedAtMs > now ||
      !['reserved', 'completed', 'uncertain'].includes(v.status) || (v.schemaVersion === 4 && !positive(v.controlGeneration))) return false
  return v.ledgerId === hash(`application\0${v.monthKey}`) && v.rateLimitLedgerId === hash(`${v.scopeDigest}\0${v.monthKey}`) &&
    key === hash(`${v.rateLimitLedgerId}\0${v.requestIdDigest}`)
}
function dispatchValid(doc, reservation, now) {
  const v = doc.data, parent = reservation.data, index = doc.path.split('/').at(-1)
  return doc.exists && exact(v, DISPATCH_MASK) && v.schemaVersion === 1 && /^[1-4]$/.test(index) &&
    v.dispatchIndex === Number(index) && v.reservationId === reservation.path.split('/')[1] &&
    v.requestIdDigest === parent.requestIdDigest && v.scopeDigest === parent.scopeDigest &&
    parent.schemaVersion === 4 && v.controlGeneration === parent.controlGeneration &&
    natural(v.claimedAtMs) && v.claimedAtMs >= parent.reservedAtMs && v.claimedAtMs <= now &&
    ((v.status === 'claimed' && v.finishedAtMs === null && v.outcome === null) ||
      (v.status === 'uncertain' && v.finishedAtMs === null && v.outcome === 'failed') ||
      (v.status === 'finished' && natural(v.finishedAtMs) && v.finishedAtMs >= v.claimedAtMs && v.finishedAtMs <= now && v.outcome === 'returned'))
}
export async function reportProviderClaims(input) {
  try {
    const s = session(input, 'provider-claims'), reservations = await s.list('insightUsageReservations')
    const counts = { reservations: reservations.length, dispatches: 0, reserved: 0, uncertainReservations: 0,
      claimed: 0, uncertainDispatches: 0, finished: 0, legacyWithoutDispatch: 0,
      missingDispatchEvidence: 0, orphanParents: 0, malformedRecords: 0 }
    const collections = [], findings = []; let documents = reservations.length
    for (const reservation of reservations) {
      const key = reservation.path.split('/')[1]
      // Unknown parent IDs cannot be followed into an unapproved path.
      if (!digest(key)) fail('scope')
      const dispatches = await s.list(`${reservation.path}/dispatches`)
      documents += dispatches.length
      if (documents > LIMITS.documents) fail('budget')
      collections.push({ path: `${reservation.path}/dispatches`, docs: dispatches })
      counts.dispatches += dispatches.length
      const valid = reservationValid(reservation, s.observedAt)
      if (!reservation.exists) { counts.orphanParents++; findings.push({ path: reservation.path, reason: 'orphan-parent' }) }
      else if (!valid) { counts.malformedRecords++; findings.push({ path: reservation.path, reason: 'malformed-reservation' }) }
      if (valid) {
        if (reservation.data.status === 'reserved') counts.reserved++
        if (reservation.data.status === 'uncertain') counts.uncertainReservations++
        if (!dispatches.length) {
          counts.missingDispatchEvidence++
          if (reservation.data.schemaVersion === 3) counts.legacyWithoutDispatch++
        }
      }
      let prior = null
      for (const [position, doc] of dispatches.entries()) {
        const good = valid && dispatchValid(doc, reservation, s.observedAt) && doc.data.dispatchIndex === position + 1 &&
          (!position || prior?.status === 'finished') &&
          (reservation.data.status !== 'completed' || doc.data.status === 'finished')
        if (!good) { counts.malformedRecords++; findings.push({ path: doc.path, reason: 'malformed-dispatch' }) }
        else counts[doc.data.status === 'claimed' ? 'claimed' : doc.data.status === 'uncertain' ? 'uncertainDispatches' : 'finished']++
        prior = good ? doc.data : null
      }
    }
    if (!equal(reservations, await s.list('insightUsageReservations'))) fail('drift')
    for (const collection of collections) if (!equal(collection.docs, await s.list(collection.path))) fail('drift')
    s.check()
    return finished({ kind: 'fictional-provider-claim-report', ...flags, privateArtifact: true,
      completion: 'COMPLETE', coverage: 'COMPLETE', providerDrain: 'UNKNOWN', metadataOnly: true,
      recordState: Object.entries(counts).some(([key, n]) => !['reservations', 'dispatches', 'finished'].includes(key) && n > 0) ? 'UNKNOWN' : 'NO_UNRESOLVED_METADATA_OBSERVED',
      counts, findings })
  } catch (error) { return stopped('fictional-provider-claim-report', error) }
}
