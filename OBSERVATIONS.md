# ui-bridge-fix observations

- Fix lives in `src/ui-publisher.ts` (pure, tested) wired in `src/index.ts` `publishUi`. `ui-bridge.ts` unchanged (it still publishes everything; policy is in the publisher).
- status/widget: keyed replace-in-place state (`mounted.uiState()`), debug-logged only if logger has `debug`. No DSH custom session event / badge surface was found for plugins (Session.append is typed per known event), so there is NO web UI rendering of status yet. Latest state is retrievable but not displayed.
- warning/error notify + unsupported errors: buffered, deduped by digit-stripped text, flushed once at `turn/end` (or next macrotask if idle) as `agent.send(msg, 'next-turn', false)` (signature verified in runtime-types.ts). Model sees it next turn; transcript shows one user message.
- info notify is dropped (not in transcript, not in state).
- hasUI: NOT changed (dialogs need hasUI=true). pi-warden advise branch is `ctx.hasUI && config.notices ? notify : steer-if-!hasUI`; with `notices:false` (default) it never calls notify, so advise stays silent regardless of this fix. Mitigation: set pi-warden `notices: true` (now safe, coalesced). Not verified against pi-warden source/runtime here.
- Edge: warnings raised mid-turn arrive at next turn, not the next step. Using 'next-step' would reach the model sooner; left as per spec.
- Widget-factory fallback text (level warning) is silent: it carries no information.

## Review fixes
- Info notify: delivered as a non-waking message when agent is idle (user command output, e.g. /warden); during a turn it is kept in state (cap 20), logged via logger.info, and rides along (low priority) when a warning summary is sent. In-turn info with no warnings is never a message (state+log only).
- Dedupe is exact text with an (xN) count; digit-stripping removed.
- Warning-level widget fallbacks are announced once per distinct text, then state only.
- Notices are flushed on dispose and on stale turn/end (delivery bypasses the disposing guard).

## Web-UI badge (piUi)

- Hawk footer status and warden widgets stay replace-in-place. Each change appends one whole `pi-ui/state` snapshot (`ignorable: true`). The `piUi` projection folds that event. The web client reads it with `useProjection('piUi')` in `conversation.session.header.utilities`.
- Do hawk/warden events written as durable domain events show in the transcript? No. `goal/change` is the precedent: it is a known log-only event, not an append-surface event. The chat fallback (`packages/client/ui-chat/src/client/conversation-nodes/fallback.ts`) renders a row only when `isAppendSurfaceEvent` is true, which requires `user/message`, `assistant/message`, `tool/result`, `system/message`, or `developer/message` with `surfaceOp: 'append'`. `goal/change` never becomes a transcript row; GoalBar reads the projection. `pi-ui/state` is the same kind of record. It is out-of-repo, so it is marked `ignorable` (DSH `Session.append` log-only option). That marker lets reload keep the event and still leaves it off the append surface, so it does not show in the transcript. Warning and error notices remain one coalesced non-waking user message, and that message does show.
- A `setWidget` that passes a terminal component is still the bridge fallback sentence. The panel shows that sentence, not a painted TUI widget.
