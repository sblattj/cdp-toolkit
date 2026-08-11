/**
 * Unit tests for src/png.ts, the band stitcher. Everything here is pure: no browser, no network.
 *
 * Five properties carry this slice, and each one has a test that FAILS if it is broken:
 *
 * 1. LOSSLESS. The stitched pixels are the input pixels, concatenated. Proved by decoding the
 *    output and comparing byte-for-byte against the raw samples the fixtures were built from,
 *    across all five row filters, all four supported colour types, bit depths 1/8/16, uneven
 *    band heights (including a 1-row band), and an IDAT split across many chunks.
 *
 * 2. THE BAND SEAM RESETS THE DECODE CONTEXT. Every band is its own PNG, so its first row
 *    filters against a row of ZEROS, not against the last row of the band above. Carrying it
 *    across produces a structurally valid PNG with one wrong row per seam. Catching that needs
 *    a band whose FIRST row uses a prev-DEPENDENT filter (Up/Average/Paeth), and no real
 *    encoder emits one there : ffmpeg and Chrome both fall back to None/Sub when the row above
 *    is known-zero (measured: ffmpeg -pred up/avg/paeth all emit filter 1 on row 0). So the
 *    fixture is hand-framed, `firstRowFilter`, and that is the only reason it exists.
 *
 * 3. A REFUSAL IS NEVER A CORRUPT FILE. Every mismatch names what disagreed, and a failed
 *    stitch leaves NOTHING at outPath : no truncated file, no half-written one, and not even a
 *    clobbered older file that was already there.
 *
 * 4. INTERLACED IS REJECTED, NOT MIS-DECODED. Adam7's seven reduced passes are not scanlines,
 *    so concatenating bands of them is not the concatenated image.
 *
 * 5. THE FILTER CHOICE IS MEASURED, NOT ASSUMED. png.ts picks per 4 MiB block by compressing
 *    both candidates. The test pins content where each candidate wins by a wide margin and
 *    asserts the output is near the winner's size : it fails if the chooser is nailed to either.
 *
 * The ffmpeg-gated block at the bottom is the INDEPENDENT oracle : a decoder this repo did not
 * write, deciding whether the bytes really say what we think. It skips when ffmpeg is absent so
 * `bun test` stays green on a machine without it; the equality it proves is recorded in the
 * commit message with real shasums.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync, inflateSync } from "node:zlib";
import { crc32, PngStitchError, stitchPngBandsToFile } from "../src/png.ts";

const FFMPEG = "/opt/homebrew/bin/ffmpeg";
const hasFfmpeg = existsSync(FFMPEG);
const CAPTURE_DIR = "/private/tmp/claude-501/-Users-sblatt--dotorg/64e8577c-dd8d-49e0-b9cb-8fe92cec95bf/scratchpad";
const REAL_TALL = join(CAPTURE_DIR, "tall-1600x16384-beyond.png");
const hasRealCapture = existsSync(REAL_TALL);

/* ------------------------------- fixture builder ------------------------------- */

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

function bytesPerRow(width: number, bitDepth: number, colourType: number): number {
  return Math.ceil((width * CHANNELS[colourType]! * bitDepth) / 8);
}
function filterUnit(bitDepth: number, colourType: number): number {
  return Math.max(1, Math.ceil((CHANNELS[colourType]! * bitDepth) / 8));
}

function chunk(type: string, payload: Uint8Array): Buffer {
  const b = Buffer.allocUnsafe(12 + payload.length);
  b.writeUInt32BE(payload.length, 0);
  b.write(type, 4, "latin1");
  Buffer.from(payload).copy(b, 8);
  b.writeUInt32BE(crc32(b.subarray(4, 8 + payload.length)), 8 + payload.length);
  return b;
}

/** Forward row filter, written straight off the PNG spec's formulas (spec 9.2). */
function applyFilter(type: number, row: Uint8Array, prev: Uint8Array, bpp: number): Uint8Array {
  const out = new Uint8Array(row.length);
  const pae = (a: number, b: number, c: number) => {
    const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  for (let i = 0; i < row.length; i++) {
    const a = i >= bpp ? row[i - bpp]! : 0;
    const b = prev[i]!;
    const c = i >= bpp ? prev[i - bpp]! : 0;
    const pred = type === 0 ? 0 : type === 1 ? a : type === 2 ? b : type === 3 ? (a + b) >> 1 : pae(a, b, c);
    out[i] = (row[i]! - pred) & 0xff;
  }
  return out;
}

interface BandSpec {
  width: number;
  height: number;
  raw: Uint8Array;
  bitDepth?: number;
  colourType?: number;
  interlace?: number;
  /** Filter type for every row but the first. Default 0. */
  filter?: number;
  /** Filter type for row 0. Default = `filter`. Set to 2/3/4 to exercise the seam-reset property. */
  firstRowFilter?: number;
  /** Split the compressed stream across this many IDAT chunks. Default 1. */
  idatChunks?: number;
  /** Chunks written between IHDR and IDAT. */
  extra?: Array<{ type: string; data: Uint8Array }>;
  /** Lie about the height in IHDR, to build a short/long-scanline band. */
  claimHeight?: number;
}

function buildBand(spec: BandSpec): Buffer {
  const bitDepth = spec.bitDepth ?? 8;
  const colourType = spec.colourType ?? 2;
  const bpr = bytesPerRow(spec.width, bitDepth, colourType);
  const bpp = filterUnit(bitDepth, colourType);
  const filter = spec.filter ?? 0;
  const stream = Buffer.allocUnsafe(spec.height * (bpr + 1));
  let prev = new Uint8Array(bpr);
  for (let y = 0; y < spec.height; y++) {
    const row = spec.raw.subarray(y * bpr, (y + 1) * bpr);
    const type = y === 0 ? spec.firstRowFilter ?? filter : filter;
    stream[y * (bpr + 1)] = type;
    Buffer.from(applyFilter(type, row, prev, bpp)).copy(stream, y * (bpr + 1) + 1);
    prev = row;
  }
  const z = deflateSync(stream);
  const n = spec.idatChunks ?? 1;
  const idats: Buffer[] = [];
  const per = Math.ceil(z.length / n);
  for (let i = 0; i < n; i++) {
    const slice = z.subarray(i * per, Math.min((i + 1) * per, z.length));
    if (slice.length > 0 || n === 1) idats.push(chunk("IDAT", slice));
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(spec.width, 0);
  ihdr.writeUInt32BE(spec.claimHeight ?? spec.height, 4);
  ihdr[8] = bitDepth;
  ihdr[9] = colourType;
  ihdr[12] = spec.interlace ?? 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    ...(spec.extra ?? []).map((c) => chunk(c.type, c.data)),
    ...idats,
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Deterministic, distinctive content: correlated with the row above, never repeating a row. */
function ramp(width: number, height: number, bpr: number, seed: number): Uint8Array {
  const b = new Uint8Array(height * bpr);
  for (let y = 0; y < height; y++) {
    for (let i = 0; i < bpr; i++) b[y * bpr + i] = (seed * 31 + y * 7 + i * 3 + ((y * i) & 0x1f)) & 0xff;
  }
  return b;
}

/**
 * A deliberately naive, allocate-everything decoder, structured nothing like src/png.ts's
 * streaming one. It is a second opinion, not the authority : ffmpeg is the authority, below.
 */
function naiveDecode(png: Buffer): { width: number; height: number; bitDepth: number; colourType: number; raw: Buffer; chunks: string[] } {
  const width = png.readUInt32BE(16), height = png.readUInt32BE(20);
  const bitDepth = png[24]!, colourType = png[25]!;
  const bpr = bytesPerRow(width, bitDepth, colourType);
  const bpp = filterUnit(bitDepth, colourType);
  const parts: Buffer[] = [];
  const chunks: string[] = [];
  let off = 8;
  while (off + 8 <= png.length) {
    const len = png.readUInt32BE(off);
    const type = png.toString("latin1", off + 4, off + 8);
    chunks.push(type);
    if (type === "IDAT") parts.push(png.subarray(off + 8, off + 8 + len));
    if (type === "IEND") break;
    off += 12 + len;
  }
  const stream = inflateSync(Buffer.concat(parts));
  const raw = Buffer.allocUnsafe(height * bpr);
  const pae = (a: number, b: number, c: number) => {
    const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  for (let y = 0; y < height; y++) {
    const t = stream[y * (bpr + 1)]!;
    for (let i = 0; i < bpr; i++) {
      const x = stream[y * (bpr + 1) + 1 + i]!;
      const a = i >= bpp ? raw[y * bpr + i - bpp]! : 0;
      const b = y > 0 ? raw[(y - 1) * bpr + i]! : 0;
      const c = y > 0 && i >= bpp ? raw[(y - 1) * bpr + i - bpp]! : 0;
      const pred = t === 0 ? 0 : t === 1 ? a : t === 2 ? b : t === 3 ? (a + b) >> 1 : pae(a, b, c);
      raw[y * bpr + i] = (x + pred) & 0xff;
    }
  }
  return { width, height, bitDepth, colourType, raw, chunks };
}

async function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "png-stitch-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/* ------------------------------------ crc32 ------------------------------------ */

describe("crc32", () => {
  test("matches the standard IEEE check value", () => {
    // The canonical CRC-32 test vector. A wrong table or a wrong xor shows up here and nowhere else.
    expect(crc32(Buffer.from("123456789", "latin1"))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array(0))).toBe(0);
    expect(crc32(Buffer.from([0x00]))).toBe(0xd202ef8d);
  });
});

/* ------------------------------ lossless round-trip ------------------------------ */

describe("stitchPngBandsToFile : lossless", () => {
  for (const filter of [0, 1, 2, 3, 4]) {
    test(`round-trips bands filtered with type ${filter}, including on row 0 of every band`, async () => {
      await withTmp(async (dir) => {
        const W = 61;
        const bpr = bytesPerRow(W, 8, 2);
        const heights = [7, 1, 12, 3];
        const raws = heights.map((h, i) => ramp(W, h, bpr, i + 1));
        const bands = heights.map((h, i) =>
          buildBand({ width: W, height: h, raw: raws[i]!, filter, firstRowFilter: filter }),
        );
        const out = join(dir, "out.png");
        const res = await stitchPngBandsToFile(bands, out);
        expect(res).toEqual({ width: W, height: 23, bytes: res.bytes, bands: 4 });
        const dec = naiveDecode(readFileSync(out));
        expect(dec.width).toBe(W);
        expect(dec.height).toBe(23);
        // The decisive comparison: output pixels === the concatenated source samples.
        expect(Buffer.compare(dec.raw, Buffer.concat(raws.map(Buffer.from)))).toBe(0);
      });
    });
  }

  test("concatenates a band whose IDAT is split across many chunks", async () => {
    await withTmp(async (dir) => {
      const W = 40, H = 30, bpr = bytesPerRow(W, 8, 2);
      const raw = ramp(W, H, bpr, 5);
      const one = buildBand({ width: W, height: H, raw, filter: 4, idatChunks: 1 });
      const many = buildBand({ width: W, height: H, raw, filter: 4, idatChunks: 17 });
      expect(naiveDecode(many).chunks.filter((c) => c === "IDAT").length).toBeGreaterThan(10);
      const a = join(dir, "a.png"), b = join(dir, "b.png");
      await stitchPngBandsToFile([one, one], a);
      await stitchPngBandsToFile([many, many], b);
      expect(Buffer.compare(readFileSync(a), readFileSync(b))).toBe(0);
      expect(Buffer.compare(naiveDecode(readFileSync(b)).raw, Buffer.concat([raw, raw]))).toBe(0);
    });
  });

  for (const [name, bitDepth, colourType] of [
    ["greyscale 8-bit", 8, 0],
    ["greyscale+alpha 8-bit", 8, 4],
    ["RGBA 8-bit", 8, 6],
    ["RGB 16-bit", 16, 2],
    ["greyscale 1-bit", 1, 0],
    ["greyscale 4-bit", 4, 0],
  ] as const) {
    test(`round-trips ${name} (bpp/bpr math is generic, not RGB-specific)`, async () => {
      await withTmp(async (dir) => {
        const W = 13;
        const bpr = bytesPerRow(W, bitDepth, colourType);
        const raws = [ramp(W, 5, bpr, 1), ramp(W, 6, bpr, 2)];
        const bands = raws.map((raw, i) =>
          buildBand({ width: W, height: i === 0 ? 5 : 6, raw, bitDepth, colourType, filter: 4, firstRowFilter: 3 }),
        );
        const out = join(dir, "out.png");
        const res = await stitchPngBandsToFile(bands, out);
        expect([res.width, res.height]).toEqual([W, 11]);
        const dec = naiveDecode(readFileSync(out));
        expect([dec.bitDepth, dec.colourType]).toEqual([bitDepth, colourType]);
        expect(Buffer.compare(dec.raw, Buffer.concat(raws.map(Buffer.from)))).toBe(0);
      });
    });
  }

  test("produces an image taller than Chrome's 16384 px capture ceiling", async () => {
    await withTmp(async (dir) => {
      const W = 8, H = 2048, bpr = bytesPerRow(W, 8, 2);
      const raws = Array.from({ length: 9 }, (_, i) => ramp(W, H, bpr, i));
      const bands = raws.map((raw) => buildBand({ width: W, height: H, raw, filter: 2, firstRowFilter: 4 }));
      const out = join(dir, "tall.png");
      const res = await stitchPngBandsToFile(bands, out);
      expect(res.height).toBe(18432);
      expect(res.height).toBeGreaterThan(16384); // the entire point of this module
      const dec = naiveDecode(readFileSync(out));
      expect(dec.height).toBe(18432);
      expect(Buffer.compare(dec.raw, Buffer.concat(raws.map(Buffer.from)))).toBe(0);
    });
  });

  test("accepts a lazy AsyncIterable and pulls it one band at a time", async () => {
    await withTmp(async (dir) => {
      const W = 20, bpr = bytesPerRow(W, 8, 2);
      let pulled = 0;
      async function* gen() {
        for (let i = 0; i < 6; i++) {
          pulled += 1;
          yield buildBand({ width: W, height: 4, raw: ramp(W, 4, bpr, i), filter: 1 });
        }
      }
      const res = await stitchPngBandsToFile(gen(), join(dir, "lazy.png"));
      expect([res.height, res.bands, pulled]).toEqual([24, 6, 6]);

      // A generator whose 3rd band is malformed must be abandoned there, not drained first.
      pulled = 0;
      async function* bad() {
        for (let i = 0; i < 10; i++) {
          pulled += 1;
          yield i === 2
            ? buildBand({ width: W + 1, height: 4, raw: ramp(W + 1, 4, bytesPerRow(W + 1, 8, 2), i) })
            : buildBand({ width: W, height: 4, raw: ramp(W, 4, bpr, i) });
        }
      }
      await expect(stitchPngBandsToFile(bad(), join(dir, "bad.png"))).rejects.toThrow(/band 3: width 21/);
      expect(pulled).toBe(3);
    });
  });
});

/* --------------------------------- the band seam --------------------------------- */

describe("stitchPngBandsToFile : the band seam", () => {
  test("resets the decode filter context at the top of every band", async () => {
    // Each band's first row uses a prev-DEPENDENT filter. Since every band is its own PNG, that
    // row must be un-filtered against ZEROS. An implementation that carried the previous band's
    // last row in decodes these rows wrongly, and this comparison is what catches it.
    for (const firstRowFilter of [2, 3, 4]) {
      await withTmp(async (dir) => {
        const W = 32, bpr = bytesPerRow(W, 8, 2);
        const heights = [5, 5, 5];
        const raws = heights.map((h, i) => ramp(W, h, bpr, i * 40 + 1));
        const bands = heights.map((h, i) => buildBand({ width: W, height: h, raw: raws[i]!, filter: 1, firstRowFilter }));
        const out = join(dir, `seam-${firstRowFilter}.png`);
        await stitchPngBandsToFile(bands, out);
        expect(Buffer.compare(naiveDecode(readFileSync(out)).raw, Buffer.concat(raws.map(Buffer.from)))).toBe(0);
      });
    }
  });
});

/* ------------------------------- refusals ------------------------------- */

describe("stitchPngBandsToFile : refusals", () => {
  const W = 16, bpr = bytesPerRow(W, 8, 2);
  const good = () => buildBand({ width: W, height: 4, raw: ramp(W, 4, bpr, 1) });

  const cases: Array<[string, () => Array<Uint8Array>, RegExp]> = [
    ["no bands at all", () => [], /no bands to stitch/],
    ["a band that is not a PNG", () => [good(), Buffer.from("not a png at all!!")], /band 2: not a PNG/],
    [
      "an interlaced (Adam7) band",
      () => [good(), buildBand({ width: W, height: 4, raw: ramp(W, 4, bpr, 2), interlace: 1 })],
      /band 2: interlaced \(Adam7\) PNG is not supported/,
    ],
    [
      "an unknown interlace method",
      () => [buildBand({ width: W, height: 4, raw: ramp(W, 4, bpr, 2), interlace: 7 })],
      /interlace method 7/,
    ],
    [
      "a palette band",
      () => [buildBand({ width: W, height: 4, raw: ramp(W, 4, bytesPerRow(W, 8, 3), 2), colourType: 3 })],
      /colour type 3 \(palette\) is not supported/,
    ],
    [
      "a width mismatch",
      () => [good(), buildBand({ width: W + 4, height: 4, raw: ramp(W + 4, 4, bytesPerRow(W + 4, 8, 2), 2) })],
      /band 2: width 20 does not match band 1's width 16/,
    ],
    [
      "a bit-depth mismatch",
      () => [good(), buildBand({ width: W, height: 4, raw: ramp(W, 4, bytesPerRow(W, 16, 2), 2), bitDepth: 16 })],
      /band 2: bit depth 16 does not match band 1's bit depth 8/,
    ],
    [
      "a colour-type mismatch",
      () => [good(), buildBand({ width: W, height: 4, raw: ramp(W, 4, bytesPerRow(W, 8, 6), 2), colourType: 6 })],
      /band 2: colour type 6 \(RGBA\) does not match band 1's colour type 2 \(truecolour RGB\)/,
    ],
    [
      "a bit depth illegal for the colour type",
      () => [buildBand({ width: W, height: 4, raw: ramp(W, 4, bpr, 1), bitDepth: 4, colourType: 2 })],
      /bit depth 4 is not legal for colour type 2/,
    ],
    [
      "a band with fewer scanlines than its IHDR height",
      () => [good(), buildBand({ width: W, height: 3, raw: ramp(W, 3, bpr, 2), claimHeight: 9 })],
      /band 2: IDAT decoded to 3 complete scanlines, but its IHDR declares 9/,
    ],
    [
      "a band with more scanlines than its IHDR height",
      () => [good(), buildBand({ width: W, height: 6, raw: ramp(W, 6, bpr, 2), claimHeight: 2 })],
      /band 2: IDAT holds more scanlines than its IHDR height of 2/,
    ],
    [
      "an unreadable IDAT stream",
      () => {
        const b = Buffer.from(good());
        const at = b.indexOf(Buffer.from("IDAT", "latin1")) + 6;
        b[at] = b[at]! ^ 0xff; // corrupt the deflate payload; adler32 must catch it
        return [b];
      },
      /IDAT stream would not inflate/,
    ],
    [
      "a truncated file",
      () => [Buffer.from(good()).subarray(0, 30)],
      /truncated PNG|no IEND/,
    ],
  ];

  for (const [name, make, message] of cases) {
    test(`refuses ${name}, by name`, async () => {
      await withTmp(async (dir) => {
        const out = join(dir, "out.png");
        const err = await stitchPngBandsToFile(make(), out).then(
          () => undefined,
          (e: unknown) => e as Error,
        );
        expect(err).toBeInstanceOf(PngStitchError);
        expect(err!.message).toMatch(message);
        // And nothing was left behind: not the output, not the partial.
        expect(existsSync(out)).toBe(false);
        expect(existsSync(`${out}.stitch-partial`)).toBe(false);
      });
    });
  }

  test("a failed stitch does not clobber a file already at outPath", async () => {
    await withTmp(async (dir) => {
      const out = join(dir, "keepme.png");
      writeFileSync(out, "an older artifact nobody asked us to destroy");
      await expect(stitchPngBandsToFile([good(), Buffer.from("garbage")], out)).rejects.toThrow(PngStitchError);
      expect(readFileSync(out, "utf8")).toBe("an older artifact nobody asked us to destroy");
      expect(existsSync(`${out}.stitch-partial`)).toBe(false);
    });
  });
});

/* ------------------------------ ancillary chunks ------------------------------ */

describe("stitchPngBandsToFile : ancillary chunks", () => {
  const W = 16, bpr = bytesPerRow(W, 8, 2);
  const profile = Buffer.from([0x70, 0x00, 0x00, 0x01, 0x02, 0x03, 0x04]);

  test("carries iCCP forward (Chrome puts one on every capture) and drops tEXt", async () => {
    await withTmp(async (dir) => {
      const extra = [
        { type: "iCCP", data: profile },
        { type: "tEXt", data: Buffer.from("Comment\0band one", "latin1") },
      ];
      const bands = [1, 2].map((i) => buildBand({ width: W, height: 4, raw: ramp(W, 4, bpr, i), extra }));
      const out = join(dir, "out.png");
      await stitchPngBandsToFile(bands, out);
      const file = readFileSync(out);
      const dec = naiveDecode(file);
      expect(dec.chunks.filter((c) => c === "iCCP")).toHaveLength(1);
      expect(dec.chunks).not.toContain("tEXt");
      // Carried BYTE-for-byte, not regenerated.
      const at = file.indexOf(Buffer.from("iCCP", "latin1"));
      expect(Buffer.compare(file.subarray(at + 4, at + 4 + profile.length), profile)).toBe(0);
      // ...and in a legal position: after IHDR, before the first IDAT.
      expect(dec.chunks.slice(0, 3)).toEqual(["IHDR", "iCCP", "IDAT"]);
    });
  });

  test("refuses bands that disagree about a carried chunk", async () => {
    await withTmp(async (dir) => {
      const a = buildBand({ width: W, height: 4, raw: ramp(W, 4, bpr, 1), extra: [{ type: "gAMA", data: Buffer.from([0, 1, 0x86, 0xa0]) }] });
      const b = buildBand({ width: W, height: 4, raw: ramp(W, 4, bpr, 2), extra: [{ type: "gAMA", data: Buffer.from([0, 2, 0x86, 0xa0]) }] });
      const c = buildBand({ width: W, height: 4, raw: ramp(W, 4, bpr, 3) });
      await expect(stitchPngBandsToFile([a, b], join(dir, "x.png"))).rejects.toThrow(/band 2: its "gAMA" chunk differs from band 1's/);
      await expect(stitchPngBandsToFile([a, c], join(dir, "y.png"))).rejects.toThrow(/band 2: is missing a "gAMA" chunk/);
    });
  });
});

/* --------------------------- the filter choice is measured --------------------------- */

describe("stitchPngBandsToFile : per-block filter choice", () => {
  test("does not pin itself to filter None on content where filtering wins", async () => {
    await withTmp(async (dir) => {
      const W = 512, H = 300, bpr = bytesPerRow(W, 8, 2);
      // A smooth diagonal ramp: residuals collapse to a constant, raw bytes never repeat.
      // Measured on this exact fixture: per-block 2,196 bytes, pinned-None 6,467. The bound
      // below sits between them, so a stitcher nailed to filter 0 fails here.
      const gradient = new Uint8Array(H * bpr);
      for (let y = 0; y < H; y++) for (let i = 0; i < bpr; i++) gradient[y * bpr + i] = (i + y) & 0xff;
      const out = join(dir, "g.png");
      const res = await stitchPngBandsToFile(
        [buildBand({ width: W, height: H, raw: gradient }), buildBand({ width: W, height: H, raw: gradient })],
        out,
      );
      expect(res.bytes).toBeLessThan(4_000);
      expect(Buffer.compare(naiveDecode(readFileSync(out)).raw, Buffer.concat([gradient, gradient]))).toBe(0);
    });
  });

  // The other direction needs REAL screenshot content: the thing that makes plain None win is
  // deflate matching long literal runs against the rows above, and no small synthetic fixture
  // reproduces it (several were tried; on all of them the heuristic won, correctly). Measured
  // on this capture: per-block 30,724,184 bytes, pinned-heuristic 35,958,755, pinned-None
  // 30,727,639. The bound sits between per-block and pinned-heuristic.
  test.skipIf(!hasRealCapture)(
    "does not pin itself to the heuristic on real screenshot content",
    async () => {
      await withTmp(async (dir) => {
        const band = readFileSync(REAL_TALL);
        const res = await stitchPngBandsToFile([band, band], join(dir, "real.png"));
        expect(res.bytes).toBeLessThan(33_000_000);
      });
    },
    120_000,
  );
});

/* --------------------------- the independent oracle: ffmpeg --------------------------- */

function ffmpegDecode(path: string, pixFmt = "rgba"): Buffer {
  const r = spawnSync(FFMPEG, ["-v", "error", "-i", path, "-f", "rawvideo", "-pix_fmt", pixFmt, "-"], {
    maxBuffer: 1 << 30,
  });
  if (r.status !== 0) throw new Error(`ffmpeg decode of ${path} failed: ${r.stderr?.toString()}`);
  return r.stdout;
}

describe.skipIf(!hasFfmpeg)("stitchPngBandsToFile : independent decode (ffmpeg)", () => {
  test("ffmpeg reads back exactly the samples the bands were built from", async () => {
    await withTmp(async (dir) => {
      const W = 64, bpr = bytesPerRow(W, 8, 2);
      const heights = [17, 1, 40];
      const raws = heights.map((h, i) => ramp(W, h, bpr, i * 11 + 1));
      // Prev-dependent filters on row 0 of every band : the seam case no real encoder emits.
      const bands = heights.map((h, i) => buildBand({ width: W, height: h, raw: raws[i]!, filter: 4, firstRowFilter: 2 + (i % 3) }));
      const out = join(dir, "out.png");
      await stitchPngBandsToFile(bands, out);

      const got = ffmpegDecode(out);
      const src = Buffer.concat(raws.map(Buffer.from));
      const want = Buffer.alloc((src.length / 3) * 4);
      for (let p = 0, q = 0; p < src.length; p += 3, q += 4) {
        want[q] = src[p]!; want[q + 1] = src[p + 1]!; want[q + 2] = src[p + 2]!; want[q + 3] = 255;
      }
      expect(Buffer.compare(got, want)).toBe(0);
    });
  }, 30_000);

  test.skipIf(!hasRealCapture)(
    "stitches two real 1600x16384 Chrome captures into one 1600x32768 image, pixel-identical",
    async () => {
      await withTmp(async (dir) => {
        const band = readFileSync(REAL_TALL);
        const out = join(dir, "real.png");
        const res = await stitchPngBandsToFile([band, band], out);
        expect([res.width, res.height]).toEqual([1600, 32768]);
        expect(res.height).toBeGreaterThan(16384);
        const stitched = ffmpegDecode(out);
        const twice = Buffer.concat([ffmpegDecode(REAL_TALL), ffmpegDecode(REAL_TALL)]);
        expect(Buffer.compare(stitched, twice)).toBe(0);
        // Chrome's iCCP profile survived the stitch.
        expect(naiveDecode(readFileSync(out)).chunks).toContain("iCCP");
      });
    },
    180_000,
  );
});
