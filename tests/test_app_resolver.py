from desktop_agent.app_resolver import resolve_application


def test_resolve_common_apps():
    disp, exe = resolve_application("task manager")
    assert exe == "taskmgr.exe"
    disp2, exe2 = resolve_application("settings")
    assert exe2.startswith("ms-settings")
    disp3, exe3 = resolve_application("control panel")
    assert exe3 == "control.exe"
