import { createHmac, timingSafeEqual } from 'node:crypto'
import { Buffer } from 'node:buffer'
import { hasExactDataKeys, isControlGeneration } from './classroomAccess.js'
import { deriveMoneyLedgerIds } from './teacherMoneyContract.js'

export function creationBinding(wire, identity, keyRing, version = keyRing?.currentVersion) {
  const key = keyRing?.keys?.[version]
  if (typeof version !== 'string' || !/^[a-zA-Z0-9_-]{1,40}$/.test(version) ||
      typeof key !== 'string' || !/^[a-f0-9]{64}$/.test(key)) throw new Error('Creation binding unavailable.')
  const tuple = ['morgan-bank/student-create', 1, identity.projectId, identity.classroomId,
    identity.teacherUid, wire.requestId, wire.protocolVersion, wire.controlGeneration,
    wire.name, wire.startingBalanceCents, wire.pin]
  return { keyVersion: version, intentHmac: createHmac('sha256', Buffer.from(key, 'hex')).update(JSON.stringify(tuple)).digest('hex') }
}

export function matchingCreationBinding(left, right) {
  return typeof left === 'string' && /^[a-f0-9]{64}$/.test(left) &&
    typeof right === 'string' && /^[a-f0-9]{64}$/.test(right) &&
    timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'))
}

export function readCreationReceipt(data, identity, requestId) {
  const keys = ['version', 'actorUid', 'requestId', 'generation', 'status', 'serverTime',
    'action', 'itemCount', 'ledgerIds', 'acknowledged', 'studentId', 'loginId', 'keyVersion', 'intentHmac']
  if (!hasExactDataKeys(data, keys) || data.version !== 4 || data.actorUid !== identity.teacherUid ||
      data.requestId !== requestId || !isControlGeneration(data.generation) || data.status !== 'committed' ||
      data.action !== 'createStudent' || data.itemCount !== 1 || typeof data.acknowledged !== 'boolean' ||
      !Number.isSafeInteger(data.studentId) || data.studentId <= 0 ||
      typeof data.loginId !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(data.loginId) || data.loginId.length > 120 ||
      typeof data.keyVersion !== 'string' || !/^[a-zA-Z0-9_-]{1,40}$/.test(data.keyVersion) ||
      typeof data.intentHmac !== 'string' || !/^[a-f0-9]{64}$/.test(data.intentHmac) ||
      typeof data.serverTime !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(data.serverTime) ||
      !Number.isFinite(Date.parse(data.serverTime)) || new Date(data.serverTime).toISOString() !== data.serverTime ||
      !Array.isArray(data.ledgerIds) || data.ledgerIds.length > 1) throw new Error('Invalid creation receipt.')
  const expected = deriveMoneyLedgerIds({ ...identity, protocolVersion: 1, requestId, action: 'createStudent' }, [data.studentId])[0].ledgerId
  if (data.ledgerIds.length && data.ledgerIds[0] !== expected) throw new Error('Invalid creation mapping.')
  return data
}
