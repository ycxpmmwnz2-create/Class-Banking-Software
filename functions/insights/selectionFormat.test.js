import test from 'node:test'
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { createConversationalClassroomAssistant, createStructuredClassroomAssistant } from './geminiClassroomAssistant.js'
import { reportingEvidence, REPORTING_CASES } from './broaderConversationFixtures.js'
import { createClassroomAssistantToolbox } from './classroomAssistantTools.js'
import { STRUCTURED_SELECTION_FORMAT, createStructuredAnswerRegistry } from './structuredClassroomAnswers.js'

const usageMetadata = { promptTokenCount: 100, candidatesTokenCount: 20, totalTokenCount: 120 }
const asText = text => ({ finishReason: 'STOP', usageMetadata, text })
function asCalls(items, turn) {
  const functionCalls = items.map((item, i) => ({ id: `call-${turn}-${i}`, name: item.tool, args: item.args }))
  return { finishReason: 'STOP', usageMetadata, functionCalls, candidateContent: { role: 'model', parts: functionCalls.map(functionCall => ({ functionCall })) } }
}
function checkFormat(request) {
  assert.equal(request.config.responseMimeType, 'application/json')
  const schema = request.config.responseJsonSchema
  assert.deepEqual(schema.required, ['schemaVersion', 'sections'])
  assert.equal(schema.additionalProperties, false)
  assert.deepEqual(schema.properties.schemaVersion.enum, [1])
  assert.equal(schema.properties.sections.minItems, 1)
  assert.equal(schema.properties.sections.maxItems, 8)
  assert.deepEqual(schema.properties.sections.items.required, ['resultId', 'view'])
  assert.equal(schema.properties.sections.items.additionalProperties, false)
  assert.equal(request.config.toolConfig.functionCallingConfig.mode, 'VALIDATED')
  assert.equal(request.config.tools[0].functionDeclarations.length, 9)
}
for (const item of REPORTING_CASES.filter(item => item.id !== 'earnings')) test(`provider format preserves ${item.id} calculations and its narration policy`, async () => {
  const e = reportingEvidence(); e.question = item.question
  let turn = 0
  const assistant = createConversationalClassroomAssistant({ generateContent: async request => {
    if (!request.config.tools) return asText(JSON.stringify({ answer: 'Friendly summary of the calculated facts.' }))
    turn++
    if (turn === 1) { assert.equal(request.config.responseJsonSchema, undefined); return asCalls([item], turn) }
    // Without provider-enforced JSON, reproduce the observed failure CLASS.
    // The production diagnostic did not retain the actual malformed reply.
    if (!request.config.responseJsonSchema) return asText('A provider response outside the required JSON format.')
    checkFormat(request)
    const r = request.contents.at(-1).parts[0].functionResponse.response
    return asText(JSON.stringify({ schemaVersion: 1, sections: [{ resultId: r.resultId, view: r.view }] }))
  } })
  const result = await assistant.answer({ assistantEvidence: e })
  assert.match(result.answer, item.expected)
  // Historical balances now display the verified answer rather than prose.
  assert.equal(result.presentation.aiSummary, item.id === 'history' ? null : 'Friendly summary of the calculated facts.')
  assert.equal(turn, 2)
})
test('structured output still permits another calculation and a multi-result final answer', async () => {
  const e=reportingEvidence();e.question='Count Fable’s Technology days last week and show the class balance.'
  let turn=0;const selected=[]
  const assistant=createConversationalClassroomAssistant({generateContent:async request=>{
    if(!request.config.tools)return asText('{"answer":"Both requested calculations are shown below."}')
    turn++
    if(turn===1)return asCalls([REPORTING_CASES[0]],turn)
    checkFormat(request)
    selected.push(...request.contents.at(-1).parts.map(p=>({resultId:p.functionResponse.response.resultId,view:p.functionResponse.response.view})))
    if(turn===2)return asCalls([REPORTING_CASES[1]],turn)
    return asText(JSON.stringify({schemaVersion:1,sections:selected}))
  }})
  const r=await assistant.answer({assistantEvidence:e});assert.match(r.answer,/1 \(2 transactions\)/u);assert.match(r.answer,/Total balance: \$16.00/u);assert.equal(r.evidence.length,2);assert.equal(turn,3)
})
for (const mutation of ['foreign-result','wrong-view','free-text']) test(`format constraints do not weaken validation of ${mutation}`,async()=>{
  let turn=0,narrations=0
  const a=createConversationalClassroomAssistant({generateContent:async request=>{
    if(!request.config.tools){narrations++;throw Error('Must not narrate rejected facts')}
    if(++turn===1)return asCalls([REPORTING_CASES[0]],turn)
    checkFormat(request)
    const r=request.contents.at(-1).parts[0].functionResponse.response
    return asText(mutation==='free-text'?'invented prose':JSON.stringify({schemaVersion:1,sections:[{resultId:mutation==='foreign-result'?'foreign':r.resultId,view:mutation==='wrong-view'?'student-balances':r.view}]}))
  }})
  await assert.rejects(a.answer({assistantEvidence:reportingEvidence()}),e=>e.category==='answer-unverified');assert.equal(turn,2);assert.equal(narrations,0)
})
test('existing structured-only contract keeps its provider request configuration',async()=>{
  let n=0;const a=createStructuredClassroomAssistant({generateContent:async request=>{
    assert.equal(request.config.responseJsonSchema,undefined)
    if(++n===1)return asCalls([REPORTING_CASES[1]],n)
    const r=request.contents.at(-1).parts[0].functionResponse.response
    return asText(JSON.stringify({schemaVersion:1,sections:[{resultId:r.resultId,view:r.view}]}))
  }});assert.match((await a.answer({assistantEvidence:reportingEvidence()})).answer,/Total balance: \$16.00/u)
})
test('calculated day facts are derived from transactions, not the provider summary',()=>{
 const r=createStructuredAnswerRegistry(createClassroomAssistantToolbox(reportingEvidence())), item=REPORTING_CASES[0], v=r.execute(item.tool,item.args)
 assert.match(r.render({schemaVersion:1,sections:[{resultId:v.resultId,view:v.view}]}).answer,/1 \(2 transactions\)/u)
})

test('format schema overhead fits within existing input-token safety padding', () => {
  // The quote has 4096 padding tokens beyond byte-counted prompt/history.
  // Even at one token per byte, this schema uses <= 2048 across all three
  // eligible turns, leaving at least half of that padding for framing.
  assert(Buffer.byteLength(JSON.stringify(STRUCTURED_SELECTION_FORMAT)) * 3 <= 2048)
})
