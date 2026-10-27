# Task for planner

[Read from: /Users/sab-mini/repos/dsh-pi/context.md]

You are a delegated subagent running from a fork of the parent session. Treat the inherited conversation as reference-only context, not a live thread to continue. Do not continue or answer prior messages as if they are waiting for a reply. Your sole job is to execute the task below and return a focused result for that task using your tools.

Task:
Produce a Pi Node Task Packet ledger for the DSH live-backbone canary. This is planning only, read-only. Canon: DSH is the canonical SessionEvent/control plane; agent-observability is a downstream projection; Sab owns completion. Desired terminal evidence: one real Pi-backed DSH session emits durable canonical events, preserves folded subagent lineage, executes one five-verb intervention through ControlPlaneManager, persists the audit receipt, and is ingested by agent-observability. Verified state: /Users/sab-mini/repos/dsh-pi main is clean, 4 commits ahead of origin, 90 tests/typecheck pass, upstream push returns HTTP 403; S0-S5 modules are exported but unused by src/index.ts apply(); ControlPlaneManager/audit and GuardrailMonitor are in-memory; control methods can return success without an actuator; ACP cancel audit outcome can diverge. In /Users/sab-mini/repos/agent-observability, DSH parser exists but default roots omit .dsh, live DB has zero DSH sessions, JSON-string tool arguments are dropped, subCalls flatten without parent identity, control outcome fields are lost, and SSE streams turns only. Split the mission into the smallest dependency-ordered packets; one writer per repo/worktree; include a publication-route gate, DSH integration design/readiness packet, DSH implementation packet, real runtime canary packet, projection-fidelity packet, ingestion verification packet, independent review, and Sab completion gate. Each packet needs id, outcome, depends_on, run route using live chains/agents, boundary/stop condition, checkpoint evidence, status, and milestone. Include authority, wave/concurrency table, verification commands, failure escalation, evidence roll-up, and exact ready frontier. Preserve positive framing and avoid selecting service ports or UI work. Return the ledger inline as YAML plus a concise rationale.

---
**Output:**
Write your findings to exactly this path: /Users/sab-mini/repos/dsh-pi/.pi-subagents/artifacts/outputs/51a7cea8/plan.md
This path is authoritative for this run.
Ignore any other output filename or output path mentioned elsewhere, including output destinations in the base agent prompt, system prompt, or task instructions.

## Acceptance Contract
Acceptance level: attested
Completion is not accepted from prose alone. End with a structured acceptance report.

Criteria:
- criterion-1: Return concrete findings with file paths and severity when applicable

Required evidence: review-findings, residual-risks

Finish with a fenced JSON block tagged `acceptance-report` in this shape:
Use empty arrays when no items apply; array fields contain strings unless object entries are shown.
`criteriaSatisfied[].status` must be exactly one of: satisfied, not-satisfied, not-applicable.
`commandsRun[].result` must be exactly one of: passed, failed, not-run.
`manualNotes` and `notes` are optional strings; an empty string means no note and does not satisfy `manual-notes` evidence.
```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "specific proof"
    }
  ],
  "changedFiles": [
    "src/file.ts"
  ],
  "testsAddedOrUpdated": [
    "test/file.test.ts"
  ],
  "commandsRun": [
    {
      "command": "command",
      "result": "passed",
      "summary": "short result"
    }
  ],
  "validationOutput": [
    "validation output or concise summary"
  ],
  "residualRisks": [
    "none"
  ],
  "noStagedFiles": true,
  "diffSummary": "short description of the diff",
  "reviewFindings": [
    "blocker: file.ts:12 - issue found, or no blockers"
  ],
  "manualNotes": "anything else the parent should know"
}
```