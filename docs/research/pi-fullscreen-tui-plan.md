# Optional fullscreen Pi TUI: research and implementation plan

**Status:** planning artifact; no implementation  
**Research baseline:** Pi `v0.82.0` (`083e616`, 2026-07-24), with `origin/main` checked for subsequent relevant work; OpenCode `f62ba5e`; oh-my-pi `a38cd95`; tinny-pi `f828d7c`. The checked-out Pi worktree (`6e6ce70`) is older than the current release, so Pi source references below refer to `v0.82.0` unless explicitly stated. At the time of research, `v0.82.0..origin/main` contained no fullscreen/viewport implementation (only an unrelated TUI changelog delta).

## 1. Executive verdict

**Feasible, but it belongs in Pi core and `@earendil-works/pi-tui`, not in an extension.** Recommend an **opt-in alternate-screen `FullscreenLayout` deep module** that owns a bounded conversation viewport and a fixed bottom dock, while preserving today's native-scrollback renderer as the default adapter.

Why this is feasible:

- Pi already renders the entire interactive tree to logical lines and performs differential terminal writes (`packages/tui/src/tui.ts`, `Component`, `Container`, `TUI.doRender`). Interactive mode already owns distinct transcript-side containers (`headerContainer`, `loadedResourcesContainer`, `chatContainer`, `pendingMessagesContainer`, `statusContainer`) and dock-side containers/components (editor, widgets, footer) (`packages/coding-agent/src/modes/interactive/interactive-mode.ts`, constructor and `init`).
- Pi already knows terminal width and height, synchronized output (`CSI ? 2026 h/l`), cursor placement, image row reservations, resize events, raw input, bracketed paste, and cleanup (`packages/tui/src/tui.ts`, `TUI.start`, `TUI.doRender`, `TUI.positionHardwareCursor`; `packages/tui/src/terminal.ts`, `Terminal`, `ProcessTerminal.start/stop`).
- Primary implementations prove the interaction model: OpenCode uses a full-height root, a growing scrollbox, and a non-shrinking prompt region (`packages/opencode/src/cli/cmd/tui/app.tsx`, `App`; `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx`, `Session`, especially the `<scrollbox>` and prompt siblings). Tinny-pi implements the exact fixed-bottom/output-scroll split as `ScrollLayout` (`packages/tui/src/components/scroll-layout.ts`, `ScrollLayout`). Oh-my-pi has reusable primary precedent for alternate-screen lifecycle, SGR mouse parsing, fixed-height scrolling, image-aware viewport painting, and cleanup (`packages/tui/src/tui.ts`, `OverlayOptions.fullscreen`, `#paintFullscreenOverlay`; `packages/tui/src/components/scroll-view.ts`, `ScrollView`; `packages/tui/src/mouse.ts`, `parseSgrMouse`; `packages/tui/src/terminal.ts`, `emergencyTerminalRestore`).

Why extension-only is insufficient:

1. The published component interface is `render(width): string[]`; it receives no terminal height or viewport geometry (`packages/tui/src/tui.ts`, `Component`; official local docs `docs/tui.md`, “Component Interface”).
2. Extensions can replace the editor/footer or show custom/overlay UI, but cannot replace the root renderer, partition the existing chat tree, own alternate-screen startup/exit, or route global mouse input (`docs/tui.md`, “Overlays,” “Widgets Above/Below Editor,” “Custom Footer,” “Custom Editor”).
3. `InteractiveMode` privately owns its `TUI`, transcript containers, editor container, and footer (`packages/coding-agent/src/modes/interactive/interactive-mode.ts`, fields and constructor). The extension seam intentionally exposes narrower UI operations, not root composition.
4. Alternate-screen and mouse modes are terminal-global state. Correct restoration on normal exit, error, signal, and suspend cannot be safely delegated to arbitrary extension lifetime.

Upstream appetite is the main feasibility constraint, not terminal capability. Issue [#1176](https://github.com/earendil-works/pi/issues/1176) requested this exact mode and linked a working tinny-pi implementation; discussion concluded that the complexity did not seem worth integrating. In [#5357](https://github.com/earendil-works/pi/issues/5357), a tested alt-buffer branch was offered and the maintainer answered “maybe in the future. not at the moment.” [#6071](https://github.com/earendil-works/pi/issues/6071) repeated the fixed-editor request but was auto-closed by the contributor gate. This plan therefore emphasizes a narrow interface, opt-in rollback, and separately reviewable phases.

## 2. UX specification

### Screenshot evidence, not claims about Claude Code internals

The supplied screenshots are used only as visual/behavioral evidence:

- Both show a conversation occupying the upper region and an editor/footer dock pinned to the bottom edge.
- The first shows streaming/work status above the dock while the input remains visible.
- The second shows a right-edge transcript thumb and a centered **“Jump to bottom (click) ↓”** affordance while viewing older content; the editor/footer remains visible.
- The dock can contain multiple rows (editor borders, mode/permission hints, agent/status rows), so it is not a fixed one-line input.

### Normative behavior

**Regions**

1. The **conversation viewport** gets `max(0, terminalRows - dockHeight)` rows. It contains header/startup material, loaded-resource sections, messages, tools, pending messages, and working/status output.
2. The **dock** is bottom-anchored and contains above-editor widgets, editor/replacement editor, below-editor widgets, and the active footer through a dedicated footer container. It is rendered at natural height, subject to tiny-terminal degradation below.
3. A one-column transcript scrollbar appears only when content overflows (default), with proportional thumb size/position. It must not shift message wrapping on appearance; reserve the column whenever fullscreen mode is active, or accept a deliberate full reflow. **Default: reserve one column** for stable wrapping.

**Follow-tail and detached state**

Use an explicit state model:

```text
follow-tail ── user scrolls upward ──> detached(anchor)
    ^                                   |
    └── jump-bottom / submit ────────────┘
```

- `follow-tail`: every layout/content/height change resolves to `maxOffset`.
- `detached`: streaming and appends update content and scrollbar but do not move the visible anchor (“anti-yank”).
- Scrolling to the computed bottom transitions back to `follow-tail`.
- While detached, show **“Jump to bottom”** above the dock (clickable when mouse is enabled) and provide a configurable keyboard action. **Default jump key: `ctrl+alt+end`**; `End` and `ctrl+end` remain editor navigation while the editor is focused.
- Prompt submission returns to follow-tail before displaying the new user turn. This matches OpenCode's explicit `toBottom()` on submit (`routes/session/index.tsx`, `toBottom`, `Prompt.onSubmit`) and avoids sending into an apparently stale context.
- Session switch, new session, clear, and full session reload reset to follow-tail. Resource-only reload preserves detached state and the current anchor when that anchor still exists.

**Streaming**

- In follow-tail, streamed growth remains bottom-locked.
- In detached state, no token/tool/spinner update may change the chosen anchor. Show unseen growth by moving the scrollbar thumb and optionally annotate the jump affordance with `+N rows`; counting exact messages is a non-goal for MVP.
- If content above the viewport changes height (for example expanded thinking/tool output or a resource reload), preserve the top visible logical child plus intra-child row where possible. A private top-level child-to-row map may provide this without changing the public `Component` interface; row offset is only a fallback when no stable child remains.

**Navigation**

- Mouse wheel over the conversation scrolls by 3 rows per notch; over dock/autocomplete it belongs to that local control.
- Configurable actions: viewport line up/down, page up/down (`height - 1`), top, and jump-bottom. Proposed defaults: `shift+up/down` for lines, context-sensitive `pageup/pagedown` for pages, `ctrl+alt+home` for top, and **`ctrl+alt+end` for jump-bottom**. Because PageUp/PageDown currently belong to editor behavior, route them to the transcript only when fullscreen mode is active and no editor-local surface such as autocomplete needs them; also define conflict-free alternatives such as `ctrl+alt+b/f`, following OpenCode's configurable message bindings (`packages/opencode/src/cli/cmd/tui/config/keybind.ts`, `messages_page_up/down`).
- Wheel/click input must not steal keyboard focus from the editor.

**Resize**

- Width change re-renders/wraps transcript and dock, then restores a logical anchor when detached or bottom-lock when following.
- Height change gives/takes rows from the conversation first. Dock remains pinned.
- Growing the terminal must not silently attach a detached viewport unless its clamped offset reaches bottom.

**Tiny terminals**

Degrade deterministically:

1. Render the full dock if it fits while leaving at least one conversation row.
2. If it does not, hide optional footer lines, below-editor widgets, then above-editor widgets.
3. Then rely on the editor's existing internal visible-height cap and scroll offset (`packages/tui/src/components/editor.ts`, editor `scrollOffset` layout in Pi `v0.82.0`).
4. At zero viable conversation rows, show the required editor region plus a one-line “terminal too short for transcript” status. Never slice through an image protocol sequence or leave the cursor outside the frame.

**Selection/copy**

- Alternate screen removes ordinary terminal scrollback as the history mechanism; users can select only visible cells unless the renderer supplies selection/copy.
- SGR mouse reporting causes the application to receive pointer events, commonly preventing ordinary drag selection. Therefore mouse capture must be independently disableable, document the terminal's modifier-to-bypass convention as terminal-specific, and retain transcript copy/export commands. OpenCode explicitly wires renderer selection to clipboard and supports a mouse setting (`packages/opencode/src/cli/cmd/tui/app.tsx`, `tuiRendererConfig`, selection handlers; `config/tui-schema.ts`, `mouse`).
- **MVP default:** fullscreen enables wheel reporting only when `terminal.fullscreenMouse` is true; default true in fullscreen, with a visible settings description warning about selection. Keyboard scrolling remains complete when false. `fullscreenScrollbar` accepts `"auto" | "always" | "never"`; `auto` draws only on overflow, `always` draws the track even for short content, and `never` suppresses it. The transcript width remains stable within a session.

## 3. Current Pi architecture and exact seams

### Renderer

- `packages/tui/src/tui.ts`
  - `Component.render(width)` and `Container.render(width)` form a vertical, unbounded line tape.
  - `TUI.doRender()` calls `this.render(width)`, composites overlays, finds the cursor only in the bottom terminal-height rows, applies resets, and diffs against `previousLines`.
  - Full redraw enters synchronized output, optionally emits `CSI 2 J`, `CUP`, and `CSI 3 J`, then writes all lines. Width/most height changes force this path.
  - The renderer tracks `previousViewportTop`, `hardwareCursorRow`, high-water line count, and Kitty image IDs/row reservations, but it does **not** expose an application-managed scroll offset.
- `packages/tui/src/terminal.ts`
  - `Terminal` is the current terminal seam. It has dimensions, lifecycle, write, cursor, clear, title, and progress operations, but no screen-buffer or mouse interface.
  - `ProcessTerminal.start()` enables raw mode, bracketed paste, resize, and keyboard protocol negotiation. `stop()` disables those and restores raw mode.
- `packages/tui/src/stdin-buffer.ts` already recognizes complete SGR mouse escape sequences as input units, so parser/routing can be added without replacing byte framing.
- `packages/tui/src/terminal-image.ts` and `TUI` image helpers mean viewport slicing must preserve Kitty image block row reservations and delete image IDs that leave/re-enter changed cells.
- Existing tests use `packages/tui/test/virtual-terminal.ts` plus render/shrink/overlay/image tests; this is the deterministic renderer test seam.

### Interactive composition

`packages/coding-agent/src/modes/interactive/interactive-mode.ts`:

- Constructor creates the root `TUI`, `headerContainer`, `loadedResourcesContainer`, chat/pending/status containers, editor/widget containers, and footer.
- `init()` currently appends all regions linearly: header, loaded resources, chat, pending, status, above widgets, editor, below widgets, footer; focus remains on editor.
- Session events create/update `streamingComponent` in `chatContainer`, append tool components, and request renders (`handleAgentEvent`, `message_start`, `message_update`, `message_end`, tool events).
- Resource reload clears and repopulates `loadedResourcesContainer`; it therefore participates in transcript anchoring and reload tests.
- `setupKeyHandlers()` installs app actions on `CustomEditor`; this is where app-level viewport actions can be registered, but binding names/defaults belong in `core/keybindings.ts`.
- Extension custom editor, widgets, footer, selectors, and overlays dynamically alter dock height. The fullscreen layout must measure every render; it must not cache a presumed editor/footer height. Footer replacement currently attaches directly to `TUI`, so integration needs a dedicated `footerContainer` used by both modes.
- `shutdown`, handled signal/crash cleanup, and suspend (`handleCtrlZ`) are terminal lifecycle integration points. SIGKILL and terminal loss cannot be cleaned up by any process and are outside the guarantee.

### Configuration seams

- `packages/coding-agent/src/core/settings-manager.ts`: add fields under `TerminalSettings`, getters/setters, global/project merge behavior, and defaults.
- `packages/coding-agent/src/modes/interactive/components/settings-selector.ts`: add toggles/options and callbacks.
- `packages/coding-agent/src/core/keybindings.ts`: add typed app actions and defaults.
- `packages/tui/src/index.ts`: export only the intentionally public layout/mouse interfaces.
- Docs/changelogs: `packages/coding-agent/docs/settings.md` (or the repository's current settings reference), `packages/tui/README.md`, `packages/*/CHANGELOG.md` under Unreleased.

## 4. Comparative primary-source findings

### OpenCode

OpenCode uses OpenTUI rather than Pi's line-tape renderer; copy no framework code. Reusable principles are:

- Root owns exact terminal width/height (`app.tsx`, `App` root `<box>`).
- Flexible transcript and non-shrinking prompt are siblings (`routes/session/index.tsx`, lines/functions around `Session` return: transcript `<scrollbox flexGrow={1}>`, then `<box flexShrink={0}>` containing permission/question/prompt).
- `stickyScroll=true`, `stickyStart="bottom"` encodes follow-tail in the viewport module, not scattered message handlers.
- Submit/session change explicitly jumps to bottom (`toBottom`, `Prompt.onSubmit`, route effect).
- Line/page/top/bottom/message navigation is expressed as configurable commands (`sessionCommandList`; `config/keybind.ts`).
- Scrollbar visibility, mouse capture, scroll speed, and acceleration are settings (`routes/session/index.tsx`, `showScrollbar`; `config/tui-schema.ts`; `util/scroll.ts`).
- Selection/copy and lifecycle cleanup are renderer-owned (`app.tsx`, `tuiRendererConfig`, selection handlers, `createTuiLifecycle`).

Not reusable by copying: Solid/OpenTUI renderables, flex layout, scroll acceleration classes, and selection internals. Pi should reproduce the invariants behind a small Pi-native interface.

### Tinny-pi (implementation linked from Pi #1176)

Tinny-pi's `ScrollLayout(scrollable, fixed, {scrollEnabled, followOutput})` is the closest proof of the composition: it renders the fixed region, computes remaining height, slices the output, pads the viewport, and transitions follow state when scrolling (`packages/tui/src/components/scroll-layout.ts`, `ScrollLayout.renderViewport`, `scrollBy`, `scrollToBottom`). Its interactive mode groups `outputContainer` and `fixedContainer`, with settings and wheel routing (`interactive-mode.ts`, constructor, `applyOutputScrollMode`, `handleOutputScroll`).

Reusable principles: separate region ownership; derive viewport height from rendered dock height; explicit follow flag; route wheel without changing editor focus; independent UI/mouse settings.

Do **not** copy its interface wholesale:

- It adds `renderViewport`/`ViewportInfo` awareness into general components, broadening the interface and risking shallow propagation.
- It initially renders, computes a new tail offset, then may render again; this can double expensive transcript work.
- Its raw row offset is weaker than a logical transcript anchor on rewrap/expansion.
- It captures mouse while still using Pi's main-screen rendering; the requested mode should use alternate screen so the app truly owns the viewport and does not mix application scrolling with native scrollback.

### Oh-my-pi

Oh-my-pi is a fork, not upstream Pi, but is a primary implementation and a strong risk catalogue:

- `ScrollView` owns fixed height, clamped row offset, page/top/bottom navigation, optional proportional scrollbar, and pre-windowed `totalRows` (`packages/tui/src/components/scroll-view.ts`).
- `parseSgrMouse` decodes SGR coordinates/buttons/wheel and exposes frame-local routing (`packages/tui/src/mouse.ts`).
- Fullscreen overlays enter `DECSET 1049`, reassert keyboard enhancement, optionally enable `1000/1003/1006` mouse modes, and reverse them before `DECRST 1049` (`packages/tui/src/tui.ts`, fullscreen overlay branch around `wantAlt`).
- Emergency restore tracks whether alternate screen is actually active rather than blindly emitting `1049l` (`packages/tui/src/terminal.ts`, `setAltScreenActive`, `emergencyTerminalRestore`; `packages/tui/test/emergency-restore-altscreen.test.ts`).
- Its extensive viewport/image/resize stress tests show that resize bursts, Windows ConPTY, Kitty images, and terminal-state cleanup are not incidental details (`packages/tui/test/render-stress-harness.ts`; issue regression tests in `packages/tui/test`).

Reuse the principles and test cases, not code: the fork has significantly diverged and its renderer contains complexity upstream explicitly declined to absorb.

### Prior Pi proposals

- [PR #1232](https://github.com/earendil-works/pi/pull/1232) added `followOutput`, persistent viewport position, and Shift+Page/Home/End controls to the native-scrollback renderer. It was auto-closed by the contributor gate, not rejected in technical review. Its patch is useful as a behavioral test source, but it does not provide a fixed dock or alt-screen ownership.
- [Issue #5357](https://github.com/earendil-works/pi/issues/5357) links an alt-buffer comparison branch and reports a month of personal testing, with problems from plugins that bypass Pi TUI and print directly. Treat that as a concrete compatibility risk, not a verified guarantee.

## 5. Design alternatives

### Design A — recommended: deep `FullscreenLayout` at the TUI root seam

**Interface (illustrative, not final TypeScript):**

```ts
new FullscreenLayout({
  transcript,
  dock: { aboveEditor, editor, belowEditor, footer },
  scrollbar,
  onViewportChange,
});
layout.scroll(command);
layout.getViewportState();
```

The module receives terminal geometry from `TUI`, renders named dock slots once so tiny-terminal degradation can apply explicit priorities, renders transcript children while privately recording top-level child identity and row ranges, computes the visible frame, scrollbar, cursor translation, and follow/detached transition. The child map supports logical anchoring across rewrap or height changes without broadening the public `Component` interface; when a child disappears, the module falls back to a clamped row offset.

`TUI` gets two implementations behind one screen-mode seam:

- **Native scrollback** — today's `doRender` path, left structurally unchanged rather than extracted merely for symmetry.
- **Fullscreen screen** — alternate buffer, exact-height frame, mouse mode, and viewport state.

**Depth:** callers know only mode and scroll commands; alternate-screen lifecycle, geometry, anchoring, image policy, cursor translation, and diff painting stay behind one interface. **Locality:** renderer invariants remain in `packages/tui`; coding-agent only declares transcript/dock composition and maps settings/actions. **Testability:** both application and tests cross the same screen interface using `VirtualTerminal`.

### Design B — `ViewportAware` protocol propagated through components (tinny-pi style)

Add `renderViewport(width, {top,height})` and `contentHeight` to components/containers; build a `ScrollLayout` that invokes it.

Advantages: can become O(viewport) for long histories and lets specialized containers skip offscreen children. Disadvantages: it enlarges the interface every component author may need to understand; viewport state leaks into transcript children; overlays/images/cursor semantics spread across modules; extensions may accidentally return inconsistent `contentHeight`. It is a shallower module and a larger compatibility surface.

### Recommendation

Choose **Design A**, with a private/internal windowed-render seam added later only if profiling requires it. First establish correct exact-height frame ownership. Then deepen `FullscreenLayout` internally with transcript child measurement/cache or a private `LineSource` adapter. This avoids making every Pi extension viewport-aware before the semantics are stable.

## 6. Phased implementation plan

### Phase 0 — contract tests and terminal-state primitives

Likely files:

- Modify `packages/tui/src/terminal.ts`
- Add `packages/tui/src/screen-mode.ts`
- Add `packages/tui/src/mouse.ts`
- Modify `packages/tui/src/stdin-buffer.ts` only if split SGR tests expose gaps
- Add `packages/tui/test/mouse.test.ts`, `terminal-fullscreen.test.ts`, `screen-mode.test.ts`

Work:

1. Extend the terminal seam with idempotent `enterAlternateScreen`, `leaveAlternateScreen`, `setMouseTracking`, and tracked active state (or keep escape sequences in a `ScreenSession` module that depends only on `Terminal.write`).
2. Enter with `CSI ? 1049 h`; leave with `CSI ? 1049 l`. Immediately reassert Pi's negotiated Kitty/modifyOtherKeys keyboard enhancement after entering the alternate buffer, then enable basic button/wheel tracking plus SGR coordinates (`?1000h`, `?1006h`). Avoid `?1003h` all-motion tracking for MVP.
3. Wrap frames in synchronized output (`?2026h/l`) as Pi already does; always close it in the same write buffer.
4. Make cleanup idempotent and reverse-order: end sync if needed, mouse off, alternate screen off, keyboard/bracketed-paste restoration, cursor visible/raw mode restored. Track state so cleanup never emits an alt-screen exit if no enter succeeded. Fullscreen stop must not emit the native-mode trailing newline before leaving the alternate buffer.
5. Cover normal stop, double stop, startup failure, handled signals, uncaught-error cleanup, and suspend/resume. Add an ordering assertion for alternate-screen entry followed by keyboard-enhancement reassertion and mouse enablement. Explicitly exclude SIGKILL and unrecoverable terminal loss.

Official control references:

- XTerm control sequences: alternate screen `DECSET/DECRST 1049`, mouse modes `1000/1006`: https://invisible-island.net/xterm/ctlseqs/ctlseqs.html
- Kitty synchronized output protocol (`CSI ? 2026 h/l`) and nesting/timeout guidance: https://sw.kovidgoyal.net/kitty/sync-output/
- Kitty keyboard protocol (already cited by Pi terminal source): https://sw.kovidgoyal.net/kitty/keyboard-protocol/

### Phase 1 — exact-height fullscreen frame and fixed dock

Likely files:

- Add `packages/tui/src/components/fullscreen-layout.ts`
- Modify `packages/tui/src/tui.ts`
- Modify `packages/tui/src/index.ts`
- Add `packages/tui/test/fullscreen-layout.test.ts`, `tui-fullscreen-render.test.ts`, `tui-fullscreen-resize.test.ts`

State:

```text
ScreenMode = native-scrollback | fullscreen
ViewportState =
  { mode: follow-tail, offset: maxOffset }
  | { mode: detached, anchor?: { child: object, intraRow: number }, offset }
Geometry = { width, height, dockHeight, viewportHeight, contentRows, maxOffset }
```

Invariants:

1. Fullscreen output is exactly `terminal.rows` logical rows after clipping/padding.
2. `0 <= offset <= max(0, contentRows - viewportHeight)`.
3. Follow-tail implies `offset === maxOffset` after every render.
4. Detached content growth does not change a surviving logical anchor; if the anchored child disappears, use a documented clamped row fallback.
5. Dock's last row maps to terminal last row whenever height > 0.
6. Cursor marker must be in the visible dock; otherwise hide hardware cursor.
7. Fullscreen MVP sets the effective image-rendering policy to textual placeholders before transcript rendering; it does not attempt to transform already-rendered image protocol lines.
8. Every line remains within terminal width after reserving the scrollbar column.

Implementation:

- Render named dock slots first to determine dynamic height and apply the documented tiny-terminal priority order without introspecting arbitrary component output.
- Render direct transcript children at stable content width and privately record `{ child, startRow, endRow }`; resolve the current logical anchor, visible slice, and row fallback from that map. This remains internal to `FullscreenLayout`.
- Combine transcript slice, jump affordance, scrollbar, and dock into an exact-height frame. In fullscreen, use absolute cursor addressing (`CUP`) or known screen-row deltas only; do not maintain native-scrollback tape coordinates.
- Fullscreen overlays composite into frame coordinates. Existing overlays remain screen-relative and must not alter transcript offset.
- For MVP, pass an effective `showImages=false` policy when constructing message/tool renderers in fullscreen so existing textual image fallbacks are produced before layout. Protocol-specific inline image support waits for Phase 5.

### Phase 2 — interactive composition and scroll actions

Likely files:

- Modify `packages/coding-agent/src/modes/interactive/interactive-mode.ts`
- Modify `packages/coding-agent/src/core/keybindings.ts`
- Add `packages/coding-agent/test/interactive-mode-fullscreen.test.ts`

Work:

1. Create `transcriptContainer` holding header, loaded resources, chat, pending, and status. Pass existing above-editor, editor, below-editor, and a new dedicated `footerContainer` as named dock slots. Preserve extension replacement behavior by moving existing containers, not duplicating content.
2. Construct fullscreen layout only when configured; otherwise preserve the current child ordering byte-for-byte as far as practical.
3. Register typed actions such as `app.viewport.pageUp`, `pageDown`, `lineUp`, `lineDown`, `top`, `bottom`. Route through the active layout; custom editors inherit action handlers through the existing `CustomEditor` wiring.
4. On user submit, session switch/new/clear, and full session reload, call `scrollToBottom()` according to the UX contract. Resource-only reload attempts to preserve a surviving anchor.
5. On streaming update, request render only. Follow behavior remains inside the layout module; no event handler should mutate offset directly.
6. Show jump-bottom affordance only while detached. Implement keyboard activation in this phase; click after mouse routing in Phase 3.

### Phase 3 — scrollbar and mouse routing

Likely files:

- Modify `packages/tui/src/components/fullscreen-layout.ts`, `tui.ts`, `mouse.ts`, `terminal.ts`
- Modify `interactive-mode.ts`
- Add mouse/scrollbar hit-test tests

Work:

- Parse SGR reports to zero-based coordinates.
- Route wheel based on screen row: conversation rows scroll transcript; dock rows are offered to focused/local dock controls first.
- Left-click jump-bottom and scrollbar track/thumb. MVP may support click-to-page on track; dragging is non-goal.
- Never change keyboard focus on wheel or jump click.
- Ensure mouse-off setting immediately emits reset sequences and restores terminal selection behavior.

### Phase 4 — settings, docs, backward compatibility

Likely files:

- `packages/coding-agent/src/core/settings-manager.ts`
- `packages/coding-agent/src/modes/interactive/components/settings-selector.ts`
- settings/keybinding tests and docs/changelogs

Proposed settings:

```json
{
  "terminal": {
    "screenMode": "native-scrollback",
    "fullscreenMouse": true,
    "fullscreenScrollbar": "auto"
}
```

- `screenMode`: `"native-scrollback" | "fullscreen"`; default native for backward compatibility and upstream risk control.
- `fullscreenMouse`: boolean, default true when fullscreen is selected.
- `fullscreenScrollbar`: `"auto" | "always" | "never"`; default `"auto"`. Reserve the scrollbar column for `auto` and `always` so overflow transitions do not rewrap content; `never` may reclaim it at startup.
- CLI/environment override may be added for canaries (`PI_SCREEN_MODE=fullscreen`), but persistent setting is canonical.
- Mode is startup-only in MVP. Changing it in `/settings` writes the next-run value and says “restart required”; live buffer switching multiplies lifecycle and scrollback edge cases.
- Unknown/invalid values fall back to native with a visible warning; never strand the terminal.
- Existing `terminal.clearOnShrink` applies only to native mode; document it as ignored in fullscreen.

### Phase 5 — image/overlay/performance hardening

- Keep Kitty/iTerm images as textual placeholders for the first fullscreen release. Add frame-local image placement/deletion and atomic block-clipping tests before optionally enabling protocol images in fullscreen.
- Validate all built-in overlays, extension overlays, replacement editors/footers, autocomplete, permission prompts, selectors, resource reload, and external-editor/suspend flows.
- Run a synthetic 10,000-row transcript benchmark with 200 editor-only updates at 80×24. Release gate: fullscreen p95 render time is at most 16 ms and no frame exceeds 50 ms on the documented reference machine, or fullscreen is no more than 1.25× native mode when CI hardware makes absolute timing unstable. If the gate fails, a private transcript line-source/cache becomes part of MVP; do not expose public `renderViewport` until two real adapters need it.

## 7. Deterministic tests and interactive canaries

No paid provider is required.

### Unit/model tests

Use table-driven reducer tests for viewport transitions:

- empty/short/exact/overflow content;
- scroll up from tail, scroll down to tail, clamp at both ends;
- append/stream while following vs detached;
- dock grow/shrink; width/height resize;
- anchor preservation after rewrap;
- tiny heights 0–5;
- proportional scrollbar thumb bounds.

Use generated operation sequences (append, replace tail, expand item, resize, scroll, jump) and assert invariants after every transition.

### Renderer tests

Use/extend `packages/tui/test/virtual-terminal.ts`:

- assert exact cell grid and cursor after every frame;
- assert enter/exit/mouse/sync sequence ordering;
- assert no alt exit without enter and cleanup after injected write/render failures;
- assert detached viewport bytes/cells remain stable during streaming updates;
- assert dock stays on last row through resize;
- assert stale cells clear on shorter frame;
- ANSI, OSC hyperlinks, CJK, emoji/graphemes, tabs, long lines;
- Kitty image fully visible/partially visible/removed/reappearing;
- overlays at all anchors while detached.

### Coding-agent integration tests

Use the repository's faux provider/harness (`packages/coding-agent/test/suite/harness.ts`, required by `AGENTS.md`), scripted streaming chunks, tool events, abort/error/retry/compaction, queued messages, custom editor/footer/widget extension fixtures, session reload, and resource-only reload of `loadedResourcesContainer`. Assert rendered snapshots and viewport state; no API keys.

### Interactive canary matrix

Run via `./pi-test.sh` inside controlled tmux panes (Pi `AGENTS.md`, “Testing pi Interactive Mode with tmux”) at 40×8, 80×24, 120×40 and resize continuously.

| Dimension   | Matrix                                                                                                                                              |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mode        | native default; fullscreen keyboard-only; fullscreen mouse                                                                                          |
| Host        | bare terminal; tmux; SSH+tmux                                                                                                                       |
| Terminal    | Kitty/Ghostty/iTerm2/WezTerm; macOS Terminal; VS Code; Windows Terminal/ConPTY; Termux where available                                              |
| Content     | ASCII; CJK/emoji; code blocks; hyperlinks; long streaming; tool expansion; images on/off                                                            |
| Lifecycle   | normal exit; Ctrl+C; Ctrl+D on an empty editor (non-empty remains delete-forward); handled signal; suspend/resume; external editor; crash injection |
| Interaction | wheel; page/line/top/bottom; detached streaming; jump click; selection/copy; overlay/autocomplete                                                   |

Canary pass criteria: shell restored, no alternate-buffer residue, no stuck mouse/raw/bracketed-paste/keyboard mode, fixed dock never displaced, detached viewport never yanked, and native mode unchanged.

## 8. Risks, mitigations, rollback, maintenance/upstream

| Risk                                                  | Mitigation                                                                                                                                                                             |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Upstream considers complexity too high (#1176, #5357) | Opt-in default-off adapter; deep small interface; submit phases separately; include deletion test showing fullscreen complexity disappears when adapter is removed.                    |
| Alternate screen removes native history/selection     | Explicit copy/export, app viewport, mouse-off setting, documentation; never change native default initially.                                                                           |
| Mouse capture breaks selection or leaks to shell      | Independent toggle; SGR only; reverse-order idempotent cleanup; crash/signal tests.                                                                                                    |
| Extensions print directly to stdout                   | Document unsupported behavior in fullscreen; route official external output through terminal adapter; detect/log writes where feasible. This was the concrete issue reported in #5357. |
| Long transcript still O(history)                      | Correctness-first; cache wrapped child lines; add private windowed source only after profiling. OpenCode's scrollbox demonstrates the target, not a drop-in algorithm.                 |
| Resize/reflow loses detached place                    | Logical child anchor + intra-child row; deterministic rewrap tests; raw offset only as MVP fallback.                                                                                   |
| Images corrupt or ghost                               | Placeholder-first; image block atomicity; frame-local deletion tracking; terminal matrix.                                                                                              |
| Cleanup failure strands terminal                      | Track active modes, one cleanup owner, `finally`/handled-signal/emergency path, idempotence tests; explicitly exclude SIGKILL and unrecoverable terminal loss.                         |
| Two renderers drift                                   | Share component rendering, line normalization, overlay composition, cursor extraction, and image helpers; vary only frame selection/painting behind screen-mode seam.                  |

**Rollback:** one setting restores `native-scrollback`; the native adapter remains the default and should receive unchanged tests. If release canaries fail, disable/ignore `fullscreen` in settings with a warning without migrating user files. No session data format changes are needed.

**Upstream strategy:** first propose the terminal-state cleanup primitives and fixed-height layout tests as independently valuable. Then submit the optional adapter with issue links and measured complexity/performance. Avoid importing fork history wholesale. Track upstream Pi changes to `TUI.doRender`, terminal lifecycle, images, overlays, and editor action plumbing; these are the maintenance hotspots.

## 9. MVP, non-goals, and acceptance criteria

### MVP

- Startup-only opt-in fullscreen alternate-screen mode.
- Fixed bottom editor/widgets/footer dock.
- Independently scrollable conversation with keyboard and wheel.
- Follow-tail/detached behavior and keyboard/click jump-bottom.
- Auto proportional scrollbar.
- Resize and tiny-terminal degradation.
- Correct normal/error/signal/suspend cleanup.
- Native mode behavior remains default.
- Inline images use textual placeholders in fullscreen.

**MVP milestone:** Phases 0–4 plus the Phase 5 compatibility and performance release gates. Phase numbers are implementation order, not separate permission to implement; work begins only after explicit user approval.

### Non-goals

- Reproducing Claude Code styling or inferring its implementation.
- Scrollbar thumb dragging, kinetic scrolling, or configurable acceleration.
- Persisting viewport offset across process restarts/session switches.
- Multiple side-by-side panes.
- Public virtualization protocol for all extension components.
- Perfect terminal-native selection across offscreen transcript content.
- Live switching between normal and alternate screen in the first release.
- Copying OpenCode/OpenTUI or fork code.

### Acceptance criteria

1. With `screenMode=fullscreen`, the dock's bottom row remains at terminal bottom while transcript scrolls by keyboard and wheel.
2. Streaming follows at tail; after any upward scroll it does not move the viewport; jump-bottom reattaches.
3. Screenshot-equivalent affordances exist: visible right-edge thumb on overflow and visible jump-bottom control while detached.
4. Width/height resize preserves follow state and a recognizable detached anchor; no stale cells or dock displacement at supported sizes.
5. Tiny terminals degrade in the specified order and never crash.
6. Custom editor/footer/widgets and built-in overlays remain functional; focus/IME cursor remains in the editor.
7. Mouse can be disabled; copy/export remains available; docs explain selection implications.
8. Every handled exit path restores cursor, raw mode, bracketed paste, keyboard protocol, mouse reporting, synchronized output, and alternate screen; SIGKILL/unrecoverable terminal loss are explicitly excluded.
9. Deterministic tests use virtual terminal/faux provider only and pass without network/API credentials.
10. With the setting absent/default, existing native-scrollback snapshots and behavior remain unchanged.
11. Invalid `screenMode` falls back to native with a visible warning; changing mode in `/settings` persists the next-run value and displays “restart required” without live-switching buffers.
12. `fullscreenScrollbar` accepts exactly `auto`, `always`, or `never`; `auto` overflow transitions do not change transcript wrapping.
13. Full session reload returns to follow-tail; resource-only reload preserves a surviving detached anchor.
14. The 10,000-row editor-update benchmark meets the Phase 5 absolute or native-relative release gate.

## 10. Open decisions requiring user input

Defaults are supplied so implementation need not block unnecessarily.

1. **Should fullscreen eventually become the default?** Recommended decision now: **no**; ship opt-in for at least one release and gather terminal canaries.
2. **Should mouse capture default on within fullscreen?** Recommended: **yes**, because wheel and click are central to the screenshot UX, but expose a nearby toggle and clear selection warning.
3. **What should PageUp/PageDown do while editor is focused?** Recommended: transcript paging in fullscreen unless autocomplete/local editor paging is active; retain configurable conflict-free alternatives.
4. **Should inline terminal images render in MVP fullscreen?** Recommended: placeholders first, then enable per protocol after atomic clipping/deletion tests.
5. **Should detached anchoring be row-based or message-based in MVP?** Recommended: message/component anchor plus intra-row where available; use row offset only as an explicitly documented first-phase fallback.

## Source index

- Supplied screenshots (session-local temporary files): `/var/folders/kz/jh7824tj1knggz46f57dwghm0000gn/T/clipboard-2026-07-25-035550-EC6BFBAB.png` and `clipboard-2026-07-25-041234-4F43A844.png`. The textual UX contract in section 2 is normative because these temporary files may be purged.
- Pi source at `v0.82.0`: `packages/tui/src/{tui,terminal,stdin-buffer,terminal-image}.ts`; `packages/coding-agent/src/modes/interactive/interactive-mode.ts`; `packages/coding-agent/src/core/{settings-manager,keybindings}.ts`; settings/interactive/TUI tests.
- Pi TUI official docs (installed package): `docs/tui.md`, especially component, overlay, widget, footer, and editor interfaces.
- OpenCode source at `f62ba5e`: `packages/opencode/src/cli/cmd/tui/app.tsx`; `routes/session/index.tsx`; `config/{keybind,tui-schema}.ts`; `util/scroll.ts`.
- Tinny-pi source at `f828d7c`: `packages/tui/src/components/scroll-layout.ts`; `packages/tui/src/mouse.ts`; `packages/coding-agent/src/modes/interactive/interactive-mode.ts`.
- Oh-my-pi source at `a38cd95`: `packages/tui/src/tui.ts`; `terminal.ts`; `mouse.ts`; `components/scroll-view.ts`; associated tests.
- Pi upstream: [#1176](https://github.com/earendil-works/pi/issues/1176), [#5357](https://github.com/earendil-works/pi/issues/5357), [#6071](https://github.com/earendil-works/pi/issues/6071), [PR #1232](https://github.com/earendil-works/pi/pull/1232).
- Official terminal references: [XTerm Control Sequences](https://invisible-island.net/xterm/ctlseqs/ctlseqs.html), [Kitty synchronized output](https://sw.kovidgoyal.net/kitty/sync-output/), [Kitty keyboard protocol](https://sw.kovidgoyal.net/kitty/keyboard-protocol/).
