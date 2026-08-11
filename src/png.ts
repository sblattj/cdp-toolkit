/**
 * png.ts : a lossless, streaming, browser-free stitcher for vertically banded PNG captures.
 *
 * WHY THIS EXISTS
 * ===============
 * Chrome's `Page.captureScreenshot` cannot produce an image larger than 16384 device px on
 * either side. Measured exact to the pixel on Chrome/151: 16384 encodes in ~250ms, 16400 never
 * answers and permanently wedges the tab. It holds on BOTH axes, clipped and unclipped alike,
 * and it is not an area cap (8192x8192 succeeds at 67M px while 16400x1600 hangs at 26M).
 * Output device px is `ceil(css * scale * devicePixelRatio)`, so on a 2x display a full-page
 * capture dies past ~8192 CSS px of page, and at `scale: 4` past ~2048 CSS px : an ordinary
 * long page. The way out is to capture the page in horizontal BANDS, each under the cap, and
 * glue them back together.
 *
 * This module is the glue and ONLY the glue. It opens no socket, imports nothing from
 * client.ts, and knows nothing about CDP; it takes PNG bytes and writes PNG bytes. That split
 * is deliberate: the size limit is a browser fact, but the fix is an image-format fact, and
 * mixing them would make the hard part (the pixel math below) untestable without a browser.
 *
 * WHAT CHROME ACTUALLY EMITS (measured, not assumed)
 * --------------------------------------------------
 * Every IHDR of five real `Page.captureScreenshot` PNGs (800x600, 2560x16384, 8192x8192,
 * 1600x16384, 16384x1600) reads byte-identically past the dimensions:
 *
 *     bit depth 8, colour type 2 (truecolour RGB, 3 bytes/px), compression 0, filter 0,
 *     interlace 0
 *
 * so interlace is never seen in practice, but is still rejected explicitly below rather than
 * mis-decoded. Their chunk tables are `IHDR, iCCP, IDAT x N, IEND`, with N = 8, 40, 2709,
 * 4421 and 261 respectively: MULTI-IDAT IS THE NORMAL CASE, not an edge case, for every
 * capture large enough to need this module. And Chrome does emit one ancillary chunk, an
 * iCCP ICC colour profile : a stitcher that dropped ancillary chunks wholesale would silently
 * recolour every Chrome capture it touched, which is why the carry policy below exists at all.
 *
 * WHAT IS SUPPORTED
 * -----------------
 *   supported : non-interlaced, colour types 0/2/4/6 (grey, RGB, grey+alpha, RGBA) at every
 *               bit depth the PNG spec allows for that type (1/2/4/8/16 for grey, 8/16 for the
 *               rest). Nothing here is RGB-specific : filtering is defined on BYTES, with
 *               `bpp = ceil(bitsPerPixel/8)` and `bpr = ceil(width*bitsPerPixel/8)`, so the
 *               same code is correct for all of them.
 *   rejected  : interlaced (Adam7), with a named error : its seven reduced passes are not
 *               scanlines of the final image, so a band-wise concatenation of them is not the
 *               concatenated image. Detected from IHDR byte 12, never guessed.
 *   rejected  : colour type 3 (palette), with a named error. Stitching palettized bands would
 *               additionally require every band's PLTE/tRNS to be identical or a full palette
 *               remap; Chrome never emits one, so the untested path is refused rather than
 *               written.
 *
 * STREAMING, AND WHAT "BOUNDED" MEANS HERE
 * ----------------------------------------
 * The images this exists for do not fit in memory: 2560x140982 RGBA is ~1.4 GB raw. So no step
 * ever holds the whole image. Per band the module inflates that band's IDAT stream in 256 KiB
 * chunks, un-filters ONE scanline at a time, and appends it to a 4 MiB block that is filtered,
 * chosen, and pushed into a single continuous deflate stream whose output is framed straight
 * into IDAT chunks on disk. Live state is: the band's own compressed bytes (the caller's
 * buffer : Chrome hands a whole PNG back per capture, so one compressed band is the floor),
 * zlib's windows, one block plus its two candidate encodings (~12 MiB), and two scanlines.
 *
 * MEASURED with `/usr/bin/time -l`, feeding an async generator that synthesises 1280x2048
 * bands on the fly (so the generator's own working set is inside the number too):
 *
 *     bands   output rows   raw image    wall     peak RSS
 *        20        40,960     150 MB     1.14s     121.1 MB
 *        60       122,880     471 MB     3.31s     129.9 MB
 *       180       368,640    1415 MB     9.81s     135.3 MB
 *
 * 9.4x the image for +11.7% RSS (23.6 MB of which is bun's own floor), and wall clock linear in
 * pixels. Peak tracks BAND size, not image size, which is the property that matters. The last
 * row's 1280x368640 output is past what the verifying tools can read back : ffmpeg refuses it
 * ("Picture size 1280x368640 is invalid", its ~268 Mpx ceiling) and `sips` reports nil
 * dimensions, so the largest INDEPENDENTLY VERIFIED stitch is the 1280x122880 middle row.
 *
 * THE THING THAT IS EASY TO GET SILENTLY WRONG: prev-row context at a band seam
 * ----------------------------------------------------------------------------
 * A PNG row filter is relative to the row above it, and "the row above" is all zeros only for
 * the first row of an IMAGE. Since every band IS its own PNG, DECODING must reset that context
 * at the top of every band; an implementation that carries the previous band's last row into
 * the first row of the next one silently mis-decodes exactly one row per seam. Nothing about
 * the file is structurally wrong when this happens : it is a valid PNG with a few wrong rows,
 * the kind of bug that survives eyeballing. `test/png.test.ts` pins a prev-DEPENDENT filter
 * (Up/Average/Paeth) onto the first row of bands 2 and 3 for this reason: neither ffmpeg nor
 * Chrome ever emits one there (both fall back to None/Sub when the row above is known-zero),
 * so a fixture built by hand is the only thing that catches it.
 *
 * HOW OUTPUT ROWS ARE RE-FILTERED: measured per block, not predicted
 * ------------------------------------------------------------------
 * The textbook answer is a per-row minimum-sum-of-absolute-differences heuristic. It is wrong
 * here, and so is its opposite. Every strategy below was implemented and run end to end at
 * zlib level 6 over all five real Chrome captures plus three ffmpeg control images (each input
 * stitched to itself, so every seam is exercised); bytes of the stitched output:
 *
 *   input (x2 bands, x4 for controls)   heuristic     all-None     THIS (per block)
 *   real  800x600     ->  800x1200          56,020       52,191       52,174
 *   real 2560x16384   -> 2560x32768        317,509    1,163,677 (!)  317,497
 *   real 1600x16384   -> 1600x32768     35,958,755   30,727,639   30,724,184
 *   real 8192x8192    -> 8192x16384     22,913,788   18,216,704   18,207,830
 *   real16384x1600    ->16384x3200       2,330,190    2,284,030    2,283,366
 *   mandelbrot        -> 1200x3200        1,995,356    2,182,530    1,995,116
 *   testsrc2          -> 1200x3200          375,421      443,609      375,325
 *   white noise       -> 1200x3200        8,173,014    8,173,014    8,172,766
 *
 * Neither fixed strategy is safe: the heuristic is 15-20% too big on two real captures, and
 * None is 266% too big on another real one. The reason the heuristic loses on screenshots is
 * that it scores one row in isolation and cannot see what actually compresses a screenshot :
 * long literal runs that deflate's LZ77 matches against the rows ABOVE them. Filtering turns
 * those runs into residuals and destroys the matches. The reason None loses on gradients is
 * the mirror image.
 *
 * So the choice is not predicted, it is measured. Rows accumulate into a 4 MiB block; the
 * block is filtered BOTH ways, both encodings are compressed with a throwaway deflate, and
 * whichever is genuinely smaller is what goes into the output stream. That lands at or below
 * the better fixed strategy on all eight images above, adapts down a page whose top is a photo
 * and whose body is text, and costs two extra deflates per block (1.6x the heuristic's wall
 * clock, 3.1x plain None's, on the 1600x32768 stitch).
 *
 * This is also what keeps the ENCODE-side prev-row carry load-bearing: the heuristic candidate
 * filters each block's first row against the last row of the previous block, which at a band
 * seam is the last row of the previous BAND. (Measured, and worth knowing before "fixing" it:
 * zeroing that carry does NOT corrupt output, because the chooser and the filter it picks read
 * the same buffer, so a zeroed one just collapses the choice onto None/Sub, which ignore it.
 * It was worth 2.1% of output size, never correctness. The DECODE-side reset, above, is the
 * one that is a correctness bug.)
 *
 * ANCILLARY CHUNKS
 * ----------------
 * This matters more than it looks, because Chrome DOES emit one (the iCCP measured above), so
 * "drop everything ancillary" would recolour every real capture. Chunks that describe the
 * SAMPLES and stay true under vertical concatenation are carried from the first band and
 * required to match byte-for-byte in every later band (a disagreement throws, naming the
 * chunk): gAMA, cHRM, sRGB, iCCP, pHYs. Everything else is dropped : tEXt/iTXt/zTXt/tIME
 * describe one capture at one instant, and silently re-labelling the whole stitch with band 1's
 * copy is worse than not having it.
 *
 * HONEST FAILURE
 * --------------
 * All output goes to `<outPath>.stitch-partial` and is renamed onto `outPath` only after IEND
 * is written and the IHDR height is patched to the real total. Any throw removes the partial,
 * so a failed stitch never leaves a file at the caller's path : not a truncated one, and not a
 * structurally valid one that is short a few thousand rows.
 *
 * ZERO NEW DEPENDENCIES, per CONTRACT rule 1: `node:zlib` is a Node builtin (this codebase
 * already imports node:fs/promises, node:path, node:async_hooks, node:child_process). CRC32 is
 * hand-written below because chunk framing needs it and "if you need a helper, write it".
 */
import { once } from "node:events";
import { mkdir, open, rename, rm } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname } from "node:path";
import { createDeflate, createInflate, deflateSync } from "node:zlib";

/** The 8 bytes every PNG starts with: \x89 P N G \r \n \x1a \n. */
const PNG_SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);

/** zlib in/out chunk size. 256 KiB keeps IDAT framing overhead at 12 bytes per 256 KiB (0.005%). */
const ZLIB_CHUNK = 1 << 18;

/**
 * Rows are filtered and emitted a block at a time. 4 MiB of raw scanlines is enough for the
 * two throwaway deflates in `emitBlock` to reflect real compressibility, and small enough that
 * the block plus its two candidate encodings stay a rounding error next to one band.
 */
const BLOCK_RAW_BYTES = 1 << 22;

/** ...but never more rows than this, so a 1-px-wide image cannot buffer a million of them. */
const MAX_BLOCK_ROWS = 4096;

/**
 * Compression level for the throwaway per-block decision deflates: the SAME level the output
 * stream uses, because a cheaper decision is a wrong decision. Deciding at level 1 was tried
 * and measured: it is ~30% faster overall but picks the loser on 2 of the 8 measured images
 * (16384x1600 real capture +2.0%, ffmpeg mandelbrot +9.4%), because level 1's shorter match
 * search under-rates exactly the long cross-row LZ77 matches the decision turns on.
 */
const DECIDE_LEVEL = 6;

/** Ancillary chunks that survive vertical concatenation unchanged. See the header for the policy. */
const CARRIED_CHUNKS: readonly string[] = ["gAMA", "cHRM", "sRGB", "iCCP", "pHYs"];

/** Channels per pixel for each PNG colour type. 3 (palette) is absent on purpose : it is rejected. */
const CHANNELS: Readonly<Record<number, number>> = { 0: 1, 2: 3, 4: 2, 6: 4 };

/** Bit depths the PNG spec allows for each supported colour type. */
const LEGAL_DEPTHS: Readonly<Record<number, readonly number[]>> = {
  0: [1, 2, 4, 8, 16],
  2: [8, 16],
  4: [8, 16],
  6: [8, 16],
};

const COLOUR_TYPE_NAMES: Readonly<Record<number, string>> = {
  0: "greyscale", 2: "truecolour RGB", 3: "palette", 4: "greyscale+alpha", 6: "RGBA",
};

/** Every failure this module raises. Carries a message that names the band and the mismatch. */
export class PngStitchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PngStitchError";
  }
}

/** What a completed stitch reports. `bytes` is the size of the file actually written. */
export interface PngStitchResult {
  width: number;
  height: number;
  bytes: number;
  bands: number;
}

/** The IHDR fields that must agree across every band (height is the one that may differ). */
interface BandHeader {
  width: number;
  height: number;
  bitDepth: number;
  colourType: number;
}

interface CarriedChunk {
  type: string;
  data: Uint8Array;
}

interface ParsedBand {
  header: BandHeader;
  /** [start, end) byte ranges of each IDAT payload, in file order. Views, never copies. */
  idat: Array<[number, number]>;
  carried: CarriedChunk[];
}

/* --------------------------------- CRC32 --------------------------------- */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** Incremental CRC32 (PNG's, the standard IEEE one). Seed 0xffffffff, xor the result at the end. */
function crcUpdate(crc: number, bytes: Uint8Array): number {
  let c = crc;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return c >>> 0;
}

/** CRC32 of one buffer. Exported so a caller framing its own chunks does not need a second copy of this. */
export function crc32(bytes: Uint8Array): number {
  return (crcUpdate(0xffffffff, bytes) ^ 0xffffffff) >>> 0;
}

/* ------------------------------ byte helpers ------------------------------ */

function readU32(b: Uint8Array, off: number): number {
  return ((b[off]! << 24) | (b[off + 1]! << 16) | (b[off + 2]! << 8) | b[off + 3]!) >>> 0;
}

function chunkTypeAt(b: Uint8Array, off: number): string {
  return String.fromCharCode(b[off]!, b[off + 1]!, b[off + 2]!, b[off + 3]!);
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/* --------------------------- PNG row filtering --------------------------- */

/** PNG's Paeth predictor (spec 9.4): pick whichever of left/up/upper-left the linear estimate is nearest. */
function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = p > a ? p - a : a - p;
  const pb = p > b ? p - b : b - p;
  const pc = p > c ? p - c : c - p;
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/**
 * Reverse a PNG row filter IN PLACE. `row` arrives filtered and leaves raw; `prev` is the raw
 * row above (all zeros for the first row of an image, which for us means the first row of each
 * BAND, since every band is its own PNG).
 */
function unfilterRow(type: number, row: Uint8Array, prev: Uint8Array, bpp: number, at: string): void {
  const n = row.length;
  switch (type) {
    case 0:
      return;
    case 1:
      for (let i = bpp; i < n; i++) row[i] = (row[i]! + row[i - bpp]!) & 0xff;
      return;
    case 2:
      for (let i = 0; i < n; i++) row[i] = (row[i]! + prev[i]!) & 0xff;
      return;
    case 3:
      for (let i = 0; i < n; i++) {
        const a = i >= bpp ? row[i - bpp]! : 0;
        row[i] = (row[i]! + ((a + prev[i]!) >> 1)) & 0xff;
      }
      return;
    case 4:
      for (let i = 0; i < n; i++) {
        const a = i >= bpp ? row[i - bpp]! : 0;
        const c = i >= bpp ? prev[i - bpp]! : 0;
        row[i] = (row[i]! + paeth(a, prev[i]!, c)) & 0xff;
      }
      return;
    default:
      throw new PngStitchError(`${at}: unknown row filter type ${type} (PNG defines 0-4)`);
  }
}

/** |byte| read as a signed value: the cost the classic per-row filter heuristic minimises. */
function absSigned(v: number): number {
  const u = v & 0xff;
  return u < 128 ? u : 256 - u;
}

/**
 * The classic per-row filter heuristic: minimum sum of absolute (signed) residuals over all five
 * candidates, computed in ONE pass because left/up/upper-left are shared across the five
 * estimates. This is only ever a CANDIDATE strategy here : see `emitBlock`, which decides
 * between it and plain None by compressing both, because this heuristic is measurably wrong on
 * screenshot content (header table).
 */
function chooseFilter(row: Uint8Array, prev: Uint8Array, bpp: number): number {
  const n = row.length;
  let s0 = 0, s1 = 0, s2 = 0, s3 = 0, s4 = 0;
  for (let i = 0; i < n; i++) {
    const x = row[i]!;
    const b = prev[i]!;
    const a = i >= bpp ? row[i - bpp]! : 0;
    const c = i >= bpp ? prev[i - bpp]! : 0;
    s0 += absSigned(x);
    s1 += absSigned(x - a);
    s2 += absSigned(x - b);
    s3 += absSigned(x - ((a + b) >> 1));
    s4 += absSigned(x - paeth(a, b, c));
  }
  let best = 0, bestSum = s0;
  if (s1 < bestSum) { best = 1; bestSum = s1; }
  if (s2 < bestSum) { best = 2; bestSum = s2; }
  if (s3 < bestSum) { best = 3; bestSum = s3; }
  if (s4 < bestSum) { best = 4; }
  return best;
}

/** Apply filter `type` to `row` against `prev`, writing bpr bytes into `out` at `off`. */
function writeFilteredRow(type: number, row: Uint8Array, prev: Uint8Array, bpp: number, out: Uint8Array, off: number): void {
  const n = row.length;
  switch (type) {
    case 0:
      out.set(row, off);
      return;
    case 1:
      for (let i = 0; i < n; i++) out[off + i] = (row[i]! - (i >= bpp ? row[i - bpp]! : 0)) & 0xff;
      return;
    case 2:
      for (let i = 0; i < n; i++) out[off + i] = (row[i]! - prev[i]!) & 0xff;
      return;
    case 3:
      for (let i = 0; i < n; i++) {
        const a = i >= bpp ? row[i - bpp]! : 0;
        out[off + i] = (row[i]! - ((a + prev[i]!) >> 1)) & 0xff;
      }
      return;
    default:
      for (let i = 0; i < n; i++) {
        const a = i >= bpp ? row[i - bpp]! : 0;
        const c = i >= bpp ? prev[i - bpp]! : 0;
        out[off + i] = (row[i]! - paeth(a, prev[i]!, c)) & 0xff;
      }
      return;
  }
}

/* ------------------------------ band parsing ------------------------------ */

/**
 * Bytes per pixel for filtering purposes: PNG rounds sub-byte pixels UP to 1 (spec 9.2). The
 * `max(1, ...)` is the spec's own wording, not a live branch : ceil() of any positive bit count
 * is already >= 1, and removing it changes no output (verified by mutation, no test moved).
 */
function filterUnitBytes(h: BandHeader): number {
  return Math.max(1, Math.ceil((CHANNELS[h.colourType]! * h.bitDepth) / 8));
}

/** Bytes in one raw scanline, excluding its leading filter byte. */
function bytesPerRow(h: BandHeader): number {
  return Math.ceil((h.width * CHANNELS[h.colourType]! * h.bitDepth) / 8);
}

function readIhdr(band: Uint8Array, dataStart: number, at: string): BandHeader {
  const width = readU32(band, dataStart);
  const height = readU32(band, dataStart + 4);
  const bitDepth = band[dataStart + 8]!;
  const colourType = band[dataStart + 9]!;
  const compression = band[dataStart + 10]!;
  const filterMethod = band[dataStart + 11]!;
  const interlace = band[dataStart + 12]!;

  if (width < 1 || height < 1) throw new PngStitchError(`${at}: IHDR declares ${width}x${height}; both dimensions must be >= 1`);
  if (compression !== 0) throw new PngStitchError(`${at}: IHDR compression method ${compression}; PNG defines only 0 (deflate)`);
  if (filterMethod !== 0) throw new PngStitchError(`${at}: IHDR filter method ${filterMethod}; PNG defines only 0`);
  if (interlace === 1) {
    throw new PngStitchError(
      `${at}: interlaced (Adam7) PNG is not supported. Its seven reduced passes are not scanlines of the final image, ` +
        `so bands of them cannot be concatenated; re-capture without interlacing (Chrome's Page.captureScreenshot always does).`,
    );
  }
  if (interlace !== 0) throw new PngStitchError(`${at}: IHDR interlace method ${interlace}; PNG defines only 0 (none) and 1 (Adam7)`);
  if (colourType === 3) {
    throw new PngStitchError(
      `${at}: colour type 3 (palette) is not supported. Concatenating palettized bands requires every band's PLTE/tRNS to ` +
        `be identical or a full palette remap; Chrome emits colour type 2, so this path is refused rather than guessed.`,
    );
  }
  if (CHANNELS[colourType] === undefined) throw new PngStitchError(`${at}: IHDR colour type ${colourType}; PNG defines 0, 2, 3, 4 and 6`);
  if (!LEGAL_DEPTHS[colourType]!.includes(bitDepth)) {
    throw new PngStitchError(
      `${at}: bit depth ${bitDepth} is not legal for colour type ${colourType} (${COLOUR_TYPE_NAMES[colourType]}); ` +
        `allowed: ${LEGAL_DEPTHS[colourType]!.join(", ")}`,
    );
  }
  return { width, height, bitDepth, colourType };
}

/**
 * Walk a band's chunk table. Only headers are read here : IDAT payloads are recorded as [start,
 * end) views and never copied, so parsing a 18 MB capture costs the 278 chunk headers, not the
 * 18 MB. IHDR's CRC is verified (13 bytes, free); IDAT corruption is caught downstream by the
 * zlib stream's own adler32, which covers the concatenated payload as a whole.
 */
function parseBand(band: Uint8Array, index: number): ParsedBand {
  const at = `band ${index}`;
  if (band.length < 8) throw new PngStitchError(`${at}: ${band.length} bytes is too short to be a PNG`);
  for (let i = 0; i < 8; i++) {
    if (band[i] !== PNG_SIGNATURE[i]) throw new PngStitchError(`${at}: not a PNG (bad 8-byte signature)`);
  }

  let header: BandHeader | undefined;
  const idat: Array<[number, number]> = [];
  const carried: CarriedChunk[] = [];
  let sawIend = false;
  let off = 8;

  while (off + 8 <= band.length) {
    const len = readU32(band, off);
    const type = chunkTypeAt(band, off + 4);
    const dataStart = off + 8;
    const dataEnd = dataStart + len;
    if (dataEnd + 4 > band.length) {
      throw new PngStitchError(`${at}: chunk "${type}" at byte ${off} claims ${len} payload bytes but only ${band.length - dataStart} remain (truncated PNG)`);
    }
    if (type === "IHDR") {
      if (off !== 8) throw new PngStitchError(`${at}: IHDR must be the first chunk, found it at byte ${off}`);
      if (len !== 13) throw new PngStitchError(`${at}: IHDR payload is ${len} bytes, must be 13`);
      const want = readU32(band, dataEnd);
      const got = crc32(band.subarray(off + 4, dataEnd));
      if (want !== got) throw new PngStitchError(`${at}: IHDR CRC mismatch (file says 0x${want.toString(16)}, computed 0x${got.toString(16)})`);
      header = readIhdr(band, dataStart, at);
    } else if (!header) {
      throw new PngStitchError(`${at}: first chunk is "${type}", expected IHDR`);
    } else if (type === "IDAT") {
      idat.push([dataStart, dataEnd]);
    } else if (type === "IEND") {
      sawIend = true;
      break;
    } else if (CARRIED_CHUNKS.includes(type)) {
      carried.push({ type, data: band.subarray(dataStart, dataEnd) });
    }
    off = dataEnd + 4;
  }

  if (!header) throw new PngStitchError(`${at}: no IHDR chunk`);
  if (idat.length === 0) throw new PngStitchError(`${at}: no IDAT chunk`);
  if (!sawIend) throw new PngStitchError(`${at}: no IEND chunk (truncated PNG)`);
  return { header, idat, carried };
}

/** Every way band N can disagree with band 1, each named in its own message. */
function assertCompatible(first: BandHeader, next: BandHeader, firstCarried: CarriedChunk[], nextCarried: CarriedChunk[], index: number): void {
  const at = `band ${index}`;
  if (next.width !== first.width) throw new PngStitchError(`${at}: width ${next.width} does not match band 1's width ${first.width}`);
  if (next.bitDepth !== first.bitDepth) throw new PngStitchError(`${at}: bit depth ${next.bitDepth} does not match band 1's bit depth ${first.bitDepth}`);
  if (next.colourType !== first.colourType) {
    throw new PngStitchError(
      `${at}: colour type ${next.colourType} (${COLOUR_TYPE_NAMES[next.colourType] ?? "?"}) does not match band 1's ` +
        `colour type ${first.colourType} (${COLOUR_TYPE_NAMES[first.colourType] ?? "?"})`,
    );
  }
  for (const type of CARRIED_CHUNKS) {
    const a = firstCarried.find((c) => c.type === type);
    const b = nextCarried.find((c) => c.type === type);
    if (!a && !b) continue;
    if (!a || !b) throw new PngStitchError(`${at}: ${b ? "has" : "is missing"} a "${type}" chunk that band 1 ${b ? "does not have" : "has"}; the bands disagree about how their samples are interpreted`);
    if (!sameBytes(a.data, b.data)) throw new PngStitchError(`${at}: its "${type}" chunk differs from band 1's; the bands disagree about how their samples are interpreted`);
  }
}

/* ------------------------------ output plumbing ------------------------------ */

/** Sequential PNG chunk framing onto a file handle, tracking the byte offset so IHDR can be patched. */
class ChunkWriter {
  private pos = 0;
  constructor(private readonly fh: FileHandle) {}

  get bytes(): number {
    return this.pos;
  }

  async writeRaw(b: Uint8Array): Promise<void> {
    await this.fh.write(b, 0, b.length, this.pos);
    this.pos += b.length;
  }

  /** One chunk as one writev: [length+type][payload][crc]. Payload is never copied. */
  async writeChunk(type: string, payload: Uint8Array): Promise<void> {
    const head = Buffer.allocUnsafe(8);
    head.writeUInt32BE(payload.length, 0);
    head.write(type, 4, "latin1");
    const crc = (crcUpdate(crcUpdate(0xffffffff, head.subarray(4)), payload) ^ 0xffffffff) >>> 0;
    const tail = Buffer.allocUnsafe(4);
    tail.writeUInt32BE(crc, 0);
    await this.fh.writev([head, payload, tail], this.pos);
    this.pos += 8 + payload.length + 4;
  }

  async patchAt(position: number, b: Uint8Array): Promise<void> {
    await this.fh.write(b, 0, b.length, position);
  }
}

/** The 25 bytes of a complete IHDR chunk (length + type + 13-byte payload + CRC). */
function ihdrChunk(h: BandHeader, height: number): Buffer {
  const buf = Buffer.allocUnsafe(25);
  buf.writeUInt32BE(13, 0);
  buf.write("IHDR", 4, "latin1");
  buf.writeUInt32BE(h.width, 8);
  buf.writeUInt32BE(height, 12);
  buf[16] = h.bitDepth;
  buf[17] = h.colourType;
  buf[18] = 0; // compression: deflate
  buf[19] = 0; // filter method: adaptive
  buf[20] = 0; // interlace: none
  buf.writeUInt32BE(crc32(buf.subarray(4, 21)), 21);
  return buf;
}

/**
 * The single continuous deflate stream every band's rows feed into, framed to IDAT chunks as it
 * emits. One stream, not one per band: a per-band stream would reset the deflate window at every
 * seam and would also be illegal PNG (the concatenated IDAT payload is ONE zlib stream).
 */
class RowEncoder {
  private readonly deflate = createDeflate({ chunkSize: ZLIB_CHUNK });
  private readonly pump: Promise<void>;
  private readonly rowsPerBlock: number;
  private readonly block: Buffer;
  private blockRows = 0;
  private readonly candNone: Buffer;
  private readonly candHeuristic: Buffer;
  /**
   * The last RAW scanline handed to the encoder, the filter context for the next one. Carried
   * across block boundaries AND across band seams : filters are defined on the whole output
   * image, which knows nothing about where the bands were cut.
   */
  private readonly prevRaw: Uint8Array;

  constructor(private readonly writer: ChunkWriter, private readonly bpr: number, private readonly bpp: number) {
    this.rowsPerBlock = Math.min(MAX_BLOCK_ROWS, Math.max(1, Math.floor(BLOCK_RAW_BYTES / bpr)));
    this.block = Buffer.allocUnsafe(this.rowsPerBlock * bpr);
    this.candNone = Buffer.allocUnsafe(this.rowsPerBlock * (bpr + 1));
    this.candHeuristic = Buffer.allocUnsafe(this.rowsPerBlock * (bpr + 1));
    this.prevRaw = new Uint8Array(bpr);
    this.pump = (async () => {
      for await (const chunk of this.deflate) await this.writer.writeChunk("IDAT", chunk as Buffer);
    })();
    // Rejection is surfaced by finish()/abort(); an unobserved rejection here would kill the process first.
    this.pump.catch(() => {});
  }

  async addRow(raw: Uint8Array): Promise<void> {
    this.block.set(raw, this.blockRows * this.bpr);
    this.blockRows += 1;
    if (this.blockRows === this.rowsPerBlock) await this.emitBlock();
  }

  /**
   * Filter one block BOTH ways, compress both, and emit whichever is actually smaller.
   *
   * A per-row heuristic cannot see the thing that decides a screenshot's size (deflate matching
   * a row against the rows above it), and a fixed choice is wrong by 266% on one of the five
   * real captures either way round : see the header table. So the choice is not predicted, it is
   * MEASURED, once per block, which also lets a page whose top is a photo and whose body is text
   * switch strategy on the way down. The extra cost is two throwaway deflates per block.
   */
  private async emitBlock(): Promise<void> {
    const n = this.blockRows;
    if (n === 0) return;
    const { bpr, bpp } = this;
    const stride = bpr + 1;
    let prev: Uint8Array = this.prevRaw;
    for (let r = 0; r < n; r++) {
      const row = this.block.subarray(r * bpr, (r + 1) * bpr);
      const at = r * stride;
      this.candNone[at] = 0;
      this.candNone.set(row, at + 1);
      const filter = chooseFilter(row, prev, bpp);
      this.candHeuristic[at] = filter;
      writeFilteredRow(filter, row, prev, bpp, this.candHeuristic, at + 1);
      prev = row;
    }
    const used = n * stride;
    const a = this.candNone.subarray(0, used);
    const b = this.candHeuristic.subarray(0, used);
    const heuristicWins = deflateSync(b, { level: DECIDE_LEVEL }).length < deflateSync(a, { level: DECIDE_LEVEL }).length;
    this.prevRaw.set(prev);
    this.blockRows = 0;
    // A COPY, because deflate.write() queues the view rather than reading it now: the candidate
    // buffers are reused by the next block and would be rewritten under zlib's feet.
    const out = Buffer.from(heuristicWins ? b : a);
    if (!this.deflate.write(out)) await once(this.deflate, "drain");
  }

  async finish(): Promise<void> {
    await this.emitBlock();
    this.deflate.end();
    await this.pump;
  }

  async abort(): Promise<void> {
    this.deflate.destroy();
    await this.pump.catch(() => {});
  }
}

/**
 * Inflate one band's IDAT payloads as a single zlib stream. The payloads are fed as VIEWS into
 * the caller's band buffer (no copy), which is also what makes the multi-IDAT case free: the
 * chunks are simply written back to back into the same inflate.
 */
async function* inflateBandIdat(band: Uint8Array, slices: ReadonlyArray<readonly [number, number]>, at: string): AsyncGenerator<Buffer> {
  const inf = createInflate({ chunkSize: ZLIB_CHUNK });
  const feed = (async () => {
    for (const [start, end] of slices) {
      const view = Buffer.from(band.buffer as ArrayBuffer, band.byteOffset + start, end - start);
      if (!inf.write(view)) await once(inf, "drain");
    }
    inf.end();
  })();
  feed.catch(() => {}); // the failure surfaces on the read side below
  try {
    for await (const chunk of inf) yield chunk as Buffer;
  } catch (err) {
    throw new PngStitchError(`${at}: IDAT stream would not inflate (${(err as Error).message})`);
  } finally {
    inf.destroy();
  }
}

/* --------------------------------- the stitcher --------------------------------- */

function isAsyncIterable(x: unknown): x is AsyncIterable<Uint8Array> {
  return typeof x === "object" && x !== null && Symbol.asyncIterator in x;
}

async function* eachBand(bands: AsyncIterable<Uint8Array> | readonly Uint8Array[]): AsyncGenerator<Uint8Array> {
  if (isAsyncIterable(bands)) {
    for await (const b of bands) yield b;
  } else {
    for (const b of bands) yield b;
  }
}

/**
 * Concatenate PNG bands vertically into one PNG at `outPath`, losslessly and without ever
 * holding the whole image.
 *
 * The bands are stacked in the order given, top to bottom. Every band must be a complete,
 * non-interlaced PNG of the same width, bit depth and colour type; heights may differ freely
 * (the last band of a page capture is usually short). Any disagreement, any interlaced or
 * palettized band, any truncated or unreadable band throws `PngStitchError` and leaves no file
 * at `outPath`.
 *
 * Accepts an array or an AsyncIterable, and consumes the iterable one band at a time : a caller
 * that captures band N+1 only when asked for it never holds two bands, and the total height does
 * not need to be known up front (the IHDR is patched with it at the end).
 */
export async function stitchPngBandsToFile(
  bands: AsyncIterable<Uint8Array> | readonly Uint8Array[],
  outPath: string,
): Promise<PngStitchResult> {
  await mkdir(dirname(outPath), { recursive: true });
  const partPath = `${outPath}.stitch-partial`;
  const fh = await open(partPath, "w");
  let done = false;
  try {
    const result = await stitchInto(fh, bands);
    await fh.close();
    await rename(partPath, outPath);
    done = true;
    return result;
  } finally {
    if (!done) {
      await fh.close().catch(() => {});
      await rm(partPath, { force: true }).catch(() => {});
    }
  }
}

async function stitchInto(fh: FileHandle, bands: AsyncIterable<Uint8Array> | readonly Uint8Array[]): Promise<PngStitchResult> {
  const writer = new ChunkWriter(fh);
  let first: BandHeader | undefined;
  let firstCarried: CarriedChunk[] = [];
  let encoder: RowEncoder | undefined;
  /** The raw row above the one being decoded. RESET at the top of every band : see the header. */
  let prevRow = new Uint8Array(0);
  let rowBuf = new Uint8Array(0);
  let bpp = 0;
  let bpr = 0;
  let totalRows = 0;
  let index = 0;

  try {
    for await (const band of eachBand(bands)) {
      index += 1;
      const parsed = parseBand(band, index);
      const at = `band ${index}`;

      if (!first) {
        first = parsed.header;
        firstCarried = parsed.carried;
        bpp = filterUnitBytes(first);
        bpr = bytesPerRow(first);
        prevRow = new Uint8Array(bpr);
        rowBuf = new Uint8Array(1 + bpr);
        await writer.writeRaw(PNG_SIGNATURE);
        await writer.writeRaw(ihdrChunk(first, 1)); // placeholder height, patched after the last band
        for (const c of parsed.carried) await writer.writeChunk(c.type, c.data);
        encoder = new RowEncoder(writer, bpr, bpp);
      } else {
        assertCompatible(first, parsed.header, firstCarried, parsed.carried, index);
      }

      const enc = encoder!;
      const raw = rowBuf.subarray(1);
      // Every band is its own PNG, so its first row filters against a row of zeros, NOT against
      // the last row of the band above it. Getting this wrong mis-decodes one row per seam.
      prevRow.fill(0);
      let rows = 0;
      let filled = 0;
      for await (const chunk of inflateBandIdat(band, parsed.idat, at)) {
        let off = 0;
        while (off < chunk.length) {
          const take = Math.min(rowBuf.length - filled, chunk.length - off);
          rowBuf.set(chunk.subarray(off, off + take), filled);
          filled += take;
          off += take;
          if (filled !== rowBuf.length) continue;
          if (rows >= parsed.header.height) {
            throw new PngStitchError(`${at}: IDAT holds more scanlines than its IHDR height of ${parsed.header.height}`);
          }
          unfilterRow(rowBuf[0]!, raw, prevRow, bpp, at);
          await enc.addRow(raw);
          prevRow.set(raw);
          rows += 1;
          filled = 0;
        }
      }
      if (filled !== 0 || rows !== parsed.header.height) {
        throw new PngStitchError(`${at}: IDAT decoded to ${rows} complete scanlines${filled > 0 ? ` plus ${filled} trailing bytes` : ""}, but its IHDR declares ${parsed.header.height}`);
      }

      totalRows += parsed.header.height;
      if (totalRows > 0x7fffffff) throw new PngStitchError(`stitched height would be ${totalRows}, past PNG's 2^31-1 limit`);
    }

    if (!first || !encoder) throw new PngStitchError("no bands to stitch");

    await encoder.finish();
    await writer.writeChunk("IEND", new Uint8Array(0));
    await writer.patchAt(8, ihdrChunk(first, totalRows));
    return { width: first.width, height: totalRows, bytes: writer.bytes, bands: index };
  } catch (err) {
    await encoder?.abort();
    throw err;
  }
}

/*
 * CDP methods/domains used: NONE. This module is deliberately browser-free : it is the pure half
 * of the >16384px capture story, and the tiling that feeds it lives on the browser side.
 *
 * Support matrix (measured against real Chrome captures, see the header):
 *   accepted : non-interlaced colour types 0/2/4/6, bit depth per PNG's own table, any number of
 *              IDAT chunks per band, differing band heights, an array or a lazy AsyncIterable.
 *   rejected : interlaced (Adam7), colour type 3 (palette), a band whose width/bit depth/colour
 *              type or carried colour chunk disagrees with band 1, a truncated or short-scanline
 *              band, zero bands. Every one of these throws PngStitchError and leaves no file at
 *              outPath.
 * Parity gaps vs anything in chrome-devtools-mcp: not applicable, this is a toolkit-internal
 * image primitive with no MCP tool of its own (hence no entry in index.ts's TOOLS registry,
 * which maps MCP tool names to tool functions : a stitcher is neither).
 */
