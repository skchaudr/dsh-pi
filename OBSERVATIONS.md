# ui-bridge-fix observations

- Fix lives in `src/ui-publisher.ts` (pure, tested) wired in `src/index.ts` `publishUi`. `ui-bridge.ts` unchanged (it still publishes everything; policy is in the publisher).
- status/widget: keyed replace-in-place state (`mounted.uiState()`), debug-logged only if logger has `debug`. No DSH custom session event / badge surface was found for plugins (Session.append is typed per known event), so there is NO web UI rendering of status yet. Latest state is retrievable but not displayed.
- warning/error notify + unsupported errors: buffered, deduped by digit-stripped text, flushed once at `turn/end` (or next macrotask if idle) as `agent.send(msg, 'next-turn', false)` (signature verified in runtime-types.ts). Model sees it next turn; transcript shows one user message.
- info notify is dropped (not in transcript, not in state).
- hasUI: NOT changed (dialogs need hasUI=true). pi-warden advise branch is `ctx.hasUI && config.notices ? notify : steer-if-!hasUI`; with `notices:false` (default) it never calls notify, so advise stays silent regardless of this fix. Mitigation: set pi-warden `notices: true` (now safe, coalesced). Not verified against pi-warden source/runtime here.
- Edge: warnings raised mid-turn arrive at next turn, not the next step. Using 'next-step' would reach the model sooner; left as per spec.
- Widget-factory fallback text (level warning) is silent: it carries no information.
