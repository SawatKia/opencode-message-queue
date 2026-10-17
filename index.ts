/**
 * message-queue — index.ts (server entrypoint, auto-discovered).
 *
 * Queues follow-up messages instead of letting them interrupt a running turn.
 *
 * OpenCode v2 already owns a DURABLE session inbox:
 *   - delivery "steer" (the default) promotes at the next safe provider-turn
 *     boundary *inside* the current drain — i.e. it interrupts.
 *   - delivery "queue" stays FIFO and promotes one item at a time once the
 *     current drain would otherwise end — i.e. it waits.
 *
 * So this plugin does not reimplement queueing. Its only job is to flip
 * `delivery` from "steer" to "queue" while a session is busy. Ordering,
 * durability, replay and drain are the server's job.
 *
 * The TUI half lives in ./tui.tsx and renders the pending inbox.
 *
 * V2 (OpenCode 2.x) port: default-exports Plugin.define({ id, setup }) and
 * registers ctx.session.hook("prompt") + ctx.tool.transform.
 */

import { Plugin } from "@opencode/plugin";
import { mqRpc } from "./rpc-def.js";

type Mode = "queue" | "steer";

/** Metadata keys the TUI sets on its own re-admissions. */
export const BYPASS_KEY = "__message_queue_bypass";
export const REORDER_KEY = "__message_queue_reorder";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

/** V2 event stream yields { type, data, ... }; v1 used { type, properties }. */
function payloadOf(event: any): any {
  return event?.data ?? event?.properties ?? event?.payload ?? null;
}

/**
 * `session.status` fires for busy AND idle. Treat a payload that explicitly
 * mentions a working state as busy, and anything else as idle.
 */
function payloadIsBusy(payload: any): boolean {
  if (!payload) return false;
  try {
    const s = JSON.stringify(payload).toLowerCase();
    if (s.includes("busy") || s.includes("running") || s.includes("working") || s.includes("active")) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

function sessionIDOf(event: any): string | undefined {
  const direct = event?.sessionID;
  if (typeof direct === "string" && direct) return direct;
  const nested = event?.prompt?.sessionID;
  return typeof nested === "string" && nested ? nested : undefined;
}

export default Plugin.define({
  id: "message-queue",
  async setup(ctx: any) {
    const options = (ctx.options ?? {}) as Record<string, unknown>;

    const defaultMode: Mode = options.mode === "steer" ? "steer" : "queue";
    const reorderEnabled = options.reorder !== false;
    const quiet = options.quiet === true;

    // Runtime state. Deliberately NOT in ctx.storage — it is per-process, not
    // durable, and must never outlive the server.
    const busy = new Map<string, boolean>();
    const modeBySession = new Map<string, Mode>();

    const log = async (message: string, extra?: unknown) => {
      try {
        await ctx.app.log({
          body: { service: "message-queue", level: "info", message, extra },
        });
      } catch {
        // logging must never break the event path
      }
    };

    const modeFor = (sessionID: string): Mode => modeBySession.get(sessionID) ?? defaultMode;

    const describe = (sessionID: string) => {
      const mode = modeFor(sessionID);
      const queued = queuedHint.get(sessionID) ?? 0;
      return `Mode: ${mode}${reorderEnabled ? "" : " (reorder disabled)"}` +
        `\nSession busy: ${busy.get(sessionID) === true}` +
        `\nKnown pending: ${queued}` +
        `\nUse /queue hold to queue messages, /queue steer to interrupt immediately.`;
    };

    // Best-effort pending count. The server owns the truth; this only feeds the
    // agent-facing tool output and is never used to decide delivery.
    const queuedHint = new Map<string, number>();

    // --- Busy tracking ----------------------------------------------------
    try {
      const controller = new AbortController();
      void (async () => {
        try {
          for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
            try {
              const type = (event as any)?.type;
              const payload = payloadOf(event);
              const sessionID = (payload as any)?.sessionID ?? (event as any)?.sessionID;
              if (typeof type !== "string" || typeof sessionID !== "string") continue;

              if (type === "session.execution.started") {
                busy.set(sessionID, true);
              } else if (
                type === "session.execution.succeeded" ||
                type === "session.execution.failed" ||
                type === "session.execution.interrupted" ||
                type === "session.idle"
              ) {
                busy.set(sessionID, false);
              } else if (type === "session.status") {
                busy.set(sessionID, payloadIsBusy(payload));
              }
            } catch {
              // per-event errors must never kill the subscription
            }
          }
        } catch {
          // aborted on unload — ignore
        }
      })();
    } catch (error) {
      void log("event subscription failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // --- The whole point: flip steer -> queue while busy ------------------
    try {
      if (ctx?.session && typeof ctx.session.hook === "function") {
        await ctx.session.hook("prompt", (event: any) => {
          try {
            const sessionID = sessionIDOf(event);
            if (!sessionID) return;
            if (modeFor(sessionID) !== "queue") return;

            const meta = asRecord(event?.metadata);
            // Our own re-admissions (edit, reorder) must never be re-queued.
            if (meta[BYPASS_KEY] === true) return;
            if (meta[REORDER_KEY] === true) return;

            if (busy.get(sessionID) !== true) return;

            event.delivery = "queue";
            if (!quiet) {
              void log("queued a follow-up message", { sessionID });
            }
          } catch {
            // a hook failure must never block prompt admission
          }
        });
      }
    } catch (error) {
      void log("prompt hook registration failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // --- Agent-facing tool ------------------------------------------------
    try {
      if (ctx?.tool && typeof ctx.tool.transform === "function") {
        await ctx.tool.transform((editor: any) => {
          // Synchronous by contract: close over plain maps, load nothing here.
          editor.add({
            name: "queue",
            description:
              "Inspect or change message-queue mode for the current session. " +
              "Use 'hold' to queue follow-up messages until the current turn finishes, " +
              "'steer' to send them immediately (interrupting), and 'status' to report. " +
              "Only change the mode when the user explicitly asks.",
            input: {
              type: "object",
              properties: {
                action: {
                  type: "string",
                  enum: ["status", "hold", "steer"],
                  description: "status (default), hold, or steer",
                },
              },
              additionalProperties: false,
            },
            output: { type: "string" },
            execute: async (input: unknown, toolCtx: any) => {
              // Never throw: a throwing executor fails the whole model turn.
              try {
                const action = (asRecord(input).action as string) ?? "status";
                const sessionID =
                  typeof toolCtx?.sessionID === "string" ? toolCtx.sessionID : undefined;
                if (!sessionID) return { output: "Message queue: no session ID." };

                if (action === "hold" || action === "queue") {
                  modeBySession.set(sessionID, "queue");
                  return { output: `Message queue mode set to: queue\n${describe(sessionID)}` };
                }
                if (action === "steer" || action === "immediate") {
                  modeBySession.set(sessionID, "steer");
                  return { output: `Message queue mode set to: steer\n${describe(sessionID)}` };
                }
                return { output: describe(sessionID) };
              } catch (error) {
                return {
                  output: `Message queue unavailable: ${
                    error instanceof Error ? error.message : String(error)
                  }`,
                };
              }
            },
          });
        });
      }
    } catch (error) {
      void log("tool registration failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // --- RPC (consumed by the TUI) ----------------------------------------
    try {
      await ctx.rpc.register(mqRpc as never, {
        getState: async (input: unknown) => {
          try {
            const { sessionID } = asRecord(input) as { sessionID?: unknown };
            if (typeof sessionID !== "string" || !sessionID) {
              return { ok: false as const, error: "getState requires sessionID" };
            }
            return {
              ok: true as const,
              mode: modeFor(sessionID),
              reorder: reorderEnabled,
              busy: busy.get(sessionID) === true,
            };
          } catch (error) {
            return {
              ok: false as const,
              error: error instanceof Error ? error.message : String(error),
            };
          }
        },
        setMode: async (input: unknown) => {
          try {
            const { sessionID, mode } = asRecord(input) as {
              sessionID?: unknown;
              mode?: unknown;
            };
            if (typeof sessionID !== "string" || !sessionID) {
              return { ok: false as const, error: "setMode requires sessionID" };
            }
            if (mode !== "queue" && mode !== "steer") {
              return {
                ok: false as const,
                error: 'setMode requires mode "queue" or "steer"',
              };
            }
            modeBySession.set(sessionID, mode);
            return { ok: true as const, mode };
          } catch (error) {
            return {
              ok: false as const,
              error: error instanceof Error ? error.message : String(error),
            };
          }
        },
      });
    } catch (error) {
      void log("rpc registration failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // --- Slash command ------------------------------------------------------
    try {
      await ctx.command.transform((editor: any) => {
        editor.add({
          name: "queue",
          description:
            "Queue follow-up messages (hold) or send immediately (steer); bare /queue shows status.",
          execute: async (input: any) => {
            // Never throw: post the degradation as text instead of failing
            // the turn that invoked the command.
            try {
              const sessionID =
                typeof input?.sessionID === "string" ? input.sessionID : undefined;
              if (!sessionID) return;
              const rawText =
                typeof input?.prompt?.text === "string" ? input.prompt.text : "";
              // Parse the trailing word (the command name itself is stripped,
              // so the args text is what remains).
              const words = rawText.trim().split(/\s+/).filter(Boolean);
              const last = (words[words.length - 1] ?? "").toLowerCase();
              let text: string;
              if (last === "hold" || last === "queue") {
                modeBySession.set(sessionID, "queue");
                text = `Message queue mode set to: queue\n${describe(sessionID)}`;
              } else if (
                last === "steer" ||
                last === "immediate" ||
                last === "send"
              ) {
                modeBySession.set(sessionID, "steer");
                text = `Message queue mode set to: steer\n${describe(sessionID)}`;
              } else {
                text = describe(sessionID);
              }
              try {
                await ctx.session.synthetic({ sessionID, text });
              } catch {
                // posting must never break the command
              }
            } catch (error) {
              try {
                const sessionID =
                  typeof input?.sessionID === "string" ? input.sessionID : undefined;
                if (sessionID) {
                  await ctx.session.synthetic({
                    sessionID,
                    text: `Message queue unavailable: ${
                      error instanceof Error ? error.message : String(error)
                    }`,
                  });
                }
              } catch {
                // last-resort posting must never throw either
              }
            }
          },
        });
      });
    } catch (error) {
      void log("command registration failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // In-memory maps die with the process; nothing to dispose beyond that.
    return () => {
      busy.clear();
      modeBySession.clear();
      queuedHint.clear();
    };
  },
});