"""Fictional directories; real OS locks and independently running processes."""
import contextlib
import io
import os
from pathlib import Path
import signal
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from operatorLease import LeaseUnavailable, OperatorLease


HERE = str(Path(__file__).resolve().parent)


class OperatorLeaseTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='fictional-operator-lease-')
        self.directory = str(Path(self.temporary.name).resolve())
        os.chmod(self.directory, 0o700)
        self.children = []

    def tearDown(self):
        for child in self.children:
            if child.poll() is None:
                child.kill()
            child.communicate(timeout=10)
        self.temporary.cleanup()

    def child(self, code, arguments=(), **options):
        child = subprocess.Popen([sys.executable, '-c',
            'import sys;sys.path.insert(0, ' + repr(HERE) + ');' + code, *arguments],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, env={'PATH': '/usr/bin:/bin', 'PYTHONDONTWRITEBYTECODE': '1'}, **options)
        self.children.append(child)
        return child

    def ready(self, child):
        # Tests are additionally bounded by the outer Node subprocess timeout.
        self.assertEqual(child.stdout.readline().strip(), 'ready')

    def contender(self):
        child = self.child('from operatorLease import OperatorLease;OperatorLease(sys.argv[1])',
                           [self.directory])
        _, stderr = child.communicate(timeout=10)
        self.assertNotEqual(child.returncode, 0)
        self.assertIn('Private operator lease unavailable.', stderr)

    def test_persistent_private_file_and_reacquisition(self):
        with OperatorLease(self.directory) as lease:
            self.assertTrue(lease.assert_held())
            info = os.stat(Path(self.directory) / lease._NAME)
            inode = info.st_ino
            self.assertEqual(stat.S_IMODE(info.st_mode), 0o600)
            self.assertEqual(info.st_nlink, 1)
            self.assertFalse(os.get_inheritable(lease.fileno()))
        with OperatorLease(self.directory) as lease:
            self.assertEqual(os.fstat(lease.fileno()).st_ino, inode)

    def test_second_independent_process_refuses(self):
        with OperatorLease(self.directory):
            self.contender()

    def test_same_process_second_descriptor_refuses(self):
        with OperatorLease(self.directory):
            with self.assertRaises(LeaseUnavailable):
                OperatorLease(self.directory)

    def test_parent_close_retains_inherited_child_lock(self):
        lease = OperatorLease(self.directory)
        descriptor = lease.fileno()
        child = self.child('import os;os.fstat(int(sys.argv[1]));print("ready",flush=True);sys.stdin.readline()',
                           [str(descriptor)], pass_fds=(descriptor,))
        self.ready(child)
        lease.close()
        self.contender()
        child.communicate('finish\n', timeout=10)
        self.assertEqual(child.returncode, 0)
        with OperatorLease(self.directory):
            pass

    def test_ordinary_child_does_not_accidentally_inherit_lock(self):
        lease = OperatorLease(self.directory)
        child = self.child('print("ready",flush=True);sys.stdin.readline()')
        self.ready(child)
        lease.close()
        with OperatorLease(self.directory):
            pass
        child.communicate('finish\n', timeout=10)

    def test_killed_lock_holder_releases_without_pid_cleanup(self):
        child = self.child('from operatorLease import OperatorLease;l=OperatorLease(sys.argv[1]);'
                           'print("ready",flush=True);sys.stdin.readline()', [self.directory])
        self.ready(child)
        self.contender()
        os.kill(child.pid, signal.SIGKILL)
        child.communicate(timeout=10)
        with OperatorLease(self.directory):
            pass

    def test_context_exception_releases_without_removing_inode(self):
        with self.assertRaises(ValueError):
            with OperatorLease(self.directory):
                raise ValueError('fictional')
        with OperatorLease(self.directory):
            pass

    def test_invalidation_retains_original_lock_and_stays_failed(self):
        lease = OperatorLease(self.directory)
        try:
            path = Path(self.directory) / lease._NAME
            os.chmod(path, 0o644)
            with self.assertRaises(LeaseUnavailable):
                lease.assert_held()
            os.chmod(path, 0o600)
            self.contender()
            with self.assertRaises(LeaseUnavailable):
                lease.assert_held()
        finally:
            lease.close()

    def test_replaced_lock_is_detected_and_not_repaired_or_deleted(self):
        with OperatorLease(self.directory) as lease:
            path = Path(self.directory) / lease._NAME
            os.rename(path, path.with_suffix('.retained'))
            path.touch(mode=0o600)
            inode = path.stat().st_ino
            with self.assertRaises(LeaseUnavailable):
                lease.assert_held()
        self.assertEqual(path.stat().st_ino, inode)
        self.assertTrue(path.with_suffix('.retained').exists())

    def test_replaced_directory_is_detected(self):
        nested = Path(self.directory) / 'private'
        nested.mkdir(mode=0o700)
        with OperatorLease(str(nested)) as lease:
            nested.rename(nested.with_name('retained'))
            nested.mkdir(mode=0o700)
            with self.assertRaises(LeaseUnavailable):
                lease.assert_held()

    def test_symlink_ancestor_refuses_before_lock_creation(self):
        actual = Path(self.directory) / 'private'
        actual.mkdir(mode=0o700)
        link = Path(self.directory) / 'redirect'
        link.symlink_to(actual, target_is_directory=True)
        with self.assertRaises(LeaseUnavailable):
            OperatorLease(str(link))
        self.assertEqual(list(actual.iterdir()), [])

    def test_unsafe_lock_types_and_modes_refuse_without_mutation(self):
        lock = Path(self.directory) / OperatorLease._NAME
        for kind in ['symlink', 'directory', 'fifo', 'hardlink', 'mode']:
            with self.subTest(kind=kind):
                target = Path(self.directory) / 'fictional-target'
                if kind in ('symlink', 'hardlink'):
                    target.touch(mode=0o600)
                    if kind == 'symlink':
                        lock.symlink_to(target)
                    else:
                        os.link(target, lock)
                elif kind == 'directory':
                    lock.mkdir(mode=0o700)
                elif kind == 'fifo':
                    os.mkfifo(lock, 0o600)
                else:
                    lock.touch(mode=0o644)
                    lock.chmod(0o644)
                before = lock.lstat()
                with self.assertRaises(LeaseUnavailable):
                    OperatorLease(self.directory)
                after = lock.lstat()
                self.assertEqual((before.st_ino, before.st_mode), (after.st_ino, after.st_mode))
                if kind == 'directory':
                    lock.rmdir()
                else:
                    lock.unlink()
                target.unlink(missing_ok=True)

    def test_invalid_paths_and_directory_modes_are_redacted(self):
        forbidden = ['relative/FICTIONAL_PRIVATE', self.directory + '/.',
                     self.directory + '//child', '/', self.directory + '/missing', None]
        for directory in forbidden:
            with self.assertRaises(LeaseUnavailable) as raised:
                OperatorLease(directory)
            self.assertEqual(str(raised.exception), 'Private operator lease unavailable.')
            self.assertTrue(raised.exception.__suppress_context__)
        os.chmod(self.directory, 0o755)
        with self.assertRaises(LeaseUnavailable):
            OperatorLease(self.directory)
        self.assertEqual(os.listdir(self.directory), [])

    def test_no_stdout_stderr_or_reactivation_after_close(self):
        stdout, stderr = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            lease = OperatorLease(self.directory)
            lease.close()
            lease.close()
            with self.assertRaises(LeaseUnavailable):
                lease.assert_held()
            with self.assertRaises(LeaseUnavailable):
                lease.fileno()
        self.assertEqual(stdout.getvalue() + stderr.getvalue(), '')

    def test_foreign_owner_refuses_before_creating_a_lock(self):
        wrong_uid = os.getuid() + 1
        with patch('operatorLease.os.getuid', return_value=wrong_uid):
            with self.assertRaises(LeaseUnavailable):
                OperatorLease(self.directory)
        self.assertEqual(os.listdir(self.directory), [])

    def test_close_failure_is_redacted_and_other_descriptor_still_closes(self):
        lease = OperatorLease(self.directory)
        close, called = os.close, []
        def fail_after_close(descriptor):
            close(descriptor)
            called.append(descriptor)
            if len(called) == 1:
                raise OSError('FICTIONAL_PRIVATE failure')
        with patch('operatorLease.os.close', side_effect=fail_after_close):
            with self.assertRaises(LeaseUnavailable) as raised:
                lease.close()
        self.assertEqual(str(raised.exception), 'Private operator lease unavailable.')
        self.assertEqual(len(called), 2)
        with OperatorLease(self.directory):
            pass


if __name__ == '__main__':
    unittest.main()
