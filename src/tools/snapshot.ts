/**
 * Accessibility snapshot + the shared element-reference helper.
 *
 * The reference scheme (CONTRACT.md "The element-reference scheme"):
 *   A `Uid` IS a CDP `backendDOMNodeId` (a number). Refs are therefore
 *   stateless — `take_snapshot` emits them straight from the a11y tree, and
 *   every interaction tool resolves them back to a live DOM node via
 *   `DOM.resolveNode({ backendNodeId: uid })`. There is no server-side ref
 *   table to drift or expire.
 */
import type { CdpConnection } from "../client.ts";
import { withPage } from "../client.ts";
import type { Target, TargetSelector, Uid } from "../types.ts";

/* --------------------------- Accessibility AX types --------------------------- */

interface AxValue {
  type?: string;
  value?: unknown;
}

interface AxProperty {
  name: string;
  value?: AxValue;
}

interface AxNode {
  nodeId: string;
  ignored?: boolean;
  role?: AxValue;
  name?: AxValue;
  value?: AxValue;
  description?: AxValue;
  properties?: AxProperty[];
  childIds?: string[];
  backendDOMNodeId?: number;
  parentId?: string;
}

/** Roles that are meaningful to a downstream agent driving the page. */
const INTERACTIVE_ROLES = new Set<string>([
  "button",
  "link",
  "textbox",
  "searchbox",
  "checkbox",
  "radio",
  "combobox",
  "listbox",
  "option",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "tab",
  "switch",
  "slider",
  "spinbutton",
  "textfield",
  "MenuItem",
  "Button",
]);

function axString(v: AxValue | undefined): string | undefined {
  if (!v) return undefined;
  const raw = v.value;
  if (raw === undefined || raw === null) return undefined;
  const s = String(raw).trim();
  return s.length ? s : undefined;
}

function propValue(node: AxNode, name: string): string | undefined {
  const p = node.properties?.find((x) => x.name === name);
  return axString(p?.value);
}

function isInteractive(role: string | undefined): boolean {
  if (!role) return false;
  return INTERACTIVE_ROLES.has(role) || INTERACTIVE_ROLES.has(role.toLowerCase());
}

/** Build the single-line summary for one AX node, or undefined to skip it. */
function formatNode(node: AxNode, interactiveOnly: boolean): string | undefined {
  const role = axString(node.role);
  const name = axString(node.name);
  const uid = node.backendDOMNodeId;

  // Nodes without a backend DOM id cannot be referenced by interaction tools.
  if (uid === undefined) return undefined;

  if (interactiveOnly && !isInteractive(role)) return undefined;

  // In full mode, skip structurally-empty generic containers (no role/name).
  if (!interactiveOnly && !role && !name) return undefined;

  const extras: string[] = [];
  const value = axString(node.value);
  if (value) extras.push(`value=${JSON.stringify(value)}`);
  const checked = propValue(node, "checked");
  if (checked && checked !== "false") extras.push(`checked=${checked}`);
  const expanded = propValue(node, "expanded");
  if (expanded) extras.push(`expanded=${expanded}`);
  const disabled = propValue(node, "disabled");
  if (disabled === "true") extras.push("disabled");
  const url = propValue(node, "url");
  if (url) extras.push(`url=${url}`);
  const focused = propValue(node, "focused");
  if (focused === "true") extras.push("focused");

  const label = name ? ` ${JSON.stringify(name)}` : "";
  const extra = extras.length ? ` [${extras.join(" ")}]` : "";
  return `[${uid}] ${role ?? "generic"}${label}${extra}`;
}

export interface TakeSnapshotArgs {
  target?: TargetSelector;
  /** When true, emit only interactive/meaningful nodes (default false = full tree). */
  interactiveOnly?: boolean;
}

export interface TakeSnapshotResult {
  snapshot: string;
  target: { id: string; url: string; title: string };
  nodeCount: number;
}

/**
 * take_snapshot — Accessibility.getFullAXTree walked into a compact indented
 * text tree. Each emitted line carries the node's backendDOMNodeId as [uid],
 * which interaction tools feed straight back to resolveUid.
 */
export async function takeSnapshot(args: TakeSnapshotArgs = {}): Promise<TakeSnapshotResult> {
  const interactiveOnly = args.interactiveOnly ?? false;
  return withPage(args.target, async (conn, target) => {
    await conn.send("Accessibility.enable");
    const { nodes } = await conn.send<{ nodes: AxNode[] }>("Accessibility.getFullAXTree");

    const byId = new Map<string, AxNode>();
    for (const n of nodes) byId.set(n.nodeId, n);

    // Find roots: a node whose parentId is absent or not present in the set.
    const roots = nodes.filter((n) => !n.parentId || !byId.has(n.parentId));

    const lines: string[] = [];
    let nodeCount = 0;

    const walk = (node: AxNode, depth: number): void => {
      const line = node.ignored ? undefined : formatNode(node, interactiveOnly);
      // In interactiveOnly mode we keep tree depth flat for emitted nodes so the
      // output stays readable; in full mode we preserve hierarchy via indent.
      if (line !== undefined) {
        const indent = interactiveOnly ? "" : "  ".repeat(depth);
        lines.push(`${indent}${line}`);
        nodeCount++;
      }
      const childDepth = line !== undefined && !interactiveOnly ? depth + 1 : depth;
      for (const childId of node.childIds ?? []) {
        const child = byId.get(childId);
        if (child) walk(child, childDepth);
      }
    };

    for (const root of roots) walk(root, 0);

    return {
      snapshot: lines.join("\n"),
      target: { id: target.id, url: target.url, title: target.title },
      nodeCount,
    } satisfies TakeSnapshotResult;
  });
}

/* ------------------------------ shared ref helper ------------------------------ */

/**
 * Resolve a Uid (backendDOMNodeId) to a live JS object handle. Shared by every
 * interaction tool in input.ts. Throws if the node no longer exists.
 */
export async function resolveUid(conn: CdpConnection, uid: Uid): Promise<{ objectId: string }> {
  const { object } = await conn.send<{ object: { objectId?: string } }>("DOM.resolveNode", {
    backendNodeId: uid,
  });
  if (!object?.objectId) {
    throw new Error(`resolveUid: DOM.resolveNode returned no objectId for uid ${uid}`);
  }
  return { objectId: object.objectId };
}

/**
 * Internal helper exposed for input.ts: load the active page target so input
 * tools can echo it back without re-resolving. Not part of the public tool set.
 */
export type SnapshotTarget = Pick<Target, "id" | "url" | "title">;

/* ------------------------------------------------------------------------------
 * CDP methods used:
 *   Accessibility.enable, Accessibility.getFullAXTree (take_snapshot)
 *   DOM.resolveNode                                   (resolveUid helper)
 * Parity gaps vs chrome-devtools-mcp take_snapshot:
 *   - MCP assigns sequential ref ids (1,2,3...) backed by a server-side handle
 *     table; we instead expose the raw backendDOMNodeId as the uid (stateless,
 *     but ids are larger / non-sequential and not human-friendly).
 *   - MCP's snapshot includes a per-frame structure and a "more nodes" cursor;
 *     this returns the full tree in one shot (frames flattened into one tree).
 *   - interactiveOnly is our addition (flattens to interactive nodes only);
 *     MCP always returns the structured tree.
 * ---------------------------------------------------------------------------- */
