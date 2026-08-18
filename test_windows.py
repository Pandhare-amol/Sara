import os
import sys
import time

sys.path.insert(0, os.path.abspath("."))
from desktop_agent.main import execute, ExecuteRequest

print("--- LIVE SCREEN & WINDOW MANAGEMENT TEST ---")

# Test 1: listWindows
req = ExecuteRequest(tool="listWindows", args={})
resp = execute(req)
print(f"listWindows: OK={resp.ok}")
if resp.ok:
    windows = resp.result.get("output", {}).get("windows", [])
    print(f"Found {len(windows)} visible windows.")
    # Print the first 3
    for w in windows[:3]:
        print(f" - {w['title']} (App: {w['application_name']})")

# Test 2: getActiveWindow
req = ExecuteRequest(tool="getActiveWindow", args={})
resp = execute(req)
print(f"\ngetActiveWindow: OK={resp.ok}")
if resp.ok:
    print(f"Result: {resp.result.get('output', {}).get('result')}")
    
# Test 3: focusWindow (let's try to focus "explorer" or "cmd")
req = ExecuteRequest(tool="focusWindow", args={"application": "explorer"})
resp = execute(req)
print(f"\nfocusWindow 'explorer': OK={resp.ok}")
if resp.ok:
    print(f"Result: {resp.result.get('output', {}).get('result')}")
    print(f"Verification: {resp.result.get('verification')}")

# Test 4: readScreen
req = ExecuteRequest(tool="readScreen", args={"max_chars": 50})
resp = execute(req)
print(f"\nreadScreen: OK={resp.ok}")
if resp.ok:
    print(f"Result: {resp.result.get('output', {}).get('result')}")
    meta = resp.result.get('output', {}).get('active_window', {})
    print(f"Active Window Meta: {meta}")

print("\nAll tests ran.")
