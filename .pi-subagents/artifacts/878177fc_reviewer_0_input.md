# Task for reviewer

[Read from: /Users/sab-mini/repos/dsh-pi/plan.md, /Users/sab-mini/repos/dsh-pi/progress.md]

Independently verify this DSH-C00 preflight against live source. Return READY or BLOCKED for the first two implementation packets, with exact corrections and the smallest ready frontier. Reject invented methods, unverified event vocabulary, unsafe fixture use, direct JSONL writes, and production DB writes.

SCOUT REPORT:

# Code Context

## Files Retrieved
1. `/Users/sab-mini/.pi/agent/sessions/--Users-sab-mini-repos-agent-observability--/2026-09-03T13-31-17-908Z_01a06777-7814-735b-9cea-c12c7e517afe.jsonl` (lines 1-55) - Authentic Pi parent session showing root session initiation, parallel subagent dispatch (`subagent` toolCall), async run handle (`38b52918-...`), subagent wait, child descriptors, and `subagent-notify` custom message.
2. `/Users/sab-mini/repos/dsh-pi/node_modules/@deepseek-ai/dsh-session/lib/index.js` (lines 1029-1060, 1303-1475, 1775-1800) - Session class, `append` implementation, canonical monotonic `seq` assignment, and storage record decoding.
3. `/Users/sab-mini/repos/dsh-pi/node_modules/@deepseek-ai/dsh-session/lib/types/known-event-types.js` (lines 15-70) - The generated 44-event catalog (`KNOWN_SESSION_EVENT_TYPES`), containing `subagent/descriptor` and omitting `control/intervention`.
4. `/Users/sab-mini/.config/deepseek-harness/packages/session/session-persistence/src/coordinator.ts` (lines 850-915, 1050-1070) - Persistence coordinator verification: `assertEventsSupported` enforces catalog check unless `event.ignorable === true`.
5. `/Users/sab-mini/.config/deepseek-harness/packages/session/session-persistence-jsonl/src/index.ts` (lines 20-80) and `src/format.ts` (lines 10-35) - JSONL backend configuration, directory resolution, `.jsonl.zstd` vs uncompressed `.jsonl` via `compression: 'none'`, and chunk row packing.

## Key Findings

### 1. Authentic Local Pi Parent Session
- **Path**: `/Users/sab-mini/.pi/agent/sessions/--Users-sab-mini-repos-agent-observability--/2026-09-03T13-31-17-908Z_01a06777-7814-735b-9cea-c12c7e517afe.jsonl`
- **SHA-256**: `30c38c589335f8625f04416f187f035614a48d43939cc1387f403279464c1d8f`
- **Size**: 556,102 bytes (158 records).
- **Exact Event Sequence**:
  - Line 1: `session` (`id: "01a06777-7814-735b-9cea-c12c7e517afe"`, `cwd: "/Users/sab-mini/repos/agent-observability"`).
  - Line 49: `message` (`role: "assistant"`, `toolCall name: "subagent"`, `workflowScript: "const results=await runs.all([...]);"`).
  - Line 50: `message` (`role: "toolResult"`, `toolName: "subagent"`, `details.mode: "workflow"`, `details.runId: "38b52918-6cc0-43fe-ae17-a855979e066b"`).
  - Line 51: `message` (`role: "assistant"`, `toolCall name: "subagent_wait"`).
  - Line 52: `message` (`role: "toolResult"`, `toolName: "subagent_wait"`, child run IDs `442aea0f`, `107d1d79`, `5f08d673`).
  - Line 53: `custom_message` (`customType: "subagent-notify"`, background workflow completion).
- **Privacy/Sanitization Requirement**: Redact user paths (`/Users/sab-mini`), developer commit SHAs, and model reasoning trace signatures (`thinkingSignature`, encrypted content tokens).

### 2. DSH Persistence Adapter & Compression
- **Path Layout**: `<root>/<sanitized-project-dir>/<session-id>/session.jsonl.zstd` (under `~/.dsh/sessions/`).
- **Forcing Uncompressed Plaintext**: Configure `session-persistence-jsonl` with `{ compression: 'none', packChunks: false }` to write `.jsonl` directly.
- **Decoding Zstd**: Use CLI `zstd -dc <path>` or `@deepseek-ai/dsh-session-persistence-jsonl` decoder helpers (`decompressZstdFrame`).
- **Flush & Reload**: Flush is triggered via `sessionStore.flush(session)` -> Cordis `'session/flush'`, writing dirty buffers. Reload runs through `PersistenceCoordinator.prepareSession(id)` calling `backend.loadStored(id)` and `Session.fromRestore()`.

### 3. Custom Event Catalog & Alternatives
- `subagent/descriptor` is present in `KNOWN_SESSION_EVENT_TYPES`.
- `control/intervention` is absent. `Session.append` permits it in memory, but on disk reload `PersistenceCoordinator.assertEventsSupported()` will reject the entire session with `SessionFormatUnsupportedError` unless marked `ignorable: true`.
- **Supported Alternative**: Provide `ignorable: true` in the event record, or wrap intervention events under known catalog types like `hook/invoked` or `tool-workflow/run-start`.

### 4. Sequence Mapping & Allocation
- `Session.append` automatically allocates canonical monotonic `seq = this.log.length`.
- Source sequence numbers are preserved through the optional surface metadata parameter `opts[0].sourceEventSeqs` (e.g. `s.append(type, data, { sourceEventSeqs: [sourceSeq] })`), or stored inside payload `data`.

## Start Here
Start with `/Users/sab-mini/.config/deepseek-harness/packages/session/session-persistence/src/coordinator.ts` to inspect the event admission and replay validation rules (`assertEventsSupported`).

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