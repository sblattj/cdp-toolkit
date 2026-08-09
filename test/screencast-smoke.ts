/**
 * End-to-end smoke for the screen-recording pair (start_screen_recording /
 * stop_screen_recording) against the live Chrome on CDP_BASE.
 *
 * HERMETIC: the recorded page is a self-contained data: URL running a CSS
 * animation, so the frames come from a repaint loop that needs no network.
 *
 * WHAT IT ACTUALLY PROVES. `bytes > 0` is not evidence a video plays, so the
 * output is handed to ffprobe and the stream is asserted on: the codec is HEVC
 * (or H.264 if no HEVC encoder exists on the machine), the dimensions are real,
 * and, the point of the whole design, the DURATION is close to the wallclock
 * length of the recording rather than the frame count divided by some assumed
 * rate.
 *
 * ORDER MATTERS HERE. Phase 1 records a SINGLE tab, because Chrome only paints
 * the visible one: opening a second tab backgrounds the first and its frame
 * stream drops to nothing (measured: 386 frames in the foreground tab vs 1 in
 * the backgrounded one over the same 4s window). So the frame-rate evidence is
 * taken with one tab in front, and phase 2 then opens a second tab purely to
 * exercise the concurrency and refusal paths, where frame counts are beside the
 * point.
 *
 * SAFETY: creates its OWN throwaway tabs and closes them in finally. Never
 * point this at a browser whose tabs you care about; run it against a scratch
 * Chrome (CDP_BASE=http://127.0.0.1:<scratch port>), never the default 9222
 * where a human's leased tabs live. Run with `bun run screencast:smoke`.
 */
import { spawn } from "node:child_process";
import { unlink } from "node:fs/promises";
import { TOOLS } from "../src/index.ts";
import { activeScreenRecordings } from "../src/tools/screencast.ts";

type Check = { name: string; ok: boolean; detail: string };
const checks: Check[] = [];
function record(name: string, ok: boolean, detail: string): void {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "✅" : "❌"} ${name}: ${detail}`);
}

/** A page that repaints continuously: a spinning, colour-cycling box. */
const ANIMATED_PAGE =
  "data:text/html," +
  encodeURIComponent(
    "<title>screencast-smoke</title><style>body{margin:0;background:#111}" +
      "div{width:200px;height:200px;margin:100px auto;background:#0af;" +
      "animation:spin 1s linear infinite,hue 2s linear infinite}" +
      "@keyframes spin{to{transform:rotate(360deg)}}" +
      "@keyframes hue{to{filter:hue-rotate(360deg)}}</style><div></div>",
  );

const RECORD_MS = 4000;

interface StopResult {
  path: string;
  bytes: number;
  durationMs: number;
  frameCount: number;
  encodedFrames: number;
  codec: string;
  encoder: string;
  width: number;
  height: number;
  droppedFrames: number;
}

interface ProbeStream {
  codec_name?: string;
  codec_tag_string?: string;
  width?: number;
  height?: number;
  nb_frames?: string;
}

/** Read the encoded file back with ffprobe. Claims about a video are settled here, not by the encoder's exit code. */
function ffprobe(path: string): Promise<{ streams: ProbeStream[]; format: { duration?: string; size?: string } }> {
  return new Promise((resolve, reject) => {
    const child = spawn("ffprobe", ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", path], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (c: Buffer) => {
      out += c.toString("utf8");
    });
    child.stderr.on("data", (c: Buffer) => {
      err += c.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) reject(new Error(`ffprobe exited ${code}: ${err}`));
      else resolve(JSON.parse(out) as { streams: ProbeStream[]; format: { duration?: string; size?: string } });
    });
  });
}

const openTabs: string[] = [];
const written: string[] = [];

try {
  /* ------------------ phase 1: ONE tab, in the foreground ------------------ */
  const a = (await TOOLS.new_page({ url: ANIMATED_PAGE })) as { targetId: string };
  openTabs.push(a.targetId);
  record("new_page (animated)", !!a.targetId, `targetId=${a.targetId.slice(0, 8)}`);

  const started = (await TOOLS.start_screen_recording({ target: a.targetId, format: "jpeg", quality: 80 })) as {
    encoder: string;
    codec: string;
    spoolDir: string;
  };
  record("start_screen_recording", !!started.spoolDir, `encoder=${started.encoder} codec=${started.codec}`);

  // --- starting twice on the same target must refuse ---
  let doubleStart = "";
  try {
    await TOOLS.start_screen_recording({ target: a.targetId });
    doubleStart = "NO ERROR";
  } catch (err) {
    doubleStart = err instanceof Error ? err.message : String(err);
  }
  record("double start refused", doubleStart.includes("already in progress"), doubleStart.slice(0, 80));

  const wallStart = Date.now();
  await new Promise((r) => setTimeout(r, RECORD_MS));

  // --- with exactly one recording live, a bare stop resolves to it ---
  const stopped = (await TOOLS.stop_screen_recording({})) as StopResult;
  const wallMs = Date.now() - wallStart;
  written.push(stopped.path);
  record(
    "stop_screen_recording",
    stopped.bytes > 0 && stopped.frameCount > 0,
    `${stopped.frameCount} captured / ${stopped.encodedFrames} encoded, ${stopped.bytes}B, durationMs=${stopped.durationMs}, dropped=${stopped.droppedFrames}`,
  );
  // An animated page repaints many times a second; a handful of frames would
  // mean acks are stalling the stream, which is invisible in the video itself.
  record("an animated page yields a real frame stream", stopped.frameCount > 20, `${stopped.frameCount} frames over ${(wallMs / 1000).toFixed(2)}s`);

  // --- ffprobe is the verdict, not the encoder's exit code ---
  const probe = await ffprobe(stopped.path);
  const v = probe.streams.find((s) => s.width !== undefined) ?? {};
  const duration = Number(probe.format.duration ?? 0);
  record("codec is HEVC (or H.264 fallback)", v.codec_name === "hevc" || v.codec_name === "h264", `codec_name=${v.codec_name} tag=${v.codec_tag_string}`);
  record("dimensions are real and even", (v.width ?? 0) > 0 && (v.height ?? 0) > 0 && (v.width ?? 1) % 2 === 0 && (v.height ?? 1) % 2 === 0, `${v.width}x${v.height}`);
  record(
    "duration tracks wallclock, not frame count",
    duration >= RECORD_MS / 1000 - 1 && duration <= RECORD_MS / 1000 + 2,
    `ffprobe=${duration}s, wallclock=${(wallMs / 1000).toFixed(2)}s, ledger=${(stopped.durationMs / 1000).toFixed(2)}s`,
  );
  record("reported width/height match the encoded file", stopped.width === v.width && stopped.height === v.height, `tool=${stopped.width}x${stopped.height} file=${v.width}x${v.height}`);
  // THE regression guard for the concat demuxer's 1/25s timestamp grid: fed raw
  // 90fps frames, ffmpeg drops the collisions with no warning at all, and the
  // only place that shows up is ffprobe's frame count. The manifest is
  // pre-coalesced onto the grid, so every entry must survive (+1 for the
  // trailing repeat that makes the final duration count).
  const encodedInFile = Number(v.nb_frames ?? 0);
  record(
    "every manifest frame survived the concat grid",
    encodedInFile === stopped.encodedFrames + 1,
    `ffprobe nb_frames=${encodedInFile}, tool encodedFrames=${stopped.encodedFrames} (+1 tail repeat), captured=${stopped.frameCount}`,
  );

  // --- stopping again must refuse (the registry entry is gone) ---
  let doubleStop = "";
  try {
    await TOOLS.stop_screen_recording({ target: a.targetId });
    doubleStop = "NO ERROR";
  } catch (err) {
    doubleStop = err instanceof Error ? err.message : String(err);
  }
  record("stop without a recording refused", doubleStop.includes("no screen recording is in progress"), doubleStop.slice(0, 80));

  /* ---------- phase 2: TWO tabs, for concurrency + the ambiguity gate ---------- */
  const b = (await TOOLS.new_page({ url: ANIMATED_PAGE })) as { targetId: string };
  openTabs.push(b.targetId);
  const startedA2 = (await TOOLS.start_screen_recording({ target: a.targetId })) as { spoolDir: string };
  const startedB = (await TOOLS.start_screen_recording({ target: b.targetId })) as { spoolDir: string };
  record("concurrent recordings on two targets", !!startedA2.spoolDir && startedB.spoolDir !== startedA2.spoolDir, "two live recordings, two spools");

  await new Promise((r) => setTimeout(r, 1200));

  let ambiguous = "";
  try {
    await TOOLS.stop_screen_recording({});
    ambiguous = "NO ERROR";
  } catch (err) {
    ambiguous = err instanceof Error ? err.message : String(err);
  }
  record("ambiguous stop refused", ambiguous.includes("pass 'target'"), ambiguous.slice(0, 80));

  const stoppedB = (await TOOLS.stop_screen_recording({ target: b.targetId })) as StopResult;
  written.push(stoppedB.path);
  record(
    "the foreground recording stops to its own file",
    stoppedB.bytes > 0 && stoppedB.frameCount > 0 && stoppedB.path !== stopped.path,
    `${stoppedB.frameCount} frames -> ${stoppedB.path.split("/").pop()}`,
  );

  // The backgrounded tab is the honest hard case: Chrome may not have painted it
  // even once. Encoding whatever arrived is fine; returning a silent empty video
  // is not, so the ONLY acceptable outcomes are real frames or the explicit
  // 0-frame error that names the repaint rule.
  let bgOk = false;
  let bgDetail = "";
  try {
    const stoppedA2 = (await TOOLS.stop_screen_recording({ target: a.targetId })) as StopResult;
    written.push(stoppedA2.path);
    bgOk = stoppedA2.frameCount > 0 && stoppedA2.bytes > 0;
    bgDetail = `encoded ${stoppedA2.frameCount} frames`;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    bgOk = message.includes("captured 0 frames");
    bgDetail = `refused: ${message.slice(0, 70)}`;
  }
  record("a backgrounded recording never yields a silent empty video", bgOk, bgDetail);

  record("both registry entries are released", activeScreenRecordings().length === 0, `active=${JSON.stringify(activeScreenRecordings())}`);
} catch (err) {
  record("FATAL", false, err instanceof Error ? err.message : String(err));
} finally {
  for (const id of openTabs) {
    try {
      await TOOLS.close_page({ target: id });
    } catch {
      /* best-effort cleanup */
    }
  }
  if (!process.env.CDP_KEEP_SCREENCAST) {
    for (const p of written) await unlink(p).catch(() => {});
  }
  record("cleanup", true, `${openTabs.length} tabs closed, ${written.length} videos ${process.env.CDP_KEEP_SCREENCAST ? "kept" : "removed"}`);
}

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length) {
  console.error(`FAILED: ${failed.map((c) => c.name).join(", ")}`);
  process.exit(1);
}
console.log("SCREENCAST SMOKE OK");
