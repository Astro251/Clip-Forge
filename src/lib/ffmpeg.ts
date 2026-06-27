/**
 * FFmpeg.wasm client-side utilities.
 *
 * Loads the single-threaded @ffmpeg/core from a CDN via toBlobURL so no
 * special COOP/COEP headers are required. All processing happens entirely
 * inside the browser — no file ever leaves the user's machine.
 */
import { FFmpeg } from "@ffmpeg/ffmpeg";
import { fetchFile, toBlobURL } from "@ffmpeg/util";

const CORE_VERSION = "0.12.10";
const CORE_BASE = `https://unpkg.com/@ffmpeg/core@${CORE_VERSION}/dist/umd`;

export type LoadProgressCb = (ratio: number) => void;
export type LogCb = (line: string) => void;
export type ProgressCb = (ratio: number) => void;

export interface FFmpegHandlers {
  onLog?: LogCb;
  onProgress?: ProgressCb;
}

/**
 * Create and load a fresh FFmpeg instance. The instance is NOT a singleton —
 * each call wires up its own log/progress callbacks so multiple consumers
 * don't clobber each other. Callers should keep the returned instance in a
 * ref for the lifetime of their session.
 */
export async function createFFmpeg(handlers: FFmpegHandlers = {}): Promise<FFmpeg> {
  const ffmpeg = new FFmpeg();

  if (handlers.onLog) {
    ffmpeg.on("log", ({ message }) => handlers.onLog!(message));
  }
  if (handlers.onProgress) {
    ffmpeg.on("progress", ({ progress }) => {
      // progress can occasionally exceed 1 or dip below 0 due to estimation
      const clamped = Math.max(0, Math.min(1, progress));
      handlers.onProgress!(clamped);
    });
  }

  await ffmpeg.load({
    coreURL: await toBlobURL(`${CORE_BASE}/ffmpeg-core.js`, "text/javascript"),
    wasmURL: await toBlobURL(`${CORE_BASE}/ffmpeg-core.wasm`, "application/wasm"),
  });

  return ffmpeg;
}

/* ------------------------------------------------------------------ */
/* Timestamp helpers                                                   */
/* ------------------------------------------------------------------ */

/**
 * Parse a timestamp into seconds with millisecond precision.
 * Accepted formats (fractional part is optional, up to 3 digits):
 *   HH:MM:SS.mmm   e.g. 00:01:30.250
 *   MM:SS.mmm      e.g. 01:30.250
 *   SS.mmm         e.g. 90.250
 *   HH:MM:SS / MM:SS / SS  (milliseconds default to 0)
 * Throws on invalid input so the UI can surface a clear error.
 */
export function parseTimestamp(ts: string): number {
  const trimmed = ts.trim();
  if (!trimmed) throw new Error("Timestamp is empty");

  // Split off the fractional (millisecond) part after the dot.
  let msPart = 0;
  let timePart = trimmed;
  const dotIdx = trimmed.indexOf(".");
  if (dotIdx >= 0) {
    timePart = trimmed.slice(0, dotIdx);
    const frac = trimmed.slice(dotIdx + 1);
    if (!/^\d{1,3}$/.test(frac)) {
      throw new Error(
        `Invalid milliseconds ".${frac}" in "${ts}" — use up to 3 digits`,
      );
    }
    msPart = Number(frac.padEnd(3, "0"));
  }

  const parts = timePart.split(":");
  if (parts.length < 1 || parts.length > 3) {
    throw new Error(
      `Invalid timestamp format "${ts}" — use HH:MM:SS.mmm or MM:SS.mmm`,
    );
  }
  const nums = parts.map((p) => Number(p));
  if (nums.some((n) => Number.isNaN(n))) {
    throw new Error(
      `Invalid timestamp "${ts}" — use HH:MM:SS.mmm or MM:SS.mmm`,
    );
  }
  if (nums.some((n) => n < 0)) {
    throw new Error(`Timestamp "${ts}" contains negative values`);
  }

  let seconds: number;
  if (nums.length === 3) {
    const [h, m, s] = nums;
    if (m >= 60 || s >= 60)
      throw new Error(
        `Invalid timestamp "${ts}" — minutes/seconds out of range`,
      );
    seconds = h * 3600 + m * 60 + s;
  } else if (nums.length === 2) {
    const [m, s] = nums;
    if (s >= 60)
      throw new Error(`Invalid timestamp "${ts}" — seconds out of range`);
    seconds = m * 60 + s;
  } else {
    seconds = nums[0];
  }

  return seconds + msPart / 1000;
}

/* ------------------------------------------------------------------ */
/* Bulk timestamp parser                                              */
/* ------------------------------------------------------------------ */

/** Matches a single timestamp token: SS | MM:SS | HH:MM:SS, optional .mmm */
const TS_TOKEN_RE = /\d{1,3}(?::\d{1,2}){0,2}(?:\.\d{1,3})?/;

export interface ParsedBulkClip {
  startSec: number;
  endSec: number;
  startRaw: string;
  endRaw: string;
  name: string;
}

export interface BulkParseResult {
  clips: ParsedBulkClip[];
  errors: { line: number; text: string; reason: string }[];
}

/**
 * Parse a multi-line block of timestamps into clip descriptors.
 *
 * Accepts one clip per line. Each line must contain two timestamps
 * (start + end); any text after the second timestamp becomes the
 * optional clip name. Common separators are tolerated:
 *
 *   00:01:00 00:02:00 intro
 *   00:01:00,00:02:00,intro
 *   00:01:00 - 00:02:00 - intro
 *   00:01:00→00:02:00 intro
 *   00:01:00\t00:02:00\tintro
 *
 * Lines that fail to parse are collected into `errors` rather than
 * throwing, so the caller can report partial success.
 */
export function parseBulkTimestamps(
  input: string,
  existingCount = 0,
): BulkParseResult {
  const clips: ParsedBulkClip[] = [];
  const errors: { line: number; text: string; reason: string }[] = [];
  const lines = input.split(/\r?\n/);

  lines.forEach((rawLine, idx) => {
    const line = rawLine.trim();
    if (!line) return;
    if (line.startsWith("#") || line.startsWith("//")) return;

    // Find every timestamp-looking token in the line.
    const tokens: { value: string; index: number }[] = [];
    let m: RegExpExecArray | null;
    const re = new RegExp(TS_TOKEN_RE.source, "g");
    while ((m = re.exec(line)) !== null) {
      tokens.push({ value: m[0], index: m.index });
    }

    if (tokens.length < 2) {
      errors.push({
        line: idx + 1,
        text: line,
        reason: "needs two timestamps (start + end)",
      });
      return;
    }

    let startSec: number;
    let endSec: number;
    try {
      startSec = parseTimestamp(tokens[0].value);
      endSec = parseTimestamp(tokens[1].value);
    } catch (e) {
      errors.push({
        line: idx + 1,
        text: line,
        reason: e instanceof Error ? e.message : String(e),
      });
      return;
    }

    if (endSec <= startSec) {
      errors.push({
        line: idx + 1,
        text: line,
        reason: "end time must be after start time",
      });
      return;
    }

    // Name = whatever comes after the second timestamp, with leading
    // separators (commas, dashes, arrows, pipes, tabs, spaces) stripped.
    const afterEnd = line.slice(tokens[1].index + tokens[1].value.length);
    const nameRaw = afterEnd
      .replace(/^[\s,→\-*|·•·]+/, "")
      .trim();

    clips.push({
      startSec,
      endSec,
      startRaw: tokens[0].value,
      endRaw: tokens[1].value,
      name: nameRaw,
    });
  });

  // Assign default names to any clips that didn't get one.
  clips.forEach((c, i) => {
    if (!c.name) {
      c.name = `clip_${existingCount + i + 1}`;
    }
  });

  return { clips, errors };
}

/**
 * Format a number of seconds as HH:MM:SS (or HH:MM:SS.mmm when `withMs`
 * is true) for display and FFmpeg arguments. FFmpeg accepts the
 * HH:MM:SS.mmm form for precise seeking.
 */
export function formatTime(totalSeconds: number, withMs = false): string {
  let s = Math.max(0, totalSeconds);
  let ms = 0;
  if (withMs) {
    ms = Math.round((s - Math.floor(s)) * 1000);
    s = Math.floor(s);
    if (ms >= 1000) {
      ms -= 1000;
      s += 1;
    }
  } else {
    s = Math.floor(s);
  }
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => n.toString().padStart(2, "0");
  const base = `${pad(h)}:${pad(m)}:${pad(sec)}`;
  return withMs ? `${base}.${ms.toString().padStart(3, "0")}` : base;
}

/**
 * Compact timecode for timeline labels: MM:SS (or H:MM:SS when ≥ 1h),
 * optionally with a .mmm suffix for millisecond precision.
 */
export function formatTimeShort(totalSeconds: number, withMs = false): string {
  let s = Math.max(0, totalSeconds);
  let ms = 0;
  if (withMs) {
    ms = Math.round((s - Math.floor(s)) * 1000);
    s = Math.floor(s);
    if (ms >= 1000) {
      ms -= 1000;
      s += 1;
    }
  } else {
    s = Math.floor(s);
  }
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => n.toString().padStart(2, "0");
  let base: string;
  if (h > 0) base = `${h}:${pad(m)}:${pad(sec)}`;
  else base = `${pad(m)}:${pad(sec)}`;
  return withMs ? `${base}.${ms.toString().padStart(3, "0")}` : base;
}

/** Format a duration (seconds) as a compact human string, e.g. "2m 15s". */
export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m ${sec}s`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

/** Format a duration with millisecond precision, e.g. "2m 15.350s". */
export function formatDurationMs(totalSeconds: number): string {
  const s = Math.max(0, totalSeconds);
  const wholeSec = Math.floor(s);
  const ms = Math.round((s - wholeSec) * 1000);
  const h = Math.floor(wholeSec / 3600);
  const m = Math.floor((wholeSec % 3600) / 60);
  const sec = wholeSec % 60;
  const msStr = ms.toString().padStart(3, "0");
  if (h > 0) return `${h}h ${m}m ${sec}.${msStr}s`;
  if (m > 0) return `${m}m ${sec}.${msStr}s`;
  return `${sec}.${msStr}s`;
}

/* ------------------------------------------------------------------ */
/* File helpers                                                        */
/* ------------------------------------------------------------------ */

/** Extract the lowercased extension (without dot) from a filename. */
export function getExtension(filename: string): string {
  const idx = filename.lastIndexOf(".");
  if (idx < 0 || idx === filename.length - 1) return "mp4";
  return filename.slice(idx + 1).toLowerCase();
}

/** Strip the extension from a filename. */
export function stripExtension(filename: string): string {
  const idx = filename.lastIndexOf(".");
  return idx > 0 ? filename.slice(0, idx) : filename;
}

/**
 * Sanitize a user-supplied filename into something safe for the in-memory
 * filesystem and for the host OS download. Keeps alphanumerics, dashes and
 * underscores; collapses the rest into a single underscore.
 */
export function sanitizeFilename(name: string): string {
  const cleaned = name
    .trim()
    .replace(/\.[a-z0-9]+$/i, "") // drop any extension the user typed
    .replace(/[^a-zA-Z0-9_\-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return cleaned || "clip";
}

/** Format a byte count as a human readable string. */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(value >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

/* ------------------------------------------------------------------ */
/* Download helper                                                     */
/* ------------------------------------------------------------------ */

/** Trigger a browser download for a Blob with the given filename. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Revoke a little later so the download has time to start.
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/* ------------------------------------------------------------------ */
/* Source probing                                                      */
/* ------------------------------------------------------------------ */

/**
 * Detect the duration (in seconds) of a media file inside FFmpeg's MEMFS.
 *
 * Runs `ffmpeg -i <input>` with no output file. FFmpeg opens the input,
 * prints its metadata (including a `Duration: HH:MM:SS.cc` line) to the log,
 * and exits with a non-zero code because no output was specified. The
 * non-zero exit is expected and harmless — we only need the log line.
 *
 * Returns null if the duration could not be parsed.
 */
export async function getSourceDuration(
  ff: FFmpeg,
  inputName: string,
): Promise<number | null> {
  const collected: string[] = [];
  const handler = ({ message }: { message: string }) => collected.push(message);
  ff.on("log", handler);
  try {
    // 8s timeout as a safety net so a hung probe never blocks the UI.
    await ff.exec(["-i", inputName], 8000);
  } catch {
    // Some builds throw on non-zero exit; the Duration line is captured already.
  } finally {
    ff.off("log", handler);
  }

  for (const line of collected) {
    const match = line.match(
      /Duration:\s*(\d{1,2}):(\d{2}):(\d{2})\.(\d{1,3})/,
    );
    if (match) {
      const [, h, m, s, frac] = match;
      const msPadded = frac.padEnd(3, "0").slice(0, 3);
      return (
        Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(msPadded) / 1000
      );
    }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* FFmpeg command builders                                             */
/* ------------------------------------------------------------------ */

/**
 * Build the args to extract the audio track of an input file and encode it
 * to a 192kbps MP3. `-vn` drops video; libmp3lame gives clean MP3 output.
 */
export function buildMp3Args(inputName: string, outputName: string): string[] {
  return [
    "-i", inputName,
    "-vn",
    "-c:a", "libmp3lame",
    "-b:a", "192k",
    "-ar", "44100",
    "-ac", "2",
    outputName,
  ];
}

/**
 * Build the args to cut a segment out of the source file using stream copy
 * (`-c copy`). This is dramatically faster than re-encoding and easily
 * handles 30-minute sources: only the requested byte range is muxed.
 *
 * `-ss` before `-i` performs fast input seeking to the nearest keyframe.
 * `-t` (duration) is used instead of `-to` to avoid ambiguity when seeking.
 * `-avoid_negative_ts make_zero` normalises timestamps so the cut starts at 0
 * (important for the concat step that follows).
 */
export function buildCutArgs(
  inputName: string,
  outputName: string,
  startSec: number,
  durationSec: number,
): string[] {
  return [
    "-ss", formatTime(startSec, true),
    "-i", inputName,
    "-t", durationSec.toFixed(3),
    "-c", "copy",
    "-avoid_negative_ts", "make_zero",
    outputName,
  ];
}

/**
 * Build the args to merge a list of files using the concat demuxer + stream
 * copy. This is the "virtual text file" approach: a `list.txt` is written to
 * the in-memory FS pointing at each segment, and FFmpeg stitches them with no
 * re-encoding. Works because every segment shares the source codec.
 */
export function buildConcatCopyArgs(listName: string, outputName: string): string[] {
  return [
    "-f", "concat",
    "-safe", "0",
    "-i", listName,
    "-c", "copy",
    "-movflags", "+faststart",
    outputName,
  ];
}

/**
 * Fallback: merge by re-encoding. Used only when stream-copy concat fails
 * (e.g. mismatched codecs across segments). Uses the concat filter which is
 * the most robust concatenation method FFmpeg offers.
 */
export function buildConcatReencodeArgs(
  segmentNames: string[],
  outputName: string,
): string[] {
  const args: string[] = [];
  for (const name of segmentNames) {
    args.push("-i", name);
  }
  // Build the filter chain: [0:v][0:a][1:v][1:a]...concat=n=N:v=1:a=1[v][a]
  const streams: string[] = [];
  segmentNames.forEach((_, i) => {
    streams.push(`[${i}:v:0][${i}:a:0]`);
  });
  const filter = `${streams.join("")}concat=n=${segmentNames.length}:v=1:a=1[v][a]`;
  args.push(
    "-filter_complex", filter,
    "-map", "[v]",
    "-map", "[a]",
    "-c:v", "libx264",
    "-preset", "ultrafast",
    "-crf", "23",
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-b:a", "192k",
    "-movflags", "+faststart",
    outputName,
  );
  return args;
}

/** Build the concat list file content (`file 'x.mp4'\nfile 'y.mp4'\n...`). */
export function buildConcatList(segmentNames: string[]): string {
  return segmentNames.map((n) => `file '${n}'`).join("\n") + "\n";
}

export { fetchFile };
