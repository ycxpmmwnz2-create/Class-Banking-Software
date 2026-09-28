"""A local OS lease for cooperating private operators; never a Cloud write fence.

The caller selects the reviewed, fixed operator directory before handling private
data. All scan, maintenance and recovery processes must use that same directory.
There is no run-specific lock name, timeout takeover, PID inference or unlink.
Keep the descriptor open in every process with outstanding work (pass_fds when
spawning a child). Closing a parent's copy cannot release a child's copy.
"""
import fcntl
import os
import stat


class LeaseUnavailable(Exception):
    """Fixed diagnostic: paths and operating-system errors never escape."""

    def __init__(self):
        super().__init__('Private operator lease unavailable.')


def _private(info, mode, directory=False):
    return (stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode)) and \
        info.st_uid == os.getuid() and stat.S_IMODE(info.st_mode) == mode and \
        (directory or info.st_nlink == 1)


def _identity(info):
    return info.st_dev, info.st_ino


def _directory(path):
    if not isinstance(path, str) or not path.startswith('/') or \
            len(path.encode('utf-8')) > 4096 or os.path.normpath(path) != path or path == '/':
        raise LeaseUnavailable()
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
    descriptor = os.open('/', flags)
    try:
        for component in path.split('/')[1:]:
            if not component or component in ('.', '..'):
                raise LeaseUnavailable()
            child = os.open(component, flags, dir_fd=descriptor)
            os.close(descriptor)
            descriptor = child
        if not _private(os.fstat(descriptor), 0o700, directory=True):
            raise LeaseUnavailable()
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise


class OperatorLease:
    """Exclusive flock held on a persistent inode in an owner-only directory.

    This is a cooperative same-host/same-directory primitive, not authentication,
    protection from the same OS user, or evidence that remote writers stopped.
    A supervisor must not claim completion until its worker and publishers have
    settled. Children inherit the descriptor only through an explicit pass_fds.
    """

    _NAME = 'maintenance-and-scan.lock'

    def __init__(self, directory):
        self._directory = directory
        self._directory_fd = None
        self._fd = None
        self._failed = False
        try:
            self._directory_fd = _directory(directory)
            self._directory_identity = _identity(os.fstat(self._directory_fd))
            flags = os.O_RDWR | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK
            try:
                self._fd = os.open(self._NAME, flags | os.O_CREAT | os.O_EXCL,
                                   0o600, dir_fd=self._directory_fd)
            except FileExistsError:
                self._fd = os.open(self._NAME, flags, dir_fd=self._directory_fd)
            info = os.fstat(self._fd)
            if not _private(info, 0o600):
                raise LeaseUnavailable()
            self._file_identity = _identity(info)
            # Nonblocking refusal; waiting or elapsed time never confers authority.
            fcntl.flock(self._fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.assert_held()
        except BaseException as error:
            self.close()
            if isinstance(error, (KeyboardInterrupt, SystemExit)):
                raise
            raise LeaseUnavailable() from None

    def assert_held(self):
        """Check the named path still reaches our held private inode; fail sticky."""
        current = None
        try:
            if self._failed or self._fd is None or self._directory_fd is None:
                raise LeaseUnavailable()
            current = _directory(self._directory)
            if _identity(os.fstat(current)) != self._directory_identity:
                raise LeaseUnavailable()
            info = os.fstat(self._fd)
            named = os.stat(self._NAME, dir_fd=current, follow_symlinks=False)
            if not _private(info, 0o600) or not _private(named, 0o600) or \
                    _identity(info) != self._file_identity or _identity(named) != self._file_identity:
                raise LeaseUnavailable()
            return True
        except BaseException as error:
            self._failed = True
            # Retain the old lock until outstanding work settles; invalidation is
            # not a safe-unlock event. Do not delete or "repair" replacement paths.
            if isinstance(error, (KeyboardInterrupt, SystemExit)):
                raise
            raise LeaseUnavailable() from None
        finally:
            if current is not None:
                os.close(current)

    def fileno(self):
        """For explicit child inheritance, never a persistent acceptance token."""
        self.assert_held()
        return self._fd

    def close(self):
        # Do not LOCK_UN: flock belongs to the shared open-file description and
        # explicit unlocking would also drop an inherited child's protection.
        # Last-descriptor closure is the only release mechanism.
        failed = False
        for attribute in ('_fd', '_directory_fd'):
            descriptor = getattr(self, attribute)
            setattr(self, attribute, None)
            if descriptor is not None:
                try:
                    os.close(descriptor)
                except OSError:
                    failed = True
        if failed:
            raise LeaseUnavailable() from None

    def __enter__(self):
        self.assert_held()
        return self

    def __exit__(self, *_):
        self.close()
