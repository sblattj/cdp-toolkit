/**
 * evaluate_script — run arbitrary JavaScript in a page's main context over raw
 * CDP and return the evaluated value.
 *
 * Two modes, selected by whether `args` is supplied:
 *   - No args: `Runtime.evaluate` of the raw expression (returnByValue,
 *     awaitPromise). The natural fast path; "1+2" -> 3.
 *   - With args: the expression is treated as a JS function (e.g. an arrow
 *     `(a,b)=>a+b` or a `function(a,b){...}`). We resolve the page's global
 *     object, then `Runtime.callFunctionOn` that global with the expression as
 *     the function declaration and the supplied `args` passed positionally.
 *     This mirrors chrome-devtools-mcp's evaluate_script(function, args) shape.
 *
 * Either way, a `exceptionDetails` in the response is surfaced as a thrown
 * `CdpError` carrying the exception/description text.
 */
import { CdpError, withPage } from "../client.ts";
import type { CdpConnection } from "../client.ts";
import type { TargetSelector } from "../types.ts";

/** A CDP RemoteObject as returned by Runtime.evaluate / Runtime.callFunctionOn. */
interface RemoteObject {
  type: string;
  subtype?: string;
  className?: string;
  value?: unknown;
  unserializableValue?: string;
  description?: string;
  objectId?: string;
}

/** Shape of a CDP exceptionDetails payload (subset we report on). */
interface ExceptionDetails {
  text?: string;
  exception?: RemoteObject;
  lineNumber?: number;
  columnNumber?: number;
}

interface EvalResponse {
  result: RemoteObject;
  exceptionDetails?: ExceptionDetails;
}

export interface EvaluateScriptArgs {
  /** Page selector; defaults to the active page. */
  target?: TargetSelector;
  /**
   * JavaScript to run. When `args` is omitted this is evaluated as an
   * expression. When `args` is provided this must be a function literal
   * (arrow or classic) whose parameters receive the supplied `args`.
   */
  expression: string;
  /** Await the result if it is a Promise (default true). */
  awaitPromise?: boolean;
  /** Positional arguments to pass to the expression (treats it as a function). */
  args?: unknown[];
}

/** Build a readable message out of a CDP exceptionDetails block. */
function exceptionMessage(details: ExceptionDetails): string {
  const ex = details.exception;
  const fromObject =
    ex?.description ??
    (typeof ex?.value === "string" ? ex.value : ex?.value !== undefined ? JSON.stringify(ex.value) : undefined);
  return fromObject ?? details.text ?? "evaluation threw";
}

/**
 * Extract the JS value from a RemoteObject. With returnByValue, `value` holds
 * the serialized value; fall back to unserializableValue (Infinity/NaN/-0) and
 * finally the description for non-serializable objects.
 */
function unwrap(obj: RemoteObject): unknown {
  if (Object.prototype.hasOwnProperty.call(obj, "value")) return obj.value;
  if (obj.unserializableValue !== undefined) return obj.unserializableValue;
  if (obj.type === "undefined") return undefined;
  return obj.description ?? null;
}

async function evaluateExpression(conn: CdpConnection, expression: string, awaitPromise: boolean): Promise<unknown> {
  const res = await conn.send<EvalResponse>("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise,
    // Allow `await` at the top of expressions and surface a usable result.
    replMode: false,
    // Don't let a thrown value escape as a raw protocol error; we read
    // exceptionDetails ourselves below.
    silent: false,
  });
  if (res.exceptionDetails) throw new CdpError(exceptionMessage(res.exceptionDetails));
  return unwrap(res.result);
}

async function evaluateFunction(
  conn: CdpConnection,
  expression: string,
  awaitPromise: boolean,
  args: unknown[],
): Promise<unknown> {
  // Resolve the page's global object to give callFunctionOn an `this`/context.
  const globalObj = await conn.send<{ result: RemoteObject }>("Runtime.evaluate", {
    expression: "globalThis",
    returnByValue: false,
  });
  const objectId = globalObj.result.objectId;
  if (!objectId) throw new CdpError("could not resolve global object for function call");

  const res = await conn.send<EvalResponse>("Runtime.callFunctionOn", {
    objectId,
    functionDeclaration: expression,
    arguments: args.map((value) => ({ value })),
    returnByValue: true,
    awaitPromise,
    silent: false,
  });
  if (res.exceptionDetails) throw new CdpError(exceptionMessage(res.exceptionDetails));
  return unwrap(res.result);
}

/**
 * Evaluate `expression` in the page and return its value. When `args` is
 * supplied, `expression` is invoked as a function with those positional args.
 */
export async function evaluateScript(args: EvaluateScriptArgs): Promise<unknown> {
  const { expression } = args;
  if (typeof expression !== "string" || expression.length === 0) {
    throw new CdpError("evaluateScript: 'expression' must be a non-empty string");
  }
  const awaitPromise = args.awaitPromise ?? true;
  const callArgs = args.args;

  return withPage(args.target, async (conn) => {
    await conn.send("Runtime.enable");
    if (callArgs && callArgs.length > 0) {
      return evaluateFunction(conn, expression, awaitPromise, callArgs);
    }
    return evaluateExpression(conn, expression, awaitPromise);
  });
}

/*
 * CDP methods/domains used:
 *   - Runtime.enable
 *   - Runtime.evaluate           (no-args expression path; returnByValue + awaitPromise)
 *   - Runtime.callFunctionOn     (args path: expression treated as a function literal, called on globalThis)
 *
 * Parity gaps vs chrome-devtools-mcp evaluate_script:
 *   - MCP injects a typed `page`/element handle into the evaluated function; here `args` are plain
 *     JSON-serializable values passed positionally — no live element/page handle is bound.
 *   - Non-serializable return values (DOM nodes, functions, circular objects) come back as their CDP
 *     `description` string rather than a structured handle, since returnByValue is used.
 *   - No isolated-world/contextId selection: evaluation runs in the page's default main-world context.
 */
