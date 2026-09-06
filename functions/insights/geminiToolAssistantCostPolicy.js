import { NARRATION_WORST_CASE_COST } from './conversationNarrator.js'
import { Buffer } from 'node:buffer'

import { createClassroomAssistantToolbox } from './classroomAssistantTools.js'
import {
  CLASSROOM_ASSISTANT_MAX_BILLED_OUTPUT_TOKENS,
  CLASSROOM_ASSISTANT_MAX_BILLED_THINKING_TOKENS,
  CLASSROOM_ASSISTANT_MAX_TURNS,
  CLASSROOM_ASSISTANT_MAX_OUTPUT_TOKENS_PER_TURN,
} from './classroomAssistantUsageContract.js'
import { CLASSROOM_ASSISTANT_MAX_TOOL_BYTES } from './geminiClassroomAssistant.js'
import { GEMINI_RATE_CARD } from './geminiCostPolicy.js'
import { GEMINI_RATE_CARD_ID } from './geminiProviderAdapter.js'
import { STRUCTURED_CLASSROOM_SYSTEM_INSTRUCTION } from './structuredClassroomPrompt.js'

const TOKENS_PER_MILLION = 1_000_000
const INPUT_TOKEN_SAFETY_MARGIN = 4_096

export class GeminiToolAssistantCostPolicyError extends Error {
  constructor(category, message) {
    super(message)
    this.name = 'GeminiToolAssistantCostPolicyError'
    this.category = category
  }
}

export function quoteConversationalWorstCaseCost(input) {
  const base = quoteGeminiToolAssistantWorstCaseCost(input)
  return Object.freeze({ ...base, worstCaseCostMicroUsd: base.worstCaseCostMicroUsd + NARRATION_WORST_CASE_COST })
}

export function quoteGeminiToolAssistantWorstCaseCost({ assistantEvidence, toolbox: suppliedToolbox } = {}) {
  const toolbox = suppliedToolbox ?? createClassroomAssistantToolbox(assistantEvidence)
  if (
    !toolbox ||
    typeof toolbox !== 'object' ||
    !toolbox.context ||
    !Array.isArray(toolbox.declarations) ||
    typeof toolbox.execute !== 'function'
  ) fail('invalid-evidence', 'The classroom tool boundary is malformed.')
  const initialBytes = Buffer.byteLength(JSON.stringify({
    question: assistantEvidence.question,
    classroomContext: toolbox.context,
    declarations: toolbox.declarations,
    systemInstruction: STRUCTURED_CLASSROOM_SYSTEM_INSTRUCTION,
  }), 'utf8')
  const inputTokens =
    initialBytes * CLASSROOM_ASSISTANT_MAX_TURNS +
    CLASSROOM_ASSISTANT_MAX_TOOL_BYTES * (CLASSROOM_ASSISTANT_MAX_TURNS - 1) +
    // Prior model turns are sent again as conversation history. This is in
    // addition to the tool output byte cap and the repeated system prompt.
    CLASSROOM_ASSISTANT_MAX_OUTPUT_TOKENS_PER_TURN * CLASSROOM_ASSISTANT_MAX_TURNS * (CLASSROOM_ASSISTANT_MAX_TURNS - 1) / 2 +
    INPUT_TOKEN_SAFETY_MARGIN
  return Object.freeze({
    rateCardId: GEMINI_RATE_CARD_ID,
    worstCaseCostMicroUsd: price({
      inputTokens,
      billedOutputTokens:
        CLASSROOM_ASSISTANT_MAX_BILLED_OUTPUT_TOKENS +
        CLASSROOM_ASSISTANT_MAX_BILLED_THINKING_TOKENS,
    }),
  })
}

export function priceGeminiToolAssistantActualUsage({ rateCardId, usage } = {}) {
  if (rateCardId !== GEMINI_RATE_CARD_ID) fail('rate-card-mismatch', 'The classroom assistant rate card is unsupported.')
  if (!isPlainObject(usage) || !hasExactKeys(usage, ['inputTokens', 'outputTokens', 'thinkingTokens'])) {
    fail('invalid-usage', 'Classroom assistant usage is malformed.')
  }
  for (const field of ['inputTokens', 'outputTokens', 'thinkingTokens']) {
    if (!Number.isSafeInteger(usage[field]) || usage[field] < 0) fail('invalid-usage', 'Classroom assistant usage is malformed.')
  }
  if (
    usage.outputTokens > CLASSROOM_ASSISTANT_MAX_BILLED_OUTPUT_TOKENS ||
    usage.thinkingTokens > CLASSROOM_ASSISTANT_MAX_BILLED_THINKING_TOKENS
  ) fail('invalid-usage', 'Classroom assistant usage exceeds its reservation.')
  return price({
    inputTokens: usage.inputTokens,
    billedOutputTokens: usage.outputTokens + usage.thinkingTokens,
  })
}

function price({ inputTokens, billedOutputTokens }) {
  const numerator =
    inputTokens * GEMINI_RATE_CARD.inputMicroUsdPerMillionTokens +
    billedOutputTokens * GEMINI_RATE_CARD.billedOutputMicroUsdPerMillionTokens
  if (!Number.isSafeInteger(numerator) || numerator < 0) fail('invalid-cost', 'Classroom assistant cost exceeds safe precision.')
  return Math.ceil(numerator / TOKENS_PER_MILLION)
}

function fail(category, message) {
  throw new GeminiToolAssistantCostPolicyError(category, message)
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasExactKeys(value, expected) {
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  return actual.length === wanted.length && actual.every((field, index) => field === wanted[index])
}
