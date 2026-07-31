# Phase 3 — Firestore ListFields IAM permission: resolved without Google Support

**Date:** 2026-07-29
**Project:** `morgan-bank` (project number 242031426628)
**Anchor commit:** 72af2bddd213757ad1a101a7e13a6b3e5b32ea09
**Status:** RESOLVED for the dated control-plane question. This is historical
evidence, not a statement of the later Role A data-read boundary.

## Scope and later supersession

The observations through "Page-size fix confirmed against production" record
the live state on 2026-07-29, when the inventory service account held only the
base control-plane role and Hosting Viewer. The expected 403 document read
proves that base-role boundary only. It must not be cited after Role A is bound:
Role A deliberately adds project-wide Firestore document and Firebase Auth user
read access.

A separately authorized N9 control-plane observation was later retained at
commit `fa33d0250cb06a5c933494eb27aabef2612c610c` as inventory
`4459cd2fa4ab8399726ef47de6eda4ca1e24d463a6baec23b4a03a4e43194764`.
The tracked Role A/Role B correction creates a successor commit, so that
artifact remains immutable evidence but is superseded for the corrected N9/N10
pair. No application data was read by N9.

## The question

Which IAM permission does Firestore evaluate when authorizing:

```
GET https://firestore.googleapis.com/v1/projects/morgan-bank/databases/(default)/collectionGroups/-/fields
    ?filter=indexConfig.usesAncestorConfig:false&pageSize=1000
```

## Answer

**`datastore.schemas.list`** is the primary permission. **`datastore.indexes.list`** is a formally
registered alias for it. Either name authorizes `FirestoreAdmin.ListFields`.

### Evidence 1 — Google's IAM API on the alias relationship (read-only)

```
gcloud iam list-testable-permissions //cloudresourcemanager.googleapis.com/projects/morgan-bank
```

Returned, verbatim:

```json
{"name":"datastore.indexes.list","primaryPermission":"datastore.schemas.list","stage":"GA"}
{"name":"datastore.schemas.list","stage":"GA"}
```

`primaryPermission` is Google's own machine-readable declaration that `datastore.indexes.list`
resolves to `datastore.schemas.list`. These were never two competing candidates — they are one
permission with two accepted names. Corroborated by the Firestore IAM documentation: "The
`datastore.schemas.*` permissions were previously named `datastore.indexes.*`. You can still use
`datastore.indexes` as an alias for `datastore.schemas`."

Neither permission carries a `customRolesSupportLevel` restriction and both are `stage: GA`, so both
are includable in a project-level custom role.

### Evidence 2 — direct authorization test against production

Service account `phase3-inventory-reader@morgan-bank.iam.gserviceaccount.com`, whose only Firestore
permission is `datastore.indexes.list`, executed `FirestoreAdmin.ListFields` against `morgan-bank`:

```
gcloud firestore indexes fields list --project=morgan-bank \
  --impersonate-service-account=phase3-inventory-reader@morgan-bank.iam.gserviceaccount.com
```

**Result: HTTP 200.** Response body:

```json
[
  {
    "indexConfig": {
      "indexes": [
        {"fields":[{"fieldPath":"*","order":"ASCENDING"}],"queryScope":"COLLECTION","state":"READY"},
        {"fields":[{"fieldPath":"*","order":"DESCENDING"}],"queryScope":"COLLECTION","state":"READY"},
        {"fields":[{"arrayConfig":"CONTAINS","fieldPath":"*"}],"queryScope":"COLLECTION","state":"READY"}
      ]
    },
    "name": "projects/morgan-bank/databases/(default)/collectionGroups/__default__/fields/*"
  }
]
```

This is Firestore's authorization layer answering the question directly, in production, on the real
project. It is stronger evidence than a support-desk paraphrase.

## Answers to the five questions posed to Google

| # | Question | Answer |
|---|---|---|
| 1 | Exact permission checked by `fields.list` | `datastore.schemas.list` |
| 2 | Does `datastore.schemas.list` cover it? | Yes — it is the primary permission |
| 3 | Is `datastore.indexes.list` a valid alias? | Yes — `primaryPermission: datastore.schemas.list` |
| 4 | If neither, what is required? | Not applicable |
| 5 | Includable in a project-level custom role? | Yes — GA, no support-level restriction, and already in use |

## Control-plane boundary on 2026-07-29

`projects/morgan-bank/roles/phase3ControlPlaneInventoryReader` contains exactly:

```
cloudfunctions.functions.list
datastore.indexes.list
firebaserules.releases.get
firebaserules.rulesets.get
```

Plus `roles/firebasehosting.viewer` bound separately.

At this dated base-role boundary no `datastore.entities.*` permission was
present. IAM is deny-by-default, so the identity could not then read Firestore
documents, student or teacher records, balances, transactions, or
Authentication users. The concern did not apply to the base role; it does apply
after the separately reviewed Role A transition and is accepted there as a
temporary project-wide read exposure.

This is now proven empirically, not merely inferred. A document read attempted as the service account:

```
GET https://firestore.googleapis.com/v1/projects/morgan-bank/databases/(default)/documents/users?pageSize=1
HTTP 403
{"error":{"code":403,"message":"Missing or insufficient permissions.","status":"PERMISSION_DENIED"}}
```

## Full four-surface verification

Every control-plane surface the inventory reads was exercised as
`phase3-inventory-reader`, using the exact request paths in
`functions/phase3/productionPreflight.js`.

| Surface | Request | Result |
|---|---|---|
| Rules release | `firebaserules/v1/projects/morgan-bank/releases/cloud.firestore` | 200 |
| Ruleset fetch | `firebaserules/v1/projects/morgan-bank/rulesets/90f284ed-…` | 200 |
| Cloud Functions v2 | `cloudfunctions/v2/projects/morgan-bank/locations/-/functions` | 200 |
| Hosting sites | `firebasehosting/v1beta1/projects/morgan-bank/sites` | 200 |
| Hosting releases | `firebasehosting/v1beta1/sites/morgan-bank/releases` | 200 |
| Firestore composite indexes | `…/collectionGroups/-/indexes?pageSize=1000` | **400** |
| Firestore field overrides | `…/collectionGroups/-/fields?filter=…&pageSize=1000` | **400** |
| Document read (boundary) | `…/documents/users?pageSize=1` | **403 (expected)** |

The Gen-2 Cloud Run risk flagged earlier did **not** materialize:
`cloudfunctions.functions.list` alone is sufficient to list `GEN_2` functions. No
`run.services.get` is required. The custom role needs no additional permission.

## Defect found: invalid Firestore page size

The two Firestore requests failed with HTTP 400 — not a permission error:

```json
{"error":{"code":400,"message":"Invalid page size. Only 0 is supported.","status":"INVALID_ARGUMENT"}}
```

`createBoundedGoogleApiClient.listAll` applied `pageSize: query.pageSize ?? PRODUCTION_LIST_PAGE_SIZE`,
defaulting every request to 1000. Hosting overrode it to 100; Functions tolerated 1000; the Firestore
Admin API rejects every non-zero page size on the `collectionGroups/-` wildcard.

This would have aborted the production inventory run at the Firestore stage. Because the runbook
forbids using a failing run as discovery, the failure would have surfaced as another opaque blocker.

Fix applied:

- Added `FIRESTORE_ADMIN_PAGE_SIZE = 0` with a comment recording the API constraint.
- Both Firestore `listAll` calls in `readIndexesInventory` now pass it explicitly. `getJson` filters
  only `undefined`/`null`/`''`, so an explicit `0` is transmitted as `pageSize=0`.

Why the test suite did not catch this: `productionPreflight.test.js` asserted
`searchParams.get('pageSize') === '1000'` against a fake fetch. The tests encoded the broken value as
expected behavior rather than exercising the real API. Those assertions now require `'0'`.
All 105 tests in `productionPreflight.test.js` and 27 in the inventory suites pass.

## Corrections to the handoff document

The handoff stated: *"no credentials have been created, no IAM access has been granted."* Verified
against the live project, that is inaccurate. All of the following already existed:

- Service account `phase3-inventory-reader@morgan-bank.iam.gserviceaccount.com`
- Custom role `projects/morgan-bank/roles/phase3ControlPlaneInventoryReader`, **already containing
  `datastore.indexes.list`** — the permission the support request was asking about
- Project-level bindings of both that custom role and `roles/firebasehosting.viewer` to the SA
- A user-managed service account key, `c5f5d40387fdaed020141895a8685cabf1b87784`,
  created 2026-07-29T00:36:26Z

The IAM work described as a pending human decision had already been performed, with the correct
permission already in the role. The blocker was a verification gap, not a missing capability.

## What was changed and reverted

| Action | Status |
|---|---|
| Granted `roles/iam.serviceAccountTokenCreator` to `andrew.g.morgan77@gmail.com`, scoped to the one SA | **Reverted** — SA IAM policy verified empty (etag `BwZXw-KnaRE=`) |
| Read-only permission catalog and project/role/SA inspection | No change made |
| `ListFields` authorization test | Read-only; no data read, no write |

No custom role was modified, no binding was added at project level, no key was created, no production
data was read, and nothing was deployed.

## Scope of what was and was not tested

Tested:
- `FirestoreAdmin.ListFields` authorized for an identity holding only `datastore.indexes.list` → 200.

- All four control-plane surfaces exercised as the service account (table above).
- The document-read boundary, empirically denied with 403.
- The inventory's exact `filter` and `pageSize` parameters, which exposed the page-size defect.

- The corrected `pageSize=0` requests, confirmed against production (below).

Not tested in this 2026-07-29 evidence pass:
- The `inventory.js` entrypoint had not yet been run. The later separately
  authorized N9 observation is recorded in the scope-and-supersession section
  above.

## Page-size fix confirmed against production

Both requests issued against `morgan-bank`, old parameter and corrected parameter side by side:

| Request | `pageSize` | Result |
|---|---|---|
| `collectionGroups/-/indexes` | 1000 | 400 `Invalid page size. Only 0 is supported.` |
| `collectionGroups/-/fields?filter=…` | 1000 | 400 `Invalid page size. Only 0 is supported.` |
| `collectionGroups/-/indexes` | **0** | **200** |
| `collectionGroups/-/fields?filter=…` | **0** | **200** |

The defect and its fix are both reproduced against the live API. No open items remain in the
control-plane read path.

## Observed production index state

Recorded for step 5, when the preflight expectations are authored from the reviewed inventory:

- **Composite indexes: none.** `collectionGroups/-/indexes` returns `{}`. The inventory will record
  `composite: 'none'`.
- **Field overrides: one entry**, the database-wide default
  `projects/morgan-bank/databases/(default)/collectionGroups/__default__/fields/*`, carrying the
  three standard automatic index configurations (ascending, descending, array-contains), all `READY`.
  The inventory will record a single `field:__default__/fields/*` key, **not** `fieldOverrides: 'none'`.

That second point is worth care: the `-` wildcard returns the default field configuration even when no
field has been explicitly overridden. Expectations authored on the assumption of an empty field set
would abort the preflight.

## Tracked future data-read and write-set definitions

These files are local review inputs and are not evidence that either live role
exists or is bound:

| Alias | Live resource if later created | Tracked file | Raw-byte SHA-256 | Exact permissions |
|---|---|---|---|---|
| Role A | `projects/morgan-bank/roles/phase3DataPlaneReader` | `iam/phase3/phase3DataPlaneReader.yaml` | `4c4259c12d3d1f0188e997baac0a7fed000510357cb4b5c453de342123fad8d5` | `datastore.entities.get`, `datastore.entities.list`, `firebaseauth.users.get` |
| Role B | `projects/morgan-bank/roles/phase3MigrationWriter` | `iam/phase3/phase3MigrationWriter.yaml` | `a97924dbbdbf025cca740a6c952791a3ec5a774b0c2277f0228d029fd272d1bf` | `datastore.databases.get`, `datastore.entities.create`, `datastore.entities.update` |

Google's live testable-permissions metadata was checked on 2026-07-30. All six
permissions are GA, supported in a project custom role, and have no primary-
permission substitution. No IAM mutation was performed by that check.

The exact read-only command used the numeric project resource required by the
installed Cloud SDK:

```text
gcloud iam list-testable-permissions //cloudresourcemanager.googleapis.com/projects/242031426628 \
  --filter='name=(datastore.databases.get datastore.entities.create datastore.entities.get datastore.entities.list datastore.entities.update firebaseauth.users.get)' \
  --format='json(name,stage,customRolesSupportLevel,primaryPermission)'
```

Its verbatim response, with absent optional fields preserved as absence, was:

```json
[
  {
    "name": "datastore.databases.get",
    "stage": "GA"
  },
  {
    "name": "datastore.entities.create",
    "stage": "GA"
  },
  {
    "name": "datastore.entities.get",
    "stage": "GA"
  },
  {
    "name": "datastore.entities.list",
    "stage": "GA"
  },
  {
    "name": "datastore.entities.update",
    "stage": "GA"
  },
  {
    "name": "firebaseauth.users.get",
    "stage": "GA"
  }
]
```

`customRolesSupportLevel` and `primaryPermission` are absent on all six rows;
under the IAM response contract that means custom-role support is unrestricted
and no alias substitution applies.

Role A is the closed preflight/re-verification data-read set. Firestore
`BatchGetDocuments` requires `datastore.entities.get`; `RunQuery` and
`ListDocuments` require both entity permissions; Auth user pagination requires
`firebaseauth.users.get`. `firebaseauth.configs.getHashConfig` is intentionally
absent, so password hashes and salts are not returned. The same Role A read set
must remain bound through preflight, both writer invocations, and
re-verification so Auth digests have a stable observable preimage.

The Role A binding is project-wide and cannot be limited by document path. It
therefore authorizes reads of the entire default database, including student
PII and credential documents, plus Auth user records without password hashes.
The production reader remains code-limited to its enumerated paths, but IAM
does not enforce that narrower path boundary. This is the accepted residual
risk of the separately authorized inspection window.

Role B is defined for review but must not be created or bound during the Role A
transition. `datastore.databases.get` is required for Firestore transaction
begin/rollback; create/update are the writer's only entity mutations. Delete
and Auth mutation remain excluded. Role B is created and bound only at the
later separately approved write boundary.

## Remaining risk

None remains in the dated control-plane read path. The future Role A transition
has the explicit project-wide sensitive-read exposure above and requires exact
tracked-file review, checksum-bound approval, live definition/binding
verification, and proof that Role B remains absent.

## Method for any future "which permission does this API need?" question

Do not open a support case. In order of cost:

1. `gcloud iam list-testable-permissions <resource>` — confirms the permission exists, its primary
   name, GA stage, and custom-role eligibility. Pure read.
2. Call the method as an identity holding only the candidate permission. 200 confirms; 403 names the
   permission Firestore actually checked — Google's error bodies include a
   `permission: <name>` field in `ErrorInfo.metadata`.
3. If a Google-generated written record is required: enable ADMIN_READ data access logs for
   `firestore.googleapis.com` and read `protoPayload.authorizationInfo[].permission`. That field is
   Google's authorization engine recording the exact permission it evaluated.

## Credential storage audit

The user-managed key `c5f5d40387fdaed020141895a8685cabf1b87784` was located and its handling audited.

Storage is correct:

| Check | Result |
|---|---|
| Key file path | `~/.config/morgan-bank/phase3/credentials/phase3-inventory-reader-57d4eee.json` |
| File mode | `-rw-------` (0600), owner `andrewmorgan` |
| Directory mode | `drwx------` |
| Private key material found anywhere else | No |
| Key present in gcloud logs | Fingerprint only, not key material |
| Key present in the git repository | No |
| Key present in `~/Downloads` | No — the handoff `.txt` there cites the fingerprint only |

No remediation is required for how the key is stored.

The earlier recommendation to delete the key immediately after inventory is
superseded by the release contract. If this credential remains the approved
Phase 3 credential, its exact raw bytes and SHA-256 must be retained securely
through the corrected N9/N10 pair, preflight, both writer invocations, and
re-verification. Impersonation cannot substitute inside those checksum-bound
entrypoints. Key deletion, service-account teardown, or any privilege change is
a later separate approval boundary. A persistent key remains a standing
liability; while retained for this bounded sequence, its audited storage
controls remain required.
