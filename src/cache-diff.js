// Sparse-cache snapshot diff.
//
// The client holds TWO sparse snapshots of the SAME resource — a "before" set
// and an "after" set of {start, dataBase64} fragments, using the exact
// fragment shape /assemble-response consumes — and asks: "which bytes changed
// between the two snapshots, byte for byte?"
//
// Each group is validated independently exactly as for /assemble-response
// (in-bounds, canonically padded standard base64, at most MAX_FRAGMENTS items)
// except that the 1 MiB decoded-input budget applies to BOTH groups COMBINED.
// Each group is then merged into one canonical sparse cache: overlapping
// fragments must agree byte-for-byte, and a disagreement inside either
// snapshot poisons the whole comparison (409 FRAGMENT_CONFLICT, naming the
// offending snapshot).
//
// Once both caches are coherent they are overlaid across the whole resource:
//   - a position covered by BOTH snapshots is "equal" or "changed" according
//     to the two bytes;
//   - a position missing from EITHER snapshot is "unknown" (no verdict).
// Equal/changed/unknown positions are reported as closed intervals sorted by
// offset, with adjacent intervals of the same kind merged, together with the
// byte count of each kind. The three counts always sum to `size`, so every
// resource byte is accounted for (all unknown when nothing was cached).
//
// Sums use BigInt internally so counts stay exact up to
// Number.MAX_SAFE_INTEGER; only the compared bytes are ever scanned (the
// overlap of the two caches is at most 1 MiB).

import {
  decodeBase64,
  buildCache,
  MAX_FRAGMENTS,
  MAX_CACHE_BYTES,
} from './assemble.js';

export { MAX_FRAGMENTS, MAX_CACHE_BYTES };

/**
 * Locate byte-level differences between two sparse snapshots.
 *
 * @returns a result object with `statusCode` 200 carrying `resource`,
 *          `ranges` (ascending, disjoint closed intervals tagged
 *          equal/changed/unknown, adjacent same-kind runs merged) and
 *          `counts` ({equalBytes, changedBytes, unknownBytes}, summing to
 *          size), a 400 result describing the first validation failure, or a
 *          409 result naming the snapshot whose own overlapping fragments
 *          disagree.
 */
export function diffSnapshots(options) {
  const { size, before, after } = options;

  if (!Number.isSafeInteger(size) || size < 0) {
    return fail(400, 'INVALID_SIZE', 'size must be a non-negative safe integer');
  }

  const decoded = decodeSnapshotFragments(size, before, after);
  if (decoded.error) return decoded.error;

  // An empty resource has no byte positions and therefore no intervals.
  if (size === 0) {
    return {
      statusCode: 200,
      resource: { size: 0 },
      ranges: [],
      counts: { equalBytes: 0, changedBytes: 0, unknownBytes: 0 },
    };
  }

  const beforeCache = buildCache(decoded.before);
  const afterCache = buildCache(decoded.after);

  // A snapshot that is not self-consistent cannot be compared at all; report
  // "before" first so repeated failures resolve deterministically.
  if (beforeCache.conflicts.length > 0) {
    return conflictResult('before', beforeCache.conflicts);
  }
  if (afterCache.conflicts.length > 0) {
    return conflictResult('after', afterCache.conflicts);
  }

  const { runs, totals } = compareCaches(size, beforeCache.intervals, afterCache.intervals);

  return {
    statusCode: 200,
    resource: { size },
    ranges: runs,
    counts: {
      equalBytes: Number(totals.equal),
      changedBytes: Number(totals.changed),
      unknownBytes: Number(totals.unknown),
    },
  };
}

/**
 * Validate and decode both fragment lists. Each group may carry at most
 * MAX_FRAGMENTS items, and the decoded bytes of BOTH groups combined may not
 * exceed MAX_CACHE_BYTES (1 MiB). Bounds and base64 rules are identical to
 * decodeFragments() in assemble.js; the error path names the group
 * (before/after) and index.
 */
function decodeSnapshotFragments(size, before, after) {
  const groups = [
    { name: 'before', fragments: before },
    { name: 'after', fragments: after },
  ];

  for (const group of groups) {
    if (!Array.isArray(group.fragments)) {
      return {
        error: fail(
          400,
          'INVALID_FRAGMENTS',
          `${group.name} must be an array of {start, dataBase64} objects`,
        ),
      };
    }
    if (group.fragments.length > MAX_FRAGMENTS) {
      return {
        error: fail(
          400,
          'TOO_MANY_FRAGMENTS',
          `${group.name} carries ${group.fragments.length} items; at most ${MAX_FRAGMENTS} are allowed`,
        ),
      };
    }
  }

  const decoded = { before: [], after: [] };
  let totalBytes = 0;
  for (const group of groups) {
    for (let i = 0; i < group.fragments.length; i += 1) {
      const fragment = group.fragments[i];
      const where = `${group.name}[${i}]`;
      if (fragment === null || typeof fragment !== 'object' || Array.isArray(fragment)) {
        return {
          error: fail(400, 'INVALID_FRAGMENT', `${where} must be an object with start and dataBase64`),
        };
      }
      const { start, dataBase64 } = fragment;
      if (!Number.isSafeInteger(start) || start < 0) {
        return {
          error: fail(400, 'INVALID_FRAGMENT', `${where}.start must be a non-negative safe integer`),
        };
      }
      const data = decodeBase64(dataBase64);
      if (data === null) {
        return {
          error: fail(
            400,
            'INVALID_FRAGMENT_BASE64',
            `${where}.dataBase64 must be a non-empty, canonically padded standard base64 string`,
          ),
        };
      }
      // Compared without ever summing past Number.MAX_SAFE_INTEGER.
      if (start >= size || data.length > size - start) {
        return {
          error: fail(
            400,
            'FRAGMENT_OUT_OF_BOUNDS',
            `${where} covers ${data.length} byte(s) from offset ${start}, ` +
              `which lies outside the ${size}-byte resource`,
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
          ),
        };
      }
      decoded[group.name].push({ start, end: start + data.length - 1, data });
    }
  }
  return decoded;
}

/**
 * Overlay the two merged, ascending and disjoint caches across [0, size-1].
 * Boundaries at every interval start and at every interval end + 1 split the
 * resource into atomic segments in which coverage (neither / before only /
 * after only / both) and the covering interval on each side are constant;
 * both-covered segments are scanned for maximal equal/changed runs. Runs that
 * meet across segment boundaries are merged when their kind is identical.
 */
function compareCaches(size, beforeIntervals, afterIntervals) {
  const boundaries = new Set([0, size]);
  for (const interval of beforeIntervals) {
    boundaries.add(interval.start);
    boundaries.add(interval.end + 1);
  }
  for (const interval of afterIntervals) {
    boundaries.add(interval.start);
    boundaries.add(interval.end + 1);
  }
  // Set iteration follows insertion order; sort explicitly for determinism.
  const cuts = [...boundaries].sort((a, b) => a - b);

  const runs = [];
  const totals = { equal: 0n, changed: 0n, unknown: 0n };
  let bi = 0;
  let ai = 0;

  for (let i = 0; i < cuts.length - 1; i += 1) {
    const segmentStart = cuts[i];
    const segmentEnd = cuts[i + 1] - 1; // inclusive
    const length = cuts[i + 1] - cuts[i];

    while (bi < beforeIntervals.length && beforeIntervals[bi].end < segmentStart) bi += 1;
    while (ai < afterIntervals.length && afterIntervals[ai].end < segmentStart) ai += 1;

    const beforeInterval =
      bi < beforeIntervals.length && beforeIntervals[bi].start <= segmentStart
        ? beforeIntervals[bi]
        : null;
    const afterInterval =
      ai < afterIntervals.length && afterIntervals[ai].start <= segmentStart
        ? afterIntervals[ai]
        : null;

    if (beforeInterval === null || afterInterval === null) {
      // Missing on at least one side: the verdict is unknown.
      pushRun(runs, segmentStart, segmentEnd, 'unknown');
      totals.unknown += BigInt(length);
      continue;
    }

    // Both sides cover the whole atomic segment; compare byte for byte and
    // group the outcome into maximal equal/changed runs.
    const beforeOffset = segmentStart - beforeInterval.start;
    const afterOffset = segmentStart - afterInterval.start;
    let pos = 0;
    while (pos < length) {
      const equal = beforeInterval.data[beforeOffset + pos] === afterInterval.data[afterOffset + pos];
      let end = pos + 1;
      while (
        end < length &&
        (beforeInterval.data[beforeOffset + end] === afterInterval.data[afterOffset + end]) === equal
      ) {
        end += 1;
      }
      const kind = equal ? 'equal' : 'changed';
      pushRun(runs, segmentStart + pos, segmentStart + end - 1, kind);
      totals[kind] += BigInt(end - pos);
      pos = end;
    }
  }

  return { runs, totals };
}

/**
 * Append [start, end] tagged `kind`, merging it into the previous run when
 * the two are adjacent and of the same kind.
 */
function pushRun(runs, start, end, kind) {
  const last = runs[runs.length - 1];
  if (last !== undefined && last.kind === kind && start === last.end + 1) {
    last.end = end;
  } else {
    runs.push({ start, end, kind });
  }
}

function conflictResult(snapshot, conflicts) {
  return {
    ...fail(
      409,
      'FRAGMENT_CONFLICT',
      `${snapshot} fragments carry different bytes in ${conflicts.length} ` +
        `interval${conflicts.length === 1 ? '' : 's'}`,
    ),
    snapshot,
    conflicts,
  };
}

function fail(statusCode, code, message) {
  const errors = { 400: 'Bad Request', 409: 'Conflict' };
  return {
    statusCode,
    code,
    error: errors[statusCode],
    message,
  };
}
