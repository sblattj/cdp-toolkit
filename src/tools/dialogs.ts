/**
 * dialogs.ts — JavaScript dialog handling (alert / confirm / prompt / beforeunload).
 *
 * Replicates chrome-devtools-mcp's `handle_dialog`. A JS dialog opened by the
 * page (alert/confirm/prompt/beforeunload) blocks the renderer until the
 * embedder responds via Page.handleJavaScriptDialog. Over raw CDP we:
 *   1. Page.enable
 *   2. subscribe to Page.javascriptDialogOpening
 *   3. on fire, respond with Page.handleJavaScriptDialog({ accept, promptText })
 *
 * Two modes are supported per CONTRACT:
 *   - "wait for next dialog then handle" (default): arm the listener and resolve
 *     when the next dialog is handled, or time out if none appears.
 *   - "auto-handle for N ms" ({ autoMs }): handle every dialog that opens during
 *     a fixed window, then resolve with the list handled.
 *
 * Because a dialog blocks the renderer, the code that *triggers* the dialog
 * (e.g. a Runtime.evaluate of `confirm("x")`) must NOT be awaited before the
 * dialog is handled — otherwise it deadlocks. `handleDialogForExpression` arms
 * the listener, fires the expression WITHOUT awaiting, waits for the dialog to
 * be handled, then awaits the now-unblocked evaluate result.
 */
import type { CdpConnection } from "../client.ts";
import { CdpError, openPage } from "../client.ts";
import type { TargetSelector } from "../types.ts";

/** Raw shape of the Page.javascriptDialogOpening event params. */
interface JavascriptDialogOpening {
  url: string;
  message: string;
  type: "alert" | "confirm" | "prompt" | "beforeunload" | string;
  hasBrowserHandler: boolean;
  defaultPrompt?: string;
}

/** A single handled dialog. */
export interface HandledDialog {
  type: string;
  message: string;
  url: string;
  defaultPrompt?: string;
  accept: boolean;
  promptText?: string;
  handled: true;
}

export interface HandleDialogArgs {
  target?: TargetSelector;
  /** Whether to accept (OK) or dismiss (Cancel) the dialog. */
  accept: boolean;
  /** Text to enter for a prompt() dialog when accepting. */
  promptText?: string;
  /** How long to wait for the next dialog (default 15000ms). */
  timeoutMs?: number;
  /**
   * Auto-handle mode: keep handling every dialog that opens for this many ms,
   * then resolve. When set, the return value is a list of handled dialogs and
   * the function never throws on "no dialog" (an empty list is a valid result).
   */
  autoMs?: number;
}

/**
 * Arm a dialog handler on a live page connection. Returns a disarm function and
 * a promise that resolves with each dialog as it is handled (via the onHandled
 * callback). This is the low-level primitive used by both public modes and by
 * the expression helper.
 */
function armDialogHandler(
  conn: CdpConnection,
  accept: boolean,
  promptText: string | undefined,
  onHandled: (d: HandledDialog) => void,
): () => void {
  return conn.on("Page.javascriptDialogOpening", (params) => {
    const ev = params as unknown as JavascriptDialogOpening;
    void (async () => {
      try {
        await conn.send("Page.handleJavaScriptDialog", {
          accept,
          ...(promptText !== undefined ? { promptText } : {}),
        });
        onHandled({
          type: ev.type,
          message: ev.message,
          url: ev.url,
          ...(ev.defaultPrompt !== undefined ? { defaultPrompt: ev.defaultPrompt } : {}),
          accept,
          ...(promptText !== undefined ? { promptText } : {}),
          handled: true,
        });
      } catch {
        /* connection may have raced closed; the awaiter will time out */
      }
    })();
  });
}

/**
 * handle_dialog — wait for the next JS dialog on a page and respond to it.
 *
 * Default mode: opens a persistent connection, enables Page, arms the listener,
 * and resolves with the first handled dialog (or throws on timeout). Auto mode
 * ({ autoMs }): handles every dialog for the window and resolves with the list.
 *
 * The caller is expected to trigger the dialog out-of-band (e.g. by clicking a
 * button on the page). To trigger-and-handle in one call, use
 * handleDialogForExpression.
 */
export async function handleDialog(
  args: HandleDialogArgs,
): Promise<HandledDialog | { handled: HandledDialog[]; count: number }> {
  const { target, accept, promptText, timeoutMs = 15_000, autoMs } = args;
  const { conn } = await openPage(target);
  try {
    await conn.send("Page.enable");

    if (autoMs !== undefined) {
      const handled: HandledDialog[] = [];
      const disarm = armDialogHandler(conn, accept, promptText, (d) => handled.push(d));
      await new Promise<void>((resolve) => setTimeout(resolve, autoMs));
      disarm();
      return { handled, count: handled.length };
    }

    return await new Promise<HandledDialog>((resolve, reject) => {
      const timer = setTimeout(() => {
        disarm();
        reject(new CdpError(`handle_dialog: no dialog opened within ${timeoutMs}ms`));
      }, timeoutMs);
      const disarm = armDialogHandler(conn, accept, promptText, (d) => {
        clearTimeout(timer);
        disarm();
        resolve(d);
      });
    });
  } finally {
    conn.close();
  }
}

export interface HandleDialogForExpressionArgs {
  target?: TargetSelector;
  /** A JS expression that opens a dialog, e.g. `confirm("ok?")` or `prompt("name?")`. */
  expression: string;
  accept: boolean;
  promptText?: string;
  timeoutMs?: number;
}

/**
 * Arm a dialog handler, evaluate an expression that OPENS a dialog (without
 * awaiting it — a blocking dialog would otherwise deadlock the evaluate), wait
 * for the dialog to be handled, then await the now-unblocked evaluate result.
 *
 * Returns both the handled-dialog metadata and the value the expression
 * resolved to (e.g. `true` for an accepted confirm, the entered text for an
 * accepted prompt, `false`/`null` for a dismissed one). This is the
 * trigger-and-handle helper used by the live smoke test.
 */
export async function handleDialogForExpression(
  args: HandleDialogForExpressionArgs,
): Promise<{ dialog: HandledDialog; value: unknown }> {
  const { target, expression, accept, promptText, timeoutMs = 15_000 } = args;
  const { conn } = await openPage(target);
  try {
    await conn.send("Page.enable");
    await conn.send("Runtime.enable");

    let resolveDialog!: (d: HandledDialog) => void;
    let rejectDialog!: (e: Error) => void;
    const dialogPromise = new Promise<HandledDialog>((res, rej) => {
      resolveDialog = res;
      rejectDialog = rej;
    });
    const timer = setTimeout(
      () => rejectDialog(new CdpError(`handle_dialog: expression opened no dialog within ${timeoutMs}ms`)),
      timeoutMs,
    );
    const disarm = armDialogHandler(conn, accept, promptText, (d) => {
      clearTimeout(timer);
      resolveDialog(d);
    });

    // Fire the dialog-opening expression WITHOUT awaiting: a blocking dialog
    // holds the evaluate open until we handle it. We capture the promise so we
    // can await its (now-unblocked) value after the dialog is handled.
    const evalPromise = conn
      .send<{ result: { value?: unknown }; exceptionDetails?: { text?: string } }>("Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise: true,
        // The evaluate itself must not time out before we handle the dialog.
        userGesture: true,
      })
      .catch((e: unknown) => {
        // Surface as an exception-shaped result so the await below can decide.
        return { result: {}, __error: e } as { result: { value?: unknown }; __error: unknown };
      });

    const dialog = await dialogPromise;
    disarm();

    const evalResult = (await evalPromise) as {
      result: { value?: unknown };
      exceptionDetails?: { text?: string };
      __error?: unknown;
    };
    if (evalResult.__error) throw evalResult.__error;
    if (evalResult.exceptionDetails) {
      throw new CdpError(`expression threw: ${evalResult.exceptionDetails.text ?? "unknown error"}`);
    }

    return { dialog, value: evalResult.result?.value };
  } finally {
    conn.close();
  }
}

/* ----------------------------------------------------------------------------
 * CDP methods / domains used:
 *   - Page.enable
 *   - Page.javascriptDialogOpening   (event, subscribed)
 *   - Page.handleJavaScriptDialog    ({ accept, promptText })
 *   - Runtime.enable                 (helper only)
 *   - Runtime.evaluate               (helper only — fires the dialog-opening expr)
 *
 * Parity gaps vs chrome-devtools-mcp `handle_dialog`:
 *   - MCP auto-handles the single pending dialog tracked by its Page object;
 *     here the caller arms first and triggers out-of-band, OR uses the
 *     handleDialogForExpression helper to trigger-and-handle atomically.
 *   - MCP returns its standard page/snapshot envelope after handling; this
 *     returns just the handled-dialog metadata (type/message/url/accept/...).
 *   - beforeunload dialogs are handled the same way but are only emitted when a
 *     real navigation/close is attempted; arming alone does not provoke them.
 * -------------------------------------------------------------------------- */
