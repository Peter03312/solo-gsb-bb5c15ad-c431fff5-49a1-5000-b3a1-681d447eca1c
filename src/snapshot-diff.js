// Sparse-cache snapshot diff.
//
// Two sparse cache snapshots of the SAME resource — the fragments present
// before and after an update — are compared byte by byte at absolute offsets.
// Each snapshot's fragments use the existing {start, dataBase64} shape
// (canonical standard base64, fully inside the resource bounds) and are merged
// within their own group first: overlapping fragments must carry identical
// bytes, otherwise that snapshot is self-inconsistent and no comparison is
// produced. The two groups together may decode to at most 1 MiB.
//
// Classification, per resource offset:
//   - "same"    — both snapshots hold the byte and it is identical;
//   - "changed" — both snapshots hold the byte and it differs;
//   - "unknown" — at least one snapshot is missing the offset.
// The result covers the WHOLE resource: same/changed runs come from the
// intersection of the two coverages, unknown runs from its complement. Runs
// are emitted as closed intervals sorted by start, merging any two adjacent
// runs of the same class. An empty resource yields empty intervals.
//
// Coverage geometry is interval based; only bytes actually held by both
// snapshots are ever touched (at most 1 MiB), so resources near
// Number.MAX_SAFE_INTEGER stay cheap. Length sums run through BigInt.

import {
  buildCache,
  decodeBase64,
  readRange,
  MAX_FRAGMENTS,
  MAX_CACHE_BYTES,
  MAX_FRAGMENT_BASE64_LENGTH,
} from './assemble.js';

export { MAX_FRAGMENTS, MAX_CACHE_BYTES, MAX_FRAGMENT_BASE64_LENGTH };

/**
 * Diff two sparse snapshots of one resource.
 *
 * @returns a result object with `statusCode` 200 carrying `size`,
 *          `intervals` (merged closed intervals tagged with
 *          `classification`: "same" | "changed" | "unknown") and the
 *          per-class byte counts `sameBytes` / `changedBytes` /
 *          `unknownBytes`, or a 400/409 result describing the failure.
 *          Snapshot-specific failures name the offending group in `snapshot`
 *          ("before" or "after"); 409 FRAGMENT_CONFLICT also lists the
 *          merged conflicting `intervals`.
 */
export function diffSnapshots(options) {
  const { size, before, after } = options;

  if (!Number.isSafeInteger(size) || size < 0) {
    return fail(400, 'INVALID_SIZE', 'size must be a non-negative safe integer');
  }

  // The two groups share a single 1 MiB decoded budget; decode before before
  // after so the group names report validation order.
  const beforeDecoded = decodeSnapshotFragments(before, size, 'before', 0);
  if (beforeDecoded.error) return beforeDecoded.error;

  const afterDecoded = decodeSnapshotFragments(
    after,
    size,
    'after',
    beforeDecoded.totalBytes,
  );
  if (afterDecoded.error) return afterDecoded.error;

  const beforeCache = buildCache(beforeDecoded.fragments);
  if (beforeCache.conflicts.length > 0) {
    return conflictFailure('before', beforeCache.conflicts);
  }
  const afterCache = buildCache(afterDecoded.fragments);
  if (afterCache.conflicts.length > 0) {
    return conflictFailure('after', afterCache.conflicts);
  }

  if (size === 0) {
    return {
      statusCode: 200,
      size: 0,
      intervals: [],
      sameBytes: 0,
      changedBytes: 0,
      unknownBytes: 0,
    };
  }

  // Runs present in both snapshots: compare the bytes at every overlap,
  // emitting "same"/"changed" runs as the intersection walk advances.
  const classified = [];
  const coverage = [];
  let i = 0;
  let j = 0;
  while (i < beforeCache.intervals.length && j < afterCache.intervals.length) {
    const left = beforeCache.intervals[i];
    const right = afterCache.intervals[j];

    if (left.end < right.start) {
      i += 1;
      continue;
    }
    if (right.end < left.start) {
      j += 1;
      continue;
    }

    const start = Math.max(left.start, right.start);
    const end = Math.min(left.end, right.end);
    coverage.push({ start, end });

    const leftBytes = readRange([left], start, end);
    const rightBytes = readRange([right], start, end);
    let pos = start;
    while (pos <= end) {
      const equal = leftBytes[pos - start] === rightBytes[pos - start];
      let runEnd = pos + 1;
      while (runEnd <= end) {
        const stillEqual = leftBytes[runEnd - start] === rightBytes[runEnd - start];
        if (stillEqual !== equal) break;
        runEnd += 1;
      }
      classified.push({
        start: pos,
        end: runEnd - 1,
        classification: equal ? 'same' : 'changed',
      });
      pos = runEnd;
    }

    if (left.end <= end) i += 1;
    if (right.end <= end) j += 1;
  }

  // Everything outside the both-present intersection is unknown.
  for (const interval of complementIntervals(coverage, size)) {
    classified.push({ ...interval, classification: 'unknown' });
  }

  const intervals = mergeClassified(classified);

  let sameBytes = 0n;
  let changedBytes = 0n;
  let unknownBytes = 0n;
  for (const interval of intervals) {
    const length = BigInt(interval.end - interval.start + 1);
    if (interval.classification === 'same') sameBytes += length;
    else if (interval.classification === 'changed') changedBytes += length;
    else unknownBytes += length;
  }

  return {
    statusCode: 200,
    size,
    intervals,
    sameBytes: Number(sameBytes),
    changedBytes: Number(changedBytes),
    unknownBytes: Number(unknownBytes),
  };
}

/**
 * Validate and decode one snapshot's fragments, identical rules to
 * assemble.decodeFragments (object shape, non-empty canonical base64,
 * in-bounds) but counting decoded bytes against the COMBINED two-group
 * budget seeded with `alreadyDecoded` bytes from the other group.
 */
function decodeSnapshotFragments(fragments, size, snapshot, alreadyDecoded) {
  if (!Array.isArray(fragments)) {
    return {
      error: fail(
        400,
        'INVALID_FRAGMENTS',
        `${snapshot}.fragments must be an array of {start, dataBase64} objects`,
        snapshot,
      ),
    };
  }
  if (fragments.length > MAX_FRAGMENTS) {
    return {
      error: fail(
        400,
        'TOO_MANY_FRAGMENTS',
        `${snapshot}.fragments carries ${fragments.length} items; at most ${MAX_FRAGMENTS} are allowed`,
        snapshot,
      ),
    };
  }

  const decoded = [];
  let totalBytes = alreadyDecoded;
  for (let index = 0; index < fragments.length; index += 1) {
    const fragment = fragments[index];
    const where = `${snapshot}.fragments[${index}]`;
    if (fragment === null || typeof fragment !== 'object' || Array.isArray(fragment)) {
      return {
        error: fail(400, 'INVALID_FRAGMENT', `${where} must be an object with start and dataBase64`, snapshot),
      };
    }
    const { start, dataBase64 } = fragment;
    if (!Number.isSafeInteger(start) || start < 0) {
      return {
        error: fail(400, 'INVALID_FRAGMENT', `${where}.start must be a non-negative safe integer`, snapshot),
      };
    }
    const data = decodeBase64(dataBase64);
    if (data === null) {
      return {
        error: fail(
          400,
          'INVALID_FRAGMENT_BASE64',
          `${where}.dataBase64 must be a non-empty, canonically padded standard base64 string`,
          snapshot,
        ),
      };
    }
    // Compared without ever summing past Number.MAX_SAFE_INTEGER.
    if (start >= size || data.length > size - start) {
      return {
        error: fail(
          400,
          'FRAGMENT_OUT_OF_BOUNDS',
          `${where} covers ${data.length} byte(s) from offset ${start}, which lies outside the ${size}-byte resource`,
          snapshot,
        ),
      };
    }
    totalBytes += data.length;
    if (totalBytes > MAX_CACHE_BYTES) {
      return {
        error: fail(
          400,
          'FRAGMENTS_TOO_LARGE',
          `before and after fragments decode to more than ${MAX_CACHE_BYTES} bytes (1 MiB) in total`,
          snapshot,
        ),
      };
    }
    decoded.push({ start, end: start + data.length - 1, data });
  }
  return { fragments: decoded, totalBytes };
}

function conflictFailure(snapshot, conflicts) {
  return {
    ...fail(
      409,
      'FRAGMENT_CONFLICT',
      `overlapping fragments in the ${snapshot} snapshot carry different bytes in ` +
        `${conflicts.length} interval${conflicts.length === 1 ? '' : 's'}`,
      snapshot,
    ),
    intervals: conflicts,
  };
}

/**
 * Complement of merged, ascending closed intervals inside
 * [0, size - 1]; result is merged and ascending.
 */
function complementIntervals(intervals, size) {
  const result = [];
  let cursor = 0;
  for (const interval of intervals) {
    if (interval.start > cursor) {
      result.push({ start: cursor, end: interval.start - 1 });
    }
    cursor = Math.max(cursor, interval.end + 1);
  }
  if (cursor < size) {
    result.push({ start: cursor, end: size - 1 });
  }
  return result;
}

/**
 * Sort tagged closed intervals by start and merge adjacent/overlapping
 * neighbours, but only when their classifications agree: a "same" run next
 * to a "changed" run (or next to "unknown") stays separate even when the
 * offsets are contiguous.
 */
function mergeClassified(intervals) {
  const sorted = intervals
    .slice()
    .sort((a, b) => a.start - b.start || a.end - b.end);

  const merged = [];
  for (const interval of sorted) {
    const last = merged[merged.length - 1];
    if (
      last &&
      interval.classification === last.classification &&
      interval.start <= last.end + 1
    ) {
      if (interval.end > last.end) last.end = interval.end;
    } else {
      merged.push({ ...interval });
    }
  }
  return merged;
}

function fail(statusCode, code, message, snapshot) {
  const errors = { 400: 'Bad Request', 409: 'Conflict' };
  const result = {
    statusCode,
    code,
    error: errors[statusCode],
    message,
  };
  if (snapshot !== undefined) result.snapshot = snapshot;
  return result;
}
