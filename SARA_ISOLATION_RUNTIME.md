# SARA Isolation Runtime

The isolation runtime is a bounded execution boundary around the existing `ToolRouter`. It is not an AGI or ASI implementation, does not rewrite SARA's source code, and does not claim to produce novel science or intelligence beyond the configured models and tools.

## Current Runtime

`src/core/isolation/isolationRuntime.ts` implements:

1. Strategist input as a typed, finite tool plan.
2. Deterministic critic review before execution.
3. Existing `ToolRouter` as the only dispatch path.
4. Step-count limits.
5. Unknown-tool denial.
6. Direct interpreter-name denial (`shell`, `exec`, `eval`, and similar).
7. Confirmation requirements for destructive tools.
8. Sandbox-plus-confirmation requirements for code-writing and Python execution tools.
9. Stop-on-failure and required verification checks.

## Safe Mapping Of The Requested Concepts

| Requested concept | Safe SARA implementation |
|---|---|
| Zero-shot transfer | Retrieve relevant episodic/semantic/procedural memories and expose them to planning; no model retraining required. |
| Metacognition | Plan, deterministic critic review, policy decision, execution, observation, and verification. This is an auditable control loop, not a claim of consciousness. |
| Online learning | Existing persistent interaction, feedback, correction, episodic, and semantic memory services. |
| Self-healing runtime | Generate repair proposals and retry/replan through approved tools; never silently mutate source or claim success without verification. |
| Vector memory evolution | Existing RAG/embedding manager can be adapted behind a memory interface; do not add a competing vector store. |
| Multi-agent council | Strategist, critic, and executor roles are separate contracts; the executor remains the existing ToolRouter/Desktop Agent boundary. |
| Recursive self-improvement | Replace with reviewed, versioned improvement proposals requiring tests and human approval. No live self-modification. |

## Real Sandbox Requirement

The current `IsolationRuntime` is a policy and orchestration boundary, not a complete OS sandbox. Before enabling model-generated code execution, add a separate worker process/container with:

- dedicated temporary workspace;
- no inherited environment secrets;
- network disabled by default;
- read-only source mounts;
- CPU, memory, process, file-size, and wall-clock limits;
- an allowlisted Python standard-library/tool API;
- structured stdout/stderr/result limits;
- process-tree termination on timeout;
- human confirmation for filesystem or network side effects;
- audit logs and post-execution verification.

On Windows, use a restricted worker process plus Job Objects/AppContainer or an equivalent OS isolation mechanism. Do not treat `exec`, `spawn`, a Python virtual environment, or a prompt instruction as a security sandbox.

## Migration Boundary

The future LangGraph runtime should call `IsolationRuntime.execute()`, and `IsolationRuntime` should call the existing `ToolRouter`. It must not call Python handlers, browser implementations, filesystem APIs, or renderer code directly. This preserves the existing dispatch, policy, confirmation, verification, and Desktop Agent systems.