/**
 * lighthouse_audit — THE ONLY non-CDP tool in this toolkit.
 *
 * Unlike every other module, this one does NOT speak the Chrome DevTools
 * Protocol over a WebSocket. Instead it shells out to the external Lighthouse
 * CLI (`npx --yes lighthouse ...`) via node:child_process. Lighthouse attaches
 * to the already-running Chrome on the remote-debugging port (9222) through its
 * `--port` flag, drives its own audit, and writes a JSON report. We parse that
 * report and return the per-category scores.
 *
 * Zero npm runtime deps are added: Lighthouse is fetched on-demand by `npx`
 * (the contract's explicit exception for this single module). If npx or
 * Lighthouse is unavailable, we throw a clear CdpError naming the dependency.
 */
import { spawn } from "node:child_process";
import { mkdir, readFile, stat } from "node:fs/promises";
import { CdpError } from "../client.ts";

const ARTIFACT_DIR = process.env.CDP_ARTIFACT_DIR ?? "/tmp/cdp-toolkit";

/** Lighthouse port to attach to the already-running Chrome (matches CDP_BASE). */
function cdpPort(): number {
  const base = process.env.CDP_BASE ?? "http://127.0.0.1:9222";
  const m = base.match(/:(\d+)/);
  return m?.[1] ? Number(m[1]) : 9222;
}

function stamp(): string {
  return new Date(Date.now()).toISOString().replace(/[:.]/g, "-");
}

function shortHost(url: string): string {
  try {
    const u = new URL(url);
    const h = u.hostname || u.protocol.replace(/:$/, "");
    return (h || "page").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 24);
  } catch {
    return "page";
  }
}

/** Result of running a single child process to completion. */
interface SpawnResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  spawnError?: Error;
}

function runProcess(
  cmd: string,
  args: string[],
  opts: { timeoutMs: number },
): Promise<SpawnResult> {
  return new Promise<SpawnResult>((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });

    const timer = setTimeout(() => {
      if (settled) return;
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }, opts.timeoutMs);

    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    child.on("error", (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: null, signal: null, stdout, stderr, spawnError: err });
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

/** The shape we read out of a Lighthouse JSON report (only the bits we need). */
interface LighthouseReport {
  requestedUrl?: string;
  finalUrl?: string;
  finalDisplayedUrl?: string;
  lighthouseVersion?: string;
  fetchTime?: string;
  runtimeError?: { code?: string; message?: string };
  runWarnings?: string[];
  categories?: Record<
    string,
    { id?: string; title?: string; score?: number | null }
  >;
}

export interface LighthouseAuditArgs {
  /** The URL to audit. Required — never points at a user tab implicitly. */
  url: string;
  /**
   * Lighthouse categories to run. Defaults to the full set.
   * e.g. ["performance"], ["performance","accessibility","seo"].
   */
  categories?: string[];
  /** Override the report output path (defaults under ARTIFACT_DIR). */
  savePath?: string;
  /**
   * Form factor: "desktop" (default) or "mobile". Desktop avoids the heavy
   * mobile throttling that makes quick smoke audits slow.
   */
  formFactor?: "desktop" | "mobile";
  /** Overall budget for the lighthouse process (ms). Default 120000. */
  timeoutMs?: number;
}

export interface LighthouseAuditResult {
  path: string;
  bytes: number;
  url: string;
  finalUrl?: string;
  lighthouseVersion?: string;
  fetchTime?: string;
  categories: Record<string, number | null>;
  warnings?: string[];
}

/**
 * Run a Lighthouse audit against `url` using the already-running Chrome on the
 * CDP port. Returns the report path and per-category scores (0..1, or null when
 * a category was not run / not scored).
 */
export async function lighthouseAudit(
  args: LighthouseAuditArgs,
): Promise<LighthouseAuditResult> {
  if (!args || typeof args.url !== "string" || args.url.trim() === "") {
    throw new CdpError("lighthouse_audit requires a non-empty 'url'");
  }
  const url = args.url.trim();
  const timeoutMs = args.timeoutMs ?? 120_000;
  const port = cdpPort();

  await mkdir(ARTIFACT_DIR, { recursive: true });
  const outPath =
    args.savePath ?? `${ARTIFACT_DIR}/lighthouse-${shortHost(url)}-${stamp()}.json`;

  const formFactor = args.formFactor ?? "desktop";
  const lhArgs: string[] = [
    "--yes",
    "lighthouse",
    url,
    `--port=${port}`,
    "--output=json",
    `--output-path=${outPath}`,
    "--quiet",
    // Attach to the existing Chrome rather than letting Lighthouse launch its
    // own; --headless=new keeps it off-screen. Lighthouse honors --port to
    // reuse the running browser on that remote-debugging port.
    '--chrome-flags=--headless=new',
  ];
  if (formFactor === "desktop") {
    lhArgs.push("--preset=desktop");
  }
  if (Array.isArray(args.categories) && args.categories.length > 0) {
    lhArgs.push(`--only-categories=${args.categories.join(",")}`);
  }

  const res = await runProcess("npx", lhArgs, { timeoutMs });

  if (res.spawnError) {
    const code = (res.spawnError as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new CdpError(
        "lighthouse_audit requires 'npx' (Node.js) on PATH to fetch and run the Lighthouse CLI; 'npx' was not found.",
      );
    }
    throw new CdpError(
      `lighthouse_audit failed to spawn npx/lighthouse: ${res.spawnError.message}`,
    );
  }

  // Try to read the report regardless of exit code: Lighthouse can exit
  // non-zero on audit warnings while still having written a valid report.
  let raw: string | undefined;
  try {
    raw = await readFile(outPath, "utf8");
  } catch {
    raw = undefined;
  }

  if (raw === undefined) {
    if (res.signal === "SIGKILL") {
      throw new CdpError(
        `lighthouse_audit timed out after ${timeoutMs}ms (no report written). stderr: ${truncate(res.stderr)}`,
      );
    }
    const hint = /not found|could not determine executable|npm ERR|E404|ERR_MODULE/i.test(
      res.stderr,
    )
      ? " The Lighthouse CLI could not be fetched/installed via npx — ensure network access and that 'lighthouse' is installable."
      : "";
    throw new CdpError(
      `lighthouse_audit produced no report (exit code ${res.code}).${hint} stderr: ${truncate(res.stderr)}`,
    );
  }

  let report: LighthouseReport;
  try {
    report = JSON.parse(raw) as LighthouseReport;
  } catch (e) {
    throw new CdpError(
      `lighthouse_audit wrote a report that is not valid JSON (${(e as Error).message})`,
    );
  }

  if (report.runtimeError?.code && report.runtimeError.code !== "NO_ERROR") {
    throw new CdpError(
      `lighthouse_audit runtime error [${report.runtimeError.code}]: ${report.runtimeError.message ?? "unknown"}`,
    );
  }

  const categories: Record<string, number | null> = {};
  for (const [key, cat] of Object.entries(report.categories ?? {})) {
    categories[key] = cat?.score ?? null;
  }
  if (Object.keys(categories).length === 0) {
    throw new CdpError(
      `lighthouse_audit report contained no category scores (exit code ${res.code}). stderr: ${truncate(res.stderr)}`,
    );
  }

  const { size } = await stat(outPath);

  return {
    path: outPath,
    bytes: size,
    url,
    finalUrl: report.finalDisplayedUrl ?? report.finalUrl,
    lighthouseVersion: report.lighthouseVersion,
    fetchTime: report.fetchTime,
    categories,
    warnings:
      Array.isArray(report.runWarnings) && report.runWarnings.length > 0
        ? report.runWarnings
        : undefined,
  };
}

function truncate(s: string, max = 600): string {
  const t = s.trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/*
 * ---------------------------------------------------------------------------
 * NON-CDP MODULE. This is the toolkit's sole tool that does not speak raw CDP.
 *
 * External dependency (subprocess, fetched on demand by npx — not an npm dep):
 *   - `npx --yes lighthouse <url> --port=<cdpPort> --output=json
 *      --output-path=<artifact> --quiet --preset=desktop
 *      [--only-categories=...] --chrome-flags=--headless=new`
 *   Lighthouse attaches to the already-running Chrome via its --port flag and
 *   runs the audit; we parse the emitted JSON report.
 *
 * CDP methods used directly: NONE (Lighthouse drives CDP internally).
 *
 * Parity gaps vs the chrome-devtools-mcp `lighthouse_audit` tool:
 *   - Defaults to the desktop preset (the MCP/Puppeteer integration may default
 *     to mobile); pass formFactor:"mobile" to match a mobile run.
 *   - Returns numeric category scores only; does not surface per-audit
 *     opportunities/diagnostics (the full report is on disk at `path`).
 *   - No programmatic Puppeteer page reuse: Lighthouse opens its own about:blank
 *     tab in the attached Chrome for the run rather than auditing a live tab,
 *     which is intentional (never drives a real user tab).
 * ---------------------------------------------------------------------------
 */
