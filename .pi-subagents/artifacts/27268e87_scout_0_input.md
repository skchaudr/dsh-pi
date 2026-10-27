# Task for scout

C00-B read-only executable preflight across /Users/sab-mini/repos/dsh-pi and /Users/sab-mini/repos/agent-observability. Determine a real, deterministic, bounded Pi-backed DSH canary launch path: available dsh CLI/profile commands; temporary DSH_HOME/data/profile setup; local or fake provider options requiring no paid provider or secrets; exact way to create a known session and one real steer/abort acknowledgement; timeout and cleanup; AGENT_OBS_DB override into a temporary SQLite DB; exact ingest/query commands; and hashing proof production DB stays unchanged. Verify available binaries and current package scripts. Cite commands and mark any unresolved capability. Do not execute paid work, mutate profiles, or edit files.

---
**Output:**
Write your findings to exactly this path: /Users/sab-mini/repos/dsh-pi/.pi-subagents/artifacts/outputs/27268e87/context.md
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