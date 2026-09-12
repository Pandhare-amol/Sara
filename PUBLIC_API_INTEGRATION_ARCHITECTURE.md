# Public API Integration Architecture

## Summary

This repository already contains a real runtime architecture for tool execution and orchestration. The correct integration point for public APIs is not a parallel tool system or a wholesale rewrite of the existing SARA tool pipeline. Instead, public APIs should be treated as a bounded discovery and capability layer that plugs into the existing tool registry, router, policy engine, and verification flow.

The implementation respects the actual ownership boundaries already present in the codebase:

- The execution runtime is owned by the SARA tool layer under `src/core/tools`.
- The desktop automation layer is owned by the Desktop Agent runtime and remains the source of truth for local side-effect execution.
- The API layer under `src/core/api` is the correct place for catalog discovery and safe capability registration.
- Gemini or external orchestration may propose tools, but the runtime policy and router are still the enforcement gate.

## Audited runtime architecture

### 1. Tool registration and routing

The central Node boundary is:

- `src/core/tools/toolRegistry.ts`
- `src/core/tools/toolRouter.ts`

These give SARA a runtime registry for tool metadata, risk classification, and route ownership. The registry is lightweight and intentionally compatibility-focused. It does not replace the Desktop Agent; it describes the Node-side routing boundary and supports policy enforcement.

The router is the gateway that:

- resolves a tool name to a registered route,
- auto-registers a known runtime tool when legitimate,
- evaluates policy before execution,
- normalizes execution results into the canonical SARA contract,
- passes execution to the configured adapter.

This is the correct place to enforce “known runtime tool” checks without duplicating tool owners.

### 2. Execution orchestration

The runtime lifecycle is coordinated by:

- `src/core/tools/execution/executionOrchestrator.ts`
- `src/core/tools/execution/unifiedExecutionResult.ts`

This orchestrator owns the phases:

1. Policy evaluation
2. Tool execution
3. Verification
4. Final status determination

The final result is intentionally normalized through the repo’s unified execution contract, not a separate new execution model.

### 3. Verification

The verification layer is in:

- `src/core/tools/verification/verificationRegistry.ts`
- `src/core/tools/verification/filesystemVerifier.ts`

This verifies that observed state matches intent. It is independent from execution and is designed to be used by the orchestrator as a postcondition check.

### 4. API integration layer

The API layer under `src/core/api` contains the safe extension points for providers and discovery. The public API work should live here rather than in a parallel top-level tool system. In particular:

- `ApiDiscovery.ts` is the discovery entry point.
- `publicApiCatalog.ts` is the catalog manager for curated public API metadata and selection logic.

This layer should validate entries, rank candidates, enforce safe-to-use policy, and keep results inside the canonical tool result contract when a tool-like execution is required.

## Why a parallel architecture is incorrect

A parallel architecture would duplicate ownership and create conflicting execution paths:

- duplicate tool registration,
- inconsistent status semantics,
- policy bypass risk,
- divergent verification rules,
- difficult debugging and audits.

SARA already has a real execution lifecycle. The new public API integration must extend that lifecycle instead of replacing it.

## Correct integration pattern

### A. Catalog manager boundary

The public API catalog manager is a local, bounded discovery and validation system.

It should:

- validate entry shape,
- reject malformed or disabled APIs,
- rank candidates by intent and trust signals,
- enforce risk restrictions and side-effect safety,
- normalize failures into the repo’s canonical result contract.

It must not auto-create every public API as a Gemini tool.

### B. Tool routing boundary

The tool router remains the runtime enforcement boundary.

A public API is not automatically a SARA tool unless it is intentionally registered as a known runtime tool with metadata, risk classification, and policy constraints. Otherwise, it remains a catalog candidate or a capability descriptor rather than an executable tool.

This preserves the policy model and avoids exposing every external API endpoint as an unreviewed tool.

### C. Verification boundary

Public-API actions should still pass through the same verification rules already used by the runtime. If a public API action is turned into a tool-like action, it must produce the canonical tool contract and must be subject to the same execution / verification lifecycle as other tools.

## Safe implementation constraints

The integration must obey these rules:

1. Reuse the existing SARA architecture and ownership model.
2. Keep the public API catalog local and intentionally curated.
3. Do not convert each public API into a Gemini function or tool by default.
4. Preserve the canonical contract for execution and verification results.
5. Keep policy enforcement before runtime execution.
6. Use the Desktop Agent and tool router as the source of truth for local side-effect execution.

## Resulting model

The final architecture is:

- Public API catalog = discovery and capability layer
- Tool registry = runtime route metadata and ownership
- Tool router = policy gate and routing execution
- Execution orchestrator = lifecycle execution + verification
- Verification registry = postcondition checks
- Desktop Agent = actual local side-effect owner for OS/browser/file automation

This is the safe architecture that keeps SARA intact while allowing public API discovery and selection to coexist with the existing runtime model.
