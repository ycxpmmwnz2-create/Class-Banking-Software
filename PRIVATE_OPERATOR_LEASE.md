# Private operator process lease

Status: implemented locally; independent review pending. This is one component
of the protected scan's remaining operating safeguards, not completion of the
real-data scanner or authority to run it.

`functions/operator/protectedMoneyScan/operatorLease.py` implements an actual
OS-held `flock` on `maintenance-and-scan.lock`. Its directory must be an absolute,
canonical, nonsymlink directory owned by the current user with mode 0700. The
lock must be a regular file, mode 0600, owned by that user and have one link.
It is created exclusively when absent and retained after release; it is never
truncated, replaced, deleted, timed out, or taken over based on a PID.

The future reviewed private operator launcher must select ONE fixed local
directory for all cooperating scan, maintenance and recovery processes. A run ID
or report directory must not select a different lease. This module does not yet
provide that launcher or choose a real operator directory. Nothing in the
existing demo scanner or any deployed entry point imports it.

## Lifetime and failure contract

Use `OperatorLease(directory)` as a context manager. The caller must invoke
`assert_held()` before each admitted operation and publication boundary. It
reopens the directory chain without following symlinks and verifies that the
named directory and lock still identify the held inodes, ownership, permissions
and link count. A failed check permanently invalidates that lease, including
when permissions or paths are later restored. Invalidation retains the held
descriptor until its owner closes after outstanding work settles.

Descriptors are noninheritable by default. A supervisor must explicitly pass
`lease.fileno()` using `pass_fds` to EVERY child which may outlive it and continue
reading or publishing. Such children must retain their inherited descriptor
until their own work ends, including forwarding it to further workers. Merely
passing it to an intermediate Node process does not automatically pass it to a
publisher that Node later spawns. The future launcher/publisher integration must
prove the entire chain before live use.

`close()` closes this process's descriptors. It intentionally does NOT call
`LOCK_UN`, because doing so would drop protection also held by an inherited
child. The OS releases the flock after the final inherited copy closes. There
is no forced cancellation, safe-resume claim or cleanup command. Killing one
holder releases its copy; surviving inheritors still hold theirs.

Exceptions and the module's output expose no input paths or OS error text. The
only exception message is `Private operator lease unavailable.` The caller must
also suppress traceback/local-variable dumps in the private launcher. The
module performs no network, environment discovery, credential, Cloud, database,
or report operation and runs no code merely by being imported.

## Limits that remain release blockers

This is cooperative exclusion on the same host and the SAME lock directory.
It cannot stop a remote operator, Cloud Function, queued trigger, direct client,
or another process using another directory. It does not prove a writer drain,
Cloud history completeness, read-only IAM, authority, or private terminal use.
Mode/owner checks are not an audit of extended ACLs, synced folders, network
filesystem semantics, screen access or another process acting as the same user.
Those require the separately reviewed private operating procedure. Same-user
malicious descriptor manipulation and arbitrary lock deletion are outside this
primitive's protection; detected replacement stops admission, not an operation
which was already admitted.

The real collector, credential verification, private launcher, fixed directory
selection, complete child/publication lifetime integration, remote maintenance
exclusion, canary/drain/recovery evidence and Node22 qualification remain open.
Existing production refusals and false initialization/activation flags are
unchanged. No live scan, staging change or production change is authorized by
this document.

## Verification

The existing `npm run test:phase3:unit` discovers `operatorLease.test.js`, which
runs `operatorLease_tests.py` with a fixed Python path, scrubbed environment,
bounded execution/output, and fictional temporary directories. Tests exercise
real competing processes, descriptor inheritance, parent closure, SIGKILL,
reacquisition, unchanged persistent inode, sticky invalidation, replacement,
symlink ancestors, FIFO/directory/hardlink rejection, permissions and redaction.
The operating-system evidence is local; it is not a Cloud maintenance proof.
