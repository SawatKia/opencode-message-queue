# message-queue

Queue follow-up messages instead of letting them interrupt a running turn — with a
native TUI bar for browsing, reordering, sending, editing, and cancelling.

Built for **OpenCode v2** (plugin API with `Plugin.define({ id, setup })`).

## Why this exists

OpenCode v2 already owns a durable session inbox. The only difference is delivery mode:

| delivery | behavior |
| --- | --- |
| `steer` (v2 default) | promotes at the next safe provider-turn boundary **inside** the current drain — it *interrupts* |
| `queue` | stays FIFO and promotes one item at a time once the current drain would otherwise end — it *waits* |

So this plugin does not reimplement queueing. Ordering, durability, replay, and drain
are the server's job. Its only server-side job is to flip `delivery` from `steer` to
`queue` while a session is busy.

Everything else is the TUI: a queue bar pinned above the prompt box.

## Install

Copy the plugin folder into your OpenCode plugins directory:

```
~/.config/opencode/plugins/message-queue/
  index.ts
  tui.tsx
  rpc-def.ts
  package.json
```

OpenCode auto-discovers the folder. No build step, no `node_modules`, no npm publish —
it only imports `@opencode/plugin` (peer) and `solid-js`.

Optionally declare it in `opencode.jsonc` to set options:

```jsonc
{
  "plugin": ["file:///Users/you/.config/opencode/plugins/message-queue"]
}
```

## TUI

The bar renders **one message at a time**, directly above the prompt box, and
disappears when the queue is drained.

```
 [ queue current status: enable ]   now: fix the failing test   [^] [v] [<] [>] [all] [e] [s] [x]
```

| token | action |
| --- | --- |
| `[^]` / `[v]` | browse previous / next message (pure view state, no inbox API) |
| `[<]` / `[>]` | **reorder** the real queue: move the visible message one slot earlier / later |
| `[all]` | open the full queue in a select dialog (view, move-to-front, edit, cancel per row) |
| `[e]` | edit the visible message |
| `[s]` | send the visible message now |
| `[x]` | cancel the visible message |
| idle row | toggle between `enable` (queue) and `disable` (steer) |

Clicking the message text opens a scrollable full-message viewer — long messages
truncate in the bar so the action tokens always stay visible.

The idle row is the one place you switch the default: `enable` queues, `disable`
steers.

### ASCII by default

Tokens are ASCII on purpose. Several terminal fonts lack `▲ ▼ ⇧ ⇩ ✏ ✕ →` and render
them as a boxed `?` (tofu). Set the plugin option `glyphs: "unicode"` for the
unicode set if your font has full coverage.

## Options

| option | default | meaning |
| --- | --- | --- |
| `mode` | `"queue"` | initial delivery mode; `"queue"` waits, `"steer"` interrupts |
| `reorder` | `true` | set `false` to disable `[<]` / `[>]` reordering entirely |
| `glyphs` | `"ascii"` | set `"unicode"` for `▲ ▼ ⇧ ⇩ ✏ ✕ →` tokens |
| `quiet` | `false` | suppress plugin logging |

## How reordering works

The inbox has no move primitive, so `[<]` / `[>]` are synthesized as
**cancel the suffix, then re-admit in the new order** (new inbox IDs). This sits
behind `options.reorder !== false` and an in-flight guard, and each re-admitted item
carries `delivery` from its own metadata so a steer item never hops into the native
queue bucket. Structural moves close the now-stale dialog and re-open the manager.

## Architecture

- `index.ts` — server entrypoint. Auto-discovered. Hooks `session.hook("prompt")` and
  `ctx.tool.transform` to flip `delivery`, registers the `queue` tool and `/queue`
  command, and serves the `message-queue` RPC (`getState` / `setMode`).
- `tui.tsx` — TUI entrypoint. Renders the bar and dialogs. Imports are limited to
  `@opencode/plugin/tui` + `solid-js`, and every registration is wrapped so a TUI
  failure can never break the terminal.
- `rpc-def.ts` — the `message-queue` RPC contract shared by both halves. The `mqDef`
  mirror in `tui.tsx` must stay verbatim identical.
- `package.json` — manifest only. `@opencode/plugin` is a peer dependency.

Data always comes from the durable session inbox (`data.session.pending`, falling back
to `client.session.inbox.list`) — pending items are *not* in chat history. The plugin
never mirrors the queue locally; it re-syncs after every mutation and clamps the view
index.

## License

[MIT](./LICENSE)