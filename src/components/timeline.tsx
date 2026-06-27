"use client";

/**
 * Desktop NLE-style editing timeline.
 *
 * Layout:
 *   ┌──────────────────────────────────────────────────────┐
 *   │ Toolbar (playhead TC · split · delete · zoom)        │
 *   ├──────────┬───────────────────────────────────────────┤
 *   │ Headers  │  Scrollable ruler + tracks + playhead     │
 *   │ (fixed)  │  (auto zoom-to-fit on mount / duration)   │
 *   ├──────────┴───────────────────────────────────────────┤
 *   │ Hint bar (kbd shortcuts)                             │
 *   └──────────────────────────────────────────────────────┘
 *
 * - Clips auto-distribute onto separate rows when they overlap.
 * - Each row gets a labelled, colour-coded track header on the left
 *   that stays fixed while the timeline scrolls horizontally.
 * - The canvas always fills the available width (auto zoom-to-fit),
 *   so there is never a big empty gap on the right.
 * - Millisecond precision everywhere (ruler labels, TC bubble, inputs).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Maximize2,
  Scissors,
  Trash2,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { formatTimeShort } from "@/lib/ffmpeg";
import type { Clip } from "@/lib/types";

export interface TimelineProps {
  clips: Clip[];
  duration: number | null;
  selectedClipId: string | null;
  onSelectClip: (id: string | null) => void;
  playhead: number;
  onPlayheadChange: (time: number) => void;
  onSplitAtPlayhead: () => void;
  onDeleteClip: (id: string) => void;
  disabled?: boolean;
}

/* ---- constants ---- */

const ROW_HEIGHT = 56;
const ROW_GAP = 6;
const RULER_HEIGHT = 40;
const HEADER_WIDTH = 132;
const MIN_PXPS = 6;
const MAX_PXPS = 400;
const DEFAULT_PXPS = 48;

/** Harmonious palette for clip blocks + track headers (cycles by row). */
const CLIP_COLORS = [
  { bg: "linear-gradient(180deg, #4f46e5, #4338ca)", solid: "#6366f1", edge: "#818cf8", glow: "rgba(99,102,241,0.45)" },
  { bg: "linear-gradient(180deg, #0891b2, #0e7490)", solid: "#06b6d4", edge: "#22d3ee", glow: "rgba(34,211,238,0.4)" },
  { bg: "linear-gradient(180deg, #db2777, #be185d)", solid: "#ec4899", edge: "#f472b6", glow: "rgba(244,114,182,0.4)" },
  { bg: "linear-gradient(180deg, #16a34a, #15803d)", solid: "#22c55e", edge: "#4ade80", glow: "rgba(74,222,128,0.4)" },
  { bg: "linear-gradient(180deg, #ea580c, #c2410c)", solid: "#f97316", edge: "#fb923c", glow: "rgba(251,146,60,0.4)" },
  { bg: "linear-gradient(180deg, #7c3aed, #6d28d9)", solid: "#a855f7", edge: "#c084fc", glow: "rgba(192,132,252,0.4)" },
];

/* ---- helpers ---- */

interface TickSet {
  major: number;
  minor: number;
}

/** Pick "nice" tick intervals so major labels stay ~90-130px apart. */
function getTickInterval(pxPerSec: number): TickSet {
  const targetMajorSec = 110 / pxPerSec;
  const nice = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800];
  let major = nice[nice.length - 1];
  for (const ni of nice) {
    if (ni >= targetMajorSec) {
      major = ni;
      break;
    }
  }
  return { major, minor: major / 5 };
}

interface LaidOutClip {
  clip: Clip;
  row: number;
  colorIndex: number;
}

/** Greedy first-fit row distribution by start time. */
function layoutClips(clips: Clip[]): {
  laid: LaidOutClip[];
  rows: number;
} {
  const sorted = [...clips].sort((a, b) => a.startSec - b.startSec);
  const rowEnds: number[] = [];
  const laid: LaidOutClip[] = [];
  sorted.forEach((clip) => {
    let row = 0;
    while (row < rowEnds.length && rowEnds[row] > clip.startSec + 0.001) {
      row++;
    }
    if (row >= rowEnds.length) rowEnds.push(clip.endSec);
    else rowEnds[row] = clip.endSec;
    laid.push({ clip, row, colorIndex: row % CLIP_COLORS.length });
  });
  return { laid, rows: Math.max(1, rowEnds.length) };
}

/** Deterministic pseudo-waveform heights for a clip (stable per id). */
function waveformBars(clipId: string, count: number): number[] {
  let h = 0;
  for (let i = 0; i < clipId.length; i++) h = (h * 31 + clipId.charCodeAt(i)) >>> 0;
  const bars: number[] = [];
  for (let i = 0; i < count; i++) {
    h = (h * 1103515245 + 12345) & 0x7fffffff;
    const v = 0.25 + ((h % 1000) / 1000) * 0.75;
    bars.push(v);
  }
  return bars;
}

/* ================================================================== */
/* Component                                                          */
/* ================================================================== */

export function Timeline({
  clips,
  duration,
  selectedClipId,
  onSelectClip,
  playhead,
  onPlayheadChange,
  onSplitAtPlayhead,
  onDeleteClip,
  disabled = false,
}: TimelineProps) {
  const [pxPerSec, setPxPerSec] = useState(DEFAULT_PXPS);
  const [draggingPlayhead, setDraggingPlayhead] = useState(false);
  const [containerW, setContainerW] = useState(0);

  const canvasRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  /* ---- derived geometry ---- */

  const maxClipEnd = clips.reduce((m, c) => Math.max(m, c.endSec), 0);
  const effectiveDuration = duration ?? Math.max(30, maxClipEnd + 10);
  const { laid, rows } = layoutClips(clips);
  const trackHeight = Math.max(
    ROW_HEIGHT,
    rows * ROW_HEIGHT + (rows - 1) * ROW_GAP,
  );
  const totalCanvasHeight = RULER_HEIGHT + trackHeight;

  const { major, minor } = getTickInterval(pxPerSec);
  const showMs = major < 1;

  /* ---- tick generation (index-based to avoid float drift) ---- */

  const majorTicks: number[] = [];
  for (let i = 0; i * major <= effectiveDuration + 0.0001; i++) {
    majorTicks.push(i * major);
  }
  const minorTicks: number[] = [];
  for (let i = 0; i * minor <= effectiveDuration + 0.0001; i++) {
    if (i % 5 === 0) continue;
    minorTicks.push(i * minor);
  }

  /* ---- measure container width so canvas always fills it ---- */
  // useEffect (not useLayoutEffect) + rAF deferral avoids nested state
  // updates during React's commit phase, which can cause removeChild
  // errors when the clip list is reconciled (e.g. after a split).

  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    let raf = 0;
    const measure = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const w = Math.round(el.clientWidth - HEADER_WIDTH);
        setContainerW((prev) => (prev === w ? prev : w));
      });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, []);

  const minCanvasWidth = Math.max(containerW, 320);
  const timelineWidth = Math.max(
    effectiveDuration * pxPerSec,
    minCanvasWidth,
  );

  /* ---- auto zoom-to-fit when container size or duration changes ---- */
  // React's "adjust state during render when a prop changes" pattern.
  // Calling setState during render is safe here: React re-renders
  // immediately without committing, and it keeps us out of effects
  // (avoids the react-hooks/set-state-in-effect lint rule and the
  // nested-update removeChild crashes that effects caused after split).
  const [autoZoomKey, setAutoZoomKey] = useState({ w: 0, d: 0 });
  if (
    autoZoomKey.w !== containerW ||
    autoZoomKey.d !== effectiveDuration
  ) {
    setAutoZoomKey({ w: containerW, d: effectiveDuration });
    if (containerW > 0) {
      const target = containerW / effectiveDuration;
      const clamped = Math.max(MIN_PXPS, Math.min(MAX_PXPS, target));
      setPxPerSec((prev) => (Math.abs(prev - clamped) < 0.5 ? prev : clamped));
    }
  }

  /* ---- pointer → time ---- */

  const timeFromClientX = useCallback(
    (clientX: number): number => {
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return 0;
      const x = clientX - rect.left;
      return Math.max(0, Math.min(effectiveDuration, x / pxPerSec));
    },
    [effectiveDuration, pxPerSec],
  );

  /* ---- playhead drag (window listeners survive leaving canvas) ---- */

  useEffect(() => {
    if (!draggingPlayhead) return;
    const onMove = (e: PointerEvent) => {
      onPlayheadChange(timeFromClientX(e.clientX));
    };
    const onUp = () => setDraggingPlayhead(false);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [draggingPlayhead, timeFromClientX, onPlayheadChange]);

  const startPlayheadDrag = useCallback(
    (clientX: number) => {
      if (disabled) return;
      onPlayheadChange(timeFromClientX(clientX));
      setDraggingPlayhead(true);
    },
    [disabled, onPlayheadChange, timeFromClientX],
  );

  /* ---- zoom to fit ---- */

  const zoomToFit = useCallback(() => {
    if (containerW <= 0) return;
    const target = containerW / effectiveDuration;
    setPxPerSec(Math.max(MIN_PXPS, Math.min(MAX_PXPS, target)));
  }, [containerW, effectiveDuration]);

  /* ---- keyboard: S = split, Delete/Backspace = delete ---- */

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (disabled) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (e.key === "s" || e.key === "S") {
        e.preventDefault();
        onSplitAtPlayhead();
      } else if (e.key === "Delete" || e.key === "Backspace") {
        if (selectedClipId) {
          e.preventDefault();
          onDeleteClip(selectedClipId);
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [disabled, selectedClipId, onSplitAtPlayhead, onDeleteClip]);

  /* ---- render helpers ---- */

  const playheadX = Math.min(playhead, effectiveDuration) * pxPerSec;
  const canSplit = clips.some(
    (c) => playhead > c.startSec + 0.001 && playhead < c.endSec - 0.001,
  );

  // Keep TC bubble from overflowing the right edge of the scroll area.
  const tcBubbleWidth = 86;
  const tcBubbleLeft = Math.max(
    4,
    Math.min(playheadX - tcBubbleWidth / 2, timelineWidth - tcBubbleWidth - 4),
  );

  return (
    <div className="timeline-wrap">
      {/* ===== Toolbar ===== */}
      <div className="timeline-toolbar">
        <div className="timeline-toolbar-left">
          <span className="timeline-badge">
            <Scissors size={11} /> PLAYHEAD
          </span>
          <span className="timeline-timecode mono">
            {formatTimeShort(playhead, true)}
          </span>
          {duration != null && (
            <span className="timeline-duration-label mono">
              / {formatTimeShort(duration, true)}
            </span>
          )}
          <span className="timeline-row-count">
            {rows} track{rows === 1 ? "" : "s"} · {clips.length} clip{clips.length === 1 ? "" : "s"}
          </span>
        </div>

        <div className="timeline-toolbar-right">
          <button
            className="btn btn-ghost tl-btn"
            onClick={onSplitAtPlayhead}
            disabled={disabled || !canSplit}
            title="Split clip at playhead (S)"
            type="button"
          >
            <Scissors size={14} /> Split
          </button>
          <button
            className="btn btn-danger-ghost tl-btn"
            onClick={() => selectedClipId && onDeleteClip(selectedClipId)}
            disabled={disabled || !selectedClipId}
            title="Delete selected clip (Del)"
            type="button"
          >
            <Trash2 size={14} /> Delete
          </button>

          <div className="tl-divider" aria-hidden="true" />

          <button
            className="btn-icon tl-zoom-btn"
            onClick={() => setPxPerSec((p) => Math.max(MIN_PXPS, Math.round(p / 1.4)))}
            disabled={disabled || pxPerSec <= MIN_PXPS}
            title="Zoom out"
            type="button"
            aria-label="Zoom out"
          >
            <ZoomOut size={15} />
          </button>
          <input
            type="range"
            className="tl-zoom-slider"
            min={MIN_PXPS}
            max={MAX_PXPS}
            value={pxPerSec}
            onChange={(e) => setPxPerSec(Number(e.target.value))}
            disabled={disabled}
            aria-label="Timeline zoom level"
          />
          <button
            className="btn-icon tl-zoom-btn"
            onClick={() => setPxPerSec((p) => Math.min(MAX_PXPS, Math.round(p * 1.4)))}
            disabled={disabled || pxPerSec >= MAX_PXPS}
            title="Zoom in"
            type="button"
            aria-label="Zoom in"
          >
            <ZoomIn size={15} />
          </button>
          <button
            className="btn-icon tl-zoom-btn"
            onClick={zoomToFit}
            disabled={disabled}
            title="Zoom to fit"
            type="button"
            aria-label="Zoom to fit"
          >
            <Maximize2 size={14} />
          </button>
        </div>
      </div>

      {/* ===== Body: fixed headers + scrollable canvas ===== */}
      <div className="timeline-body" ref={bodyRef}>
        {/* --- Left: fixed track-header column --- */}
        <div
          className="timeline-headers"
          style={{ width: HEADER_WIDTH }}
          aria-hidden="true"
        >
          {/* spacer that aligns with the ruler */}
          <div
            className="tl-header-ruler-spacer"
            style={{ height: RULER_HEIGHT }}
          >
            <span className="tl-header-ruler-label">TRACKS</span>
          </div>
          {/* per-row headers */}
          <div
            className="tl-headers-rows"
            style={{ height: trackHeight }}
          >
            {Array.from({ length: rows }).map((_, i) => {
              const c = CLIP_COLORS[i % CLIP_COLORS.length];
              return (
                <div
                  key={i}
                  className="tl-track-header"
                  style={{
                    height: ROW_HEIGHT,
                    marginBottom: i < rows - 1 ? ROW_GAP : 0,
                  }}
                >
                  <span
                    className="tl-track-dot"
                    style={{ background: c.solid, boxShadow: `0 0 8px ${c.glow}` }}
                  />
                  <span className="tl-track-label">T{i + 1}</span>
                </div>
              );
            })}
            {rows === 0 && (
              <div className="tl-track-header-empty">no tracks yet</div>
            )}
          </div>
        </div>

        {/* --- Right: scrollable timeline canvas --- */}
        <div className="timeline-scroll" ref={scrollRef}>
          <div
            className="timeline-canvas"
            ref={canvasRef}
            style={{
              width: `${timelineWidth}px`,
              height: `${totalCanvasHeight}px`,
            }}
          >
            {/* --- Ruler --- */}
            <div
              className="timeline-ruler"
              style={{ height: RULER_HEIGHT }}
              onPointerDown={(e) => {
                e.preventDefault();
                startPlayheadDrag(e.clientX);
              }}
            >
              {/* alternating shaded bands between major ticks */}
              {majorTicks.map((t, i) =>
                i % 2 === 1 ? (
                  <div
                    key={`band-${i}`}
                    className="tl-ruler-band"
                    style={{
                      left: majorTicks[i - 1] * pxPerSec,
                      width: (t - majorTicks[i - 1]) * pxPerSec,
                      height: RULER_HEIGHT,
                    }}
                  />
                ) : null,
              )}
              {minorTicks.map((t, i) => (
                <div
                  key={`mn-${i}`}
                  className="tl-tick tl-tick-minor"
                  style={{ left: t * pxPerSec }}
                />
              ))}
              {majorTicks.map((t, i) => (
                <div
                  key={`mj-${i}`}
                  className="tl-tick tl-tick-major"
                  style={{ left: t * pxPerSec }}
                >
                  <span className="tl-tick-label">
                    {formatTimeShort(t, showMs)}
                  </span>
                </div>
              ))}
            </div>

            {/* --- Track --- */}
            <div
              className="timeline-track"
              style={{ height: trackHeight }}
              onPointerDown={(e) => {
                if (e.target === e.currentTarget) {
                  e.preventDefault();
                  startPlayheadDrag(e.clientX);
                }
              }}
            >
              {/* vertical gridlines */}
              {majorTicks.map((t, i) => (
                <div
                  key={`gl-${i}`}
                  className="tl-gridline"
                  style={{ left: t * pxPerSec, height: trackHeight }}
                />
              ))}

              {/* row separators */}
              {Array.from({ length: rows }).map((_, i) =>
                i > 0 ? (
                  <div
                    key={`rs-${i}`}
                    className="tl-row-sep"
                    style={{ top: i * (ROW_HEIGHT + ROW_GAP) - ROW_GAP / 2 }}
                  />
                ) : null,
              )}

              {/* clip blocks */}
              {laid.map(({ clip, row, colorIndex }) => {
                const color = CLIP_COLORS[colorIndex];
                const left = clip.startSec * pxPerSec;
                const width = Math.max(
                  8,
                  (clip.endSec - clip.startSec) * pxPerSec,
                );
                const top = row * (ROW_HEIGHT + ROW_GAP);
                const selected = clip.id === selectedClipId;
                const barCount = Math.max(
                  4,
                  Math.min(48, Math.floor(width / 7)),
                );
                const bars = waveformBars(clip.id, barCount);
                return (
                  <div
                    key={clip.id}
                    className={`timeline-clip ${selected ? "selected" : ""}`}
                    style={{
                      left: `${left}px`,
                      width: `${width}px`,
                      top: `${top}px`,
                      height: `${ROW_HEIGHT}px`,
                      background: color.bg,
                      borderColor: selected ? "#ffffff" : color.edge,
                      boxShadow: selected
                        ? `0 0 0 2px #fff, 0 6px 18px rgba(0,0,0,0.5), 0 0 18px ${color.glow}`
                        : `0 4px 12px rgba(0,0,0,0.45), inset 0 1px 0 rgba(255,255,255,0.2)`,
                    }}
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      if (disabled) return;
                      onSelectClip(clip.id);
                    }}
                    title={`${clip.filename} · ${formatTimeShort(clip.startSec, true)} → ${formatTimeShort(clip.endSec, true)}`}
                  >
                    {/* top label bar */}
                    <div className="timeline-clip-labelbar">
                      <span className="timeline-clip-name">{clip.filename}</span>
                      <span className="timeline-clip-dur mono">
                        {formatTimeShort(clip.endSec - clip.startSec, true)}
                      </span>
                    </div>
                    {/* faux waveform body */}
                    <div className="timeline-clip-waveform">
                      {bars.map((v, i) => (
                        <span
                          key={i}
                          className="tl-wave-bar"
                          style={{
                            height: `${Math.round(v * 100)}%`,
                            background: color.edge,
                          }}
                        />
                      ))}
                    </div>
                    {/* trim handles */}
                    <div className="timeline-clip-handle left" aria-hidden="true" />
                    <div className="timeline-clip-handle right" aria-hidden="true" />
                  </div>
                );
              })}

              {clips.length === 0 && (
                <div className="timeline-empty">
                  Add clips above — they&apos;ll appear here on the timeline.
                </div>
              )}
            </div>

            {/* --- Playhead --- */}
            <div
              className="timeline-playhead"
              style={{ left: `${playheadX}px`, height: `${totalCanvasHeight}px` }}
              aria-hidden="true"
            >
              {/* TC bubble — also the drag handle */}
              <div
                className="timeline-playhead-tc mono"
                style={{ left: `${tcBubbleLeft - playheadX}px`, width: tcBubbleWidth }}
                onPointerDown={(e) => {
                  e.stopPropagation();
                  e.preventDefault();
                  startPlayheadDrag(e.clientX);
                }}
              >
                {formatTimeShort(playhead, true)}
              </div>
              {/* visual triangle cap below the bubble */}
              <div className="timeline-playhead-handle" />
              <div className="timeline-playhead-line" />
            </div>
          </div>
        </div>
      </div>

      {/* ===== Hint bar ===== */}
      <div className="timeline-hint">
        <kbd>S</kbd> split at playhead · <kbd>Del</kbd> delete selected ·
        click ruler / drag handle to scrub · zoom in for millisecond precision
      </div>
    </div>
  );
}
