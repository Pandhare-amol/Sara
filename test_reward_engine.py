import os
import sys
import uuid
import time
sys.path.insert(0, os.path.abspath("."))

from desktop_agent.main import execute, ExecuteRequest
from desktop_agent.sqlite_memory import data_root
from desktop_agent.reward_engine import RewardEngine

print("--- SARA REWARD ENGINE VERIFICATION TEST ---")

# Setup
reward_engine = RewardEngine()

# Test 1: Successful Task
print("\n[TEST 1] Testing Successful Task...")
req1 = ExecuteRequest(
    tool="saraMemoryRemember",
    args={
        "taskId": "task-success-123",
        "agent_id": "memory_agent",
        "kind": "fact",
        "content": "SARA learned to use the Reward Engine today."
    }
)
resp1 = execute(req1)
print(f"Tool Executed. OK: {resp1.ok}")
if resp1.result:
    print(f"Verification: {resp1.result.get('verification')}")
    print(f"Reward Outcome: {resp1.result.get('reward_outcome')}")
else:
    print("No result found!")

# Test 2: Intentionally Failed Task
print("\n[TEST 2] Testing Intentionally Failed Task...")
req2 = ExecuteRequest(
    tool="saraSecurityAssess", # Requires real action string, passing empty triggers error
    args={
        "taskId": "task-fail-456",
        "agent_id": "security_agent"
    }
)
resp2 = execute(req2)
print(f"Tool Executed. OK: {resp2.ok}")
if not resp2.ok:
    print(f"Error returned: {resp2.error}")
else:
    print(f"Verification: {resp2.result.get('verification')}")
    print(f"Reward Outcome: {resp2.result.get('reward_outcome')}")

# Now verify it hit the reward engine
stats = reward_engine.get_policy_stats()
key = "security_agent:saraSecurityAssess"
if key in stats:
    print(f"Policy Stats for {key}: {stats[key]}")

# Test 3: Policy Strategy Data
print("\n[TEST 3] Testing Policy Retrieval...")
req3 = ExecuteRequest(
    tool="saraRlSummary",
    args={"taskId": "task-summary-789", "agent_id": "orchestrator_agent"}
)
resp3 = execute(req3)
print(f"Tool Executed. OK: {resp3.ok}")
if resp3.result and "policy_stats" in resp3.result:
    print("Successfully retrieved Policy Stats:")
    for k, v in resp3.result["policy_stats"].items():
        print(f"  {k}: Success Rate {v['success_rate']*100:.1f}% ({v['successes']}/{v['total']})")

