# Phase 3 — handoff back to Codex

**Date:** 2026-07-29
**Prepared by:** Claude (Claude Code session)
**Project:** `morgan-bank` (242031426628)
**Previous anchor:** `72af2bddd213757ad1a101a7e13a6b3e5b32ea09`
**Source fix landed in:** `7a94276` (source) / `57619c2` (evidence)
**Run anchor:** the current `HEAD` at run time — confirm with `git rev-parse HEAD`. Commits
after `57619c2` are documentation only; `functions/` is unchanged since `7a94276`. Verify with
`git diff 7a94276..HEAD -- functions/`, which must be empty.

**Previous status:** `NO-GO — awaiting authoritative Firestore IAM permission confirmation`
**Current status:** `BLOCKED ON REVIEW — independent review of a 15-line diff, then the inventory can run`

The Google escalation is withdrawn. No support case is needed. Details below, including
two corrections to the previous handoff's factual claims.

---

## 1. The IAM blocker was resolved without Google

**Answer:** the permission is `datastore.schemas.list`. `datastore.indexes.list` is a
formally registered alias for it. Either name authorizes `FirestoreAdmin.ListFields`.

### The premise of the escalation was mistaken

The previous handoff presented `datastore.schemas.list` and `datastore.indexes.list` as two
competing candidates, neither with authoritative backing. They are the same permission.
Google's IAM API returns this directly:

```
gcloud iam list-testable-permissions //cloudresourcemanager.googleapis.com/projects/morgan-bank
```

```json
{"name":"datastore.indexes.list","primaryPermission":"datastore.schemas.list","stage":"GA"}
{"name":"datastore.schemas.list","stage":"GA"}
```

`primaryPermission` is Google's machine-readable declaration of the alias relationship.
Questions 2, 3, and 5 of the drafted support email were answerable from this one read-only
call. The Firestore IAM documentation states the same thing in prose: "The
`datastore.schemas.*` permissions were previously named `datastore.indexes.*`. You can still
use `datastore.indexes` as an alias for `datastore.schemas`."

### The observation that *was* correct

The REST reference for `projects.databases.collectionGroups.fields.list` genuinely lists only
OAuth scopes and no IAM permission. That gap is real. It is not a reason to open a support
case, because the authorization result is directly observable.

### Direct verification against production

`phase3-inventory-reader@morgan-bank.iam.gserviceaccount.com`, whose only Firestore permission
is `datastore.indexes.list`, executed `ListFields` against `morgan-bank` and received **HTTP
200**. Firestore's authorization layer answered the question itself.

### Generalizable method

For any future "which IAM permission does this API method require?" question, in order of cost:

1. `gcloud iam list-testable-permissions <resource>` — existence, primary name, GA stage,
   custom-role eligibility. Pure read.
2. Call the method as an identity holding only the candidate permission. 200 confirms. 403
   names the permission Firestore actually checked — Google's error bodies carry
   `permission: <name>` in `ErrorInfo.metadata`. (Observed directly during this work: an
   unrelated denial returned `permission: iam.serviceAccounts.getAccessToken`.)
3. If a Google-generated written record is required, enable ADMIN_READ data access logs for
   `firestore.googleapis.com` and read `protoPayload.authorizationInfo[].permission`.

---

## 2. Corrections to the previous handoff

### "No credentials have been created, no IAM access has been granted"

Inaccurate. Verified against the live project, all of the following already existed:

- Service account `phase3-inventory-reader@morgan-bank.iam.gserviceaccount.com`
- Custom role `projects/morgan-bank/roles/phase3ControlPlaneInventoryReader`
- Project-level bindings of that role **and** `roles/firebasehosting.viewer` to the SA
- A user-managed key, `c5f5d40387fdaed020141895a8685cabf1b87784`, created
  2026-07-28T18:36 local / 2026-07-29T00:36 UTC

The custom role **already contained `datastore.indexes.list`** — the exact permission the
support request was drafted to ask about. The escalation was blocked on confirming a
permission that was already deployed in the role.

### "A non-production experiment was considered and rejected"

The rejection reasoning was that the inventory is pinned to `morgan-bank`. That is true of the
*entrypoint*, but the decisive test needed neither a test project nor the inventory code — only
one API call against the existing service account.

---

## 3. Defect found and fixed: invalid Firestore page size

Verifying the remaining control-plane surfaces surfaced a defect unrelated to IAM.

Both Firestore Admin requests returned **HTTP 400**:

```json
{"error":{"code":400,"message":"Invalid page size. Only 0 is supported.","status":"INVALID_ARGUMENT"}}
```

`createBoundedGoogleApiClient.listAll` applied
`pageSize: query.pageSize ?? PRODUCTION_LIST_PAGE_SIZE`, defaulting every request to 1000.
Hosting overrode it to 100. Functions tolerated 1000. The Firestore Admin API rejects every
non-zero page size on the `collectionGroups/-` wildcard.

**This would have aborted the production inventory at the Firestore stage.** Because the
runbook forbids using a failing run as discovery, it would have surfaced as another opaque
blocker with no diagnostic path.

### Why review and tests did not catch it

`productionPreflight.test.js` asserted `searchParams.get('pageSize') === '1000'` against a fake
fetch. The test encoded the broken value as expected behavior. Both prior reviews passed over
it because every check agreed with the code — nothing had ever exercised the real API.

This is the finding worth carrying forward beyond the immediate fix: the Phase 3 control-plane
path had been validated almost entirely against its own assumptions. One real API call found
what two reviews could not.

### Verified against production, both directions

| Request | `pageSize` | Result |
|---|---|---|
| `collectionGroups/-/indexes` | 1000 | 400 `Invalid page size. Only 0 is supported.` |
| `collectionGroups/-/fields?filter=…` | 1000 | 400 `Invalid page size. Only 0 is supported.` |
| `collectionGroups/-/indexes` | **0** | **200** |
| `collectionGroups/-/fields?filter=…` | **0** | **200** |

---

## 4. Full four-surface verification

Every surface the inventory reads, exercised as `phase3-inventory-reader` using the exact
request paths in `functions/phase3/productionPreflight.js`:

| Surface | Result |
|---|---|
| Rules release (`firebaserules.releases.get`) | 200 |
| Ruleset fetch (`firebaserules.rulesets.get`) | 200 |
| Cloud Functions v2 (`cloudfunctions.functions.list`) | 200 |
| Hosting sites | 200 |
| Hosting releases | 200 |
| Firestore composite indexes (`pageSize=0`) | 200 |
| Firestore field overrides (`pageSize=0`) | 200 |
| Document read — boundary test | **403 PERMISSION_DENIED** |

Two results worth noting:

- **Gen-2 risk did not materialize.** All three deployed functions are `GEN_2`, and
  `cloudfunctions.functions.list` alone is sufficient. No `run.services.get` needed. The
  custom role requires no additional permission.
- **The control-plane boundary is now proven empirically.** The 403 on a document read is an
  observed result, not an inference from role composition.

---

## 5. Observed production state (for expectations authoring, step 5)

- **Composite indexes: none.** `collectionGroups/-/indexes` returns `{}`. The inventory will
  record `composite: 'none'`.
- **Field overrides: one entry** —
  `projects/morgan-bank/databases/(default)/collectionGroups/__default__/fields/*`, carrying
  the three standard automatic index configurations (ascending, descending, array-contains),
  all `READY`.

**Trap to avoid:** the `-` wildcard returns the `__default__` field configuration even when no
field has been explicitly overridden. The inventory will record a single
`field:__default__/fields/*` key, **not** `fieldOverrides: 'none'`. Expectations authored on
the assumption of an empty field set would abort the preflight.

---

## 6. Everything that was changed, and what was reverted

| Action | Status |
|---|---|
| `roles/iam.serviceAccountTokenCreator` granted to `andrew.g.morgan77@gmail.com`, scoped to the one SA | **Reverted** both times; SA IAM policy verified empty |
| Google Cloud SDK installed at `~/google-cloud-sdk` (+ standalone Python at `~/.local/gcloud-python`) | Local tooling only |
| Read-only inspection of project, roles, SA, keys, permissions | No change |
| Control-plane read verification across four surfaces | Read-only |
| Source fix + test correction | Committed, see below |

**Not done:** no custom role modified, no project-level binding added, no key created or
deleted, no production data read, nothing deployed, nothing pushed to remote.

**Credential storage audited and correct:** key file at
`~/.config/morgan-bank/phase3/credentials/phase3-inventory-reader-57d4eee.json`, mode `0600`,
directory `drwx------`. No private key material anywhere else — not in gcloud logs, not in
Downloads, not in the repository. Lifecycle recommendation only: delete the key after the
inventory run and prefer impersonation, which was sufficient for every verification here.

### Commits on `feature/multi-teacher` (local, not pushed)

- `7a94276` — `fix(phase3): send pageSize=0 on Firestore Admin list requests`
- `57619c2` — `docs(phase3): confirm page-size fix against production`

Full evidence: `PHASE3_IAM_PERMISSION_EVIDENCE.md`.

---

## 7. What Codex needs to do next

### Immediate task: independent review of this diff

This is the blocker. The reviewed commit `72af2bd` is **unrunnable** — it sends
`pageSize=1000` and dies with 400. The runnable source is **unreviewed**. There is no path
through the runbook without a fresh review, and Claude cannot self-certify a change it authored.

Local gates run against this source: **464 unit tests pass, 67 contract tests pass, eslint
clean.** Re-run them at the final anchor before the inventory:

```
npm run test:phase3:unit && npm run test:phase3:contracts && npm run lint
```

```diff
--- a/functions/phase3/productionPreflight.js
+++ b/functions/phase3/productionPreflight.js
@@ -1738,6 +1738,9 @@
 export const PRODUCTION_READER_TIMEOUT_MS = 10_000
 const PRODUCTION_PAGE_LIMIT = 10_000
 const PRODUCTION_LIST_PAGE_SIZE = 1_000
+// The Firestore Admin API rejects every non-zero pageSize on the
+// collectionGroups wildcard: "Invalid page size. Only 0 is supported."
+const FIRESTORE_ADMIN_PAGE_SIZE = 0
 let productionReaderSequence = 0

@@ -2166,12 +2169,16 @@ async function readIndexesInventory(client, projectId) {
       originKey: 'firestoreAdmin',
       apiPath: `${parent}/indexes`,
       itemsField: 'indexes',
+      query: { pageSize: FIRESTORE_ADMIN_PAGE_SIZE },
     }),
     client.listAll({
       originKey: 'firestoreAdmin',
       apiPath: `${parent}/fields`,
       itemsField: 'fields',
-      query: { filter: 'indexConfig.usesAncestorConfig:false' },
+      query: {
+        filter: 'indexConfig.usesAncestorConfig:false',
+        pageSize: FIRESTORE_ADMIN_PAGE_SIZE,
+      },
     }),
   ])
```

```diff
--- a/functions/phase3/productionPreflight.test.js
+++ b/functions/phase3/productionPreflight.test.js
@@ -2353,7 +2353,8 @@
           assert.equal(parsed.searchParams.get('filter'), null)
-          assert.equal(parsed.searchParams.get('pageSize'), '1000')
+          // Firestore Admin rejects any non-zero pageSize on the wildcard.
+          assert.equal(parsed.searchParams.get('pageSize'), '0')
@@ -2370,7 +2371,8 @@
             'indexConfig.usesAncestorConfig:false',
           )
-          assert.equal(parsed.searchParams.get('pageSize'), '1000')
+          // Firestore Admin rejects any non-zero pageSize on the wildcard.
+          assert.equal(parsed.searchParams.get('pageSize'), '0')
```

Points worth specific attention during review:

1. `getJson` filters only `undefined`, `null`, and `''`. An explicit `0` is therefore
   transmitted as `pageSize=0` rather than omitted. Confirm that is the intended contract.
2. `PRODUCTION_LIST_PAGE_SIZE = 1_000` remains the default for Functions and the Auth reader
   (`auth.listUsers`). Only the two Firestore Admin calls were changed. Confirm no other
   caller reaches a Firestore Admin list endpoint.
3. With `pageSize=0` the server chooses its own page size. `listAll` still paginates via
   `pageToken` and retains the `PRODUCTION_PAGE_LIMIT` bound, so the pagination-safety
   properties are unchanged. Confirm.
4. The empty-result branches (`if (indexes.length === 0) inventory.composite = 'none'`) are
   unaffected, but note the production observation in section 5: indexes will be empty and
   fields will contain exactly one entry.

### Then

1. Re-anchor the operational plan from `72af2bd` to `57619c2` and record the new artifact
   hashes.
2. Grok performs the 5,000-foot review on the re-anchored plan.
3. Andrew authorizes and runs the runbook step 3 inventory. The credential and IAM are already
   in place and verified; the remaining input is the time-bounded authorization file.
4. Steps 4 onward proceed as written, with the section 5 field-override trap in mind.

### Recommendation for the rest of Phase 3

Treat "reviewed against fakes" as unproven. Every remaining control-plane and data-plane
assumption should be checked against the real API before it gates a production decision, using
the method in section 1. The page-size defect passed two reviews and a full test suite because
nothing had ever contacted Google.
