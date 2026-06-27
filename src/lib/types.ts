/**
 * Shared types used across the editor UI and the timeline component.
 */

export interface Clip {
  /** Stable unique id (crypto.randomUUID when available). */
  id: string;
  /** Segment start in seconds (with sub-second precision). */
  startSec: number;
  /** Segment end in seconds (with sub-second precision). */
  endSec: number;
  /** Original raw string the user typed for the start — kept for round-trip editing. */
  startRaw: string;
  /** Original raw string the user typed for the end. */
  endRaw: string;
  /** Sanitized output filename (without extension). */
  filename: string;
}
