/**
 * screencast.ts: tab-to-video capture. `start_screen_recording` opens a
 * persistent page connection and streams CDP `Page.screencastFrame` events to a
 * spool directory; `stop_screen_recording` assembles those frames into an H.265
 * MP4 with ffmpeg.
 *
 * WHY THIS IS A START/STOP PAIR AND NOT A ONE-SHOT
 * ===============================================
 * A screencast is a live event subscription on ONE CDP connection, exactly like
 * recorder.ts's console/network capture: the frames arrive as events on the
 * socket that called `Page.startScreencast`, so the recording cannot be handed
 * to another process. The module therefore mirrors recorder.ts's model (a
 * persistent `openPage` connection held open until stop) and performance.ts's
 * registry (module-level `Map` keyed by targetId, so start and stop must run in
 * the SAME process). Unlike tracing, which is browser-global, screencasts are
 * per-target: several recordings on DIFFERENT targets run concurrently, and the
 * registry key is what keeps their spools and ledgers apart.
 *
 * WHY PER-FRAME DURATIONS (the thing a naive implementation gets wrong)
 * --------------------------------------------------------------------
 * Chrome emits a screencast frame ON REPAINT, not on a clock. A page that sits
 * still emits nothing; an animating page emits at whatever rate it paints. The
 * stream is therefore inherently VARIABLE-frame-rate, and feeding those frames
 * to ffmpeg at a fixed rate produces a video that is either sped up (a 30s
 * recording of a mostly-still page collapsing to 2s) or frozen. So every frame
 * is timestamped into an in-memory LEDGER, and on stop the ledger is rendered
 * as an ffconcat manifest carrying an explicit `duration` per frame:
 *
 *     duration(frame N) = ts(N+1) - ts(N)
 *     duration(last)    = stopWallclock - ts(last)
 *
 * so a still page yields one long-held frame and the total video duration comes
 * out at the wallclock length of the recording. `metadata.timestamp` (seconds
 * since epoch, from the renderer) is preferred over arrival wallclock, which
 * only backfills when Chrome omits it.
 *
 * ACKING IS NOT OPTIONAL. Chrome stops sending frames until the previous one is
 * acknowledged with `Page.screencastFrameAck(sessionId)`. The ack is therefore
 * fired from the event handler BEFORE the frame is written to disk: an ack that
 * waits on a disk write turns the frame rate into the disk's write latency.
 *
 * ENCODER LADDER. Probed ONCE per process from `ffmpeg -hide_banner -encoders`:
 * hevc_videotoolbox -> h264_videotoolbox -> libx265 -> libx264. Both HEVC
 * encoders get `-tag:v hvc1`, without which QuickTime refuses to play the file
 * it just wrote. Dimensions are forced even because videotoolbox rejects odd
 * ones. ffmpeg is probed at START time, not stop, so a missing ffmpeg fails
 * before a recording is captured and then thrown away.
 *
 * ZERO NEW DEPENDENCIES: ffmpeg is spawned via node:child_process, the same
 * shell-out shape lighthouse.ts uses. No Bun.* APIs anywhere (dist/ is bundled
 * to node ESM).
 */
import { spawn } from "node:child_process";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CdpError, openPage } from "../client.ts";
import type { CdpConnection } from "../client.ts";
import type { Target, TargetSelector } from "../types.ts";

const ARTIFACT_DIR = process.env.CDP_ARTIFACT_DIR ?? "/tmp/cdp-toolkit";

/** ffmpeg binary, overridable for a non-PATH install. */
const FFMPEG_BIN = process.env.CDP_FFMPEG ?? "ffmpeg";

/* --------------------------------- ledger --------------------------------- */

/** One captured frame: where it landed, when it was painted, and how big it is. */
export interface FrameLedgerEntry {
  /** File name relative to the spool directory (the ffconcat manifest lives there too). */
  file: string;
  /** Paint time in ms since epoch: metadata.timestamp*1000 when Chrome supplies it, else arrival wallclock. */
  timestamp: number;
  width: number;
  height: number;
}

/**
 * Per-frame display durations in MILLISECONDS, from the ledger. Frame N is held
 * until frame N+1 paints; the final frame is held until the caller stopped.
 * Clamped to >=1ms: a repeated or non-monotonic timestamp would otherwise emit a
 * zero/negative `duration` that the concat demuxer silently drops.
 */
export function frameDurationsMs(ledger: FrameLedgerEntry[], stopWallclockMs: number): number[] {
  return ledger.map((entry, i) => {
    const next = i + 1 < ledger.length ? ledger[i + 1]!.timestamp : stopWallclockMs;
    return Math.max(1, Math.round(next - entry.timestamp));
  });
}

/**
 * The concat demuxer's timestamp resolution, in ms.
 *
 * MEASURED, not assumed. The demuxer takes its stream time_base from the first
 * file's sub-demuxer, and image files come in through image2 at its default 25
 * fps, so EVERY frame's presentation timestamp is snapped to a 1/25s grid
 * regardless of what the manifest's `duration` lines say. Feeding it a 93 fps
 * screencast unchanged therefore hands several frames the same timestamp, and
 * ffmpeg silently drops all but one of each collision: a 373-frame capture came
 * out as 102 encoded frames with no warning. There is no way around it from the
 * outside either: `-r` before `-i` overrides the durations entirely (a 1.0s clip
 * became 0.101s), `-framerate` is not an option the concat demuxer accepts, and
 * `settb`/`-video_track_timescale` change only the OUTPUT timebase.
 *
 * So the snapping is done here, deliberately and visibly, instead of being left
 * to ffmpeg to do silently. Encoded video tops out at 25 fps.
 */
export const CONCAT_GRID_MS = 40;

/** One frame as it will actually appear in the video: a file and a grid-aligned hold. */
export interface GriddedFrame {
  file: string;
  durationMs: number;
}

/**
 * Snap the ledger's raw per-frame durations onto the concat demuxer's grid,
 * keeping the FIRST frame that falls in each slot and dropping the frames that
 * would otherwise collide on the same timestamp.
 *
 * The two properties this preserves are the ones the whole design exists for:
 * a long still stays ONE entry held for its full length (a 3s hold encodes as a
 * single 3s frame, not 75 resampled ones), and the durations still sum to the
 * wallclock span, rounded to the grid.
 */
export function coalesceToConcatGrid(
  ledger: FrameLedgerEntry[],
  stopWallclockMs: number,
  gridMs: number = CONCAT_GRID_MS,
): GriddedFrame[] {
  if (!ledger.length) return [];
  const raw = frameDurationsMs(ledger, stopWallclockMs);
  // Cumulative offsets from the first frame, taken from the CLAMPED durations so
  // a non-monotonic clock cannot walk the timeline backwards.
  let elapsed = 0;
  const kept: Array<{ file: string; slot: number }> = [];
  let lastSlot = -1;
  for (let i = 0; i < ledger.length; i++) {
    const slot = Math.round(elapsed / gridMs);
    if (slot > lastSlot) {
      kept.push({ file: ledger[i]!.file, slot });
      lastSlot = slot;
    }
    elapsed += raw[i]!;
  }
  const endSlot = Math.max(lastSlot + 1, Math.round(elapsed / gridMs));
  return kept.map((frame, i) => ({
    file: frame.file,
    durationMs: ((i + 1 < kept.length ? kept[i + 1]!.slot : endSlot) - frame.slot) * gridMs,
  }));
}

/**
 * Render grid-aligned frames as an ffconcat v1 manifest. Paths are the bare
 * spool-relative file names (the concat demuxer resolves them against the
 * manifest's own directory), which sidesteps ffconcat path quoting entirely.
 *
 * THE TRAILING REPEAT is load-bearing: the concat demuxer applies a `duration`
 * only when another `file` line follows it, so without repeating the final entry
 * the last frame's hold time is discarded and a recording that ends on a long
 * still cuts short. The repeated entry itself contributes one grid step, which
 * is why the encoded file runs exactly one 40ms frame longer than the durations
 * here sum to.
 */
export function buildConcatManifest(frames: GriddedFrame[]): string {
  if (!frames.length) throw new CdpError("cannot build a concat manifest from an empty frame ledger");
  const lines = ["ffconcat version 1.0"];
  for (const frame of frames) {
    lines.push(`file ${frame.file}`);
    lines.push(`duration ${(frame.durationMs / 1000).toFixed(6)}`);
  }
  lines.push(`file ${frames[frames.length - 1]!.file}`);
  return `${lines.join("\n")}\n`;
}

/** videotoolbox rejects odd dimensions; this is the JS twin of `scale=trunc(iw/2)*2:trunc(ih/2)*2`. */
export function evenDimensions(width: number, height: number): { width: number; height: number } {
  return { width: Math.max(0, Math.trunc(width / 2) * 2), height: Math.max(0, Math.trunc(height / 2) * 2) };
}

/* -------------------------------- image size ------------------------------- */

/** PNG: an 8-byte signature, then an IHDR chunk whose payload opens with two big-endian uint32s. */
function pngSize(buf: Buffer): { width: number; height: number } | undefined {
  if (buf.length < 24) return undefined;
  if (buf.readUInt32BE(0) !== 0x89504e47 || buf.readUInt32BE(4) !== 0x0d0a1a0a) return undefined;
  if (buf.toString("latin1", 12, 16) !== "IHDR") return undefined;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/** SOF markers carrying frame dimensions. SOF4 (0xc4 DHT), SOF8 (0xc8), SOF12 (0xcc DAC) are NOT frame headers. */
const JPEG_SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

/** JPEG: walk the marker segments to the first start-of-frame, which carries height then width. */
function jpegSize(buf: Buffer): { width: number; height: number } | undefined {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return undefined;
  let i = 2;
  while (i + 3 < buf.length) {
    if (buf[i] !== 0xff) {
      i += 1; // resync past fill bytes / padding
      continue;
    }
    const marker = buf[i + 1]!;
    if (marker === 0xff) {
      i += 1;
      continue;
    }
    // Standalone markers: no length field follows.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    if (i + 3 >= buf.length) return undefined;
    const segLen = buf.readUInt16BE(i + 2);
    if (JPEG_SOF.has(marker)) {
      if (i + 9 > buf.length) return undefined;
      return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
    }
    if (segLen < 2) return undefined;
    i += 2 + segLen;
  }
  return undefined;
}

/** Frame dimensions read from the encoded bytes themselves (never guessed from metadata). */
export function imageSize(buf: Buffer): { width: number; height: number } | undefined {
  return pngSize(buf) ?? jpegSize(buf);
}

/* ------------------------------ encoder ladder ----------------------------- */

export interface EncoderChoice {
  /** The ffmpeg encoder name passed to -c:v. */
  encoder: string;
  /** The codec the encoder produces, as ffprobe reports it. */
  codec: "hevc" | "h264";
  /** -tag:v value, set on HEVC so QuickTime will play the result. */
  tag?: "hvc1";
}

/** Preference order: hardware HEVC, hardware H.264, software HEVC, software H.264. */
export const ENCODER_LADDER: readonly EncoderChoice[] = [
  { encoder: "hevc_videotoolbox", codec: "hevc", tag: "hvc1" },
  { encoder: "h264_videotoolbox", codec: "h264" },
  { encoder: "libx265", codec: "hevc", tag: "hvc1" },
  { encoder: "libx264", codec: "h264" },
];

/**
 * The encoder NAMES listed by `ffmpeg -encoders`, read out of the name column
 * only. Each row is `<6 capability flags> <name> <description>`, e.g.
 * ` V....D libx264rgb   libx264 H.264 / AVC ... RGB (codec h264)`.
 *
 * Searching the raw text instead is the trap this exists to avoid: ffmpeg
 * repeats an encoder's family name inside OTHER encoders' descriptions, so a
 * substring (or even word-boundary) match on "libx264" hits the libx264rgb row,
 * and the toolkit would then encode with an RGB-only encoder that cannot write
 * the yuv420p MP4 it just promised.
 */
export function ffmpegEncoderNames(encodersOutput: string): Set<string> {
  const names = new Set<string>();
  for (const line of encodersOutput.split("\n")) {
    const m = /^\s*[VAS][A-Z.]{5}\s+(\S+)/.exec(line);
    if (m) names.add(m[1]!);
  }
  return names;
}

/** Pick the best available encoder from the raw text of `ffmpeg -encoders`. */
export function selectEncoder(encodersOutput: string): EncoderChoice {
  const available = ffmpegEncoderNames(encodersOutput);
  for (const candidate of ENCODER_LADDER) {
    if (available.has(candidate.encoder)) return candidate;
  }
  throw new CdpError(
    `ffmpeg reports none of the supported video encoders (${ENCODER_LADDER.map((c) => c.encoder).join(", ")}). ` +
      "Install a full ffmpeg build: 'brew install ffmpeg' (macOS) or 'apt install ffmpeg' (Debian/Ubuntu).",
  );
}

/**
 * The exact ffmpeg argv. `-vsync vfr` (not `-fps_mode`, which needs ffmpeg
 * >=5.1 and would break Ubuntu 22.04's 4.4) passes the concat demuxer's
 * per-frame timestamps through instead of resampling them to a constant rate.
 * `-t` is deliberately NOT used to pin the duration: it trims at the LAST
 * frame's PTS, which throws away exactly the long final hold the ledger exists
 * to preserve (measured: a 4.25s ledger came out at 3.56s).
 */
export function buildFfmpegArgs(manifestPath: string, outPath: string, choice: EncoderChoice): string[] {
  return [
    "-hide_banner",
    "-loglevel", "error",
    "-y",
    "-f", "concat",
    "-safe", "0",
    "-i", manifestPath,
    "-vsync", "vfr",
    "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2",
    "-c:v", choice.encoder,
    ...(choice.tag ? ["-tag:v", choice.tag] : []),
    "-pix_fmt", "yuv420p",
    "-movflags", "+faststart",
    "-an",
    outPath,
  ];
}

/* ------------------------------- ffmpeg shell ------------------------------ */

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Spawn a binary and collect its output. Rejects only when the process cannot be spawned at all. */
function run(bin: string, args: string[]): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

/** The single encoder probe per process (see the header note on probing at start, not stop). */
let encoderProbe: Promise<EncoderChoice> | undefined;

const FFMPEG_MISSING =
  `ffmpeg is required to encode a screen recording but '${FFMPEG_BIN}' could not be executed. ` +
  "Install it with 'brew install ffmpeg' (macOS) or 'apt install ffmpeg' (Debian/Ubuntu), " +
  "or point CDP_FFMPEG at the binary.";

/**
 * Probe ffmpeg once and cache the chosen encoder. Called from START so a missing
 * ffmpeg is reported before any frames are captured, rather than after a
 * recording has been made and is about to be discarded.
 */
async function probeEncoder(): Promise<EncoderChoice> {
  if (!encoderProbe) {
    encoderProbe = (async () => {
      let res: RunResult;
      try {
        res = await run(FFMPEG_BIN, ["-hide_banner", "-encoders"]);
      } catch (err) {
        throw new CdpError(`${FFMPEG_MISSING} (${(err as Error).message})`);
      }
      if (res.code !== 0) throw new CdpError(`${FFMPEG_MISSING} ('-encoders' exited ${res.code}: ${res.stderr.trim().slice(0, 300)})`);
      return selectEncoder(`${res.stdout}\n${res.stderr}`);
    })();
    // A failed probe must not poison every later call: forget it so a caller who
    // installs ffmpeg and retries is not told it is still missing.
    encoderProbe.catch(() => {
      encoderProbe = undefined;
    });
  }
  return encoderProbe;
}

/* -------------------------------- registry --------------------------------- */

/** A live screencast held in-process between start and stop, keyed by targetId. */
interface LiveRecording {
  conn: CdpConnection;
  target: Target;
  spoolDir: string;
  ledger: FrameLedgerEntry[];
  startedAt: number;
  format: "jpeg" | "png";
  encoder: EncoderChoice;
  /** Serialized frame writes, so two frames never interleave a partial file. */
  writes: Promise<void>;
  /** Frames whose bytes could not be written or parsed (reported, never hidden). */
  dropped: number;
  /** Ledger file names whose write failed; dropped before the manifest so ffmpeg never chases a missing frame. */
  unwritten: Set<string>;
  /** Detach the Page.screencastFrame subscription. */
  off: () => void;
}

const liveRecordings = new Map<string, LiveRecording>();

/** Live recording target ids, for tests and diagnostics. */
export function activeScreenRecordings(): string[] {
  return [...liveRecordings.keys()];
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

/**
 * Refuse a second recording on a target that is already recording. Starting
 * twice would orphan the first screencast's connection and its spool, and the
 * caller would then stop a recording that is not the one they think it is.
 * Split out from the tool so the guard is testable without a browser.
 */
export function assertNotRecording(targetId: string, activeIds: readonly string[]): void {
  if (activeIds.includes(targetId)) {
    throw new CdpError(
      `a screen recording is already in progress for target ${shortId(targetId)}; call stop_screen_recording first`,
    );
  }
}

/**
 * Decide which live recording a stop call means, from the active ids alone.
 * Returns the id when it can be settled without touching the browser, or
 * `undefined` when `selector` is a non-id form (index:/url:/title:) that has to
 * be resolved against the browser first. Throws when nothing is recording, and
 * when several are recording but the caller did not say which: silently
 * stopping "the first one" would end another agent's recording.
 */
export function chooseRecordingId(activeIds: readonly string[], selector?: TargetSelector): string | undefined {
  if (!activeIds.length) {
    throw new CdpError(
      "no screen recording is in progress in this process. start_screen_recording parks a live CDP connection in memory, so a recording cannot be stopped from a different process than the one that started it (the CLI is one process per call: use the MCP server for the pair).",
    );
  }
  if (selector === undefined || selector === "active") {
    if (activeIds.length === 1) return activeIds[0]!;
    throw new CdpError(
      `${activeIds.length} screen recordings are in progress (targets: ${activeIds.map(shortId).join(", ")}); pass 'target' to say which one to stop`,
    );
  }
  return activeIds.find((id) => id === selector);
}

function stamp(): string {
  return new Date(Date.now()).toISOString().replace(/[:.]/g, "-");
}

function target3(t: Target): { id: string; url: string; title: string } {
  return { id: t.id, url: t.url, title: t.title };
}

/* ---------------------------- start_screen_recording ---------------------------- */

export interface StartScreenRecordingArgs {
  target?: TargetSelector;
  /** Frame image format. jpeg (default) is smaller per repaint; png is lossless. */
  format?: "jpeg" | "png";
  /** JPEG quality 0-100. Ignored for png. */
  quality?: number;
  maxWidth?: number;
  maxHeight?: number;
  /** Capture every Nth repaint (1 = every frame). */
  everyNthFrame?: number;
  /** Activate the tab before recording. A fully backgrounded tab may never repaint. */
  bringToFront?: boolean;
}

export interface StartScreenRecordingResult {
  target: { id: string; url: string; title: string };
  format: "jpeg" | "png";
  spoolDir: string;
  encoder: string;
  codec: "hevc" | "h264";
  startedAt: number;
  note: string;
}

/**
 * Begin recording the target tab. Opens a persistent page connection, parks it
 * in the module registry, and streams `Page.screencastFrame` to a spool dir.
 * Pairs with `stopScreenRecording` WITHIN THE SAME PROCESS.
 */
export async function startScreenRecording(args: StartScreenRecordingArgs = {}): Promise<StartScreenRecordingResult> {
  const format = args.format ?? "jpeg";
  if (format !== "jpeg" && format !== "png") throw new CdpError("start_screen_recording: format must be 'jpeg' or 'png'");
  if (args.quality !== undefined && (!Number.isFinite(args.quality) || args.quality < 0 || args.quality > 100)) {
    throw new CdpError("start_screen_recording: quality must be a number between 0 and 100 (jpeg only)");
  }

  // Probe ffmpeg BEFORE dialing the browser: failing here costs the caller
  // nothing, whereas failing at stop costs them the whole recording.
  const encoder = await probeEncoder();

  const { conn, target } = await openPage(args.target);

  try {
    assertNotRecording(target.id, [...liveRecordings.keys()]);
  } catch (err) {
    conn.close();
    throw err;
  }

  const spoolDir = join(ARTIFACT_DIR, `screencast-${shortId(target.id)}-${stamp()}`);
  try {
    await mkdir(spoolDir, { recursive: true });
  } catch (err) {
    // An unwritable artifact dir must not leak the page connection we just opened.
    conn.close();
    throw new CdpError(`cannot create the screencast spool directory '${spoolDir}': ${(err as Error).message}`);
  }

  const ext = format === "png" ? "png" : "jpg";
  const rec: LiveRecording = {
    conn,
    target,
    spoolDir,
    ledger: [],
    startedAt: Date.now(),
    format,
    encoder,
    writes: Promise.resolve(),
    dropped: 0,
    unwritten: new Set<string>(),
    off: () => {},
  };

  let seq = 0;
  rec.off = conn.on("Page.screencastFrame", (params) => {
    const sessionId = (params as { sessionId?: number }).sessionId;
    // ACK FIRST, ALWAYS. Chrome will not send frame N+1 until frame N is acked,
    // so anything awaited before this ack becomes the frame rate.
    if (typeof sessionId === "number") {
      void conn.send("Page.screencastFrameAck", { sessionId }).catch(() => {
        /* the socket is closing or the ack raced stop(); frames simply end */
      });
    }
    const data = (params as { data?: string }).data;
    if (typeof data !== "string" || !data.length) {
      rec.dropped += 1;
      return;
    }
    const meta = (params as { metadata?: { timestamp?: number } }).metadata;
    // metadata.timestamp is Network.TimeSinceEpoch: SECONDS (float). Arrival
    // wallclock only backfills when Chrome omits it.
    const timestamp = typeof meta?.timestamp === "number" ? Math.round(meta.timestamp * 1000) : Date.now();
    const buf = Buffer.from(data, "base64");
    const size = imageSize(buf);
    if (!size || size.width <= 0 || size.height <= 0) {
      rec.dropped += 1;
      return;
    }
    seq += 1;
    const file = `frame-${String(seq).padStart(6, "0")}.${ext}`;
    // Ledger order is the arrival order, fixed synchronously here; the write is
    // queued behind whatever is already in flight.
    rec.ledger.push({ file, timestamp, width: size.width, height: size.height });
    rec.writes = rec.writes.then(() => writeFile(join(spoolDir, file), buf)).catch(() => {
      // A ledger row whose file never landed would send ffmpeg looking for a
      // missing frame and fail the whole encode. Record it so stop can drop the
      // row; the neighbouring frame's duration then covers the gap, because
      // durations come from timestamps rather than from row positions.
      rec.dropped += 1;
      rec.unwritten.add(file);
    });
  });

  try {
    await conn.send("Page.enable");
    if (args.bringToFront) await conn.send("Page.bringToFront").catch(() => {});
    const params: Record<string, unknown> = { format };
    if (format === "jpeg" && args.quality !== undefined) params.quality = args.quality;
    if (args.maxWidth !== undefined) params.maxWidth = args.maxWidth;
    if (args.maxHeight !== undefined) params.maxHeight = args.maxHeight;
    if (args.everyNthFrame !== undefined) params.everyNthFrame = args.everyNthFrame;
    await conn.send("Page.startScreencast", params);
  } catch (err) {
    rec.off();
    conn.close();
    await rm(spoolDir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }

  liveRecordings.set(target.id, rec);

  return {
    target: target3(target),
    format,
    spoolDir,
    encoder: encoder.encoder,
    codec: encoder.codec,
    startedAt: rec.startedAt,
    note: "Recording. Call stop_screen_recording in THIS process to encode the MP4; frames only arrive on repaint, so a still page yields one long-held frame.",
  };
}

/* ---------------------------- stop_screen_recording ----------------------------- */

export interface StopScreenRecordingArgs {
  target?: TargetSelector;
  /** Output file path. Default: <artifact dir>/screen-recording-<targetIdShort>-<stamp>.mp4. */
  savePath?: string;
}

export interface StopScreenRecordingResult {
  path: string;
  bytes: number;
  /** Sum of the durations actually written to the concat manifest; the file itself runs one 40ms grid step longer (see buildConcatManifest). */
  durationMs: number;
  /** Frames CAPTURED off the wire. */
  frameCount: number;
  /** Frames that survived the concat demuxer's 40ms grid and are in the video (see CONCAT_GRID_MS). */
  encodedFrames: number;
  codec: "hevc" | "h264";
  encoder: string;
  width: number;
  height: number;
  droppedFrames: number;
  target: { id: string; url: string; title: string };
}

/**
 * Look the chosen recording up, resolving a non-id selector (index:/url:/title:)
 * against the browser exactly the way every other tool resolves a target,
 * including its lease check.
 */
async function pickRecording(selector?: TargetSelector): Promise<LiveRecording> {
  const chosen = chooseRecordingId([...liveRecordings.keys()], selector);
  if (chosen) return liveRecordings.get(chosen)!;
  const { conn, target } = await openPage(selector);
  conn.close();
  const hit = liveRecordings.get(target.id);
  if (!hit) {
    throw new CdpError(
      `no screen recording is in progress for target ${shortId(target.id)} (recording: ${[...liveRecordings.keys()].map(shortId).join(", ") || "none"})`,
    );
  }
  return hit;
}

/**
 * Stop the recording, encode the spooled frames into an MP4 with per-frame
 * durations, and return the file's real measured size alongside the ledger's
 * own numbers. On an encode failure the spool directory is KEPT and named in the
 * error, so the frames can be re-encoded by hand rather than lost.
 */
export async function stopScreenRecording(args: StopScreenRecordingArgs = {}): Promise<StopScreenRecordingResult> {
  const rec = await pickRecording(args.target);

  // Tear the stream down first so no frame lands after the stop wallclock that
  // the last frame's duration is measured against.
  rec.off();
  try {
    await rec.conn.send("Page.stopScreencast");
  } catch {
    /* the page may have navigated or closed; the frames already spooled are still good */
  }
  const stoppedAt = Date.now();
  await rec.writes.catch(() => {});
  rec.conn.close();
  liveRecordings.delete(rec.target.id);

  const ledger = rec.unwritten.size ? rec.ledger.filter((entry) => !rec.unwritten.has(entry.file)) : rec.ledger;
  if (!ledger.length) {
    await rm(rec.spoolDir, { recursive: true, force: true }).catch(() => {});
    throw new CdpError(
      `screen recording captured 0 frames for target ${shortId(rec.target.id)}. Chrome emits a screencast frame only on repaint: a fully backgrounded or occluded tab may never paint. Retry with bringToFront:true, or drive the page while recording.`,
    );
  }

  await mkdir(ARTIFACT_DIR, { recursive: true });
  const outPath = args.savePath ?? join(ARTIFACT_DIR, `screen-recording-${shortId(rec.target.id)}-${stamp()}.mp4`);

  const frames = coalesceToConcatGrid(ledger, stoppedAt);
  const manifestPath = join(rec.spoolDir, "frames.ffconcat");
  await writeFile(manifestPath, buildConcatManifest(frames), "utf8");

  // Both numbers are computed, never estimated: durationMs is the sum of the
  // durations actually written to the manifest, so it matches the file.
  const durationMs = frames.reduce((total, f) => total + f.durationMs, 0);
  const { width, height } = evenDimensions(ledger[0]!.width, ledger[0]!.height);

  let res: RunResult;
  try {
    res = await run(FFMPEG_BIN, buildFfmpegArgs(manifestPath, outPath, rec.encoder));
  } catch (err) {
    throw new CdpError(`${FFMPEG_MISSING} Spooled frames kept at ${rec.spoolDir}. (${(err as Error).message})`);
  }
  if (res.code !== 0) {
    throw new CdpError(
      `ffmpeg (${rec.encoder.encoder}) exited ${res.code} encoding ${frames.length} frames. Spooled frames kept at ${rec.spoolDir}, re-run by hand with: ` +
        `${FFMPEG_BIN} ${buildFfmpegArgs(manifestPath, outPath, rec.encoder).join(" ")}\nffmpeg said: ${res.stderr.trim().slice(0, 800)}`,
    );
  }

  const { size } = await stat(outPath);
  await rm(rec.spoolDir, { recursive: true, force: true }).catch(() => {});

  return {
    path: outPath,
    bytes: size,
    durationMs,
    frameCount: ledger.length,
    encodedFrames: frames.length,
    codec: rec.encoder.codec,
    encoder: rec.encoder.encoder,
    width,
    height,
    droppedFrames: rec.dropped,
    target: target3(rec.target),
  };
}

/*
 * CDP methods / domains used:
 *   Page.enable
 *   Page.bringToFront            (optional, only with bringToFront:true)
 *   Page.startScreencast         (format, quality, maxWidth, maxHeight, everyNthFrame)
 *   Page.screencastFrame         (event; data + metadata.timestamp + sessionId)
 *   Page.screencastFrameAck      (acked from the event handler; unacked frames stall the stream)
 *   Page.stopScreencast
 *
 * External process: ffmpeg (spawned via node:child_process, like lighthouse.ts).
 * This is the second non-pure-CDP tool group in the toolkit.
 *
 * Parity gaps / known limits:
 *   - chrome-devtools-mcp has no screen-recording tool at all; this is a toolkit addition.
 *   - start/stop must run in ONE process, for the same reason performance_start_trace does:
 *     the frames are events on the connection that started the screencast and cannot be
 *     re-attached from a fresh process. There is deliberately no one-shot convenience twin,
 *     because "record for N seconds" is exactly what an agent cannot know in advance.
 *   - WebDriver BiDi has no screencast primitive (no streamed-frame command exists in the
 *     spec, and Firefox 153 implements none), so both tools declare the capability
 *     "capture.screencast", which the BiDi driver does not offer: they are absent from
 *     tools/list under --browser firefox rather than present and throwing.
 *   - The encoded file runs exactly one 40ms grid step longer than the reported
 *     durationMs: the concat demuxer honors a `duration` only when another `file` line
 *     follows, so the final frame is repeated and that repeat costs one step.
 *     Trimming it back with -t is worse (it cuts at the last frame's PTS and discards the
 *     final hold entirely: a 4.25s ledger measured 3.56s).
 *   - Encoded video tops out at 25 fps, because the concat demuxer represents image PTS
 *     on a 1/25s grid (see CONCAT_GRID_MS for the measurements and the three workarounds
 *     that do not work). Frames captured less than 40ms apart are coalesced HERE, first
 *     one per slot, rather than being dropped silently by ffmpeg; frameCount reports what
 *     was captured and encodedFrames what reached the video. Pass everyNthFrame on a
 *     high-framerate page to stop spooling frames that will be coalesced away.
 *   - Frames are captured at the size Chrome sends. If the viewport is resized mid-recording
 *     the spool holds mixed dimensions and ffmpeg's concat demuxer will reject the change;
 *     resize before starting, or pass maxWidth/maxHeight to pin the stream.
 *   - No audio: CDP screencast is video-only, so the MP4 is muxed with -an.
 */
