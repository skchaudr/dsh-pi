# Task for scout

C00 follow-up, read-only. Find an executable deterministic Pi-backed DSH integration-test/canary path in /Users/sab-mini/repos/dsh-pi. Inspect existing tests and installed DSH test helpers for creating a real DSH Agent/Session, applying the dsh-pi plugin, registering a fake/local LlmAdapter, exercising one Pi-backed turn or extension lifecycle, registering a real ControlPlaneManager handle, and proving steer/abort acknowledgement with zero network/secrets. Produce exact test harness imports, setup sequence, command, timeout, expected events, and cleanup. Validate actual method names in control.ts and avoid invented CLI verbs. If a fully executable route is absent, state the smallest missing test seam. Do not edit or run provider calls.

---
**Output:**
Write your findings to exactly this path: /Users/sab-mini/repos/dsh-pi/.pi-subagents/artifacts/outputs/a65b46ce/context.md
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