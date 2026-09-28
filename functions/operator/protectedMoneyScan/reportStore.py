"""Local-only descriptor-relative report publication. No network or credentials.
Input and errors never echoed. A run directory is exclusive and never reused.
"""
import hashlib
import json
import os
import re
import stat
import sys

MAX_BYTES = 32 * 1024 * 1024

def publish(request):
    if set(request) != {'directory', 'runId', 'contents', 'digest'}:
        raise ValueError()
    directory, run_id, contents, digest = [request[k] for k in ('directory', 'runId', 'contents', 'digest')]
    if not isinstance(directory, str) or not directory.startswith('/') or os.path.normpath(directory) != directory:
        raise ValueError()
    if not isinstance(run_id, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]{0,127}', run_id):
        raise ValueError()
    if not isinstance(contents, str) or not isinstance(digest, str) or not re.fullmatch(r'[a-f0-9]{64}', digest):
        raise ValueError()
    data = contents.encode('utf-8')
    if len(data) > MAX_BYTES or hashlib.sha256(data).hexdigest() != digest:
        raise ValueError()
    # Contents must be complete JSON before any filesystem change.
    report = json.loads(contents)
    if report.get('runId') != run_id or report.get('kind') != 'protected-money-scan-rehearsal-result' or report.get('projectId') != 'demo-morgan-bank-protected-scan':
        raise ValueError()
    if any(report.get(key) is not False for key in ('activationAllowed', 'initializationAllowed', 'artifactAccepted', 'productionEligible')):
        raise ValueError()
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    fd = os.open('/', flags)
    run_fd = None
    try:
        for part in directory.split('/')[1:]:
            if not part or part in ('.', '..'):
                raise ValueError()
            child = os.open(part, flags, dir_fd=fd)
            os.close(fd)
            fd = child
        info = os.fstat(fd)
        if info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
            raise ValueError()
        os.mkdir(run_id, 0o700, dir_fd=fd)
        run_fd = os.open(run_id, flags, dir_fd=fd)
        os.fsync(fd)
        file_fd = os.open('report.pending', os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=run_fd)
        try:
            info = os.fstat(file_fd)
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or stat.S_IMODE(info.st_mode) != 0o600:
                raise ValueError()
            remaining = memoryview(data)
            while remaining:
                written = os.write(file_fd, remaining)
                if written <= 0:
                    raise OSError()
                remaining = remaining[written:]
            os.fsync(file_fd)
            os.lseek(file_fd, 0, os.SEEK_SET)
            check = hashlib.sha256()
            while True:
                chunk = os.read(file_fd, 65536)
                if not chunk:
                    break
                check.update(chunk)
            if check.hexdigest() != digest:
                raise ValueError()
        finally:
            os.close(file_fd)
        # link is atomic and cannot overwrite. Both names are relative to the
        # held directory descriptor, so swapped ancestor paths cannot redirect it.
        os.link('report.pending', 'report.json', src_dir_fd=run_fd, dst_dir_fd=run_fd, follow_symlinks=False)
        os.unlink('report.pending', dir_fd=run_fd)
        os.fsync(run_fd)
        return {'digest': digest, 'durable': True}
    finally:
        if run_fd is not None:
            os.close(run_fd)
        os.close(fd)

if __name__ == '__main__':
    os.umask(0o077)
    try:
        raw = sys.stdin.buffer.read(2 * MAX_BYTES + 65537)
        if len(raw) > 2 * MAX_BYTES + 65536:
            raise ValueError()
        answer = publish(json.loads(raw))
        sys.stdout.write(json.dumps(answer) + '\n')
    except Exception:
        sys.stdout.write('{"error":"storage"}\n')
        sys.exit(1)
