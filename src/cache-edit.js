// Sparse-cache edit planner.
//
// A resource of `size` bytes is edited: each edit is expressed in OLD
// coordinates and deletes `deleteBytes` bytes starting at `start`, then
// inserts `insertBytes` bytes at the same position. Bytes outside every
// edited span are unchanged; an edit with deleteBytes 0 is a pure insert
// (including insertion at the tail, start === size).
//
// The caller already holds a sparse cache of the OLD resource. This planner
// reports which cached bytes are still reusable after the edits:
//
//   - deleted bytes are never reusable; inserted bytes are always gaps in
//     the NEW resource that must be fetched;
//   - every other cached byte keeps its identity and moves by the net
//     (insert - delete) shift of the edits before it;
//   - cached intervals are deduplicated (overlapping inputs merged first);
//     each surviving run is split at the edit boundaries, producing
//     old->new closed-interval mappings;
//   - two consecutive mappings merge only when BOTH their old and new
//     ranges are adjacent (an edit at the boundary breaks at least one
//     side);
//   - the new resource's gaps are the complement of the mapped new ranges.
//
// All arithmetic is interval based — no per-byte expansion — and sums run
// through BigInt so inputs near Number.MAX_SAFE_INTEGER cannot lose
// precision or overflow the safe-integer range.

export const MAX_CACHED_INTERVALS = 1000;
export const MAX_EDITS = 1000;

/**
 * Plan sparse-cache reuse after a sequence of edits.
 *
 * @returns a result object with `statusCode` 200 carrying `oldSize`,
 *          `newSize`, `mappings` (merged old->new closed intervals),
 *          `reusedBytes`, `gaps` (merged new-resource closed intervals)
 *          and `gapBytes`, or a 400 result describing the first
 *          validation failure.
 */
export function planCacheEdits(options) {
  const { size, cached, edits } = options;

  if (!Number.isSafeInteger(size) || size < 0) {
    return fail('INVALID_SIZE', 'size must be a non-negative safe integer');
  }

  const cachedError = validateCached(cached, size);
  if (cachedError) return cachedError;

  const parsedEdits = [];
  const editsError = validateEdits(edits, size, parsedEdits);
  if (editsError) return editsError;

  // Edits are unordered on the wire; sort by start before any interaction
  // between edits is examined.
  parsedEdits.sort((a, b) => a.start - b.start);

  const orderingError = validateEditOrdering(parsedEdits);
  if (orderingError) return orderingError;

  let newSizeBig = BigInt(size);
  for (const edit of parsedEdits) {
    newSizeBig += BigInt(edit.insertBytes) - BigInt(edit.deleteBytes);
  }
  if (newSizeBig > BigInt(Number.MAX_SAFE_INTEGER)) {
    return fail(
      'NEW_SIZE_OVERFLOW',
      `the edits grow the resource beyond Number.MAX_SAFE_INTEGER (${Number.MAX_SAFE_INTEGER}) bytes`,
    );
  }
  const newSize = Number(newSizeBig);

  // Overlapping cache inputs describe the same bytes and are merged once;
  // merely ADJACENT inputs are kept apart so the mapping merge pass can
  // decide whether the boundary survived the edits.
  const cache = unionOverlappingIntervals(cached);

  const pieces = buildMappingPieces(cache, parsedEdits);
  const mappings = mergeAdjacentMappings(pieces);

  const gaps = complementIntervals(mappings, newSize);

  const reusedBytes = mappings.reduce(
    (sum, mapping) => sum + (mapping.oldEnd - mapping.oldStart + 1),
    0,
  );
  const gapBytes = gaps.reduce((sum, gap) => sum + (gap.end - gap.start + 1), 0);

  return {
    statusCode: 200,
    oldSize: size,
    newSize,
    mappings,
    reusedBytes,
    gaps,
    gapBytes,
  };
}

function validateCached(cached, size) {
  if (!Array.isArray(cached)) {
    return fail('INVALID_CACHED', 'cached must be an array of {start, end} intervals');
  }
  if (cached.length > MAX_CACHED_INTERVALS) {
    return fail(
      'TOO_MANY_CACHED',
      `cached carries ${cached.length} intervals; at most ${MAX_CACHED_INTERVALS} are allowed`,
    );
  }
  for (let i = 0; i < cached.length; i += 1) {
    const interval = cached[i];
    if (interval === null || typeof interval !== 'object' || Array.isArray(interval)) {
      return fail('INVALID_CACHED_RANGE', `cached[${i}] must be an object with start and end`);
    }
    const { start, end } = interval;
    if (!Number.isSafeInteger(start) || start < 0) {
      return fail('INVALID_CACHED_RANGE', `cached[${i}].start must be a non-negative safe integer`);
    }
    if (!Number.isSafeInteger(end) || end < 0) {
      return fail('INVALID_CACHED_RANGE', `cached[${i}].end must be a non-negative safe integer`);
    }
    if (start > end) {
      return fail('INVALID_CACHED_RANGE', `cached[${i}] has start ${start} after end ${end}`);
    }
    if (end >= size) {
      return fail(
        'CACHED_RANGE_OUT_OF_BOUNDS',
        `cached[${i}] end ${end} lies outside the ${size}-byte resource`,
      );
    }
  }
  return null;
}

function validateEdits(edits, size, parsedEdits) {
  if (!Array.isArray(edits)) {
    return fail(
      'INVALID_EDITS',
      'edits must be an array of {start, deleteBytes, insertBytes} objects',
    );
  }
  if (edits.length > MAX_EDITS) {
    return fail('TOO_MANY_EDITS', `edits carries ${edits.length} items; at most ${MAX_EDITS} are allowed`);
  }
  for (let i = 0; i < edits.length; i += 1) {
    const edit = edits[i];
    if (edit === null || typeof edit !== 'object' || Array.isArray(edit)) {
      return fail('INVALID_EDIT', `edits[${i}] must be an object with start, deleteBytes and insertBytes`);
    }
    const { start, deleteBytes, insertBytes } = edit;
    if (!Number.isSafeInteger(start) || start < 0) {
      return fail('INVALID_EDIT', `edits[${i}].start must be a non-negative safe integer`);
    }
    if (!Number.isSafeInteger(deleteBytes) || deleteBytes < 0) {
      return fail('INVALID_EDIT', `edits[${i}].deleteBytes must be a non-negative safe integer`);
    }
    if (!Number.isSafeInteger(insertBytes) || insertBytes < 0) {
      return fail('INVALID_EDIT', `edits[${i}].insertBytes must be a non-negative safe integer`);
    }
    if (start > size) {
      return fail(
        'EDIT_OUT_OF_BOUNDS',
        `edits[${i}].start ${start} lies outside the ${size}-byte resource`,
      );
    }
    // start + deleteBytes may reach size (deleting through the last byte);
    // BigInt guards the addition itself.
    const endExclusive = BigInt(start) + BigInt(deleteBytes);
    if (endExclusive > BigInt(size)) {
      return fail(
        'EDIT_RANGE_OUT_OF_BOUNDS',
        `edits[${i}] deletes through offset ${Number(endExclusive) - 1}, past the ${size}-byte resource end`,
      );
    }
    if (deleteBytes === 0 && insertBytes === 0) {
      return fail('EMPTY_EDIT', `edits[${i}] neither deletes nor inserts any bytes`);
    }
    parsedEdits.push({
      start,
      deleteBytes,
      insertBytes,
      endExclusive: Number(endExclusive),
      shift: BigInt(insertBytes) - BigInt(deleteBytes),
    });
  }
  return null;
}

/**
 * Sorted edits may not share a start and may not overlap; touching edits
 * (the next start equals the previous deleted span's exclusive end) are
 * allowed.
 */
function validateEditOrdering(edits) {
  for (let i = 1; i < edits.length; i += 1) {
    const previous = edits[i - 1];
    const current = edits[i];
    if (current.start === previous.start) {
      return fail(
        'DUPLICATE_EDIT_START',
        `multiple edits start at offset ${current.start}`,
      );
    }
    if (current.start < previous.endExclusive) {
      return fail(
        'EDITS_OVERLAP',
        `edit at ${current.start} falls inside the delete span of the edit at ${previous.start} ` +
          `([${previous.start}, ${previous.endExclusive - 1}])`,
      );
    }
  }
  return null;
}

/**
 * Sort closed intervals by start and merge strictly OVERLAPPING ones.
 * Adjacent intervals ([0,9] and [10,19]) stay separate: they share no
 * bytes and their boundary may matter once edits are applied.
 */
function unionOverlappingIntervals(intervals) {
  const sorted = intervals
    .map((interval) => ({ start: interval.start, end: interval.end }))
    .sort((a, b) => a.start - b.start || a.end - b.end);

  const merged = [];
  for (const interval of sorted) {
    const last = merged[merged.length - 1];
    if (last && interval.start <= last.end) {
      if (interval.end > last.end) last.end = interval.end;
    } else {
      merged.push({ start: interval.start, end: interval.end });
    }
  }
  return merged;
}

/**
 * Split each deduplicated cached interval at the edit boundaries and map
 * the surviving closed pieces into new coordinates.
 *
 * A surviving old offset x moves by the net shift of every edit whose
 * deleted span ends at or before x (a pure insert at x counts as "before
 * x": its exclusive end equals its start). Deleted byte ranges are
 * skipped outright, and a pure insert splits the run without consuming
 * old bytes.
 */
function buildMappingPieces(cache, edits) {
  const pieces = [];

  // Prefix net shifts: prefixShift[t] is the total shift of the first t
  // edits. A surviving old offset x moves by prefixShift[t] where t is the
  // number of edits whose exclusive end is <= x (a pure insert at x has
  // endExclusive === x, so byte x moves past the inserted bytes).
  const prefixShift = [0n];
  for (const edit of edits) prefixShift.push(prefixShift.at(-1) + edit.shift);

  const emit = (oldStart, oldEnd, pieceShift) => {
    if (oldStart > oldEnd) return;
    const newStart = Number(BigInt(oldStart) + pieceShift);
    const newEnd = Number(BigInt(oldEnd) + pieceShift);
    pieces.push({ oldStart, oldEnd, newStart, newEnd });
  };

  for (const interval of cache) {
    // First edit not fully before the interval start.
    let t = lowerBoundEndExclusive(edits, interval.start);
    let cursor = interval.start;

    while (cursor <= interval.end) {
      // Touching edits (or deletions already jumped over) fold in here.
      while (t < edits.length && edits[t].endExclusive <= cursor) t += 1;

      const edit = edits[t];
      if (edit === undefined || edit.start > interval.end) {
        emit(cursor, interval.end, prefixShift[t]);
        break;
      }

      // Surviving run up to this edit; empty when the interval starts
      // inside the edit's deleted span (edit.start < cursor).
      if (edit.start > cursor) {
        emit(cursor, edit.start - 1, prefixShift[t]);
        cursor = edit.start;
      }

      if (edit.deleteBytes > 0) {
        // Deleted bytes are not reusable; jump the surviving cursor past
        // them (the jump may leave this interval entirely).
        cursor = edit.endExclusive;
      }
      t += 1;
    }
  }

  return pieces;
}

/**
 * Index of the first edit whose exclusive end is strictly greater than
 * `offset`; equivalently, the count of edits ending at or before it.
 */
function lowerBoundEndExclusive(edits, offset) {
  let lo = 0;
  let hi = edits.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (edits[mid].endExclusive <= offset) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Merge consecutive pieces only when both coordinate systems agree the
 * boundary carries no edit: the old ranges must be adjacent AND the new
 * ranges must be adjacent. An insert at the boundary opens a new-coordinate
 * gap; a delete removes the old adjacency.
 */
function mergeAdjacentMappings(pieces) {
  const mappings = [];
  for (const piece of pieces) {
    const last = mappings[mappings.length - 1];
    if (
      last &&
      piece.oldStart === last.oldEnd + 1 &&
      piece.newStart === last.newEnd + 1
    ) {
      last.oldEnd = piece.oldEnd;
      last.newEnd = piece.newEnd;
    } else {
      mappings.push({ ...piece });
    }
  }
  return mappings;
}

/**
 * Complement of the mapped new ranges inside [0, size - 1]. The mapped
 * ranges are disjoint and ascending, so the gaps come out merged and
 * ascending without a separate pass.
 */
function complementIntervals(mappings, size) {
  const gaps = [];
  let cursor = 0;
  for (const mapping of mappings) {
    if (mapping.newStart > cursor) {
      gaps.push({ start: cursor, end: mapping.newStart - 1 });
    }
    cursor = mapping.newEnd + 1;
  }
  if (cursor < size) {
    gaps.push({ start: cursor, end: size - 1 });
  }
  return gaps;
}

function fail(code, message) {
  return {
    statusCode: 400,
    code,
    error: 'Bad Request',
    message,
  };
}
