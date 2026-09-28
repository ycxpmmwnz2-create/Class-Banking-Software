"""Fictional local fault tests; not imported by the scanner."""
import hashlib
import json
import os
import tempfile
from unittest.mock import patch
from reportStore import publish

def request(directory):
    content = json.dumps({'kind': 'protected-money-scan-rehearsal-result', 'projectId': 'demo-morgan-bank-protected-scan',
                          'runId': 'fictional-run', 'activationAllowed': False, 'initializationAllowed': False, 'artifactAccepted': False, 'productionEligible': False})
    return dict(directory=directory, runId='fictional-run', contents=content, digest=hashlib.sha256(content.encode()).hexdigest())

def refusing(operation, replacement):
    with tempfile.TemporaryDirectory() as parent:
        parent = os.path.realpath(parent)
        os.chmod(parent, 0o700)
        with patch('reportStore.os.' + operation, replacement):
            try:
                publish(request(parent))
            except (OSError, ValueError):
                pass
            else:
                raise AssertionError('Fault must not return a success receipt')
        # The exclusive run remains unusable even after an uncertain publication.
        try:
            publish(request(parent))
        except FileExistsError:
            pass
        else:
            raise AssertionError('Must not reuse an incomplete run')

def disk_full(*args, **kwargs):
    raise OSError(28, 'fictional disk full')
refusing('write', disk_full)
refusing('write', lambda *a, **k: 0)
refusing('fsync', disk_full)
refusing('read', lambda *a, **k: b'')
refusing('link', disk_full)
# Failure after atomic publication must still not produce a durable receipt.
original_sync = os.fsync
count = [0]
def last_sync(fd):
    count[0] += 1
    if count[0] == 3:
        raise OSError('fictional final directory sync failure')
    original_sync(fd)
refusing('fsync', last_sync)
original_write = os.write
with tempfile.TemporaryDirectory() as parent:
    parent = os.path.realpath(parent); os.chmod(parent, 0o700)
    with patch('reportStore.os.write', lambda fd, data: original_write(fd, data[:3])):
        assert publish(request(parent))['durable'] is True
# Rename an ancestor after its fd is held. Output stays in the held directory.
with tempfile.TemporaryDirectory() as base:
    base = os.path.realpath(base)
    parent, moved, redirected = [os.path.join(base, p) for p in ('parent', 'moved', 'redirected')]
    os.mkdir(parent, 0o700); os.mkdir(redirected, 0o700)
    original_mkdir = os.mkdir
    def rename_then_mkdir(path, mode=0o777, *, dir_fd=None):
        os.rename(parent, moved)
        os.symlink(redirected, parent)
        return original_mkdir(path, mode, dir_fd=dir_fd)
    with patch('reportStore.os.mkdir', rename_then_mkdir):
        assert publish(request(parent))['durable'] is True
    assert os.listdir(redirected) == []
    assert os.path.isfile(os.path.join(moved, 'fictional-run', 'report.json'))
print('8 storage fault cases passed')
