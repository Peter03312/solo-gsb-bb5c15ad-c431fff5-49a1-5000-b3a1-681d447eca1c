// Shared origin-fetch (request coalescing) planner.
//
// When several clients request overlapping/nearby byte ranges of the same
// resource in parallel, an origin fetch layer can collapse their needs into a
// smaller set of upstream Range requests. Given the resource size, every
// client's demanded closed intervals, a per-fetch byte ceiling
// (`maxFetchBytes`) and the largest gap that may be bridged (`maxGapBytes`),
// plan the shared fetches:
//
//   1. Merge every client's intervals (overlapping or adjacent) into one
//      global, deduplicated demand list.
//   2. Split each demand into chunks of at most maxFetchBytes.
//   3. Walk the chunks left to right and merge a chunk into the running fetch
//      only when the gap between them is at most maxGapBytes AND the merged
//      length stays within maxFetchBytes.
//
// The resulting closed intervals are ascending and pairwise disjoint. For each
// client the result states which bytes of every planned fetch belong to it.

export const MAX_CLIENTS = 1000;
export const MAX_RANGES_PER_CLIENT = 10000;
export const MAX_TOTAL_RANGES = 10000;
export const MAX_CLIENT_ID_LENGTH = 255;

/**
 * Plan the shared origin fetches.
 *
 * @returns a 200 result carrying the fetch list, per-client coverage and byte
 *          accounting, or a 400 result describing the first validation
 *          failure.
 */
export function planSharedFetch(options) {
  const { size, clients, maxFetchBytes, maxGapBytes } = options;

  if (!Number.isSafeInteger(size) || size < 0) {
    return fail('INVALID_SIZE', 'size must be a non-negative safe integer');
  }
  if (!Number.isSafeInteger(maxFetchBytes) || maxFetchBytes < 1) {
    return fail('INVALID_MAX_FETCH_BYTES', 'maxFetchBytes must be a positive safe integer');
  }
  if (!Number.isSafeInteger(maxGapBytes) || maxGapBytes < 0) {
    return fail('INVALID_MAX_GAP_BYTES', 'maxGapBytes must be a non-negative safe integer');
  }
  if (!Array.isArray(clients)) {
    return fail('INVALID_CLIENTS', 'clients must be an array of {clientId, ranges} entries');
  }
  if (clients.length > MAX_CLIENTS) {
    return fail(
      'TOO_MANY_CLIENTS',
      `clients carries ${clients.length} entries; at most ${MAX_CLIENTS} are allowed`,
    );
  }

  let totalRanges = 0;
  const seenIds = new Set();
  for (let i = 0; i < clients.length; i += 1) {
    const entry = clients[i];
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      return fail('INVALID_CLIENT', `clients[${i}] must be an object with clientId and ranges`);
    }

    const { clientId, ranges } = entry;
    if (typeof clientId !== 'string' || clientId.trim() === '') {
      return fail('INVALID_CLIENT_ID', `clients[${i}].clientId must be a non-empty string`);
    }
    if (clientId.length > MAX_CLIENT_ID_LENGTH) {
      return fail(
        'INVALID_CLIENT_ID',
        `clients[${i}].clientId exceeds the ${MAX_CLIENT_ID_LENGTH}-character limit`,
      );
    }
    if (seenIds.has(clientId)) {
      return fail('DUPLICATE_CLIENT_ID', `duplicate clientId ${JSON.stringify(clientId)}`);
    }
    seenIds.add(clientId);

    if (!Array.isArray(ranges)) {
      return fail('INVALID_RANGES', `clients[${i}].ranges must be an array of {start, end} intervals`);
    }
    if (ranges.length > MAX_RANGES_PER_CLIENT) {
      return fail(
        'TOO_MANY_RANGES',
        `clients[${i}].ranges carries ${ranges.length} intervals; at most ${MAX_RANGES_PER_CLIENT} are allowed`,
      );
    }
    totalRanges += ranges.length;
    if (totalRanges > MAX_TOTAL_RANGES) {
      return fail(
        'TOO_MANY_RANGES',
        `the requests carry more than ${MAX_TOTAL_RANGES} intervals in total`,
      );
    }

    for (let j = 0; j < ranges.length; j += 1) {
      const interval = ranges[j];
      if (interval === null || typeof interval !== 'object' || Array.isArray(interval)) {
        return fail('INVALID_RANGE', `clients[${i}].ranges[${j}] must be an object with start and end`);
      }
      const { start, end } = interval;
      if (!Number.isSafeInteger(start) || start < 0) {
        return fail(
          'INVALID_RANGE_BOUNDS',
          `clients[${i}].ranges[${j}].start must be a non-negative safe integer`,
        );
      }
      if (!Number.isSafeInteger(end) || end < 0) {
        return fail(
          'INVALID_RANGE_BOUNDS',
          `clients[${i}].ranges[${j}].end must be a non-negative safe integer`,
        );
      }
      if (start > end) {
        return fail(
          'INVALID_RANGE_ORDER',
          `clients[${i}].ranges[${j}] has start ${start} after end ${end}`,
        );
      }
      if (end >= size) {
        return fail(
          'RANGE_OUT_OF_BOUNDS',
          `clients[${i}].ranges[${j}] end ${end} lies outside the ${size}-byte resource`,
        );
      }
    }
  }

  // Step 1: global, deduplicated demand (overlapping/adjacent intervals merge).
  const allRanges = clients.flatMap((client) => client.ranges);
  const demands = mergeIntervals(allRanges);
  const demandsBytes = demands.reduce((sum, interval) => sum + (interval.end - interval.start + 1), 0);

  // Steps 2-3: split each demand at the byte ceiling, then greedily merge left
  // to right across gaps no larger than maxGapBytes while the ceiling holds.
  const mergedFetches = [];
  for (const demand of demands) {
    for (let start = demand.start; start <= demand.end; start += maxFetchBytes) {
      const end = Math.min(start + maxFetchBytes - 1, demand.end);
      const last = mergedFetches[mergedFetches.length - 1];
      if (last !== undefined) {
        const gap = start - last.end - 1;
        const mergedLength = end - last.start + 1;
        if (gap <= maxGapBytes && mergedLength <= maxFetchBytes) {
          last.end = end;
          continue;
        }
      }
      mergedFetches.push({ start, end });
    }
  }

  const fetches = mergedFetches.map((fetch, index) => ({
    index: index + 1,
    start: fetch.start,
    end: fetch.end,
    bytes: fetch.end - fetch.start + 1,
    rangeHeader: `bytes=${fetch.start}-${fetch.end}`,
  }));
  const fetchedBytes = fetches.reduce((sum, fetch) => sum + fetch.bytes, 0);

  // Per-client view: its own deduplicated demand and the slice(s) of every
  // fetch that satisfy it. All demanded bytes are covered by construction.
  const clientPlans = clients.map((client) => {
    const merged = mergeIntervals(client.ranges);
    const demandedBytes = merged.reduce((sum, interval) => sum + (interval.end - interval.start + 1), 0);

    const coverage = [];
    for (const fetch of fetches) {
      for (const interval of merged) {
        const start = Math.max(interval.start, fetch.start);
        const end = Math.min(interval.end, fetch.end);
        if (start <= end) {
          coverage.push({
            fetchIndex: fetch.index,
            start,
            end,
            bytes: end - start + 1,
          });
        }
      }
    }

    return {
      clientId: client.clientId,
      ranges: merged,
      demandedBytes,
      coveredBytes: coverage.reduce((sum, part) => sum + part.bytes, 0),
      coverage,
    };
  });

  return {
    statusCode: 200,
    resource: { size },
    params: { maxFetchBytes, maxGapBytes },
    demands,
    demandsBytes,
    fetchesCount: fetches.length,
    fetches,
    fetchedBytes,
    extraBytes: fetchedBytes - demandsBytes,
    clientsCount: clientPlans.length,
    clients: clientPlans,
  };
}

/**
 * Sort intervals by start offset and merge overlapping or adjacent ones
 * ([0-9] and [10-19] are adjacent: no byte sits between them).
 */
function mergeIntervals(intervals) {
  const sorted = intervals
    .map((interval) => ({ start: interval.start, end: interval.end }))
    .sort((a, b) => a.start - b.start || a.end - b.end);

  const merged = [];
  for (const interval of sorted) {
    const last = merged[merged.length - 1];
    if (last && interval.start <= last.end + 1) {
      if (interval.end > last.end) last.end = interval.end;
    } else {
      merged.push({ start: interval.start, end: interval.end });
    }
  }
  return merged;
}

function fail(code, message) {
  return {
    statusCode: 400,
    code,
    error: 'Bad Request',
    message,
  };
}
