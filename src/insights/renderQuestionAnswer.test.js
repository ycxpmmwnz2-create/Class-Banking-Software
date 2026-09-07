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
test('shows one escaped conversational answer without source or calculation clutter', () => {
  const hostile = '<img src=x onerror="window.attacked=true"> & <script>alert(1)</script>';
  const response = { ...result, presentation: { ...p, aiSummary: hostile } };
  const before = JSON.stringify(response);
  const html = renderQuestionAnswer(response);
  assert.doesNotMatch(html, /AI summary|Calculated facts|Check the calculated|Approved additions|Fable:|<details|<img|<script/u);
  assert.match(html, /data-testid="provider-question-ai-summary"/u);
  assert.equal((html.match(/&lt;img/gu) ?? []).length, 1);
  assert.equal(JSON.stringify(response), before, 'Underlying calculated facts remain intact');
});
test('narration failure retains the complete calculated answer without billing jargon', () => {
  const html = renderQuestionAnswer({ ...result, presentation: { ...p, aiSummary: null, billingBasis: 'reserved-unknown' } });
  assert.doesNotMatch(html, /provider-question-ai-summary|reserved allowance|AI wording/u);
  assert.match(html, /Fable: \$30/u);
  assert.match(html, /Approved additions; current roster/u);
});
test('legacy answers remain visible and escaped', () => {
  const html = renderQuestionAnswer({ answer: '<script>bad</script> actual answer' });
  assert.doesNotMatch(html, /<script/u);
  assert.match(html, /actual answer/u);
});
