# Code Context

## Files Retrieved
1. `/Users/sab-mini/repos/dsh-pi/package.json` (lines 1-75) - Package configuration, dependencies (`@earendil-works/pi-coding-agent`, `@deepseek-ai/*`), and verification scripts (`check`, `test`, `compat`).
2. `/Users/sab-mini/repos/dsh-pi/src/control.ts` (lines 1-366) - Backend for 5 control plane verbs: `abort`, `steer`, `annotate`, `reassign`, `respawn` with audit logs and events.
3. `/Users/sab-mini/repos/dsh-pi/src/acp-mirror.ts` (lines 1-203) - ACP session mirroring and event synthesis (`session_start`, `steer_accepted`, `abort_acknowledged`).
4. `/Users/sab-mini/repos/dsh-pi/src/guardrails.ts` (lines 1-191) - Guardrail metrics monitor (TTFT, cost, cache tracking).
5. `/Users/sab-mini/repos/agent-observability/pyproject.toml` (lines 1-45) - Python CLI configuration for `agent-obs`.
6. `/Users/sab-mini/repos/agent-observability/src/agent_obs/core/paths.py` (lines 1-60) - Default database path logic and `AGENT_OBS_DB` override handling.
7. `/Users/sab-mini/repos/agent-observability/src/agent_obs/cli.py` (lines 1-100) - CLI options supporting `--db` and `AGENT_OBS_DB`.

## Key Code & Commands

### 1. Binaries and Package Scripts
- **Binaries verified**:
  - `dsh`: `/Users/sab-mini/.local/bin/dsh`
  - `pi`: `/Users/sab-mini/.pi/agent/bin/pi`
  - `node`: `/opt/homebrew/bin/node`
  - `pnpm`: `/opt/homebrew/bin/pnpm`
  - `agent-obs`: `/Users/sab-mini/repos/agent-observability/.venv/bin/agent-obs`
- **Verification commands**:
  - In `dsh-pi`: `pnpm check` (runs `vitest run`, `tsc --noEmit`, and `tsc -p tsconfig.build.json`)
  - In `agent-observability`: `/Users/sab-mini/repos/agent-observability/.venv/bin/pytest tests`

### 2. Isolated Environment Setup (Canary DSH & Agent-Obs)
To guarantee zero mutations to user profiles, credentials, and production databases:
```bash
# Set isolated sandbox dirs
export CANARY_DIR=$(mktemp -d /tmp/dsh-canary-XXXXXX)
export DSH_HOME="${CANARY_DIR}/dsh_home"
export AGENT_OBS_DB="${CANARY_DIR}/agent-obs-canary.db"
mkdir -p "${DSH_HOME}/profiles/canary" "${DSH_HOME}/sessions"
```

### 3. Fake/Local Provider & Cordis Patch (No Paid APIs or Secrets)
Canary execution uses a dummy mock provider or dry-run configuration in `cordis.patch.yml`:
```yaml
- id: system-prompt
  config:
    persona: "Mock test agent"
- insert:
    - id: dsh-pi
      name: 'dsh-pi-host'
      config:
        extensions: []
        projectTrusted: false
        allowLocalPaths: false
        strict: true
```
Launch via:
```bash
dsh --profile canary --dump-config
# Or run with ACP stdio interface in isolated headless/acp mode
dsh acp --help
```

### 4. Known Session Creation & Steer / Abort Acknowledgement
Using `src/control.ts` and `src/acp-mirror.ts` interfaces:
- Session created with ID e.g. `session-canary-001`.
- Execute verb `steer` via `ControlPlaneManager.steerSession("session-canary-001", { directive: "stop test" })`.
- Execute verb `abort` via `ControlPlaneManager.abortSession("session-canary-001", { reason: "preflight-test" })`.
- Returns recorded event types: `steer_accepted` and `abort_acknowledged` in session event logs.

### 5. Ingestion, Queries, and Production DB Protection
- **Pre-execution hash capture**:
  ```bash
  shasum -a 256 ~/.local/share/agent-obs/agent-obs.db > /tmp/prod_db_pre.sha256
  ```
- **Canary ingestion into temporary DB**:
  ```bash
  /Users/sab-mini/repos/agent-observability/.venv/bin/agent-obs --db "${AGENT_OBS_DB}" ingest "${DSH_HOME}/sessions"
  /Users/sab-mini/repos/agent-observability/.venv/bin/agent-obs --db "${AGENT_OBS_DB}" list
  /Users/sab-mini/repos/agent-observability/.venv/bin/agent-obs --db "${AGENT_OBS_DB}" stats
  ```
- **Post-execution hash verification**:
  ```bash
  shasum -a 256 -c /tmp/prod_db_pre.sha256
  ```
- **Cleanup**:
  ```bash
  rm -rf "${CANARY_DIR}" /tmp/prod_db_pre.sha256
  ```

## Architecture
- `dsh-pi-host` acts as a Cordis plugin for DSH profiles, wrapping Pi extensions and lifecycle handlers.
- `ControlPlaneManager` handles `abort`, `steer`, `annotate`, `reassign`, and `respawn` events without requiring external model API calls.
- `agent-observability` reads sessions and events via `agent_obs.cli`, parameterized completely by `AGENT_OBS_DB` and custom roots/paths.

## Start Here
Open `src/control.ts` and `src/acp-mirror.ts` to see exact event payloads and verification steps for steer/abort verbs.
