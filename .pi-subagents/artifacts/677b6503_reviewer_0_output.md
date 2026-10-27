**Binary verdict: NOT READY for implementation.**

## Review
- Correct: Durable adapter is `@deepseek-ai/dsh-session-persistence-jsonl`; canonical storage is `<DSH_HOME>/sessions/<projectSlug>/<sessionId>/session.jsonl[.zst]`, with header then session events and default Zstandard compression.
- Correct: Persistence uses `ctx.emit('session/event', session, event)` and the durability barrier `ctx.emit('session/flush', session)`.
- Correct: Actual control methods include `registerSession`, `unregisterSession`, `steer`, `abort`, and `getAuditHistory` (`src/control.ts:112+`).
- Blocker: `plan.md` and `progress.md` do not exist at the required repository paths, so C00 scope and acceptance state cannot be verified.
- Blocker: No `src/__tests__/canary.test.ts` exists; the supplied verification command is therefore not currently executable.
- Blocker: The proposed canary manually registers `ControlPlaneManager`; production `src/index.ts` only exports it and does not register/unregister agent sessions.
- Blocker: The canary neither loads the JSONL persistence adapter nor emits, flushes, and reads a persisted canonical session artifact.
- Blocker: `setImmediate` is not the established mount barrier; `src/__tests__/index.test.ts:119-126` awaits `systemPrompt.assemble`.
- Note: `package.json` has no `@deepseek-ai/dsh-agent-loop`, confirming the proposed harness is mock-backed rather than a concrete loop integration.