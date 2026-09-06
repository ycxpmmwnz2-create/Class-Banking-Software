import assert from 'node:assert/strict';
import test from 'node:test';
import { renderQuestionAnswer } from './renderQuestionAnswer.js';
import { validateProviderQuestionResponse } from './providerInsightsClient.js';
const p = { aiSummary: 'Fable had $30 added.', calculatedSummary: 'Fable: $30.', calculationDetails: 'Approved additions; current roster.', billingBasis: 'observed' };
const result = { schemaVersion: 2, source: 'ai-grounded', periodDays: 7, generatedAt: '2026-09-07T18:00:00.000Z', answer: `${p.calculatedSummary}\n${p.calculationDetails}`, evidence: ['Computed from classroom records.'], usage: { inputTokens: 100, outputTokens: 10, thinkingTokens: 0, costMicroUsd: 200 }, presentation: p };
test('client validates the optional presentation and preserves old responses', () => {
  assert.deepEqual(validateProviderQuestionResponse(result), result);
  const old = { ...result }; delete old.presentation;
  assert.deepEqual(validateProviderQuestionResponse(old), old);
  assert.throws(() => validateProviderQuestionResponse({ ...result, presentation: { ...p, calculatedSummary: 'Wrong facts.' } }));
});
test('AI and calculated text remain separately labelled and HTML is escaped everywhere', () => {
  const hostile = '<img src=x onerror="window.attacked=true"> & <script>alert(1)</script>';
  const html = renderQuestionAnswer({ ...result, presentation: { ...p, aiSummary: hostile, calculatedSummary: hostile, calculationDetails: hostile } });
  assert.match(html, /AI summary/u);
  assert.match(html, /Calculated facts/u);
  assert.doesNotMatch(html, /<img|<script/u);
  assert.equal((html.match(/&lt;img/gu) ?? []).length, 3);
});
test('narration failure keeps facts visible and only unknown usage shows retained-allowance wording', () => {
  const html = renderQuestionAnswer({ ...result, presentation: { ...p, aiSummary: null, billingBasis: 'reserved-unknown' } });
  assert.doesNotMatch(html, /data-testid="provider-question-ai-summary"/u);
  assert.match(html, /Fable: \$30/u);
  assert.match(html, /reserved allowance is retained/u);
});
