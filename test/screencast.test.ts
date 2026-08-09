/**
 * Unit tests for the screen-recording pair: start_screen_recording / stop_screen_recording.
 *
 * Three properties carry these tools, and each is tested on the pure function
 * that owns it rather than through a browser.
 *
 * 1. TIMING. A CDP screencast is variable-frame-rate by construction (Chrome
 *    emits a frame on repaint, not on a clock), so the whole point of the
 *    ledger is that frame N is displayed for exactly ts(N+1)-ts(N) and the last
 *    frame is held until the caller stopped. If that tail duration is dropped,
 *    a recording that ends on a long still silently cuts short, which looks
 *    exactly like a successful recording. So the tail is asserted explicitly,
 *    the concat manifest's trailing repeat (without which ffmpeg discards the
 *    last `duration` outright) is asserted, and the durations are asserted to
 *    sum to the wallclock span.
 *
 * 2. ENCODER SELECTION. The ladder must degrade in order, and it must not be
 *    fooled by ffmpeg's own listing, where `libx264rgb` sits one line above
 *    `libx264` and a naive substring match picks the wrong encoder. HEVC must
 *    carry -tag:v hvc1 (QuickTime refuses HEVC in MP4 without it) and every
 *    build must force even dimensions, which videotoolbox rejects.
 *
 * 3. REFUSALS. Double-start, stop-without-start, and the Firefox gap are all
 *    paths where a quiet no-op is worse than an error: a second start would
 *    orphan the first recording's connection, a silent stop would return an
 *    empty video, and a screencast under Firefox cannot work at all. The
 *    Firefox refusal is asserted the way every other chrome-only tool's is
 *    (absent from tools/list via a capability the BiDi driver does not
 *    declare), not as a runtime throw, per ADR-001.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONCAT_GRID_MS,
  ENCODER_LADDER,
  activeScreenRecordings,
  assertNotRecording,
  buildConcatManifest,
  chooseRecordingId,
  coalesceToConcatGrid,
  buildFfmpegArgs,
  evenDimensions,
  ffmpegEncoderNames,
  frameDurationsMs,
  imageSize,
  selectEncoder,
  startScreenRecording,
  stopScreenRecording,
  type FrameLedgerEntry,
} from "../src/tools/screencast.ts";
import { REQUIRED_CAPABILITIES } from "../src/driver.ts";
import { toolAvailability } from "../src/capabilities.ts";
import { FIREFOX_TOOLS } from "../src/firefox-tools.ts";
import { MANIFEST } from "../src/manifest.ts";
import { TOOL_NAMES } from "../src/index.ts";

/** A three-frame ledger: 500ms, then a 3s still, then a final frame held to stop. */
const LEDGER: FrameLedgerEntry[] = [
  { file: "frame-000001.jpg", timestamp: 1_000_000, width: 800, height: 600 },
  { file: "frame-000002.jpg", timestamp: 1_000_500, width: 800, height: 600 },
  { file: "frame-000003.jpg", timestamp: 1_003_500, width: 800, height: 600 },
];
const STOP_AT = 1_004_250;

describe("ledger -> per-frame durations", () => {
  test("frame N is held until frame N+1 painted", () => {
    expect(frameDurationsMs(LEDGER, STOP_AT).slice(0, 2)).toEqual([500, 3000]);
  });

  test("the LAST frame is held until stop, not dropped", () => {
    // The failure this pins: a recording that ends on a long still. Without the
    // tail, the 750ms hold vanishes and the video ends early.
    expect(frameDurationsMs(LEDGER, STOP_AT).at(-1)).toBe(750);
  });

  test("durations sum to the wallclock span from the first frame to stop", () => {
    const total = frameDurationsMs(LEDGER, STOP_AT).reduce((a, b) => a + b, 0);
    expect(total).toBe(STOP_AT - LEDGER[0]!.timestamp);
  });

  test("a still page yields ONE long-held frame, not a frozen or sped-up video", () => {
    const still: FrameLedgerEntry[] = [{ file: "frame-000001.jpg", timestamp: 5_000, width: 640, height: 480 }];
    expect(frameDurationsMs(still, 35_000)).toEqual([30_000]);
  });

  test("a repeated or backwards timestamp is clamped to 1ms, never 0 or negative", () => {
    // A zero/negative `duration` is silently dropped by the concat demuxer, so a
    // clock hiccup would delete a frame rather than raise anything.
    const jittery: FrameLedgerEntry[] = [
      { file: "a.jpg", timestamp: 2_000, width: 4, height: 4 },
      { file: "b.jpg", timestamp: 2_000, width: 4, height: 4 },
      { file: "c.jpg", timestamp: 1_900, width: 4, height: 4 },
    ];
    for (const d of frameDurationsMs(jittery, 1_800)) expect(d).toBeGreaterThanOrEqual(1);
  });
});

describe("coalescing onto the concat demuxer's grid", () => {
  test("the grid step is the measured 1/25s the concat demuxer imposes", () => {
    expect(CONCAT_GRID_MS).toBe(40);
  });

  test("frames already further apart than the grid are all kept, with their durations", () => {
    // Each raw duration lands on the nearest grid step: 500 -> 520, 3000 stays,
    // and the tail absorbs the rounding so the total still tracks wallclock.
    expect(coalesceToConcatGrid(LEDGER, STOP_AT)).toEqual([
      { file: "frame-000001.jpg", durationMs: 520 },
      { file: "frame-000002.jpg", durationMs: 3000 },
      { file: "frame-000003.jpg", durationMs: 720 },
    ]);
  });

  test("frames closer together than the grid are coalesced, first one per slot", () => {
    // This is the bug the grid exists to make visible: fed unchanged, ffmpeg
    // gives colliding frames the SAME timestamp and silently drops all but one
    // (measured: a 373-frame capture encoded as 102 frames, no warning).
    const fast: FrameLedgerEntry[] = [0, 10, 20, 30, 40, 50, 80].map((ms, i) => ({
      file: `f${i}.jpg`,
      timestamp: 10_000 + ms,
      width: 100,
      height: 100,
    }));
    const gridded = coalesceToConcatGrid(fast, 10_120);
    expect(gridded.map((f) => f.file)).toEqual(["f0.jpg", "f2.jpg", "f6.jpg"]);
    for (const f of gridded) expect(f.durationMs % CONCAT_GRID_MS).toBe(0);
  });

  test("a long still survives as ONE long-held frame, not a run of resampled ones", () => {
    const still: FrameLedgerEntry[] = [{ file: "only.jpg", timestamp: 5_000, width: 8, height: 8 }];
    expect(coalesceToConcatGrid(still, 35_000)).toEqual([{ file: "only.jpg", durationMs: 30_000 }]);
  });

  test("durations stay on the grid and still sum to the wallclock span", () => {
    const gridded = coalesceToConcatGrid(LEDGER, STOP_AT);
    const total = gridded.reduce((a, f) => a + f.durationMs, 0);
    for (const f of gridded) expect(f.durationMs % CONCAT_GRID_MS).toBe(0);
    // 4250ms of wallclock rounds to 106 grid steps = 4240ms.
    expect(total).toBe(Math.round((STOP_AT - LEDGER[0]!.timestamp) / CONCAT_GRID_MS) * CONCAT_GRID_MS);
    expect(Math.abs(total - (STOP_AT - LEDGER[0]!.timestamp))).toBeLessThanOrEqual(CONCAT_GRID_MS);
  });

  test("every frame gets at least one grid step, so none is encoded as zero-length", () => {
    const fast: FrameLedgerEntry[] = [
      { file: "a.jpg", timestamp: 0, width: 8, height: 8 },
      { file: "b.jpg", timestamp: 1_000, width: 8, height: 8 },
    ];
    for (const f of coalesceToConcatGrid(fast, 1_001)) expect(f.durationMs).toBeGreaterThanOrEqual(CONCAT_GRID_MS);
  });

  test("an empty ledger coalesces to nothing rather than throwing", () => {
    expect(coalesceToConcatGrid([], STOP_AT)).toEqual([]);
  });
});

describe("concat manifest generation", () => {
  const manifest = buildConcatManifest(coalesceToConcatGrid(LEDGER, STOP_AT));

  test("declares the ffconcat version header", () => {
    expect(manifest.split("\n")[0]).toBe("ffconcat version 1.0");
  });

  test("emits one file+duration pair per frame, in seconds", () => {
    expect(manifest).toContain("file frame-000001.jpg\nduration 0.520000\n");
    expect(manifest).toContain("file frame-000002.jpg\nduration 3.000000\n");
    expect(manifest).toContain("file frame-000003.jpg\nduration 0.720000\n");
  });

  test("repeats the final file so its duration is honored", () => {
    // The concat demuxer applies a `duration` only when another `file` line
    // follows it. Without this repeat the last frame's hold is discarded.
    const lines = manifest.trim().split("\n");
    expect(lines.at(-1)).toBe("file frame-000003.jpg");
    expect(lines.at(-2)).toBe("duration 0.720000");
    expect(lines.filter((l) => l === "file frame-000003.jpg")).toHaveLength(2);
  });

  test("uses spool-relative names so ffconcat path quoting can never bite", () => {
    for (const line of manifest.split("\n")) {
      if (line.startsWith("file ")) expect(line).not.toContain("/");
    }
  });

  test("an empty ledger throws instead of producing a manifest of nothing", () => {
    expect(() => buildConcatManifest([])).toThrow(/empty frame ledger/);
  });
});

describe("encoder selection", () => {
  /** A realistic slice of `ffmpeg -hide_banner -encoders` output. */
  const line = (name: string, desc: string): string => ` V....D ${name}              ${desc}`;
  const FULL = [
    line("libx264", "libx264 H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10 (codec h264)"),
    line("libx264rgb", "libx264 H.264 RGB (codec h264)"),
    line("h264_videotoolbox", "VideoToolbox H.264 Encoder (codec h264)"),
    line("libx265", "libx265 H.265 / HEVC (codec hevc)"),
    line("hevc_videotoolbox", "VideoToolbox H.265 Encoder (codec hevc)"),
  ].join("\n");

  test("prefers hardware HEVC when present", () => {
    expect(selectEncoder(FULL)).toEqual({ encoder: "hevc_videotoolbox", codec: "hevc", tag: "hvc1" });
  });

  test("falls back to hardware H.264 when hevc_videotoolbox is absent", () => {
    const noHevcVt = FULL.split("\n").filter((l) => !l.includes("hevc_videotoolbox")).join("\n");
    expect(selectEncoder(noHevcVt)).toEqual({ encoder: "h264_videotoolbox", codec: "h264" });
  });

  test("falls back to libx265 on a machine with no videotoolbox at all", () => {
    const linuxish = FULL.split("\n").filter((l) => !l.includes("videotoolbox")).join("\n");
    expect(selectEncoder(linuxish)).toEqual({ encoder: "libx265", codec: "hevc", tag: "hvc1" });
  });

  test("falls back to libx264 as the last rung", () => {
    expect(selectEncoder(line("libx264", "libx264 (codec h264)"))).toEqual({ encoder: "libx264", codec: "h264" });
  });

  test("libx264rgb alone does NOT satisfy libx264", () => {
    // The trap: ffmpeg repeats "libx264" inside libx264rgb's DESCRIPTION, so a
    // substring (and even a word-boundary) match on the raw text picks an
    // RGB-only encoder that cannot write the yuv420p MP4 we just promised.
    // Only the name column counts.
    expect(() => selectEncoder(line("libx264rgb", "libx264 H.264 / AVC RGB (codec h264)"))).toThrow(/none of the supported video encoders/);
  });

  test("only the name column is read, never the description", () => {
    expect([...ffmpegEncoderNames(FULL)].sort()).toEqual([
      "h264_videotoolbox", "hevc_videotoolbox", "libx264", "libx264rgb", "libx265",
    ]);
  });

  test("ffmpeg's own flag legend is not mistaken for an encoder", () => {
    const legend = " V..... = Video\n A..... = Audio\n ------";
    expect(ffmpegEncoderNames(legend).has("libx264")).toBe(false);
    expect(() => selectEncoder(legend)).toThrow(/none of the supported video encoders/);
  });

  test("an ffmpeg with no usable encoder throws an install-actionable error", () => {
    expect(() => selectEncoder(line("gif", "GIF (Graphics Interchange Format)"))).toThrow(/brew install ffmpeg/);
    expect(() => selectEncoder(line("gif", "GIF (Graphics Interchange Format)"))).toThrow(/apt install ffmpeg/);
  });

  test("the ladder is HEVC-first and every HEVC rung carries the hvc1 tag", () => {
    expect(ENCODER_LADDER.map((c) => c.encoder)).toEqual([
      "hevc_videotoolbox", "h264_videotoolbox", "libx265", "libx264",
    ]);
    for (const rung of ENCODER_LADDER) {
      // QuickTime refuses to play HEVC in MP4 branded hev1; hvc1 is not cosmetic.
      if (rung.codec === "hevc") expect(rung.tag).toBe("hvc1");
      else expect(rung.tag).toBeUndefined();
    }
  });
});

describe("ffmpeg argv", () => {
  const args = buildFfmpegArgs("/spool/frames.ffconcat", "/out/v.mp4", ENCODER_LADDER[0]!);

  test("reads the manifest through the concat demuxer", () => {
    expect(args.join(" ")).toContain("-f concat -safe 0 -i /spool/frames.ffconcat");
  });

  test("passes the per-frame timestamps through instead of resampling to a fixed rate", () => {
    expect(args.join(" ")).toContain("-vsync vfr");
  });

  test("does NOT pin the duration with -t", () => {
    // Measured: -t trims at the LAST frame's PTS, so a 4.25s ledger encoded to
    // 3.56s. It throws away exactly the final hold the ledger exists to keep.
    expect(args).not.toContain("-t");
  });

  test("forces even dimensions, which videotoolbox requires", () => {
    expect(args.join(" ")).toContain("-vf scale=trunc(iw/2)*2:trunc(ih/2)*2");
  });

  test("always writes a faststart yuv420p mp4", () => {
    expect(args.join(" ")).toContain("-pix_fmt yuv420p");
    expect(args.join(" ")).toContain("-movflags +faststart");
  });

  test("tags HEVC hvc1 and leaves H.264 untagged", () => {
    expect(buildFfmpegArgs("m", "o", ENCODER_LADDER[0]!).join(" ")).toContain("-c:v hevc_videotoolbox -tag:v hvc1");
    expect(buildFfmpegArgs("m", "o", ENCODER_LADDER[1]!).join(" ")).toContain("-c:v h264_videotoolbox");
    expect(buildFfmpegArgs("m", "o", ENCODER_LADDER[1]!)).not.toContain("-tag:v");
  });

  test("the output path is the final argument", () => {
    expect(args.at(-1)).toBe("/out/v.mp4");
  });
});

describe("even dimensions", () => {
  test("odd dimensions are truncated down, matching the ffmpeg filter exactly", () => {
    expect(evenDimensions(641, 481)).toEqual({ width: 640, height: 480 });
  });

  test("even dimensions are left alone", () => {
    expect(evenDimensions(1280, 720)).toEqual({ width: 1280, height: 720 });
  });
});

describe("frame dimensions are read from the bytes, never guessed", () => {
  test("PNG width/height come out of IHDR", () => {
    const png = Buffer.alloc(24);
    png.writeUInt32BE(0x89504e47, 0);
    png.writeUInt32BE(0x0d0a1a0a, 4);
    png.write("IHDR", 12, "latin1");
    png.writeUInt32BE(1440, 16);
    png.writeUInt32BE(900, 20);
    expect(imageSize(png)).toEqual({ width: 1440, height: 900 });
  });

  test("JPEG width/height come out of the first SOF segment", () => {
    // SOI, an APP0 segment to be skipped, then SOF0 carrying height then width.
    const jpeg = Buffer.from([
      0xff, 0xd8,
      0xff, 0xe0, 0x00, 0x04, 0x00, 0x00,
      0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0x58, 0x03, 0x20,
      0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
    ]);
    expect(imageSize(jpeg)).toEqual({ width: 800, height: 600 });
  });

  test("a truncated or non-image payload yields undefined rather than a bogus size", () => {
    expect(imageSize(Buffer.from([0xff, 0xd8]))).toBeUndefined();
    expect(imageSize(Buffer.from("not an image", "utf8"))).toBeUndefined();
  });
});

describe("double start", () => {
  test("starting twice on one target throws instead of orphaning the first recording", () => {
    // The quiet version of this bug: the second start replaces the registry
    // entry, the first screencast's connection and spool leak, and the caller's
    // stop then finalizes a recording that is not the one they started.
    expect(() => assertNotRecording("TAB-A", ["TAB-A"])).toThrow(/already in progress for target TAB-A/);
    expect(() => assertNotRecording("TAB-A", ["TAB-A"])).toThrow(/stop_screen_recording first/);
  });

  test("a second target is free to record concurrently", () => {
    expect(() => assertNotRecording("TAB-B", ["TAB-A"])).not.toThrow();
    expect(() => assertNotRecording("TAB-A", [])).not.toThrow();
  });
});

describe("choosing which recording to stop", () => {
  test("with nothing recording, it throws and explains the same-process constraint", () => {
    expect(() => chooseRecordingId([])).toThrow(/no screen recording is in progress in this process/);
    expect(() => chooseRecordingId([], "TAB-A")).toThrow(/different process/);
  });

  test("with exactly one recording, a bare stop resolves to it", () => {
    expect(chooseRecordingId(["TAB-A"])).toBe("TAB-A");
    expect(chooseRecordingId(["TAB-A"], "active")).toBe("TAB-A");
  });

  test("with several recordings, a bare stop refuses rather than guessing", () => {
    // Guessing here ends another agent's recording, which is unrecoverable.
    expect(() => chooseRecordingId(["TAB-A", "TAB-B"])).toThrow(/2 screen recordings are in progress/);
    expect(() => chooseRecordingId(["TAB-A", "TAB-B"])).toThrow(/pass 'target'/);
  });

  test("an explicit target id picks that recording out of several", () => {
    expect(chooseRecordingId(["TAB-A", "TAB-B"], "TAB-B")).toBe("TAB-B");
  });

  test("a non-id selector defers to browser resolution rather than string-matching", () => {
    // 'url:foo' is not a target id; answering from the id list alone would
    // either miss or, worse, match an id that happened to contain the text.
    expect(chooseRecordingId(["TAB-A", "TAB-B"], "url:example.com")).toBeUndefined();
    expect(chooseRecordingId(["TAB-A", "TAB-B"], "index:0")).toBeUndefined();
  });
});

describe("refusal paths", () => {
  let dir = "";
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = "";
  });

  test("no recording is live in a fresh process", () => {
    expect(activeScreenRecordings()).toEqual([]);
  });

  test("stop without start throws, naming the same-process constraint", async () => {
    // A silent no-op here would hand the caller an empty result that reads like
    // a zero-length recording rather than a mistake.
    await expect(stopScreenRecording()).rejects.toThrow(/no screen recording is in progress in this process/);
    await expect(stopScreenRecording()).rejects.toThrow(/different process/);
  });

  test("stop with a savePath and no recording still throws (the file is never created)", async () => {
    dir = await mkdtemp(join(tmpdir(), "cdp-screencast-"));
    await expect(stopScreenRecording({ savePath: join(dir, "never.mp4") })).rejects.toThrow(/no screen recording is in progress/);
  });

  test("start refuses a format outside jpeg|png before dialing the browser", async () => {
    await expect(startScreenRecording({ format: "webp" as unknown as "jpeg" })).rejects.toThrow(/format must be 'jpeg' or 'png'/);
  });

  test("start refuses an out-of-range jpeg quality before dialing the browser", async () => {
    await expect(startScreenRecording({ quality: 140 })).rejects.toThrow(/quality must be a number between 0 and 100/);
    await expect(startScreenRecording({ quality: -1 })).rejects.toThrow(/quality must be a number between 0 and 100/);
  });
});

describe("Firefox / BiDi has no screencast", () => {
  test("both tools require capture.screencast", () => {
    expect(REQUIRED_CAPABILITIES.start_screen_recording).toEqual(["capture.screencast"]);
    expect(REQUIRED_CAPABILITIES.stop_screen_recording).toEqual(["capture.screencast"]);
  });

  test("Chrome offers both tools", () => {
    const chrome = toolAvailability("chrome");
    expect(chrome.available).toContain("start_screen_recording");
    expect(chrome.available).toContain("stop_screen_recording");
  });

  test("Firefox reports both as unavailable, naming the missing capability", () => {
    // ADR-001: an unsupported tool is ABSENT from tools/list, never present and
    // throwing, so the refusal has to be visible here rather than at call time.
    const firefox = toolAvailability("firefox");
    expect(firefox.available).not.toContain("start_screen_recording");
    expect(firefox.available).not.toContain("stop_screen_recording");
    for (const name of ["start_screen_recording", "stop_screen_recording"] as const) {
      expect(firefox.unavailable.find((u) => u.name === name)?.missing).toEqual(["capture.screencast"]);
    }
  });

  test("neither tool is wired into the Firefox registry", () => {
    expect(FIREFOX_TOOLS).not.toHaveProperty("start_screen_recording");
    expect(FIREFOX_TOOLS).not.toHaveProperty("stop_screen_recording");
  });

  test("the manifest tells a reader why Firefox cannot run it", () => {
    const spec = MANIFEST.find((s) => s.name === "start_screen_recording");
    expect(spec?.description).toContain("WebDriver BiDi has no screencast");
  });
});

describe("registration", () => {
  test("both tools are in the registry and the manifest", () => {
    expect(TOOL_NAMES).toContain("start_screen_recording");
    expect(TOOL_NAMES).toContain("stop_screen_recording");
    expect(MANIFEST.map((s) => s.name)).toContain("start_screen_recording");
    expect(MANIFEST.map((s) => s.name)).toContain("stop_screen_recording");
  });

  test("both accept the optional lease every target-resolving tool takes", () => {
    for (const name of ["start_screen_recording", "stop_screen_recording"]) {
      expect(MANIFEST.find((s) => s.name === name)?.inputSchema.properties?.lease).toBeDefined();
    }
  });
});
