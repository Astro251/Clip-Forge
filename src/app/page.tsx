"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Clapperboard,
  UploadCloud,
  FileVideo,
  Music,
  Plus,
  Trash2,
  Download,
  Layers,
  TerminalSquare,
  Loader2,
  X,
  CheckCircle2,
  AlertCircle,
  Info,
  Film,
  Eraser,
  FilmIcon,
  Play,
  Pause,
  Square,
  ListPlus,
  ChevronDown,
  ChevronUp,
  Languages,
  FileText,
  ExternalLink,
} from "lucide-react";
import type { FFmpeg } from "@ffmpeg/ffmpeg";
import { Timeline } from "@/components/timeline";
import {
  buildConcatCopyArgs,
  buildConcatList,
  buildConcatReencodeArgs,
  buildCutArgs,
  buildMp3Args,
  createFFmpeg,
  downloadBlob,
  fetchFile,
  formatBytes,
  formatDurationMs,
  formatTime,
  formatTimeShort,
  getExtension,
  getSourceDuration,
  parseBulkTimestamps,
  parseTimestamp,
  sanitizeFilename,
  stripExtension,
} from "@/lib/ffmpeg";
import type { Clip } from "@/lib/types";

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

type FfmpegStatus = "idle" | "loading" | "ready";
type LogType = "info" | "success" | "warn" | "error" | "muted";
interface LogEntry {
  id: number;
  text: string;
  type: LogType;
}
type ToastType = "info" | "success" | "error";
interface Toast {
  id: string;
  message: string;
  type: ToastType;
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Generate a stable unique id with a fallback when crypto.randomUUID is absent. */
function generateId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** Filter out the noisy per-frame progress lines FFmpeg spams. */
function shouldLogLine(line: string): boolean {
  const t = line.trim();
  if (!t) return false;
  if (/^frame=\s*\d+/.test(t)) return false;
  if (/^size=\s*\d+/.test(t)) return false;
  if (/^Stream mapping:$/.test(t)) return false;
  return true;
}

/* ------------------------------------------------------------------ */
/* Component                                                           */
/* ------------------------------------------------------------------ */

export default function Home() {
  /* ---- file / ffmpeg state ---- */
  const [file, setFile] = useState<File | null>(null);
  const ffmpegRef = useRef<FFmpeg | null>(null);
  const [ffmpegStatus, setFfmpegStatus] = useState<FfmpegStatus>("idle");

  // Write-once source: the input file is written to MEMFS a single time and
  // reused across every operation. This is a major speedup for 30-min files
  // (avoids re-writing hundreds of MB per export).
  const inputNameRef = useRef<string>("");
  const inputReadyRef = useRef<boolean>(false);
  const [sourceDuration, setSourceDuration] = useState<number | null>(null);

  /* ---- timeline state ---- */
  const [playhead, setPlayhead] = useState(0);
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);

  /* ---- clip form state ---- */
  const [startInput, setStartInput] = useState("");
  const [endInput, setEndInput] = useState("");
  const [nameInput, setNameInput] = useState("");
  const [clips, setClips] = useState<Clip[]>([]);
  const [inputMode, setInputMode] = useState<"single" | "bulk">("single");
  const [bulkInput, setBulkInput] = useState("");
  const [bulkOpen, setBulkOpen] = useState(false);
  // Timeline editor starts collapsed to save vertical space. Users expand
  // it on demand once they've added clips via the form / bulk paste above.
  const [timelineOpen, setTimelineOpen] = useState(false);

  /* ---- audio playback state ---- */
  // Object URL for the source file — memoized so the media element
  // keeps a stable src across re-renders. Revoked on file change /
  // unmount to avoid leaking blobs.
  // We use a <video> element (hidden) rather than <audio> because
  // browsers' <audio> elements often cannot decode video containers
  // (MP4) — a hidden <video> plays both audio AND video files and
  // outputs just the audio track.
  const mediaRef = useRef<HTMLVideoElement | null>(null);
  const [playingClipId, setPlayingClipId] = useState<string | null>(null);
  const [audioCurrentTime, setAudioCurrentTime] = useState(0);
  const audioUrl = useMemo(() => (file ? URL.createObjectURL(file) : null), [file]);
  // Track the end boundary of the clip currently playing so the
  // timeupdate listener knows when to stop.
  const playEndRef = useRef<number>(0);

  /* ---- processing state ---- */
  const [busy, setBusy] = useState(false);
  const [taskLabel, setTaskLabel] = useState("");
  const [progress, setProgress] = useState(0);

  /* ---- logs (batched) ---- */
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const logIdRef = useRef(0);
  const logBufferRef = useRef<LogEntry[]>([]);
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const progressHandlerRef = useRef<(r: number) => void>(() => {});

  /* ---- drag / toast ---- */
  const [dragging, setDragging] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);

  /* ---- refs ---- */
  const fileInputRef = useRef<HTMLInputElement>(null);
  const terminalRef = useRef<HTMLDivElement>(null);

  /* ---------------------------------------------------------------- */
  /* Logging (batched to avoid re-rendering on every FFmpeg line)      */
  /* ---------------------------------------------------------------- */
  const appendLog = useCallback((text: string, type: LogType = "muted") => {
    if (type === "muted" && !shouldLogLine(text)) return;
    logIdRef.current += 1;
    logBufferRef.current.push({ id: logIdRef.current, text, type });
    if (flushTimerRef.current === null) {
      flushTimerRef.current = setTimeout(() => {
        const batch = logBufferRef.current;
        logBufferRef.current = [];
        flushTimerRef.current = null;
        setLogs((prev) => [...prev, ...batch].slice(-600));
      }, 90);
    }
  }, []);

  const clearLogs = useCallback(() => {
    logBufferRef.current = [];
    setLogs([]);
  }, []);

  /* ---------------------------------------------------------------- */
  /* Toasts                                                            */
  /* ---------------------------------------------------------------- */
  const showToast = useCallback((message: string, type: ToastType = "info") => {
    const id = generateId();
    setToasts((prev) => [...prev, { id, message, type }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 4200);
  }, []);

  /* ---------------------------------------------------------------- */
  /* FFmpeg loading                                                    */
  /* ---------------------------------------------------------------- */
  const loadFFmpeg = useCallback(async () => {
    if (ffmpegRef.current?.loaded) return ffmpegRef.current;
    setFfmpegStatus("loading");
    appendLog("Loading FFmpeg WebAssembly core…", "info");
    try {
      const ff = await createFFmpeg({
        onLog: (line) => appendLog(line, "muted"),
        onProgress: (r) => progressHandlerRef.current(r),
      });
      ffmpegRef.current = ff;
      setFfmpegStatus("ready");
      appendLog("FFmpeg core ready.", "success");
      return ff;
    } catch (e) {
      setFfmpegStatus("idle");
      appendLog(`Failed to load FFmpeg: ${String(e)}`, "error");
      showToast(
        "Could not load the FFmpeg engine. Check your connection.",
        "error",
      );
      throw e;
    }
  }, [appendLog, showToast]);

  const ensureFFmpeg = useCallback(async () => {
    if (ffmpegRef.current?.loaded) return ffmpegRef.current;
    return loadFFmpeg();
  }, [loadFFmpeg]);

  /* ---------------------------------------------------------------- */
  /* Source file MEMFS management (write-once)                         */
  /* ---------------------------------------------------------------- */
  const prepareSource = useCallback(
    async (ff: FFmpeg, f: File): Promise<string> => {
      if (inputReadyRef.current && inputNameRef.current) {
        return inputNameRef.current;
      }
      const ext = getExtension(f.name);
      const name = `input.${ext}`;
      appendLog(`Writing source file to FFmpeg in-memory FS…`, "info");
      await ff.writeFile(name, await fetchFile(f));
      inputNameRef.current = name;
      inputReadyRef.current = true;
      return name;
    },
    [appendLog],
  );

  const cleanupSource = useCallback(async () => {
    const ff = ffmpegRef.current;
    if (ff && inputReadyRef.current && inputNameRef.current) {
      try {
        await ff.deleteFile(inputNameRef.current);
      } catch {
        /* ignore — file may already be gone */
      }
    }
    inputNameRef.current = "";
    inputReadyRef.current = false;
  }, []);

  const detectDuration = useCallback(
    async (ff: FFmpeg, inputName: string) => {
      appendLog("Probing source duration…", "info");
      const dur = await getSourceDuration(ff, inputName);
      setSourceDuration(dur);
      if (dur) {
        appendLog(`Source duration: ${formatTimeShort(dur, true)}`, "success");
      } else {
        appendLog(
          "Could not auto-detect duration; timeline will use clip extents.",
          "warn",
        );
      }
    },
    [appendLog],
  );

  /* ---------------------------------------------------------------- */
  /* File handling                                                     */
  /* ---------------------------------------------------------------- */
  const handleFileSelect = useCallback(
    async (f: File) => {
      // Clear any previously-written source from MEMFS.
      await cleanupSource();
      setFile(f);
      setClips([]);
      setStartInput("");
      setEndInput("");
      setNameInput("");
      setPlayhead(0);
      setSelectedClipId(null);
      setSourceDuration(null);
      setProgress(0);
      setTaskLabel("");
      appendLog(`Loaded "${f.name}" — ${formatBytes(f.size)}`, "info");
      try {
        const ff = await ensureFFmpeg();
        const name = await prepareSource(ff, f);
        await detectDuration(ff, name);
      } catch {
        // errors already logged / toasted
      }
    },
    [cleanupSource, ensureFFmpeg, prepareSource, detectDuration, appendLog],
  );

  /** Stop all audio playback. Defined early so clearFile can use it. */
  const stopPlayback = useCallback(() => {
    const audio = mediaRef.current;
    if (audio) {
      audio.pause();
      audio.currentTime = 0;
    }
    setPlayingClipId(null);
  }, []);

  const clearFile = useCallback(async () => {
    await cleanupSource();
    stopPlayback();
    setFile(null);
    setClips([]);
    setStartInput("");
    setEndInput("");
    setNameInput("");
    setBulkInput("");
    setProgress(0);
    setTaskLabel("");
    setPlayhead(0);
    setSelectedClipId(null);
    setSourceDuration(null);
  }, [cleanupSource, stopPlayback]);

  const onFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) void handleFileSelect(f);
    e.target.value = "";
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const f = e.dataTransfer.files?.[0];
    if (f) void handleFileSelect(f);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    if (!dragging) setDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
  };

  /* ---------------------------------------------------------------- */
  /* Playhead (clamped to effective duration)                          */
  /* ---------------------------------------------------------------- */
  const handlePlayheadChange = useCallback(
    (time: number) => {
      const maxClipEnd = clips.reduce((m, c) => Math.max(m, c.endSec), 0);
      const max = sourceDuration ?? Math.max(30, maxClipEnd + 10);
      setPlayhead(Math.max(0, Math.min(max, time)));
    },
    [sourceDuration, clips],
  );

  /* ---------------------------------------------------------------- */
  /* Clip management                                                   */
  /* ---------------------------------------------------------------- */
  const addClip = () => {
    let start: number;
    let end: number;
    try {
      start = parseTimestamp(startInput);
    } catch (e) {
      showToast(
        `Start time: ${e instanceof Error ? e.message : String(e)}`,
        "error",
      );
      return;
    }
    try {
      end = parseTimestamp(endInput);
    } catch (e) {
      showToast(
        `End time: ${e instanceof Error ? e.message : String(e)}`,
        "error",
      );
      return;
    }
    if (end <= start) {
      showToast("End time must be later than start time.", "error");
      return;
    }
    const name = sanitizeFilename(
      nameInput.trim() || `clip_${clips.length + 1}`,
    );
    const newClip: Clip = {
      id: generateId(),
      startSec: start,
      endSec: end,
      startRaw: startInput.trim(),
      endRaw: endInput.trim(),
      filename: name,
    };
    setClips((prev) => [...prev, newClip]);
    setSelectedClipId(newClip.id);
    setStartInput("");
    setEndInput("");
    setNameInput("");
    showToast(
      `Added clip "${name}" (${formatDurationMs(end - start)})`,
      "info",
    );
  };

  /** Parse the bulk textarea and append all valid clips at once. */
  const addBulkClips = () => {
    if (!bulkInput.trim()) {
      showToast("Paste at least one line of timestamps first.", "error");
      return;
    }
    const { clips: parsed, errors } = parseBulkTimestamps(
      bulkInput,
      clips.length,
    );
    if (parsed.length === 0) {
      showToast(
        errors[0]
          ? `Line ${errors[0].line}: ${errors[0].reason}`
          : "No valid clips found.",
        "error",
      );
      return;
    }
    const newClips: Clip[] = parsed.map((p) => ({
      id: generateId(),
      startSec: p.startSec,
      endSec: p.endSec,
      startRaw: p.startRaw,
      endRaw: p.endRaw,
      filename: sanitizeFilename(p.name),
    }));
    setClips((prev) => [...prev, ...newClips]);
    setSelectedClipId(newClips[0].id);
    setBulkInput("");
    setBulkOpen(false);
    if (errors.length === 0) {
      showToast(
        `Added ${newClips.length} clip${newClips.length === 1 ? "" : "s"} from bulk input`,
        "success",
      );
    } else {
      showToast(
        `Added ${newClips.length} clip${newClips.length === 1 ? "" : "s"} · ${errors.length} line${errors.length === 1 ? "" : "s"} skipped`,
        "info",
      );
    }
  };

  /* ---------------------------------------------------------------- */
  /* Audio playback (verify clips before downloading)                  */
  /* ---------------------------------------------------------------- */

  /** Play a clip's audio range from start to end. Toggles off if active. */
  const playClip = useCallback(
    (clip: Clip) => {
      const audio = mediaRef.current;
      if (!audio) return;
      // If this clip is already playing, toggle to pause.
      if (playingClipId === clip.id && !audio.paused) {
        audio.pause();
        setPlayingClipId(null);
        return;
      }
      playEndRef.current = clip.endSec;
      setPlayingClipId(clip.id);
      // Seek to clip start. If metadata isn't loaded yet, wait for the
      // loadedmetadata event before seeking + playing.
      const startPlayback = () => {
        try {
          audio.currentTime = clip.startSec;
        } catch {
          /* ignore seek errors */
        }
        audio.play().catch(() => {
          showToast("Could not play audio for this file.", "error");
          setPlayingClipId(null);
        });
      };
      if (audio.readyState >= 1) {
        startPlayback();
      } else {
        audio.addEventListener(
          "loadedmetadata",
          startPlayback,
          { once: true },
        );
      }
    },
    [playingClipId, showToast],
  );

  // Keep audio element's src in sync with the object URL.
  useEffect(() => {
    const audio = mediaRef.current;
    if (!audio) return;
    if (audioUrl) audio.src = audioUrl;
  }, [audioUrl]);

  // Revoke the object URL when the file changes or component unmounts.
  useEffect(() => {
    return () => {
      if (audioUrl) URL.revokeObjectURL(audioUrl);
    };
  }, [audioUrl]);

  // timeupdate listener: track progress + auto-stop at clip end.
  useEffect(() => {
    const audio = mediaRef.current;
    if (!audio) return;
    const onTime = () => {
      setAudioCurrentTime(audio.currentTime);
      if (playEndRef.current && audio.currentTime >= playEndRef.current) {
        audio.pause();
        setPlayingClipId(null);
        playEndRef.current = 0;
      }
    };
    const onEnded = () => {
      setPlayingClipId(null);
      playEndRef.current = 0;
    };
    audio.addEventListener("timeupdate", onTime);
    audio.addEventListener("ended", onEnded);
    return () => {
      audio.removeEventListener("timeupdate", onTime);
      audio.removeEventListener("ended", onEnded);
    };
  }, []);

  const removeClip = (id: string) => {
    setClips((prev) => prev.filter((c) => c.id !== id));
    setSelectedClipId((prev) => (prev === id ? null : prev));
    if (playingClipId === id) stopPlayback();
  };

  const deleteClip = useCallback(
    (id: string) => {
      setClips((prev) => {
        const target = prev.find((c) => c.id === id);
        if (target) {
          showToast(`Deleted clip "${target.filename}"`, "info");
        }
        return prev.filter((c) => c.id !== id);
      });
      setSelectedClipId((prev) => (prev === id ? null : prev));
      if (playingClipId === id) stopPlayback();
    },
    [showToast, playingClipId, stopPlayback],
  );

  /** Split the clip under the playhead into two clips at the playhead position. */
  const splitAtPlayhead = useCallback(() => {
    if (clips.length === 0 || busy) return;
    const clip = clips.find(
      (c) => playhead > c.startSec + 0.001 && playhead < c.endSec - 0.001,
    );
    if (!clip) {
      showToast(
        "Position the playhead inside a clip to split it.",
        "info",
      );
      return;
    }
    const left: Clip = {
      ...clip,
      endSec: playhead,
      endRaw: formatTime(playhead, true),
      filename: `${clip.filename}_A`,
    };
    const right: Clip = {
      ...clip,
      id: generateId(),
      startSec: playhead,
      startRaw: formatTime(playhead, true),
      filename: `${clip.filename}_B`,
    };
    setClips((prev) =>
      prev.flatMap((c) => (c.id === clip.id ? [left, right] : [c])),
    );
    setSelectedClipId(right.id);
    showToast(
      `Split "${clip.filename}" → "${left.filename}" + "${right.filename}" at ${formatTimeShort(playhead, true)}`,
      "success",
    );
  }, [clips, playhead, busy, showToast]);

  /* ---------------------------------------------------------------- */
  /* Operation: MP4 → MP3                                              */
  /* ---------------------------------------------------------------- */
  const extractMp3 = async () => {
    if (!file || busy) return;
    setBusy(true);
    setTaskLabel("Extracting audio → 192 kbps MP3");
    setProgress(0);
    const outputName = "output.mp3";
    try {
      const ff = await ensureFFmpeg();
      const inputName = await prepareSource(ff, file);

      progressHandlerRef.current = (r) => setProgress(r);
      appendLog("Encoding audio with libmp3lame @ 192 kbps…", "info");
      await ff.exec(buildMp3Args(inputName, outputName));

      const data = (await ff.readFile(outputName)) as Uint8Array;
      const baseName = sanitizeFilename(stripExtension(file.name));
      const outName = `${baseName}.mp3`;
      downloadBlob(new Blob([data], { type: "audio/mpeg" }), outName);
      appendLog(
        `✓ Done — downloaded ${outName} (${formatBytes(data.byteLength)})`,
        "success",
      );
      showToast(`MP3 extracted → ${outName}`, "success");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      appendLog(`✗ MP3 extraction failed: ${msg}`, "error");
      showToast(`MP3 extraction failed: ${msg}`, "error");
    } finally {
      const ff = ffmpegRef.current;
      if (ff) {
        try {
          await ff.deleteFile(outputName);
        } catch {
          /* ignore */
        }
      }
      // NOTE: input file intentionally stays in MEMFS for reuse.
      setBusy(false);
      setProgress(0);
      setTaskLabel("");
      progressHandlerRef.current = () => {};
    }
  };

  /* ---------------------------------------------------------------- */
  /* Operation: Export separate clips                                  */
  /* ---------------------------------------------------------------- */
  const exportSeparate = async () => {
    if (!file || clips.length === 0 || busy) return;
    setBusy(true);
    setTaskLabel("Cutting & downloading separate clips");
    setProgress(0);
    const segNames: string[] = [];
    try {
      const ff = await ensureFFmpeg();
      const inputName = await prepareSource(ff, file);

      for (let i = 0; i < clips.length; i++) {
        const clip = clips[i];
        const segName = `seg_${i}.mp4`;
        segNames.push(segName);
        const duration = clip.endSec - clip.startSec;
        const outName = `${sanitizeFilename(clip.filename)}.mp4`;

        appendLog(
          `[${i + 1}/${clips.length}] Cutting "${outName}" — ${formatTime(clip.startSec, true)} → ${formatTime(clip.endSec, true)} (${formatDurationMs(duration)})`,
          "info",
        );
        const idx = i;
        progressHandlerRef.current = (r) =>
          setProgress((idx + r) / clips.length);
        await ff.exec(
          buildCutArgs(inputName, segName, clip.startSec, duration),
        );

        const data = (await ff.readFile(segName)) as Uint8Array;
        downloadBlob(new Blob([data], { type: "video/mp4" }), outName);
        appendLog(
          `  ✓ Downloaded ${outName} (${formatBytes(data.byteLength)})`,
          "success",
        );

        // Free the MEMFS entry so memory stays bounded for 30-min sources.
        try {
          await ff.deleteFile(segName);
        } catch {
          /* ignore */
        }
        segNames.pop();

        // Brief pause so browsers don't block multi-file downloads.
        await sleep(450);
      }

      appendLog(`✓ All ${clips.length} clips downloaded.`, "success");
      showToast(`${clips.length} clips downloaded`, "success");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      appendLog(`✗ Export failed: ${msg}`, "error");
      showToast(`Export failed: ${msg}`, "error");
    } finally {
      const ff = ffmpegRef.current;
      if (ff) {
        for (const n of segNames) {
          try {
            await ff.deleteFile(n);
          } catch {
            /* ignore */
          }
        }
      }
      setBusy(false);
      setProgress(0);
      setTaskLabel("");
      progressHandlerRef.current = () => {};
    }
  };

  /* ---------------------------------------------------------------- */
  /* Operation: Export merged master file                              */
  /* ---------------------------------------------------------------- */
  const exportMerged = async () => {
    if (!file || clips.length === 0 || busy) return;
    setBusy(true);
    setTaskLabel("Building merged master file");
    setProgress(0);
    const segNames: string[] = [];
    const listName = "concat_list.txt";
    const outputName = "merged.mp4";
    try {
      const ff = await ensureFFmpeg();
      const inputName = await prepareSource(ff, file);

      const total = clips.length;
      // Phase 1 — cut each segment (0% → 70%)
      for (let i = 0; i < total; i++) {
        const clip = clips[i];
        const segName = `seg_${i}.mp4`;
        segNames.push(segName);
        const duration = clip.endSec - clip.startSec;
        appendLog(
          `[${i + 1}/${total}] Cutting segment — ${formatTime(clip.startSec, true)} → ${formatTime(clip.endSec, true)}`,
          "info",
        );
        const idx = i;
        progressHandlerRef.current = (r) =>
          setProgress(((idx + r) / total) * 0.7);
        await ff.exec(
          buildCutArgs(inputName, segName, clip.startSec, duration),
        );
      }

      // Phase 2 — build the virtual concat list (FFmpeg text file)
      appendLog("Generating concat demuxer list.txt…", "info");
      await ff.writeFile(listName, buildConcatList(segNames));

      // Phase 3 — stitch with stream copy (instant for same-codec segments)
      appendLog("Stitching via concat demuxer + stream copy…", "info");
      progressHandlerRef.current = () => setProgress(0.72);
      let mergedOk = false;
      try {
        await ff.exec(buildConcatCopyArgs(listName, outputName));
        mergedOk = true;
      } catch (e) {
        appendLog(
          `Stream-copy concat failed (${e instanceof Error ? e.message : String(e)}); falling back to concat filter re-encode…`,
          "warn",
        );
        try {
          await ff.deleteFile(outputName);
        } catch {
          /* ignore */
        }
        progressHandlerRef.current = (r) => setProgress(0.72 + r * 0.26);
        await ff.exec(buildConcatReencodeArgs(segNames, outputName));
        mergedOk = true;
      }

      if (mergedOk) {
        progressHandlerRef.current = () => setProgress(0.98);
        const data = (await ff.readFile(outputName)) as Uint8Array;
        const outName = "merged_master.mp4";
        downloadBlob(new Blob([data], { type: "video/mp4" }), outName);
        appendLog(
          `✓ Merged master downloaded — ${outName} (${formatBytes(data.byteLength)})`,
          "success",
        );
        showToast(`Merged master file downloaded`, "success");
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      appendLog(`✗ Merge failed: ${msg}`, "error");
      showToast(`Merge failed: ${msg}`, "error");
    } finally {
      const ff = ffmpegRef.current;
      if (ff) {
        for (const n of segNames) {
          try {
            await ff.deleteFile(n);
          } catch {
            /* ignore */
          }
        }
        try {
          await ff.deleteFile(listName);
        } catch {
          /* ignore */
        }
        try {
          await ff.deleteFile(outputName);
        } catch {
          /* ignore */
        }
      }
      setBusy(false);
      setProgress(0);
      setTaskLabel("");
      progressHandlerRef.current = () => {};
    }
  };

  /* ---------------------------------------------------------------- */
  /* Auto-scroll terminal to bottom on new logs                        */
  /* ---------------------------------------------------------------- */
  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.scrollTop = terminalRef.current.scrollHeight;
    }
  }, [logs]);

  /* ---------------------------------------------------------------- */
  /* Cleanup MEMFS on unmount                                          */
  /* ---------------------------------------------------------------- */
  useEffect(() => {
    return () => {
      const ff = ffmpegRef.current;
      if (ff && inputReadyRef.current && inputNameRef.current) {
        try {
          void ff.deleteFile(inputNameRef.current);
        } catch {
          /* ignore */
        }
      }
    };
  }, []);

  /* ---------------------------------------------------------------- */
  /* Derived display values                                            */
  /* ---------------------------------------------------------------- */
  const statusDotClass =
    ffmpegStatus === "ready"
      ? "ready"
      : ffmpegStatus === "loading"
        ? "loading"
        : busy
          ? "busy"
          : "";
  const statusText =
    ffmpegStatus === "ready"
      ? "Engine ready"
      : ffmpegStatus === "loading"
        ? "Loading engine…"
        : busy
          ? "Processing…"
          : "Engine idle";

  const ext = file ? getExtension(file.name) : "";

  /* ---------------------------------------------------------------- */
  /* Render                                                            */
  /* ---------------------------------------------------------------- */
  return (
    <div className="editor-shell">
      {/* ===== Header ===== */}
      <header className="editor-header">
        <div className="editor-brand">
          <div className="editor-logo" aria-hidden="true">
            <Clapperboard size={22} color="#fff" strokeWidth={2.2} />
          </div>
          <div>
            <h1 className="editor-title">ClipForge</h1>
            <p className="editor-subtitle">
              Client-side Audio / Video Editor
            </p>
          </div>
        </div>
        <div className="editor-status" role="status" aria-live="polite">
          <span className={`status-dot ${statusDotClass}`} />
          <span>{statusText}</span>
        </div>
      </header>

      {/* ===== Main ===== */}
      <main className="editor-main">
        {/* --- Step 1: Source file --- */}
        <section className="panel" aria-labelledby="step1-title">
          <div className="panel-header">
            <h2 id="step1-title" className="panel-title">
              <span className="step-num">1</span> Source File
            </h2>
            <p className="panel-desc">
              Drop a video — everything runs in your browser
            </p>
          </div>
          <div className="panel-body">
            {!file ? (
              <div
                className={`dropzone ${dragging ? "dragging" : ""}`}
                onDrop={handleDrop}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onClick={() => fileInputRef.current?.click()}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    fileInputRef.current?.click();
                  }
                }}
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="video/*,audio/*"
                  onChange={onFileInputChange}
                  hidden
                />
                <div className="dropzone-icon" aria-hidden="true">
                  <UploadCloud size={28} />
                </div>
                <div className="dropzone-text">
                  Drop an MP4 / video here, or click to browse
                </div>
                <div className="dropzone-hint">
                  100% client-side · no upload · handles files up to ~30 min
                </div>
              </div>
            ) : (
              <div className="fileinfo">
                <div className="fileinfo-icon" aria-hidden="true">
                  <FileVideo size={22} />
                </div>
                <div className="fileinfo-meta">
                  <div className="fileinfo-name" title={file.name}>
                    {file.name}
                  </div>
                  <div className="fileinfo-sub">
                    {formatBytes(file.size)} · {ext.toUpperCase()} ·{" "}
                    {file.type || "media file"}
                    {sourceDuration != null && (
                      <>
                        {" · "}
                        <span className="mono">
                          {formatTimeShort(sourceDuration, true)}
                        </span>
                      </>
                    )}
                  </div>
                </div>
                <div className="fileinfo-clear">
                  <button
                    className="btn btn-ghost"
                    onClick={clearFile}
                    disabled={busy}
                    type="button"
                  >
                    <X size={15} /> Change
                  </button>
                </div>
              </div>
            )}
          </div>
        </section>

        {/* --- Step 2: Operations dashboard --- */}
        {file && (
          <section className="panel" aria-labelledby="step2-title">
            <div className="panel-header">
              <h2 id="step2-title" className="panel-title">
                <span className="step-num">2</span> Operations Dashboard
              </h2>
              <p className="panel-desc">
                Extract full MP3 &amp; mark clip segments
              </p>
            </div>
            <div
              className="panel-body"
              style={{
                display: "flex",
                flexDirection: "column",
                gap: "1.1rem",
              }}
            >
              {/* MP3 extraction */}
              <div className="toggle-row">
                <div className="toggle-info">
                  <div className="toggle-title">
                    <Music
                      size={15}
                      style={{
                        display: "inline",
                        marginRight: 6,
                        verticalAlign: "-2px",
                      }}
                    />
                    MP3 Extraction · 192 kbps
                  </div>
                  <div className="toggle-desc">
                    Extract the full audio track and encode a clean 192 kbps
                    MP3.
                  </div>
                </div>
                <button
                  className="btn btn-primary"
                  onClick={extractMp3}
                  disabled={busy}
                  type="button"
                >
                  {busy && taskLabel.startsWith("Extracting") ? (
                    <Loader2 size={15} className="animate-spin" />
                  ) : (
                    <Music size={15} />
                  )}
                  Extract MP3
                </button>
              </div>

              {/* Segment timestamp form */}
              <div>
                <div
                  className="row-between"
                  style={{ marginBottom: "0.75rem", flexWrap: "wrap", gap: "0.5rem" }}
                >
                  <div className="row">
                    <span className="badge">
                      <Film
                        size={11}
                        style={{
                          display: "inline",
                          marginRight: 4,
                          verticalAlign: "-1px",
                        }}
                      />
                      Clip Segments
                    </span>
                    <span
                      className="muted"
                      style={{ fontSize: "0.78rem" }}
                    >
                      {clips.length} added
                    </span>
                  </div>
                  {/* Single / Bulk mode toggle */}
                  <div className="mode-toggle" role="tablist" aria-label="Input mode">
                    <button
                      type="button"
                      role="tab"
                      aria-selected={inputMode === "single"}
                      className={`mode-toggle-btn ${inputMode === "single" ? "active" : ""}`}
                      onClick={() => setInputMode("single")}
                    >
                      <Plus size={13} /> Single
                    </button>
                    <button
                      type="button"
                      role="tab"
                      aria-selected={inputMode === "bulk"}
                      className={`mode-toggle-btn ${inputMode === "bulk" ? "active" : ""}`}
                      onClick={() => setInputMode("bulk")}
                    >
                      <ListPlus size={13} /> Bulk paste
                    </button>
                  </div>
                </div>

                {inputMode === "single" ? (
                  <div className="form-grid">
                    <div className="field">
                      <label className="field-label" htmlFor="clip-start">
                        Start Time
                      </label>
                      <input
                        id="clip-start"
                        className="input"
                        placeholder="00:01:30.000"
                        value={startInput}
                        onChange={(e) => setStartInput(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") addClip();
                        }}
                        disabled={busy}
                        inputMode="numeric"
                      />
                    </div>
                    <div className="field">
                      <label className="field-label" htmlFor="clip-end">
                        End Time
                      </label>
                      <input
                        id="clip-end"
                        className="input"
                        placeholder="00:02:15.500"
                        value={endInput}
                        onChange={(e) => setEndInput(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") addClip();
                        }}
                        disabled={busy}
                        inputMode="numeric"
                      />
                    </div>
                    <div className="field field--name">
                      <label className="field-label" htmlFor="clip-name">
                        Clip Name
                      </label>
                      <input
                        id="clip-name"
                        className="input"
                        placeholder="intro-scene"
                        value={nameInput}
                        onChange={(e) => setNameInput(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") addClip();
                        }}
                        disabled={busy}
                      />
                    </div>
                    <div className="field field--add">
                      <button
                        className="btn btn-primary"
                        onClick={addClip}
                        disabled={busy}
                        type="button"
                        style={{ width: "100%" }}
                      >
                        <Plus size={15} /> Add Clip
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="bulk-input-wrap">
                    <div className="bulk-input-header">
                      <span className="muted" style={{ fontSize: "0.74rem" }}>
                        One clip per line —{" "}
                        <code className="inline-code">
                          start end name
                        </code>
                        . Separators: space, comma, tab, dash, arrow.
                      </span>
                      <button
                        type="button"
                        className="btn btn-ghost bulk-collapse-btn"
                        onClick={() => setBulkOpen((v) => !v)}
                        aria-expanded={bulkOpen}
                        title={bulkOpen ? "Hide examples" : "Show examples"}
                      >
                        {bulkOpen ? (
                          <ChevronUp size={14} />
                        ) : (
                          <ChevronDown size={14} />
                        )}
                        Examples
                      </button>
                    </div>
                    {bulkOpen && (
                      <pre className="bulk-examples mono">{`# one clip per line — anything after the
# 2nd timestamp becomes the clip name
00:01:00 00:02:00 intro
00:02:05.500 00:03:30 bridge
1:30 2:15 verse-two
00:05:00,00:06:00,outro`}</pre>
                    )}
                    <textarea
                      className="bulk-textarea mono"
                      placeholder={
                        "00:00:01.000 00:00:04.500 intro\n00:00:05.000 00:00:09.000 main-scene\n00:00:10.000 00:00:15.500 outro"
                      }
                      value={bulkInput}
                      onChange={(e) => setBulkInput(e.target.value)}
                      disabled={busy}
                      rows={6}
                      spellCheck={false}
                    />
                    <div className="bulk-actions">
                      <button
                        className="btn btn-ghost"
                        type="button"
                        onClick={() => setBulkInput("")}
                        disabled={busy || !bulkInput}
                      >
                        <Eraser size={14} /> Clear
                      </button>
                      <button
                        className="btn btn-primary"
                        type="button"
                        onClick={addBulkClips}
                        disabled={busy || !bulkInput.trim()}
                      >
                        <ListPlus size={15} /> Add all clips
                      </button>
                    </div>
                  </div>
                )}
              </div>

              {/* Clips list */}
              <div className="clips-list">
                {clips.length === 0 ? (
                  <div className="empty-state">
                    No clips yet. Add segments using the form above, or use
                    the timeline below to split &amp; edit visually — each
                    clip gets its own custom filename.
                  </div>
                ) : (
                  <>
                    {/* Audio transport bar — only visible while a clip is playing */}
                    {playingClipId && (
                      <div className="audio-transport">
                        <button
                          className="btn-icon audio-stop-btn"
                          type="button"
                          onClick={stopPlayback}
                          aria-label="Stop playback"
                          title="Stop"
                        >
                          <Square size={14} />
                        </button>
                        <span className="audio-transport-name">
                          {clips.find((c) => c.id === playingClipId)?.filename ?? ""}
                        </span>
                        <div className="audio-progress-track">
                          {(() => {
                            const c = clips.find((cl) => cl.id === playingClipId);
                            if (!c) return null;
                            const pct = Math.max(
                              0,
                              Math.min(
                                100,
                                ((audioCurrentTime - c.startSec) /
                                  (c.endSec - c.startSec)) *
                                  100,
                              ),
                            );
                            return (
                              <div
                                className="audio-progress-fill"
                                style={{ width: `${pct}%` }}
                              />
                            );
                          })()}
                        </div>
                        <span className="audio-transport-time mono">
                          {formatTimeShort(
                            Math.max(
                              0,
                              audioCurrentTime -
                                (clips.find((c) => c.id === playingClipId)
                                  ?.startSec ?? 0),
                            ),
                            true,
                          )}
                        </span>
                      </div>
                    )}
                    {clips.map((clip, i) => {
                      const isPlaying = playingClipId === clip.id;
                      return (
                        <div
                          className={`clip-item ${clip.id === selectedClipId ? "selected" : ""} ${isPlaying ? "playing" : ""}`}
                          key={clip.id}
                          onClick={() => setSelectedClipId(clip.id)}
                          role="button"
                          tabIndex={0}
                        >
                          <div className="clip-idx">{i + 1}</div>
                          <div
                            className="clip-name"
                            title={`${clip.filename}.mp4`}
                          >
                            {clip.filename}.mp4
                          </div>
                          <div className="clip-time">
                            {formatTime(clip.startSec, true)} →{" "}
                            {formatTime(clip.endSec, true)}
                          </div>
                          <div className="clip-dur">
                            {formatDurationMs(clip.endSec - clip.startSec)}
                          </div>
                          <button
                            className="btn-icon clip-play-btn"
                            onClick={(e) => {
                              e.stopPropagation();
                              playClip(clip);
                            }}
                            disabled={busy}
                            type="button"
                            aria-label={
                              isPlaying
                                ? `Pause ${clip.filename}`
                                : `Play ${clip.filename}`
                            }
                            title={isPlaying ? "Pause" : "Play audio"}
                          >
                            {isPlaying ? (
                              <Pause size={16} />
                            ) : (
                              <Play size={16} />
                            )}
                          </button>
                          <button
                            className="btn-icon"
                            onClick={(e) => {
                              e.stopPropagation();
                              removeClip(clip.id);
                            }}
                            disabled={busy}
                            type="button"
                            aria-label={`Remove clip ${clip.filename}`}
                            title="Remove clip"
                          >
                            <Trash2 size={16} />
                          </button>
                        </div>
                      );
                    })}
                  </>
                )}
              </div>
            </div>
          </section>
        )}

        {/* --- Step 3: Timeline editor (collapsible, collapsed by default) --- */}
        {file && (
          <section
            className={`panel ${timelineOpen ? "" : "panel-collapsed"}`}
            aria-labelledby="step3-title"
          >
            <div className="panel-header">
              <div className="panel-head-main">
                <h2 id="step3-title" className="panel-title">
                  <span className="step-num">3</span> Timeline Editor
                </h2>
                <p className="panel-desc">
                  Visual NLE timeline · split &amp; delete with millisecond
                  precision
                </p>
              </div>
              <button
                className="btn-icon panel-collapse-btn"
                type="button"
                onClick={() => setTimelineOpen((v) => !v)}
                aria-expanded={timelineOpen}
                aria-controls="step3-body"
                title={timelineOpen ? "Collapse timeline" : "Expand timeline"}
              >
                {timelineOpen ? (
                  <ChevronUp size={18} />
                ) : (
                  <ChevronDown size={18} />
                )}
              </button>
            </div>
            {timelineOpen && (
              <div className="panel-body" id="step3-body">
                <Timeline
                  clips={clips}
                  duration={sourceDuration}
                  selectedClipId={selectedClipId}
                  onSelectClip={setSelectedClipId}
                  playhead={playhead}
                  onPlayheadChange={handlePlayheadChange}
                  onSplitAtPlayhead={splitAtPlayhead}
                  onDeleteClip={deleteClip}
                  disabled={busy}
                />
              </div>
            )}
          </section>
        )}

        {/* --- Step 4: Export panel --- */}
        {file && clips.length > 0 && (
          <section className="panel" aria-labelledby="step4-title">
            <div className="panel-header">
              <h2 id="step4-title" className="panel-title">
                <span className="step-num">4</span> Export Pipeline
              </h2>
              <p className="panel-desc">
                Optimized for 30-minute sources
              </p>
            </div>
            <div className="panel-body">
              <div className="export-grid">
                {/* Option A */}
                <div className="export-card">
                  <div className="export-card-title">
                    <Download size={16} /> Option A · Separate Clips
                  </div>
                  <div className="export-card-desc">
                    Loop through the timestamp list, cut each segment from
                    the source with stream-copy, and trigger an immediate
                    browser download for every clip. Fast &amp;
                    memory-friendly.
                  </div>
                  <button
                    className="btn btn-primary"
                    onClick={exportSeparate}
                    disabled={busy}
                    type="button"
                  >
                    {busy && taskLabel.startsWith("Cutting") ? (
                      <Loader2 size={15} className="animate-spin" />
                    ) : (
                      <Download size={15} />
                    )}
                    Download Separate Clips
                  </button>
                </div>
                {/* Option B */}
                <div className="export-card">
                  <div className="export-card-title">
                    <Layers size={16} /> Option B · Merged Master
                  </div>
                  <div className="export-card-desc">
                    Cut all segments, generate a virtual{" "}
                    <span className="mono">concat</span> list, then stitch
                    them with FFmpeg&apos;s concat demuxer into one
                    continuous master file.
                  </div>
                  <button
                    className="btn btn-success"
                    onClick={exportMerged}
                    disabled={busy}
                    type="button"
                  >
                    {busy && taskLabel.startsWith("Building") ? (
                      <Loader2 size={15} className="animate-spin" />
                    ) : (
                      <Layers size={15} />
                    )}
                    Download Merged Master File
                  </button>
                </div>
              </div>
            </div>
          </section>
        )}

        {/* --- Processing log --- */}
        {file && (
          <section className="panel" aria-labelledby="log-title">
            <div className="panel-header">
              <h2 id="log-title" className="panel-title">
                <TerminalSquare size={15} /> Processing Log
              </h2>
              <button
                className="btn-icon"
                onClick={clearLogs}
                disabled={busy}
                type="button"
                title="Clear log"
                aria-label="Clear log"
              >
                <Eraser size={15} />
              </button>
            </div>
            <div className="panel-body">
              {busy && (
                <div className="progress-wrap">
                  <div className="progress-track">
                    <div
                      className="progress-fill"
                      style={{
                        width: `${Math.round(progress * 100)}%`,
                      }}
                    />
                  </div>
                  <div className="progress-label">
                    <span>{taskLabel || "Working…"}</span>
                    <span>{Math.round(progress * 100)}%</span>
                  </div>
                </div>
              )}
              <div
                className="terminal"
                ref={terminalRef}
                aria-live="polite"
              >
                {logs.length === 0 ? (
                  <div className="terminal-empty">
                    Logs will appear here once processing starts…
                  </div>
                ) : (
                  logs.map((l) => (
                    <div key={l.id} className={`terminal-line ${l.type}`}>
                      {l.text}
                    </div>
                  ))
                )}
              </div>
            </div>
          </section>
        )}

        {/* --- Transcription tools (external links, last section) --- */}
        <section className="panel" aria-labelledby="trans-title">
          <div className="panel-header">
            <div className="panel-head-main">
              <h2 id="trans-title" className="panel-title">
                <Languages size={15} /> Transcription Tools
              </h2>
              <p className="panel-desc">
                Convert speech to text · opens in a new tab
              </p>
            </div>
          </div>
          <div className="panel-body">
            <div className="transcription-actions">
              <a
                className="btn btn-primary transcription-btn"
                href="https://elevenlabs.io/speech-to-text/hindi"
                target="_blank"
                rel="noopener noreferrer"
              >
                <Languages size={15} /> Hindi Transcription
                <ExternalLink size={14} />
              </a>
              <a
                className="btn btn-ghost transcription-btn"
                href="https://elevenlabs.io/speech-to-text/english"
                target="_blank"
                rel="noopener noreferrer"
              >
                <FileText size={15} /> English Transcription
                <ExternalLink size={14} />
              </a>
            </div>
          </div>
        </section>
      </main>

      {/* ===== Footer ===== */}
      <footer className="editor-footer">
        ClipForge · Powered by{" "}
        <a
          href="https://ffmpegwasm.netlify.app/"
          target="_blank"
          rel="noopener noreferrer"
        >
          FFmpeg.wasm
        </a>{" "}
        — all processing happens locally in your browser. No file is ever
        uploaded.
      </footer>

      {/* ===== Toasts ===== */}
      <div className="toast-stack" aria-live="assertive">
        {/* Hidden audio element for clip preview playback. Its src is
            kept in sync with the uploaded file's object URL via the
            effects above. */}
        <video ref={mediaRef} preload="metadata" hidden />
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`toast ${t.type}`}
            onClick={() => setToasts((prev) => prev.filter((x) => x.id !== t.id))}
            role="button"
            tabIndex={0}
            title="Dismiss"
          >
            {t.type === "success" ? (
              <CheckCircle2
                size={17}
                color="var(--ed-success)"
                style={{ flexShrink: 0, marginTop: 1 }}
              />
            ) : t.type === "error" ? (
              <AlertCircle
                size={17}
                color="var(--ed-danger)"
                style={{ flexShrink: 0, marginTop: 1 }}
              />
            ) : (
              <Info
                size={17}
                color="var(--ed-accent-hi)"
                style={{ flexShrink: 0, marginTop: 1 }}
              />
            )}
            <span>{t.message}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
