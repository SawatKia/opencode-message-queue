/**
 * message-queue — tui.tsx (TUI entrypoint).
 *
 * Pinned queued-message bar directly above the prompt box
 * (`session.composer.top` only — never below in `prompt.footer`).
 *
 * Data comes from the durable session inbox — pending items are NOT in chat
 * history, so `data.session.pending` (falling back to
 * `client.session.inbox.list`) is the only source of truth. Never mirror the
 * queue locally; re-sync after every mutation and clamp the view index.
 *
 * Two arrow pairs, deliberately distinct:
 *   - `[^]` / `[v]` BROWSE only. Pure view state (`viewIndex`), touches no
 *     inbox API, takes no guard, toasts nothing. Cannot send, cancel/reorder.
 *   - `[<]` / `[>]` REORDER the real queue: move the visible message one slot
 *     earlier/later. The inbox has no move primitive, so this is synthesized
 *     as cancel-the-suffix + re-admit in the new order (new inbox IDs), behind
 *     `options.reorder !== false` and an in-flight guard.
 *   - Clicking the message text opens a scrollable full-message viewer
 *     (edit / send / back to list). `[all]` opens the full queue in a select
 *     dialog (view, move-to-front, edit, cancel per row). `[e]` edit, `[x]`
 *     cancel, `[s]` send-now complete the row. Arrows move the selection,
 *     Enter activates, everything is clickable.
 *   - Tokens are ASCII so no terminal font renders tofu (boxed `?`); set the
 *     plugin option `glyphs: "unicode"` for the legacy ▲▼⇧⇩✏✕→ look.
 *
 * Imports are limited to `@opencode/plugin/tui` + `solid-js` on purpose, the
 * same rule as `context-segments/tui.tsx`. Every registration is wrapped so a
 * TUI failure can never break the terminal.
 */

import { Plugin, usePlugin } from "@opencode/plugin/tui";
import { For, Show, createEffect, createSignal, onCleanup } from "solid-js";

const LOAD_FLAG = "__mq_tui_setup_done__";

/** MUST match index.ts (server hook bypass contract). */
const BYPASS_KEY = "__message_queue_bypass";
const REORDER_KEY = "__message_queue_reorder";

/** MUST match the server's rpc-def.ts verbatim (handoff contract). */
const mqDef = {
  id: "message-queue",
  methods: { getState: {}, setMode: {} },
  events: {},
} as const;

/** Idle-row mode cache, keyed by sessionID. Invalidated after setMode. */
const mqModeCache = new Map<string, string>();

function mqCall(ctx: Ctx): Record<string, (args?: unknown) => Promise<unknown>> | null {
  try {
    const rpc = (ctx.client as unknown as Record<string, unknown>).rpc as
      | ((def: unknown) => Record<string, (args?: unknown) => Promise<unknown>>)
      | undefined;
    return rpc ? rpc(mqDef) : null;
  } catch {
    return null;
  }
}

/** Single mount: the bar lives ONLY above the prompt box. */

type Ctx = ReturnType<typeof usePlugin>;

interface InboxItem {
  id: string;
  sessionID: string;
  type: string;
  delivery?: string;
  text: string;
  files?: Array<{ uri: string; name?: string }>;
  agents?: Array<{ name: string }>;
  skills?: Array<{ id: string }>;
}

function asRecord(value: unknown): Record<string, any> {
  return value && typeof value === "object" ? (value as Record<string, any>) : {};
}

function oneLine(s: string, max = 72): string {
  const flat = String(s ?? "").replace(/\s+/g, " ").trim();
  if (!flat) return "";
  return flat.length <= max ? flat : `${flat.slice(0, Math.max(0, max - 1))}…`;
}

/** Display-cell width: CJK/emoji glyphs occupy 2 terminal cells. `String`
 * length miscounts them, which is how long messages used to push the action
 * tokens off-screen. */
function cellWidthOf(s: string): number {
  let w = 0;
  for (const ch of String(s ?? "")) {
    w +=
      /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe19\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6\u{1f300}-\u{1faff}\u{20000}-\u{3fffd}]/u.test(
        ch,
      )
        ? 2
        : 1;
  }
  return w;
}

/** Flatten + truncate to a cell budget. ASCII mode uses `...` (always in
 * every font); unicode mode keeps `…`. */
function oneLineCells(s: string, maxCells: number, ascii: boolean): string {
  const flat = String(s ?? "").replace(/\s+/g, " ").trim();
  if (!flat) return "";
  if (cellWidthOf(flat) <= maxCells) return flat;
  const ell = ascii ? "..." : "…";
  const budget = Math.max(0, maxCells - cellWidthOf(ell));
  let out = "";
  let w = 0;
  for (const ch of flat) {
    const cw =
      /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe19\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6\u{1f300}-\u{1faff}\u{20000}-\u{3fffd}]/u.test(
        ch,
      )
        ? 2
        : 1;
    if (w + cw > budget) break;
    out += ch;
    w += cw;
  }
  return out + ell;
}

/** Terminal width for width-aware truncation. Renderer shape is host-owned,
 * so probe a few known paths, then stdout, then fall back to 80. */
function termWidthOf(ctx: unknown): number {
  try {
    const r = (ctx as any)?.renderer;
    for (const k of ["width", "columns", "terminalWidth"]) {
      const v = r?.[k];
      if (typeof v === "number" && v > 0) return v;
      if (typeof v === "function") {
        try {
          const n = v.call(r);
          if (typeof n === "number" && n > 0) return n;
        } catch {
          // ignore
        }
      }
    }
  } catch {
    // ignore
  }
  try {
    const c = (globalThis as any)?.process?.stdout?.columns;
    if (typeof c === "number" && c > 0) return c;
  } catch {
    // ignore
  }
  return 80;
}

/** Defensive preview: the server owns the truth, never assume a shape. */
function textOf(raw: any): string {
  const payload = asRecord(raw?.payload);
  for (const key of ["text", "message", "content", "preview", "body"]) {
    const v = payload[key];
    if (typeof v === "string" && v.trim()) return v;
  }
  const parts = payload.parts;
  if (Array.isArray(parts)) {
    for (const p of parts) {
      const t = asRecord(p).text;
      if (typeof t === "string" && t.trim()) return t;
    }
    if (parts.some((p) => asRecord(p).type === "file")) return "[file]";
    if (parts.some((p) => asRecord(p).type === "agent")) return "[agent]";
    if (parts.some((p) => asRecord(p).type === "subtask")) return "[subtask]";
  }
  return "[queued message]";
}

function normalize(raw: any): InboxItem[] {
  const arr = Array.isArray(raw) ? raw : Array.isArray(raw?.data) ? raw.data : [];
  const out: InboxItem[] = [];
  for (const entry of arr) {
    const r = asRecord(entry);
    if (typeof r.id !== "string" || !r.id) continue;
    out.push({
      id: r.id,
      sessionID: typeof r.sessionID === "string" ? r.sessionID : "",
      type: typeof r.type === "string" ? r.type : "user",
      delivery: typeof r.delivery === "string" ? r.delivery : undefined,
      text: textOf(r),
      files: Array.isArray(asRecord(r.payload).files)
        ? (asRecord(r.payload).files as any[]).filter(
            (f) => f && typeof asRecord(f).uri === "string",
          )
        : undefined,
      agents: Array.isArray(asRecord(r.payload).agents)
        ? (asRecord(r.payload).agents as any[]).filter(
            (a) => a && typeof asRecord(a).name === "string",
          )
        : undefined,
      skills: Array.isArray(asRecord(r.payload).skills)
        ? (asRecord(r.payload).skills as any[]).filter(
            (s) => s && typeof asRecord(s).id === "string",
          )
        : undefined,
    });
  }
  return out;
}

/** Re-admission must never flip delivery: a steer item touched by a move/edit
 * stays steer, otherwise it hops native buckets ("Pending steer" ↔
 * "Queued prompts") and the open dialog goes stale. */
function keepDelivery(it: InboxItem): "queue" | "steer" {
  return it.delivery === "steer" ? "steer" : "queue";
}

function themeOf(ctx: Ctx): any {
  try {
    return (ctx as any)?.theme ?? {};
  } catch {
    return {};
  }
}

function toast(ctx: Ctx, title: string, message: string, variant: string): void {
  try {
    ctx.ui.toast.show({ title, message, variant } as any);
  } catch {
    // toasts are best-effort
  }
}

function currentSessionID(ctx: Ctx): string | undefined {
  try {
    const route = (ctx.ui.router.current() as unknown as {
      type?: unknown;
      sessionID?: unknown;
    }) ?? null;
    if (route && route.type === "session" && typeof route.sessionID === "string") {
      return route.sessionID;
    }
  } catch {
    // ignore
  }
  return undefined;
}

// --- inbox client (exact shapes from @opencode/client 2.0.30) ---------------

async function inboxList(client: any, sessionID: string): Promise<InboxItem[]> {
  const res = await client.session.inbox.list({ sessionID });
  return normalize(res);
}

async function inboxUpdate(
  client: any,
  sessionID: string,
  inboxID: string,
  delivery: "steer" | "queue",
): Promise<void> {
  await client.session.inbox.update({ sessionID, inboxID, delivery });
}

async function inboxCancel(client: any, sessionID: string, inboxID: string): Promise<void> {
  await client.session.inbox.cancel({ sessionID, inboxID });
}

async function promptQueue(
  client: any,
  sessionID: string,
  text: string,
  metadata: Record<string, unknown>,
  carry?: { files?: unknown; agents?: unknown; skills?: unknown; delivery?: unknown },
  delivery: "queue" | "steer" = "queue",
): Promise<void> {
  const body: Record<string, unknown> = { sessionID, text, delivery, metadata };
  if (Array.isArray(carry?.files) && (carry.files as unknown[]).length > 0) body.files = carry.files;
  if (Array.isArray(carry?.agents) && (carry.agents as unknown[]).length > 0) body.agents = carry.agents;
  if (Array.isArray(carry?.skills) && (carry.skills as unknown[]).length > 0) body.skills = carry.skills;
  await client.session.prompt(body);
}

// --- affordances -------------------------------------------------------------

type AffordID = "up" | "down" | "all" | "shiftUp" | "shiftDown" | "edit" | "cancel" | "send";

function affordances(count: number, viewIndex: number, reorder: boolean): AffordID[] {
  const list: AffordID[] = [];
  if (count > 1 && viewIndex > 0) list.push("up");
  if (count > 1 && viewIndex < count - 1) list.push("down");
  // `[all]` opens the manager list. It replaces the old `+N` token, which
  // had no mental model (a bare count of messages behind the cursor).
  if (count > 1) list.push("all");
  if (reorder && count > 1 && viewIndex > 0) list.push("shiftUp");
  if (reorder && count > 1 && viewIndex < count - 1) list.push("shiftDown");
  list.push("edit", "cancel", "send");
  return list;
}

/** ASCII tokens by default: several terminal fonts lack ▲▼⇧⇩✏✕→ and render
 * them as boxed question marks. `glyphs: "unicode"` restores the legacy set. */
function glyphOf(a: AffordID, behind: number, ascii: boolean): string {
  if (!ascii) {
    switch (a) {
      case "up": return "▲";
      case "down": return "▼";
      case "all": return `+${behind}`;
      case "shiftUp": return "⇧";
      case "shiftDown": return "⇩";
      case "edit": return "✏";
      case "cancel": return "✕";
      case "send": return "→";
    }
  }
  switch (a) {
    case "up": return "[^]";
    case "down": return "[v]";
    case "all": return "[all]";
    case "shiftUp": return "[<]";
    case "shiftDown": return "[>]";
    case "edit": return "[e]";
    case "cancel": return "[x]";
    case "send": return "[s]";
  }
}

// --- the idle row ------------------------------------------------------------

// Dim one-line indicator rendered in the same slot when the queue is EMPTY:
// `queue: <mode> · idle`. Clicking toggles queue<->steer via RPC and repaints.
// Own component so the getState fetch only ever runs for the idle row, never
// for the busy bar. Every failure path falls back to "queue" and a toast.
function IdleRow(props: { sessionID: string }) {
  const ctx = usePlugin();
  const theme = themeOf(ctx);

  const [mode, setMode] = createSignal(mqModeCache.get(props.sessionID) ?? "queue");
  const [toggling, setToggling] = createSignal(false);
  const [hovered, setHovered] = createSignal(false);

  const readMode = (res: unknown): string | null => {
    try {
      const r = asRecord(res);
      if (r.ok === true && (r.mode === "queue" || r.mode === "steer")) return r.mode as string;
    } catch {
      // ignore: fall through to null
    }
    return null;
  };

  // Lazy + cached: runs only when the idle row mounts (or the session flips),
  // never on busy-bar renders.
  createEffect(() => {
    const id: string = props.sessionID;
    if (!id) return;
    try {
      const hit = mqModeCache.get(id);
      if (hit) {
        setMode(hit);
        return;
      }
      const call = mqCall(ctx);
      if (!call) return;
      void call
        .getState({ sessionID: id })
        .then((res: unknown) => {
          const m = readMode(res);
          if (m) {
            try {
              mqModeCache.set(id, m);
            } catch {
              // ignore
            }
            setMode(m);
          }
        })
        .catch(() => {});
    } catch {
      // never break the terminal
    }
  });

  const onToggle = (): void => {
    try {
      const id: string = props.sessionID;
      const call = mqCall(ctx);
      if (!call || !id) {
        toast(ctx, "Message queue", "Queue server offline.", "warning");
        return;
      }
      // No label-width change while working: the label stays fixed so the
      // row never reflows (the old " …" suffix caused the flicker).
      if (toggling()) return;
      setToggling(true);
      const prev = mode();
      const next = prev === "steer" ? "queue" : "steer";
      // Optimistic flip: exactly one repaint, no intermediate states.
      setMode(next);
      try {
        mqModeCache.set(id, next);
      } catch {
        // ignore
      }
      void call
        .setMode({ sessionID: id, mode: next })
        .then((res: unknown) => {
          const m = readMode(res);
          // Trust the optimistic value unless the server explicitly
          // disagrees; avoids a second getState round-trip repaint.
          if (m && m !== next) {
            setMode(m);
            try {
              mqModeCache.set(id, m);
            } catch {
              // ignore
            }
          } else if (!m && asRecord(res).ok !== true) {
            // Revert on hard failure so the row never lies.
            setMode(prev);
            try {
              mqModeCache.set(id, prev);
            } catch {
              // ignore
            }
            toast(ctx, "Message queue", "Queue server offline.", "warning");
          }
        })
        .catch(() => {
          setMode(prev);
          try {
            mqModeCache.set(id, prev);
          } catch {
            // ignore
          }
          toast(ctx, "Message queue", "Queue server offline.", "warning");
        })
        .finally(() => {
          try {
            setToggling(false);
          } catch {
            // ignore
          }
        });
    } catch {
      try {
        setToggling(false);
        toast(ctx, "Message queue", "Queue server offline.", "warning");
      } catch {
        // ignore
      }
    }
  };

  // Fixed-width label: never grows/shrinks while toggling, so no flicker.
  const label = (): string => {
    if (mode() === "steer") {
      return "queue current status: disable";
    }
    return "queue current status: enable";
  };

  return (
    <box
      flexDirection="row"
      onMouseOver={() => setHovered(true)}
      onMouseOut={() => setHovered(false)}
    >
      <text
        fg={(hovered() ? theme.text?.base : theme.text?.muted) as never}
        onMouseUp={() => {
          try {
            onToggle();
          } catch {
            // never break the terminal
          }
        }}
      >
        {`[ ${label()} ]`}
      </text>
    </box>
  );
}

// --- the bar -----------------------------------------------------------------

function QueueBar(props: { sessionID?: string }) {
  const ctx = usePlugin();
  const theme = themeOf(ctx);

  const sid = () => props.sessionID ?? currentSessionID(ctx);
  const reorderEnabled = (() => {
    try {
      return (ctx as any)?.options?.reorder !== false;
    } catch {
      return true;
    }
  })();

  const [items, setItems] = createSignal<InboxItem[]>([]);
  const [viewIndex, setViewIndex] = createSignal(0);
  const [selected, setSelected] = createSignal(0);
  // Hover state: EVERY clickable brightens on hover (standard mental model).
  // Bar body opens the manager dialog; each glyph runs its own action.
  const [hoverBar, setHoverBar] = createSignal(false);
  const [hoverGlyph, setHoverGlyph] = createSignal<number | null>(null);

  // In-flight guard: every real mutation takes it; the view-only ▲/▼ path
  // deliberately does NOT. Module-component scope, cleared in `finally`.
  let mutating = false;
  // Browse-dialog state: `browsing` blocks stacked selects from rapid
  // clicks; `reopenBrowse` lets a structural move close the stale dialog
  // and re-open OUR manager on the fresh inbox IDs instead of dropping
  // the user into whichever native dialog matches next.
  let browsing = false;
  let reopenBrowse = false;

  const clampIndex = (i: number, n: number): number => {
    if (n <= 0) return 0;
    if (i < 0) return 0;
    if (i > n - 1) return n - 1;
    return i;
  };

  const syncQuiet = async (): Promise<InboxItem[]> => {
    const id = sid();
    if (!id) return items();
    try {
      const pending = (ctx.data as any)?.session?.pending;
      if (pending && typeof pending.sync === "function" && typeof pending.list === "function") {
        await pending.sync(id);
        const list = pending.list(id);
        const next = normalize(list);
        setItems(next);
        return next;
      }
    } catch {
      // fall through to the direct client call
    }
    try {
      const next = await inboxList((ctx as any).client, id);
      setItems(next);
      return next;
    } catch {
      return items();
    }
  };

  const invalidate = async (): Promise<void> => {
    const id = sid();
    if (!id) return;
    try {
      const pending = (ctx as any)?.data?.session?.pending;
      if (pending && typeof pending.invalidate === "function") pending.invalidate(id);
    } catch {
      // ignore
    }
  };

  const afterChange = async (): Promise<InboxItem[]> => {
    await invalidate();
    const next = await syncQuiet();
    setViewIndex((i) => clampIndex(i, next.length));
    setSelected((s) => clampIndex(s, affordances(next.length, viewIndex(), reorderEnabled).length));
    return next;
  };

  const refresh = async (): Promise<void> => {
    await syncQuiet();
    setViewIndex((i) => clampIndex(i, items().length));
    setSelected((s) => clampIndex(s, affordances(items().length, viewIndex(), reorderEnabled).length));
  };

  const visible = () => items()[clampIndex(viewIndex(), items().length)];

  // Live updates: any inbox/session event re-syncs (debounced). Cheap cache
  // sync; the bar only repaints when the list actually changes.
  let debounce: ReturnType<typeof setTimeout> | null = null;
  let stopListening: (() => void) | null = null;
  try {
    const listen = (ctx.data as any)?.listen;
    if (typeof listen === "function") {
      stopListening =
        listen((evt: any) => {
          try {
            const t = String(evt?.details?.type ?? evt?.type ?? "");
            if (!/inbox|session|prompt|message/i.test(t)) return;
            if (debounce) clearTimeout(debounce);
            debounce = setTimeout(() => void refresh().catch(() => {}), 300);
          } catch {
            // ignore
          }
        }) ?? null;
    }
  } catch {
    // hosts without data.listen keep manual refresh only
  }
  onCleanup(() => {
    try {
      if (debounce) clearTimeout(debounce);
      stopListening?.();
    } catch {
      // ignore
    }
  });
  void refresh().catch(() => {});

  // --- mutations (all guarded, all toast their outcome) ----------------------

  const guard = async (label: string, fn: () => Promise<unknown>): Promise<unknown> => {
    if (mutating) {
      toast(ctx, "Message queue", "Already working — try again in a moment.", "warning");
      return undefined;
    }
    mutating = true;
    try {
      return await fn();
    } catch (error) {
      toast(ctx, "Message queue", error instanceof Error ? error.message : String(error), "error");
      return undefined;
    } finally {
      mutating = false;
    }
  };

  /** Re-read first: never act on a stale view of the queue. */
  const fresh = async (): Promise<{ id: string; list: InboxItem[] } | undefined> => {
    const list = await syncQuiet();
    const v = visible();
    if (!v || !list.some((it) => it.id === v.id)) {
      toast(ctx, "Message queue", "That message already ran — queue changed.", "warning");
      await afterChange();
      return undefined;
    }
    return { id: v.id, list };
  };

  const doSend = () =>
    guard("send", async () => {
      const f = await fresh();
      const id = sid();
      if (!f || !id) return;
      await inboxUpdate((ctx as any).client, id, f.id, "steer");
      await afterChange();
    });

  const doCancel = () =>
    guard("cancel", async () => {
      const f = await fresh();
      const id = sid();
      if (!f || !id) return;
      await inboxCancel((ctx as any).client, id, f.id);
      setViewIndex(0);
      await afterChange();
    });

  const doEdit = () =>
    guard("edit", async () => {
      const f = await fresh();
      const id = sid();
      if (!f || !id) return;
      const item = f.list.find((it) => it.id === f.id);
      if (!item) return;
      let next: string | undefined;
      try {
        next = (await (ctx.ui.dialog as any).prompt({
          title: "Edit queued message",
          placeholder: item.text,
          initial: item.text,
        })) as string | undefined;
      } catch {
        return;
      }
      if (typeof next !== "string" || !next.trim() || next === item.text) return;
      await inboxCancel((ctx as any).client, id, item.id);
      await promptQueue((ctx as any).client, id, next, { [BYPASS_KEY]: true }, item, keepDelivery(item));
      setViewIndex(0);
      await afterChange();
    });

  /**
   * Move the visible item from `from` to `to` by cancelling the affected
   * suffix and re-admitting it in the new order. New inbox IDs; items before
   * `lo` are untouched. Unguarded core — callers take the guard themselves.
   *
   * Works uniformly from any position: `lo == 0` (front edge) cancels the
   * whole list, a single-item suffix (back edge) is just cancel-one +
   * re-admit. The verification read bypasses the `pending` cache (direct
   * `inboxList` after `invalidate`) — `syncQuiet` alone can return the
   * pre-cancel snapshot, which used to false-trigger the mid-reorder abort
   * on every attempt.
   */
  const verifyClear = async (client: any, id: string): Promise<Set<string>> => {
    await invalidate();
    try {
      const check = await inboxList(client, id);
      return new Set(check.map((c) => c.id));
    } catch {
      // Verification read failed: fall back to the cached sync rather than
      // aborting a reorder whose cancels may already have executed.
      const check = await syncQuiet();
      return new Set(check.map((c) => c.id));
    }
  };

  const reorderCore = async (from: number, to: number): Promise<void> => {
    const id = sid();
    if (!id) return;
    const list = await syncQuiet();
    if (!list[from] || !list[to]) {
      toast(ctx, "Message queue", "Queue changed — reorder aborted.", "warning");
      await afterChange();
      return;
    }
    const client = (ctx as any).client;
    const lo = Math.min(from, to);
    const suffix = list.slice(lo);
    const moved = [...suffix];
    const a = from - lo;
    const b = to - lo;
    const [picked] = moved.splice(a, 1);
    moved.splice(b, 0, picked);
    // Per-item tolerance: an already-gone item must not abort the whole
    // reorder mid-way (leaving a half-cancelled suffix). Verification below
    // is the single source of truth for what actually survived.
    for (const it of suffix) {
      try {
        await inboxCancel(client, id, it.id);
      } catch {
        // ignore: already removed concurrently
      }
    }
    // If anything survived the cancels (promoted concurrently), abort the
    // re-admit: re-prompting it would duplicate a message the model got.
    const checkIds = await verifyClear(client, id);
    if (suffix.some((s) => checkIds.has(s.id))) {
      toast(ctx, "Message queue", "Queue changed mid-reorder — no changes made.", "warning");
      await afterChange();
      return;
    }
    for (const it of moved) {
      await promptQueue(client, id, it.text, { [REORDER_KEY]: true }, it, keepDelivery(it));
    }
    await afterChange();
    setViewIndex(to);
    toast(ctx, "Message queue", `Moved to position ${to + 1} of ${list.length}.`, "success");
  };

  const doReorder = (from: number, to: number) => guard("reorder", () => reorderCore(from, to));

  const doBrowse = async (): Promise<void> => {
    // No stacked selects: rapid bar clicks while one is open are ignored.
    if (browsing) return;
    const list = await syncQuiet();
    if (list.length === 0) return;
    browsing = true;
    let choice: string | undefined;
    try {
      choice = (await (ctx.ui.dialog as any).select({
        title: "Queued messages",
        placeholder: "Choose a message to view",
        options: list.map((it, i) => ({
          title: `${i + 1}. ${oneLine(it.text, 60)}`,
          value: it.id,
          // Delivery state first, then a long preview so truncated titles
          // stay distinguishable for long messages.
          description: `${it.delivery === "steer" ? "sending now" : "queued"} · ${oneLine(it.text, 300)}`,
        })),
        actions: [
          {
            bind: "ctrl+s",
            title: "Send now",
            onTrigger: (value: unknown) => {
              if (typeof value === "string") void sendOne(value);
            },
          },
          {
            bind: "ctrl+e",
            title: "Edit",
            onTrigger: (value: unknown) => {
              if (typeof value === "string") void editOne(value);
            },
          },
          {
            bind: "ctrl+u",
            title: "Move up",
            onTrigger: (value: unknown) => {
              if (typeof value === "string") void moveOne(value, -1);
            },
          },
          {
            bind: "ctrl+d",
            title: "Move down",
            onTrigger: (value: unknown) => {
              if (typeof value === "string") void moveOne(value, 1);
            },
          },
          {
            bind: "ctrl+o",
            title: "Move to front",
            onTrigger: (value: unknown) => {
              if (typeof value === "string") void moveToFront(value);
            },
          },
          {
            bind: "ctrl+x",
            title: "Cancel",
            onTrigger: (value: unknown) => {
              if (typeof value === "string") void cancelOne(value);
            },
          },
        ],
      })) as string | undefined;
    } catch {
      browsing = false;
      return;
    }
    browsing = false;
    // A structural move closed this dialog via closeDialog: re-open OUR
    // manager on the fresh inbox IDs instead of leaving the user to fall
    // into a native dialog holding dead IDs.
    if (reopenBrowse) {
      reopenBrowse = false;
      const freshList = await syncQuiet();
      if (freshList.length === 0) return;
      return void doBrowse();
    }
    if (typeof choice !== "string") return;
    const idx = items().findIndex((it) => it.id === choice);
    if (idx >= 0) setViewIndex(idx);
  };

  const moveToFront = (inboxID: string) =>
    guard("move-to-front", async () => {
      const id = sid();
      if (!id) return;
      const list = await syncQuiet();
      const idx = list.findIndex((it) => it.id === inboxID);
      if (idx <= 0) {
        if (idx === 0) toast(ctx, "Message queue", "Already first.", "info");
        else toast(ctx, "Message queue", "That message already ran.", "warning");
        await afterChange();
        return;
      }
      const client = (ctx as any).client;
      for (const it of list) {
        try {
          await inboxCancel(client, id, it.id);
        } catch {
          // ignore: already removed concurrently; verification decides
        }
      }
      const checkIds = await verifyClear(client, id);
      if (list.some((s) => checkIds.has(s.id))) {
        toast(ctx, "Message queue", "Queue changed mid-move — no changes made.", "warning");
        await afterChange();
        return;
      }
      const [head, ...rest] = list;
      void head;
      const target = list[idx];
      const reordered = [target, ...list.filter((it) => it.id !== inboxID)];
      for (const it of reordered) {
        await promptQueue(client, id, it.text, { [REORDER_KEY]: true }, it, keepDelivery(it));
      }
      setViewIndex(0);
      await afterChange();
      toast(ctx, "Message queue", "Moved to front.", "success");
      // Our dialog (and any native one) still holds the dead inbox IDs —
      // close it and re-open OUR manager on the fresh list.
      reopenBrowse = true;
      closeDialog();
    });

  const cancelOne = (inboxID: string) =>
    guard("cancel-one", async () => {
      const id = sid();
      if (!id) return;
      await inboxCancel((ctx as any).client, id, inboxID);
      setViewIndex(0);
      await afterChange();
      closeDialog();
    });

  /** Dismiss the browse dialog if it is open. Best-effort. */
  const closeDialog = (): void => {
    try {
      (ctx.ui.dialog as any).clear();
    } catch {
      // ignore
    }
  };

  const sendOne = (inboxID: string) =>
    guard("send-one", async () => {
      const id = sid();
      if (!id) return;
      const list = await syncQuiet();
      if (!list.some((it) => it.id === inboxID)) {
        toast(ctx, "Message queue", "That message already ran.", "warning");
        await afterChange();
        return;
      }
      await inboxUpdate((ctx as any).client, id, inboxID, "steer");
      await afterChange();
      closeDialog();
    });

  const editOne = (inboxID: string) =>
    guard("edit-one", async () => {
      const id = sid();
      if (!id) return;
      const list = await syncQuiet();
      const item = list.find((it) => it.id === inboxID);
      if (!item) {
        toast(ctx, "Message queue", "That message already ran.", "warning");
        await afterChange();
        return;
      }
      // Close the browse dialog first so the edit prompt never stacks on it.
      closeDialog();
      let next: string | undefined;
      try {
        next = (await (ctx.ui.dialog as any).prompt({
          title: "Edit queued message",
          placeholder: item.text,
          initial: item.text,
        })) as string | undefined;
      } catch {
        return;
      }
      if (typeof next !== "string" || !next.trim() || next === item.text) return;
      await inboxCancel((ctx as any).client, id, item.id);
      await promptQueue((ctx as any).client, id, next, { [BYPASS_KEY]: true }, item, keepDelivery(item));
      setViewIndex(0);
      await afterChange();
    });

  /** Full-message viewer: clicking the bar body opens the visible message in
   * a scrollable read-only dialog (edit / send / back to list / close).
   * Long messages are never fully readable in the one-line bar, so this is
   * the only place the complete text is shown. */
  const doView = (): void => {
    void (async () => {
      const list = await syncQuiet();
      const v = visible();
      if (!v || !list.some((it) => it.id === v.id)) {
        toast(ctx, "Message queue", "That message already ran — queue changed.", "warning");
        await afterChange();
        return;
      }
      const id = v.id;
      const text = v.text;
      const n = list.length;
      const pos = list.findIndex((it) => it.id === id) + 1;
      const theme = themeOf(ctx);
      const close = (): void => {
        try {
          (ctx.ui.dialog as any).clear();
        } catch {
          // ignore
        }
      };
      const btn = (label: string, run: () => void) => (
        <text
          fg={theme.text?.muted as never}
          onMouseUp={(e: any) => {
            try {
              e?.stopPropagation?.();
            } catch {
              // ignore
            }
            run();
          }}
        >
          {` ${label}`}
        </text>
      );
      try {
        (ctx.ui.dialog as any).show(() => (
          <box flexDirection="column">
            <text fg={theme.text?.base as never}>{`Queued message ${pos}/${n}`}</text>
            <scrollbox height={14}>
              <box flexDirection="column">
                <text fg={theme.text?.base as never}>{text}</text>
              </box>
            </scrollbox>
            <box flexDirection="row">
              {btn("[edit]", () => void editOne(id))}
              {btn("[send]", () => void sendOne(id))}
              {btn("[list]", () => {
                close();
                void doBrowse();
              })}
              {btn("[close]", () => close())}
            </box>
          </box>
        ));
        try {
          (ctx.ui.dialog as any).setSize("xlarge");
        } catch {
          // older hosts without setSize keep the default width
        }
      } catch {
        // Custom JSX unsupported: fall back to a plain alert with full text.
        try {
          await (ctx.ui.dialog as any).alert({ title: `Queued message ${pos}/${n}`, message: text });
        } catch {
          // ignore: never break the terminal
        }
      }
    })();
  };

  const moveOne = (inboxID: string, delta: number) =>
    guard("move-one", async () => {
      const list = await syncQuiet();
      const idx = list.findIndex((it) => it.id === inboxID);
      if (idx < 0) {
        toast(ctx, "Message queue", "That message already ran.", "warning");
        await afterChange();
        return;
      }
      const to = idx + delta;
      if (to < 0 || to >= list.length) {
        toast(ctx, "Message queue", "Already at the edge.", "info");
        return;
      }
      // reorderCore (not doReorder): we already hold the guard.
      await reorderCore(idx, to);
      // Re-open OUR manager on the fresh IDs; see moveToFront.
      reopenBrowse = true;
      closeDialog();
    });

  // --- selection model -------------------------------------------------------

  const ascii = (): boolean => {
    try {
      return (ctx as any)?.options?.glyphs !== "unicode";
    } catch {
      return true;
    }
  };

  const affords = (): AffordID[] => affordances(items().length, viewIndex(), reorderEnabled);
  const behind = () => Math.max(0, items().length - viewIndex() - 1);

  /** Cell budget for the bar body: terminal width minus the counter prefix
   * and the action tokens, so long messages truncate instead of pushing the
   * clickable actions off-screen. Clamped to a sane range. */
  const bodyBudget = (): number => {
    const n = items().length;
    const prefix = `queued ${viewIndex() + 1}/${n} `;
    const tokens = affords().reduce((w, a) => w + cellWidthOf(glyphOf(a, behind(), ascii())) + 1, 0);
    return Math.min(120, Math.max(20, termWidthOf(ctx) - cellWidthOf(prefix) - tokens - 2));
  };

  const activate = (a: AffordID): void => {
    const vi = viewIndex();
    const n = items().length;
    switch (a) {
      case "up":
        setViewIndex(clampIndex(vi - 1, n));
        break;
      case "down":
        setViewIndex(clampIndex(vi + 1, n));
        break;
      case "all":
        void doBrowse();
        break;
      case "shiftUp":
        void doReorder(vi, vi - 1);
        break;
      case "shiftDown":
        void doReorder(vi, vi + 1);
        break;
      case "edit":
        void doEdit();
        break;
      case "cancel":
        void doCancel();
        break;
      case "send":
        void doSend();
        break;
    }
  };

  const moveSelection = (delta: number): void => {
    const list = affords();
    if (list.length === 0) return;
    setSelected((s) => clampIndex(s + delta, list.length));
  };

  // Arrow capture, scoped to this bar's own element so typing in the composer
  // is never affected. If the host has no such scoping, this throws, we catch
  // it, and mouse + dialog selection remain fully usable.
  let rootEl: unknown = null;
  try {
    ctx.keymap.layer(() => ({
      target: () => rootEl,
      commands: [
        { id: "mq.left", bind: "left", run: () => moveSelection(-1) },
        { id: "mq.right", bind: "right", run: () => moveSelection(1) },
        {
          id: "mq.activate",
          bind: "enter",
          run: () => {
            const a = affords()[selected()];
            if (a) activate(a);
          },
        },
        { id: "mq.send", bind: "s", run: () => void doSend() },
        { id: "mq.all", bind: "a", run: () => void doBrowse() },
        { id: "mq.view", bind: "v", run: () => doView() },
        { id: "mq.cancel", bind: "x", run: () => void doCancel() },
        { id: "mq.edit", bind: "e", run: () => void doEdit() },
        { id: "mq.shiftUp", bind: "[", run: () => void doReorder(viewIndex(), viewIndex() - 1) },
        { id: "mq.shiftDown", bind: "]", run: () => void doReorder(viewIndex(), viewIndex() + 1) },
      ],
    }));
  } catch {
    // hosts without targeted layers keep mouse + dialog selection
  }

  const fg = (hot: boolean): unknown =>
    (hot ? theme.text?.base : theme.text?.muted) as never;

  return (
    <>
      <Show when={sid() && items().length > 0} fallback={null}>
        <box
          ref={(el: unknown) => {
            rootEl = el;
          }}
          flexDirection="row"
          onMouseUp={() => doView()}
          onMouseOver={() => setHoverBar(true)}
          onMouseOut={() => {
            setHoverBar(false);
            setHoverGlyph(null);
          }}
        >
          <text fg={(hoverBar() ? theme.text?.base : theme.text?.muted) as never}>
            {`queued ${viewIndex() + 1}/${items().length} ${oneLineCells(visible()?.text ?? "", bodyBudget(), ascii())} `}
          </text>
          <For each={affords()}>
            {(a, i) => (
              <text
                fg={fg(i() === selected() || hoverGlyph() === i()) as never}
                onMouseOver={() => setHoverGlyph(i())}
                onMouseOut={() => setHoverGlyph(null)}
                onMouseUp={(e: any) => {
                  try {
                    e?.stopPropagation?.();
                  } catch {
                    // hosts without propagation keep both handlers; harmless
                  }
                  activate(a);
                }}
              >
                {` ${glyphOf(a, behind(), ascii())}`}
              </text>
            )}
          </For>
        </box>
      </Show>
      <Show when={sid() && items().length === 0} fallback={null}>
        <IdleRow sessionID={sid() as string} />
      </Show>
    </>
  );
}

export default Plugin.define({
  id: "message-queue-tui",
  async setup(context) {
    const flag = globalThis as unknown as Record<string, unknown>;
    if (flag[LOAD_FLAG]) return;
    flag[LOAD_FLAG] = true;

    const disposables: (() => void)[] = [];
    // One bad slot registration must not fail setup (which would unload the
    // whole TUI plugin) — degrade to fewer contributions instead.
    const safeSlot = (def: any) => {
      try {
        disposables.push(context.ui.slot(def));
      } catch {
        // ignore: that contribution stays unavailable
      }
    };

    safeSlot({
      prepend: "session.composer.top",
      render: (input: any) => <QueueBar sessionID={input?.sessionID} />,
    });

    return () => {
      for (const dispose of disposables) {
        try {
          dispose();
        } catch {
          // ignore
        }
      }
      try {
        flag[LOAD_FLAG] = false;
      } catch {
        // ignore
      }
    };
  },
});
