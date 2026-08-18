import types
import pytest

from desktop_agent.verification import VerificationEngine


def test_open_application_verified_by_psutil(monkeypatch):
    ve = VerificationEngine()

    fake_proc = types.SimpleNamespace(info={'name': 'taskmgr.exe', 'exe': 'C:\\Windows\\System32\\taskmgr.exe'})

    def fake_iter(attrs):
        yield fake_proc

    monkeypatch.setattr('psutil.process_iter', lambda attrs: fake_iter(attrs))

    record = ve.verify_task('t1', 'agent1', 'openApplication', result={}, args={'name': 'taskmgr'})
    assert record['verification_status'] == 'VERIFIED'
    assert 'processes' in record['observed']


def test_close_window_verified_when_not_present(monkeypatch):
    ve = VerificationEngine()

    # Monkeypatch tools_windows.list_windows to return no matching windows
    def fake_list_windows(args):
        return {'result': 'Found 0 visible windows.', 'windows': []}

    import desktop_agent.tools_windows as tw
    monkeypatch.setattr(tw, 'list_windows', fake_list_windows)

    record = ve.verify_task('t2', 'agent1', 'closeWindow', result={}, args={'title': 'Task Manager'})
    # if no windows found, verification should be VERIFIED
    assert record['verification_status'] == 'VERIFIED'