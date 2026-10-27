# Node Task Packet Ledger: DSH Live-Backbone Canary

## 1. Plan Overview & Canon

```yaml
plan_id: DSH-CANARY-01
shape: pipeline
problem: >
  DSH contains tested modular implementations for S0-S5 (lineage folding, canonical event ingest, 5-verb control, guardrails, ACP mirror) that remain unmounted in the active runtime, while agent-observability omits DSH from default discovery roots and drops structured tool arguments.
goal: >
  Execute one verified Pi-backed DSH session that emits durable canonical SessionEvents with folded subagent lineage, executes a five-verb control intervention through ControlPlaneManager, persists the audit receipt, and ingests into agent-observability with high-fidelity tool and control metadata.
sources:
  - /Users/sab-mini/repos/dsh-pi/src/index.ts
  - /Users/sab-mini/repos/dsh-pi/src/control.ts
  - /Users/sab-mini/repos/dsh-pi/src/ingest.ts
  - /Users/sab-mini/repos/dsh-pi/src/trajectory.ts
  - /Users/sab-mini/repos/dsh-pi/src/acp-mirror.ts
  - /Users/sab-mini/repos/agent-observability/src/agent_obs/parsers/dsh_projection.py
  - /Users/sab-mini/repos/agent-observability/src/agent_obs/core/paths.py
authority:
  execution: Pi orchestrator dispatches ordinary task packets.
  external: Sab authorizes remote repository configuration and publishing.
  completion: Sab verifies the evidence bundle and confirms milestone completion.
```

---

## 2. Milestones

- **M1 — Architecture & Readiness**: Resolve upstream publishing route and deliver exact integration specification for DSH runtime hooks and control actuation.
- **M2 — Implementation & Projection Fidelity**: Mount S0-S5 in `dsh-pi/src/index.ts` with durable disk emission and real actuators; update `agent-observability` parser and roots to preserve tool arguments, parent call lineage, and intervention outcomes.
- **M3 — Canary Execution & Ingestion**: Run a live Pi session through DSH, steer or abort it via `ControlPlaneManager`, persist the audit receipt, and ingest the stream into `agent-obs.db`.
- **M4 — Verification & Governance**: Independent adversarial contract review across both repositories, followed by Sab terminal milestone acceptance.

---

## 3. Node Task Packets (NTPs)

```yaml
packets:
  - id: DSH-W01A
    title: Resolve DSH Upstream Publication Route
    outcome: >
      Configure an authorized git remote for /Users/sab-mini/repos/dsh-pi (such as personal fork skchaudr/dsh-pi or updated SSH upstream) that preserves the four local commits (7be47d5, 23c93e3, 3d0e5a6, d96122b) and enables push operations.
    depends_on: []
    run: human:sab-publication-route
    boundary: >
      Git remote configuration and push authorization only. Keep existing commit tree intact. Stop if any destructive rewrite of existing commits is proposed.
    checkpoint:
      evidence: Remote configuration verified via `git remote -v` and push test output.
      verify: Git tracking branch resolves to an authorized remote with zero rejected pushes.
    milestone: M1
    gate: Sab selects and authorizes the fork or upstream remote target.
    status: ready

  - id: DSH-W01B
    title: DSH Runtime Lifecycle Integration Specification
    outcome: >
      Produce an exact implementation blueprint detailing how src/index.ts apply() connects Pi session events to streamPiEventsToDsh, selects the persistent session directory, registers live session handles into ControlPlaneManager, and aligns ACP cancel audit outcomes with real control results.
    depends_on: []
    run: chain:contract-scout
    boundary: >
      Read-only analysis in /Users/sab-mini/repos/dsh-pi. Stop if Cordis lifecycle hooks or DSH agent event APIs diverge from verified source interfaces.
    checkpoint:
      evidence: .pi-subagents/artifacts/dsh-runtime-integration-spec.md
      verify: File exists, cites exact line numbers, and details required Cordis listeners and file append targets.
    milestone: M1
    status: ready

  - id: DSH-W02A
    title: Wire DSH Event Ledger and Actuated Control Plane
    outcome: >
      Mount S0-S5 inside dsh-pi/src/index.ts apply(): stream raw events to canonical SessionEvents, persist events and ControlAuditEvents to disk, bind active agent abort/steer callbacks to ControlPlaneManager handles, and harmonize ACP mirror cancel outcomes.
    depends_on:
      - DSH-W01A
      - DSH-W01B
    run: chain:implement-verified
    boundary: >
      Source files in /Users/sab-mini/repos/dsh-pi (src/index.ts, src/control.ts, src/acp-mirror.ts, src/__tests__/*). Keep agent-observability read-only. Stop if any of the 90 pre-existing tests fail.
    checkpoint:
      evidence: Clean run of `./node_modules/.bin/vitest run` and `./node_modules/.bin/tsc -p tsconfig.json --noEmit` with new lifecycle and persistence tests.
      verify: Vitest reports all suites passing; new tests verify session event append and control handle actuation.
    milestone: M2
    status: held

  - id: DSH-W02B
    title: Upgrade DSH Projection Parser and Default Discovery Roots
    outcome: >
      Update agent-observability to include .dsh session directories in default_roots(), parse stringified JSON tool arguments in dsh_projection.py, record parent_call_id for recursive subCalls in ToolCall, and preserve complete intervention audit details in session metadata.
    depends_on:
      - DSH-W01B
    run: chain:implement-verified
    boundary: >
      Source files in /Users/sab-mini/repos/agent-observability (src/agent_obs/parsers/dsh_projection.py, src/agent_obs/core/paths.py, src/agent_obs/core/models.py, tests/test_dsh_projection.py). Keep dsh-pi read-only. Stop if any of the 77 pre-existing tests fail.
    checkpoint:
      evidence: Clean run of `.venv/bin/pytest -q` with regression tests for JSON-string arguments, parent call tracking, and intervention metadata.
      verify: Pytest reports 100% pass rate; new unit tests verify parser retention of arguments and subCall hierarchy.
    milestone: M2
    status: held

  - id: DSH-W03A
    title: Execute Real Pi-Backed DSH Session Canary with Steering
    outcome: >
      Run an end-to-end execution session using the integrated DSH harness and a live Pi agent, emit canonical SessionEvents with folded subagent subCalls to disk, execute one five-verb intervention (steer or abort) via ControlPlaneManager, and write the immutable audit receipt.
    depends_on:
      - DSH-W02A
    run: direct
    boundary: >
      Dedicated canary directory in ~/.dsh/sessions/canary-backbone/. Stop on unhandled runtime exception, missing event output file, or process hang.
    checkpoint:
      evidence: Persisted canary JSONL event stream containing canonical turn, tool, subCall, and control/intervention records.
      verify: Inspect JSONL records confirming presence of `tool/call` with `subCalls` and `control/intervention` with `outcome: "success"`.
    milestone: M3
    status: held

  - id: DSH-W03B
    title: Ingest Canary Session and Validate SQLite Projection
    outcome: >
      Ingest the canary event log into agent-observability using `agent-obs ingest --path <canary_path>`, verifying that SQLite stores the new DSH session, preserves turn sequences, retains tool call arguments, establishes parent-child relationships, and records the intervention audit.
    depends_on:
      - DSH-W02B
      - DSH-W03A
    run: chain:contract-scout
    boundary: >
      Read-only query of ~/.local/share/agent-obs/agent-obs.db and verification of ingest exit status. Stop if ingest returns non-zero exit or leaves session tables unpopulated.
    checkpoint:
      evidence: .pi-subagents/artifacts/canary-ingest-validation.json
      verify: File confirms session row presence, non-empty tool call arguments, positive parent_call_id associations, and intervention metadata.
    milestone: M3
    status: held

  - id: DSH-W04A
    title: Cross-Repo Contract and Invariant Audit
    outcome: >
      Perform an independent adversarial audit across dsh-pi and agent-observability verifying single-writer ledger authority in DSH, absence of dual-ledger drift, complete audit trail preservation, and test regression coverage.
    depends_on:
      - DSH-W03B
    run: chain:parallel-review
    boundary: >
      Read-only inspection of git diffs, test logs, and canary artifacts across both repositories. Stop on discovery of unmitigated data loss or contract divergence.
    checkpoint:
      evidence: .pi-subagents/artifacts/backbone-canary-review-findings.md
      verify: Review report confirms spec adherence, zero critical blockers, and verifiable artifact paths.
    milestone: M4
    status: held

  - id: DSH-W04B
    title: Sab Terminal Review and Milestone Acceptance
    outcome: >
      Sab reviews the complete evidence bundle (canary log, audit receipt, SQLite queries, test receipts, and review findings) and records formal completion of the live-backbone canary milestone.
    depends_on:
      - DSH-W04A
    run: human:sab-completion-decision
    boundary: >
      Applies exclusively to the live-backbone canary milestone.
    checkpoint:
      evidence: Completion record in daily memory (~/.pi/agent/memory/2026-09-03.md).
      verify: Verified record created with terminal approval timestamp and next milestone resume pointer.
    milestone: M4
    status: held
```

---

## 4. Wave & Concurrency Table

| Wave | Packet ID | Scope / Target | Route | Writer Isolation / Concurrency |
| :--- | :--- | :--- | :--- | :--- |
| **Wave 1** | `DSH-W01A` | Remote publishing authorization | `human:sab-publication-route` | Isolated to git remote config; non-interfering. |
| **Wave 1** | `DSH-W01B` | `dsh-pi` lifecycle specification | `chain:contract-scout` | Read-only analysis; runs concurrently with W01A. |
| **Wave 2** | `DSH-W02A` | `dsh-pi` core wiring & actuators | `chain:implement-verified` | Writer isolated to `/Users/sab-mini/repos/dsh-pi`. |
| **Wave 2** | `DSH-W02B` | `agent-observability` projection parser | `chain:implement-verified` | Writer isolated to `/Users/sab-mini/repos/agent-observability`. Runs concurrently with W02A. |
| **Wave 3** | `DSH-W03A` | Live DSH canary execution | `direct` | Execution isolated to canary session path. |
| **Wave 3** | `DSH-W03B` | `agent-obs` canary ingestion | `chain:contract-scout` | Read-only database query & ingest check. |
| **Wave 4** | `DSH-W04A` | Cross-repo adversarial review | `chain:parallel-review` | Read-only inspection across both worktrees. |
| **Wave 4** | `DSH-W04B` | Sab milestone disposition | `human:sab-completion-decision` | Human decision; terminal milestone gate. |

---

## 5. Verification Commands & Acceptance Gates

### DSH Repository Gate (`/Users/sab-mini/repos/dsh-pi`)
```bash
./node_modules/.bin/vitest run
./node_modules/.bin/tsc -p tsconfig.json --noEmit
./node_modules/.bin/tsc -p tsconfig.build.json
```
*Expected evidence*: 13+ test suites passing (including new lifecycle/actuator suites), zero TypeScript diagnostic errors.

### Agent Observability Gate (`/Users/sab-mini/repos/agent-observability`)
```bash
.venv/bin/pytest -q
git status --short
```
*Expected evidence*: 77+ tests passing (including stringified arguments, `parent_call_id`, and intervention details), zero uncommitted unstaged modifications outside the packet scope.

### Canary Verification Command
```bash
# 1. Verify event stream has turn, subcall, and intervention records
grep '"type":"control/intervention"' ~/.dsh/sessions/canary-backbone/events.jsonl
grep '"subCalls"' ~/.dsh/sessions/canary-backbone/events.jsonl

# 2. Ingest and query SQLite
uv run agent-obs ingest --path ~/.dsh/sessions/canary-backbone/events.jsonl
uv run agent-obs show <canary-session-id>
sqlite3 ~/.local/share/agent-obs/agent-obs.db "SELECT id, agent_type, status FROM sessions WHERE id = '<canary-session-id>';"
sqlite3 ~/.local/share/agent-obs/agent-obs.db "SELECT id, tool_name, parent_call_id FROM tool_calls WHERE session_id = '<canary-session-id>';"
```
*Expected evidence*: Ingestion succeeds, SQLite returns session with `agent_type = 'dsh'`, tool calls contain parsed arguments and parent IDs, and control interventions appear in session turns/metadata.

---

## 6. Failure Escalation Matrix

| Failure Mode | Detection Point | Escalation Action |
| :--- | :--- | :--- |
| **Upstream remote rejects push** | `DSH-W01A` | Pause dependent implementation; prompt Sab for personal fork URL or access key authorization. |
| **Cordis lifecycle mismatch** | `DSH-W01B` / `DSH-W02A` | Stop code mutation; inspect runtime Cordis context bindings; revise integration specification. |
| **Existing test regressions** | `DSH-W02A` or `DSH-W02B` | Revert failing diff; isolate root cause before proceeding. Maintain green suite invariant. |
| **DSH session fails to emit events** | `DSH-W03A` | Halt canary; capture process logs; inspect event stream hook bindings in `src/index.ts`. |
| **SQLite projection drops tool arguments** | `DSH-W03B` | Block milestone completion; dispatch fix worker to `dsh_projection.py` to refine JSON payload unwrapping. |
| **Dual-ledger drift detected** | `DSH-W04A` | Escalate to Sab; audit all event paths to verify DSH remains single source of truth. |

---

## 7. Evidence Roll-up & Terminal Completion

The terminal evidence bundle submitted to Sab for `DSH-W04B` contains:
1. Git commit hashes across both repositories (`dsh-pi` and `agent-observability`).
2. Vitest and Pytest command outputs proving 100% test pass rates.
3. Raw canary `events.jsonl` file path and cryptographic hash.
4. SQLite inspection output demonstrating populated session, turn, tool call (with parent ID), and intervention records.
5. Signed adversarial review report (`backbone-canary-review-findings.md`).
6. Proposed daily memory update for `~/.pi/agent/memory/2026-09-03.md`.

---

## 8. Exact Ready Frontier

The following two packets have zero unsatisfied dependencies and are ready for immediate dispatch:
1. **`DSH-W01A`**: Resolve DSH upstream publication route (Route: `human:sab-publication-route`).
2. **`DSH-W01B`**: DSH runtime lifecycle integration specification (Route: `chain:contract-scout`).