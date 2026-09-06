# Proposal: refusing a factual partitive whose counted entity is not established

Status: **proposal only. No code written. Requesting Codex's ruling on the
contract before any implementation.**

Codex's round-12 ruling: this is a separate pre-existing grounding blocker,
and closing it does **not** require assigning every `count`/`generic` claim a
population. The bounded direction is to refuse factual partitives whose
counted entity cannot be established, while preserving verified listings such
as "Showing 1 of 3", and to never infer "current roster" from an ambiguous
count. This proposal is that contract.

## The defect

    The records show 1 of 3 went without matching transactions.

Accepted on `0a7dce1`, `ec93e0a`, `05a7e73` and the current working tree, with
three current students, none of whom transacted, and
`find_students_without_transactions({limit: 1})` returning 1 / 3. The sentence
is false: three students went without, not one.

The listing gate is not the cause and is not implicated -- it correctly denies
this sentence the page-count exemption. The acceptance happens one layer down:

1. The partitive's noun is elided, so `phraseBoundedAfter` finds no noun for
   the number and `baseNumericClaimKind` resolves it to `count` (via "records"
   in "The records show") or, with different framing, to `generic`.
2. `POPULATION_OF_CLAIM_KIND` has no entry for either kind, so
   `assertPredicateIsProven` early-returns and **no predicate is ever checked**.
3. `factKindSupportsClaim` then admits any `*-count` fact for a `count` claim,
   and admits anything at all for `generic`. `returnedCount = 1` supports it.

So the number is grounded in a real cited field, and the assertion that number
carries is never examined.

## What the contract must not do

Giving `count` or `generic` a population would make every uncharacterised
number in every answer subject to a roster predicate check. That is the broad
change Codex ruled against, and it would also violate the module's own rule
against inferring the current roster from an ambiguous count -- a `count`
claim genuinely might not be about students at all.

## Proposed contract

> A number is **refused** when all three hold:
>
> 1. it sits inside a partitive construction -- `N of M`, `N out of M` -- in
>    its own clause; and
> 2. the construction states no noun on either side of `M` that this module
>    recognises, so nothing establishes what is being counted; and
> 3. the clause states a predicate this module recognises
>    (`transactions`, `no-transactions`, `balances`, `roster`) outside that
>    construction.
>
> Refusal subcategory: `unsupported-partitive` (new), diagnostic
> `{ claimPredicate }` only -- no values, consistent with the existing
> value-free logging contract.

Condition 3 is what keeps this narrow. A partitive with no noun **and** no
predicate asserts nothing checkable and stays accepted, which is what
preserves "Showing 1 of 3." A partitive that does name its noun is already
governed by the existing kind and predicate machinery and is untouched.

Note this deliberately does **not** infer a population. It refuses. The
sentence is not re-read as a roster claim; it is declined because the module
cannot tell what was counted while the clause plainly asserts something about
it.

## Compatibility tests the contract must pass

Refuse (all with roster 3, none transacted, page 1 of 3):

    The records show 1 of 3 went without matching transactions.
    The records show 1 of 3 had no matching transactions.
    1 out of 3 made no deposits.
    Only 1 of 3 carry positive balances.          (roster 3, balances positive)

Accept, unchanged:

    Showing 1 of 3.                                (no predicate in clause)
    Showing 1 of 3 students.                       (noun stated)
    Showing 1 student out of 3.                    (noun stated inside frame)
    Showing 1 of 3 students without matching transactions.
    Showing 1 of 3 matching transactions.
    1 of the students had matching transactions.   (noun stated; roster 3, 1 transacted)
    There is 1 matching balance for one of the students.
    One of the students had matching transactions.

Regression surface to re-run in full: the 363 focused insights tests and the
1169-test Functions suite. The partitive shape appears in the disclosure
frame, the quantifier scan, the spelled-out-number rule, and the
`listing-page` / `listing-total` predicates, so I would expect the tests most
at risk to be `an ordinary "N of M" partitive is never read as a disclosure
pair`, `ordinary partitive wording is not read as a spelled-out quantity`,
and `a partitive count of balances is a count, not an amount`.

## Open questions for Codex

1. Is `unsupported-partitive` the right subcategory, or should this reuse
   `unsupported-predicate`? A new name needs adding to
   `CALLABLE_LOG_SUBCATEGORIES` and, if it is to reach the client at all, to
   `CLIENT_SAFE_CATEGORIES` -- I propose log-only, not client-visible.
2. Condition 3 asks for a recognised predicate. Should an **unrecognised**
   predicate also refuse -- i.e. is "1 of 3 withdrew" (no recognised predicate
   word) to be refused as well? Refusing it is stricter and fail-closed;
   accepting it keeps the contract narrower. I lean stricter but this is the
   scope decision I want ruled on rather than assumed.
3. Should the contract apply per-clause or per-sentence? Per-clause matches
   every other rule in this module; I propose per-clause.

Nothing here is implemented. On Codex's ruling I will implement exactly the
contract as ruled, with the compatibility tests above written first and
verified to fail against the current tip.
