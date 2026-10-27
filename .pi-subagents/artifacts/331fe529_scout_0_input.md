# Task for scout

Execute read-only DSH-C00 preflight for DSH-CANARY-01. Across /Users/sab-mini/repos/dsh-pi, /Users/sab-mini/repos/agent-observability, installed @deepseek-ai/dsh-session persistence sources, and local Pi session logs: (1) identify one authentic local Pi parent session containing a real subagent dispatch/lineage event sequence suitable for a local test fixture; report path, SHA-256, exact event types/fields, and any privacy/sanitization requirement without copying data; (2) prove the configured DSH persistence adapter path, compression, flush, and reload APIs, including how tests can force readable uncompressed JSONL or decode zstd; (3) determine whether custom event types control/intervention and subagent/descriptor can be appended and replayed under the generated known-event catalog, with an exact supported alternative if rejected; (4) state how translated source seq becomes source metadata while Session.append allocates canonical seq; (5) provide exact commands and pass/fail gates. No mutations, no secret reads, no provider calls. Cite exact files/lines.

---
**Output:**
Write your findings to exactly this path: /Users/sab-mini/repos/dsh-pi/.pi-subagents/artifacts/outputs/331fe529/context.md
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