import test from 'node:test'
import assert from 'node:assert/strict'
import { createConversationalClassroomAssistant, createStructuredClassroomAssistant } from './geminiClassroomAssistant.js'
import { createClassroomAssistantToolbox } from './classroomAssistantTools.js'
import { createStructuredAnswerRegistry } from './structuredClassroomAnswers.js'
import { validateProviderQuestionResponse } from '../../src/insights/providerInsightsClient.js'
import { reportingEvidence, REPORTING_CASES } from './broaderConversationFixtures.js'
const usageMetadata = { promptTokenCount: 100, candidatesTokenCount: 20, totalTokenCount: 120 }
async function run(items, { extraPlannerTurns = 0, mode = 'valid', evidence = reportingEvidence(), structured = false } = {}) {
  const calls = [], question = items.map(i => i.question).join(' '); evidence.question = question
  const expectedRegistry = createStructuredAnswerRegistry(createClassroomAssistantToolbox(evidence))
  const expectedSections = items.map(i => expectedRegistry.execute(i.tool, i.args)).map(x => ({resultId:x.resultId,view:x.view}))
  const expected = expectedRegistry.render({ schemaVersion:1, sections:expectedSections })
  let plans = 0
  const assistant = (structured ? createStructuredClassroomAssistant : createConversationalClassroomAssistant)({generateContent:async request => {
    calls.push(request)
    if (!request.config.tools) {
      const data = JSON.parse(request.contents[0].parts[0].text)
      assert.equal(data.calculatedAnswer, expected.answer);assert.equal(data.question,question)
      if(mode==='timeout')throw Error('simulated')
      return {finishReason:'STOP',usageMetadata:mode==='missing-usage'?undefined:usageMetadata,text: mode==='malformed'?'{':JSON.stringify({answer:'A friendly reporting summary.'})}
    }
    plans++
    if (plans<=extraPlannerTurns+1) {
      const chosen=plans<=extraPlannerTurns?[{tool:'describe_schema',args:{}}]:items
      const functionCalls=chosen.map((i,n)=>({id:`call-${plans}-${n}`,name:i.tool,args:i.args}))
      return {finishReason:'STOP',usageMetadata,functionCalls,candidateContent:{role:'model',parts:functionCalls.map(functionCall=>({functionCall}))}}
    }
    const outputs=request.contents.at(-1).parts.filter(p=>p.functionResponse).map(p=>p.functionResponse.response)
    return {finishReason:'STOP',usageMetadata,text:JSON.stringify({schemaVersion:1,sections:outputs.map(x=>({resultId:x.resultId,view:x.view}))})}
  }})
  const result=await assistant.answer({assistantEvidence:evidence})
  assert.equal(result.answer,expected.answer)
  if(result.presentation) validateProviderQuestionResponse({schemaVersion:2,source:'ai-grounded',periodDays:30,generatedAt:evidence.generatedAt,answer:result.answer,evidence:result.evidence,presentation:result.presentation,usage:{...result.usage,costMicroUsd:1}})
  return {result,calls,expected}
}
for(const item of REPORTING_CASES)test(`calculated ${item.id} results preserve facts and the narration policy`,async()=>{
  const {result,calls}=await run([item]);assert.match(result.answer,item.expected)
  // History is deliberately code-owned; the other reporting views still narrate.
  assert.equal(result.presentation?.aiSummary,item.id==='history'?null:'A friendly reporting summary.')
  assert.equal(calls.filter(x=>!x.config.tools).length,item.id==='history'?0:1)
})
test('a multi-part selection receives one narration containing every selected fact section',async()=>{const {result,calls}=await run(REPORTING_CASES.slice(0,2));assert.equal(result.presentation?.aiSummary,'A friendly reporting summary.');assert.equal(calls.length,3);assert.match(result.answer,/Total balance: \$16.00/u)})
test('absence facts identify the missing transaction predicate and label balance separately',async()=>{
  const {result}=await run([REPORTING_CASES.find(item=>item.id==='absence')])
  assert.match(result.answer,/• "Quill" — no matching transactions under the filters above; current balance: \$4\.00; unfrozen\./u)
  assert.doesNotMatch(result.answer,/• "Fable"/u)
})
test('capabilities-only answers remain fixed without a narrator request',async()=>{const {result,calls}=await run([{tool:'describe_schema',args:{},question:'Can you search memos?'}]);assert.equal(result.presentation,null);assert.equal(calls.length,2)})
for(const mode of ['timeout','missing-usage','malformed'])test(`non-earnings ${mode} keeps original facts and accounting classification`,async()=>{const {result}=await run([REPORTING_CASES[0]],{mode});assert.equal(result.presentation?.aiSummary,null);assert.equal(result.usageUncertain,mode!=='malformed')})
test('existing structured contract never makes a narrator call',async()=>{const {result,calls}=await run([REPORTING_CASES[0]],{structured:true});assert.equal(result.presentation,undefined);assert.equal(calls.length,2)})
test('large details stay intact in structured fallback and cannot fail the presentation size contract',async()=>{const evidence=reportingEvidence();evidence.students=Array.from({length:150},(_,i)=>({ref:`student-${String(i+1).padStart(3,'0')}`,displayName:`Fictional student ${String(i).padStart(3,'0')} with a longer display name`,current:true,balance:i,frozen:false}));evidence.transactions=[];const {result,calls}=await run([{...REPORTING_CASES[1],args:{limit:500}}],{evidence});assert.ok(result.answer.length>8000);assert.equal(result.presentation,null);assert.equal(calls.length,2);assert.match(result.answer,/Fictional student 149/u)})

test('fourth-turn non-earnings selection keeps facts without a fifth narrator call',async()=>{const {result,calls}=await run([REPORTING_CASES[0]],{extraPlannerTurns:2});assert.equal(result.presentation.aiSummary,null);assert.equal(calls.length,4);assert.ok(calls.every(c=>c.config.tools))})

for (const [asOfDate, startDate, endDate] of [
  ['2026-09-06','2026-08-24','2026-08-30'],
  ['2026-09-07','2026-08-31','2026-09-06'],
  ['2026-01-01','2025-12-22','2025-12-28'],
  ['2026-03-08','2026-02-23','2026-03-01'],
  ['2026-03-09','2026-03-02','2026-03-08'],
]) for (const timeZone of ['America/Denver','Pacific/Kiritimati']) test(`previous week is server-owned for ${asOfDate} in ${timeZone}`,()=>{
  const e={...reportingEvidence(),asOfDate,timeZone,generatedAt:`${asOfDate}T18:00:00.000Z`,historyStart:'2025-11-01T00:00:00.000Z',periodStart:`${startDate}T00:00:00.000Z`,transactions:[]}
  const tools=createClassroomAssistantToolbox(e)
  assert.deepEqual(tools.context.previousCalendarWeek,{startDate,endDate})
  assert(Object.isFrozen(tools.context.previousCalendarWeek))
  const actual=tools.execute('compare_student_earnings',{window:'last-week'})
  assert.equal(actual.ok,true);assert.equal(actual.windowStartDate,startDate);assert.equal(actual.windowEndDate,endDate)
})
