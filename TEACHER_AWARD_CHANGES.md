# Teacher award/deduct calculation component

Stage16 implements the calculation part of the existing teacher-money design.
It is dormant: no callable, database access, browser integration, or deployment
configuration imports it. It does not authorize a teacher or prevent replay.

`bindTeacherAwardIntent(request, identity)` validates the exact protocol-1
award/deduct envelope and returns its canonical intent, SHA-256 digest, and the
existing deterministic ledger IDs. The identity is trusted server input, never
a client field. Targets are sorted and deduplicated. The digest's versioned
compact JSON tuple is documented in the source; every accepted intent field,
project, classroom, teacher, and control generation is bound without Unicode
normalization. Ledger IDs retain the existing, separate namespace.

`buildTeacherAwardChanges(request, inputs)` calculates complete student and
ledger replacements from supplied server-read records. It preserves teacher
overdraft/frozen-student authority and historical entries, uses integer-cent
arithmetic, and rejects the whole action for missing targets, malformed data,
candidate ledger/mirror collisions, or capacity limits. It never trims history
or mutates its inputs. New ledger and mirror entries match exactly.

## Required integration boundary

The future transaction service must:

- Authenticate and resolve reciprocal teacher/classroom ownership and current
  access control inside every transaction attempt. Supply project identity from
  trusted configuration and the reason allowlist from current server settings
  and action policy, including any permitted Quick Cash/Classroom Expense values.
- Bind the intent and handle existing receipt/replay/conflict, actor recovery,
  and receipt quota before calculating a **new** action. Recalculating the same
  request is not replay protection.
- Read the exact target documents and every candidate ledger in that same
  transaction. Supply each ledger's actual existence and server-generated time;
  do not accept cached or client-supplied records, allowlists, or timestamps.
- Enforce full transaction read/write/receipt/actor/quota budgets and atomically
  create ledgers, update students, and persist recovery metadata. Use create,
  not overwrite, for new ledgers. The returned byte count covers only resulting
  student and ledger documents and is a conservative estimate, not an SDK limit
  guarantee. It excludes all reads and recovery metadata.

This component does not verify historical mirror-to-ledger parity or qualify
existing data. It is not `planTeacherMoneyV2`: no bounded read planning,
source-version proof, or 60-second executable plan is implemented. Other teacher
actions, lifecycle/opening balances, UI recovery, strict rules, and release
qualification remain separate work under the existing design. Stage15's real-data
scanner NO-GO is unchanged.

## Verification

Node 22: `node --test functions/phase3/teacherAwardChanges.test.js`.
The existing `npm run test:phase3:unit` command includes these tests. Fixtures are
fictional. Tests cover binding, cents, whole-action refusal, fresh recalculation,
cross-target orphan collisions, history preservation, and count/byte limits.
They provide calculation evidence, not emulator, concurrency, or live evidence.

Stage16 review status: Muse PASS; Claude PASS WITH CONDITIONS. The unchanged
four-file component was committed as 2c1cb0a. Claude C1 required relocating the
size estimator before deployed integration. The Stage17 candidate does that;
see TEACHER_AWARD_SERVICE.md. Stage17 is pending its own independent reviews.
