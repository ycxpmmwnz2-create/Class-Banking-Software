import test from 'node:test'
import assert from 'node:assert/strict'
import { transactionClassification, adjustmentTotals } from './transactionClassification.js'
import { buildClassInsightsReport } from './classInsights.js'
import { buildFactPacketFromEvidence } from './factPacketBuilder.js'

test('shared reserved classification is exact and preserves signed raw adjustments', () => {
  assert.equal(transactionClassification({source:'Opening Balance'}),'opening')
  assert.equal(transactionClassification({source:'opening balance'}),'activity')
  assert.equal(transactionClassification({source:'Student',category:'Balance adjustment'}),'activity')
  assert.equal(transactionClassification({source:'Teacher',category:'Balance adjustment'}),'adjustment')
  assert.equal(transactionClassification({source:'Operator correction'}),'adjustment')
  assert.deepEqual(adjustmentTotals([
    {source:'Opening Balance',status:'Approved',type:'Add',amount:20},
    {source:'Opening Balance',status:'Approved',type:'Subtract',amount:5},
  ]),{opening:15,adjustment:0})
})

test('local report and fact packet retain opening cash movement but exclude it from earning patterns', () => {
  const students=[{id:1,name:'Fictional New',balance:200},{id:2,name:'Fictional Old',balance:200}]
  const transactions=[1,2].map(id=>({id,studentId:id,studentName:students[id-1].name,
    date:'2026-10-05T12:00:00.000Z',type:'Add',amount:200,status:'Approved',source:'Opening Balance',category:'Balance adjustment',reason:'Opening balance'}))
  const report=buildClassInsightsReport({students,transactions,days:7,mode:'deep',now:new Date('2026-10-05T18:00:00.000Z')})
  assert.equal(report.metrics.totalClassCash,400)
  assert.equal(report.observations.some(row=>row.id.startsWith('timing-')),false)
  const movement=report.observations.find(row=>row.id==='class-money-movement')
  assert.match(movement.evidence,/Opening adjustments: \$400/)
  const packet=buildFactPacketFromEvidence({evidence:{schemaVersion:1,generatedAt:report.generatedAt,metrics:report.metrics,
    observations:report.observations.map(({priority,category,title,summary,evidence})=>({priority,category,title,summary,evidence:[evidence]}))},mode:'deep',periodDays:7,modeProfile:{maxObservations:20}})
  assert.match(JSON.stringify(packet),/excluded from earnings\/spending/)
})
