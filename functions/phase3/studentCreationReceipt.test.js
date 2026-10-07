import test from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { Buffer } from 'node:buffer'
import { creationBinding, matchingCreationBinding, readCreationReceipt } from './studentCreationReceipt.js'
import { deriveMoneyLedgerIds } from './teacherMoneyContract.js'
const identity={projectId:'demo-fixture',classroomId:'class-a',teacherUid:'teacher-a'}
const wire={requestId:'1'.repeat(32),protocolVersion:1,controlGeneration:2,name:'Fictional',startingBalanceCents:123,pin:'0123'}
const ring={currentVersion:'v1',keys:{v1:'ab'.repeat(32)}}
test('creation binds the canonical full intent with keyed HMAC only, including leading-zero PIN',()=>{
  const expected=createHmac('sha256',Buffer.from(ring.keys.v1,'hex')).update(JSON.stringify([
    'morgan-bank/student-create',1,'demo-fixture','class-a','teacher-a','1'.repeat(32),1,2,'Fictional',123,'0123',
  ])).digest('hex')
  assert.deepEqual(creationBinding(wire,identity,ring),{keyVersion:'v1',intentHmac:expected})
  assert.equal(matchingCreationBinding(expected,creationBinding({...wire,pin:'0124'},identity,ring).intentHmac),false)
  assert.equal(matchingCreationBinding(expected,'bad'),false)
  assert.throws(()=>creationBinding(wire,identity,{currentVersion:'missing',keys:{}}))
})
test('creation receipt validates public IDs, exact private schema, time, and deterministic opening mapping',()=>{
  const ledgerId=deriveMoneyLedgerIds({...identity,protocolVersion:1,requestId:wire.requestId,action:'createStudent'},[7])[0].ledgerId
  const receipt={version:4,actorUid:identity.teacherUid,requestId:wire.requestId,generation:2,status:'committed',serverTime:'2026-10-05T00:00:00.000Z',
    action:'createStudent',itemCount:1,ledgerIds:[ledgerId],acknowledged:false,studentId:7,loginId:'fictional',...creationBinding(wire,identity,ring)}
  assert.deepEqual(readCreationReceipt(receipt,identity,wire.requestId),receipt)
  assert.doesNotThrow(()=>readCreationReceipt({...receipt,ledgerIds:[]},identity,wire.requestId))
  for(const change of [{digest:'1'.repeat(64)},{pin:'0123'},{actorUid:'other'},{ledgerIds:[ledgerId+1]},{studentId:0},{serverTime:'invalid'},{keyVersion:''}])
    assert.throws(()=>readCreationReceipt({...receipt,...change},identity,wire.requestId))
})
