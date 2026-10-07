import { frozen, fail } from './common.js'
// Source-reviewed findings, not caller-supplied "verified" flags. No credential,
// platform client, environment lookup, filesystem or network is touched here.
const capabilities = frozen([
  { capability: 'bounded-missing-parent-reader', status: 'UNVERIFIED', evidence: 'installed-api-contract-and-local-tests-only' },
  { capability: 'explicit-credential-and-effective-iam', status: 'UNVERIFIED', evidence: 'no-live-principal-verification' },
  { capability: 'complete-deployed-writer-inventory', status: 'UNVERIFIED', evidence: 'source-inventory-is-not-live-inventory' },
  { capability: 'complete-interval-and-drain', status: 'UNVERIFIED', evidence: 'no-qualified-platform-completeness-boundary' },
  { capability: 'client-denial-propagation', status: 'UNVERIFIED', evidence: 'no-live-canary-evidence' },
  { capability: 'credentials-and-audit-reconciliation', status: 'UNVERIFIED', evidence: 'no-private-live-verifier' },
  { capability: 'external-operator-exclusion', status: 'UNVERIFIED', evidence: 'cooperative-lock-only' },
  { capability: 'private-launch-and-publication', status: 'UNVERIFIED', evidence: 'no-qualified-live-launcher-or-publisher' },
])
export function qualificationStatus() {
  return frozen({ kind: 'cutover-capability-assessment', decision: 'NO-GO', capabilities,
    productionEligible: false, initializationAllowed: false, activationAllowed: false })
}
// No option or supplied evidence JSON can promote this local candidate to live.
export function refuseLiveQualification() { fail('live-unavailable') }
