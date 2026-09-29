import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';

const app = buildApp();
const url = '/cache-edit-plan';

function editPlan(payload) {
  return app.inject({
    method: 'POST',
    url,
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify(payload),
  });
}

test('deletion shifts later cached intervals and inserted bytes are gaps', async () => {
  // Old resource 100 bytes; edit at 10 deletes [10,19] and inserts 5 bytes,
  // net shift -5 for everything after offset 20.
  const res = await editPlan({
    size: 100,
    cached: [
      { start: 0, end: 9 },
      { start: 20, end: 29 },
      { start: 50, end: 79 },
    ],
    edits: [{ start: 10, deleteBytes: 10, insertBytes: 5 }],
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.oldSize, 100);
  assert.equal(body.newSize, 95);
  assert.deepEqual(body.mappings, [
    { oldStart: 0, oldEnd: 9, newStart: 0, newEnd: 9 },
    { oldStart: 20, oldEnd: 29, newStart: 15, newEnd: 24 },
    { oldStart: 50, oldEnd: 79, newStart: 45, newEnd: 74 },
  ]);
  assert.equal(body.reusedBytes, 50);
  assert.deepEqual(body.gaps, [
    { start: 10, end: 14 },
    { start: 25, end: 44 },
    { start: 75, end: 94 },
  ]);
  assert.equal(body.gapBytes, 45);
  assert.equal(body.reusedBytes + body.gapBytes, body.newSize);
});

test('a pure insert splits a cached interval and never merges', async () => {
  const res = await editPlan({
    size: 100,
    cached: [{ start: 0, end: 99 }],
    edits: [{ start: 50, deleteBytes: 0, insertBytes: 10 }],
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.newSize, 110);
  assert.deepEqual(body.mappings, [
    { oldStart: 0, oldEnd: 49, newStart: 0, newEnd: 49 },
    { oldStart: 50, oldEnd: 99, newStart: 60, newEnd: 109 },
  ]);
  // Old ranges are adjacent but the new ranges are not (the insert sits
  // between them), so the mappings must not merge.
  assert.deepEqual(body.gaps, [{ start: 50, end: 59 }]);
  assert.equal(body.gapBytes, 10);
});

test('insertion at the tail is allowed', async () => {
  const res = await editPlan({
    size: 100,
    cached: [{ start: 90, end: 99 }],
    edits: [{ start: 100, deleteBytes: 0, insertBytes: 3 }],
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.newSize, 103);
  assert.deepEqual(body.mappings, [
    { oldStart: 90, oldEnd: 99, newStart: 90, newEnd: 99 },
  ]);
  assert.deepEqual(body.gaps, [
    { start: 0, end: 89 },
    { start: 100, end: 102 },
  ]);
});

test('an interval fully covered by a deletion produces no mapping', async () => {
  const res = await editPlan({
    size: 100,
    cached: [
      { start: 20, end: 39 },
      { start: 50, end: 59 },
    ],
    edits: [{ start: 20, deleteBytes: 20, insertBytes: 0 }],
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.newSize, 80);
  assert.deepEqual(body.mappings, [
    { oldStart: 50, oldEnd: 59, newStart: 30, newEnd: 39 },
  ]);
  assert.equal(body.reusedBytes, 10);
  assert.deepEqual(body.gaps, [
    { start: 0, end: 29 },
    { start: 40, end: 79 },
  ]);
  assert.equal(body.gapBytes, 70);
});

test('a deletion through the middle of a cached interval splits both sides', async () => {
  const res = await editPlan({
    size: 100,
    cached: [{ start: 10, end: 40 }],
    edits: [{ start: 20, deleteBytes: 5, insertBytes: 0 }],
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.newSize, 95);
  assert.deepEqual(body.mappings, [
    { oldStart: 10, oldEnd: 19, newStart: 10, newEnd: 19 },
    { oldStart: 25, oldEnd: 40, newStart: 20, newEnd: 35 },
  ]);
  assert.deepEqual(body.gaps, [
    { start: 0, end: 9 },
    { start: 36, end: 94 },
  ]);
});

test('same-length replacement leaves inserted bytes as a gap and does not merge', async () => {
  const res = await editPlan({
    size: 100,
    cached: [{ start: 10, end: 30 }],
    edits: [{ start: 20, deleteBytes: 5, insertBytes: 5 }],
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.newSize, 100);
  assert.deepEqual(body.mappings, [
    { oldStart: 10, oldEnd: 19, newStart: 10, newEnd: 19 },
    { oldStart: 25, oldEnd: 30, newStart: 25, newEnd: 30 },
  ]);
  assert.deepEqual(body.gaps, [
    { start: 0, end: 9 },
    { start: 20, end: 24 },
    { start: 31, end: 99 },
  ]);
});

test('adjacent cached inputs merge only when old and new ranges stay adjacent', async () => {
  // The edit sits beyond the [0,9]/[10,19] boundary, which survives intact;
  // those two pieces are adjacent on both axes and merge. The [30,39]
  // interval is separated by uncached bytes and stays its own mapping.
  const res = await editPlan({
    size: 100,
    cached: [
      { start: 0, end: 9 },
      { start: 10, end: 19 },
      { start: 30, end: 39 },
    ],
    edits: [{ start: 50, deleteBytes: 0, insertBytes: 5 }],
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.newSize, 105);
  assert.deepEqual(body.mappings, [
    { oldStart: 0, oldEnd: 19, newStart: 0, newEnd: 19 },
    { oldStart: 30, oldEnd: 39, newStart: 30, newEnd: 39 },
  ]);
  assert.deepEqual(body.gaps, [
    { start: 20, end: 29 },
    { start: 40, end: 104 },
  ]);
  assert.equal(body.reusedBytes + body.gapBytes, body.newSize);
});

test('an edit at an adjacent-cache boundary breaks the merge', async () => {
  // [0,9] and [10,19] touch at 10; deleting old byte 10 removes the old
  // adjacency even though new coordinates line up again.
  const res = await editPlan({
    size: 100,
    cached: [
      { start: 0, end: 9 },
      { start: 10, end: 19 },
    ],
    edits: [{ start: 10, deleteBytes: 1, insertBytes: 0 }],
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.newSize, 99);
  assert.deepEqual(body.mappings, [
    { oldStart: 0, oldEnd: 9, newStart: 0, newEnd: 9 },
    { oldStart: 11, oldEnd: 19, newStart: 10, newEnd: 18 },
  ]);
});

test('overlapping cache intervals are deduplicated', async () => {
  // The overlap [20,30] must be counted once: 50 reused bytes, not 80.
  const res = await editPlan({
    size: 100,
    cached: [
      { start: 0, end: 30 },
      { start: 20, end: 49 },
    ],
    edits: [],
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.deepEqual(body.mappings, [
    { oldStart: 0, oldEnd: 49, newStart: 0, newEnd: 49 },
  ]);
  assert.equal(body.reusedBytes, 50);
  assert.deepEqual(body.gaps, [{ start: 50, end: 99 }]);
});

test('exact duplicate cache intervals are deduplicated', async () => {
  const res = await editPlan({
    size: 20,
    cached: [
      { start: 0, end: 9 },
      { start: 0, end: 9 },
    ],
    edits: [],
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json().mappings, [
    { oldStart: 0, oldEnd: 9, newStart: 0, newEnd: 9 },
  ]);
});

test('edits may arrive out of order and are applied by ascending start', async () => {
  // Edit at 50 (insert 10) is supplied before the edit at 10 (delete 10,
  // insert 2). All coordinates are old coordinates.
  const res = await editPlan({
    size: 100,
    cached: [{ start: 0, end: 99 }],
    edits: [
      { start: 50, deleteBytes: 0, insertBytes: 10 },
      { start: 10, deleteBytes: 10, insertBytes: 2 },
    ],
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.newSize, 102);
  assert.deepEqual(body.mappings, [
    { oldStart: 0, oldEnd: 9, newStart: 0, newEnd: 9 },
    { oldStart: 20, oldEnd: 49, newStart: 12, newEnd: 41 },
    { oldStart: 50, oldEnd: 99, newStart: 52, newEnd: 101 },
  ]);
  assert.deepEqual(body.gaps, [
    { start: 10, end: 11 },
    { start: 42, end: 51 },
  ]);
  assert.equal(body.reusedBytes + body.gapBytes, body.newSize);
});

test('touching edits are allowed and combine their shifts', async () => {
  // Delete [10,14] and [15,19]: the second start equals the first delete
  // span's exclusive end.
  const res = await editPlan({
    size: 100,
    cached: [{ start: 0, end: 29 }],
    edits: [
      { start: 10, deleteBytes: 5, insertBytes: 0 },
      { start: 15, deleteBytes: 5, insertBytes: 0 },
    ],
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.newSize, 90);
  assert.deepEqual(body.mappings, [
    { oldStart: 0, oldEnd: 9, newStart: 0, newEnd: 9 },
    { oldStart: 20, oldEnd: 29, newStart: 10, newEnd: 19 },
  ]);
  assert.deepEqual(body.gaps, [{ start: 20, end: 89 }]);
});

test('gaps are returned merged and ascending when no byte is cached', async () => {
  // Two inserts inside an otherwise uncached resource still leave one
  // contiguous gap spanning the whole new resource.
  const res = await editPlan({
    size: 100,
    cached: [],
    edits: [
      { start: 10, deleteBytes: 0, insertBytes: 3 },
      { start: 20, deleteBytes: 0, insertBytes: 3 },
    ],
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.newSize, 106);
  assert.deepEqual(body.mappings, []);
  assert.deepEqual(body.gaps, [{ start: 0, end: 105 }]);
  assert.equal(body.gapBytes, 106);
});

test('deleting every byte shrinks the resource to zero', async () => {
  const res = await editPlan({
    size: 10,
    cached: [{ start: 0, end: 9 }],
    edits: [{ start: 0, deleteBytes: 10, insertBytes: 0 }],
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.newSize, 0);
  assert.deepEqual(body.mappings, []);
  assert.deepEqual(body.gaps, []);
  assert.equal(body.reusedBytes, 0);
  assert.equal(body.gapBytes, 0);
});

test('size 0 permits only a tail insertion and requires an empty cache', async () => {
  const empty = await editPlan({ size: 0, cached: [], edits: [] });
  assert.equal(empty.statusCode, 200);
  const emptyBody = empty.json();
  assert.equal(emptyBody.newSize, 0);
  assert.deepEqual(emptyBody.mappings, []);
  assert.deepEqual(emptyBody.gaps, []);

  const inserted = await editPlan({
    size: 0,
    cached: [],
    edits: [{ start: 0, deleteBytes: 0, insertBytes: 5 }],
  });
  assert.equal(inserted.statusCode, 200);
  const insertedBody = inserted.json();
  assert.equal(insertedBody.newSize, 5);
  assert.deepEqual(insertedBody.gaps, [{ start: 0, end: 4 }]);

  const nonEmptyCache = await editPlan({
    size: 0,
    cached: [{ start: 0, end: 0 }],
    edits: [],
  });
  assert.equal(nonEmptyCache.statusCode, 400);
  assert.equal(nonEmptyCache.json().code, 'CACHED_RANGE_OUT_OF_BOUNDS');
});

test('large offsets keep safe-integer precision via BigInt arithmetic', async () => {
  const size = Number.MAX_SAFE_INTEGER;
  const res = await editPlan({
    size,
    cached: [{ start: size - 5, end: size - 1 }],
    edits: [{ start: size - 2, deleteBytes: 2, insertBytes: 0 }],
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.newSize, size - 2);
  assert.deepEqual(body.mappings, [
    { oldStart: size - 5, oldEnd: size - 3, newStart: size - 5, newEnd: size - 3 },
  ]);
  assert.equal(body.reusedBytes, 3);
});

test('non-integer or negative size is rejected', async () => {
  for (const size of [-1, 1.5, '1000', Number.MAX_SAFE_INTEGER + 1, null]) {
    const res = await editPlan({ size, cached: [], edits: [] });
    assert.equal(res.statusCode, 400, `expected 400 for size=${size}`);
  }
});

test('cached must be an array of interval objects', async () => {
  for (const cached of [null, {}, '0-9', [null], [1], [{ start: 0 }], [{ start: 0, end: 9, extra: 1 }]]) {
    const res = await editPlan({ size: 100, cached, edits: [] });
    assert.equal(res.statusCode, 400, `expected 400 for cached=${JSON.stringify(cached)}`);
  }
});

test('cached interval with start after end is rejected', async () => {
  const res = await editPlan({
    size: 100,
    cached: [{ start: 50, end: 10 }],
    edits: [],
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().code, 'INVALID_CACHED_RANGE');
});

test('cached interval reaching past the resource end is rejected', async () => {
  const res = await editPlan({
    size: 100,
    cached: [{ start: 90, end: 100 }],
    edits: [],
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().code, 'CACHED_RANGE_OUT_OF_BOUNDS');
});

test('cached is limited to 1000 intervals', async () => {
  const cached = Array.from({ length: 1001 }, (_, i) => ({ start: i, end: i }));
  const res = await editPlan({ size: 10000, cached, edits: [] });
  assert.equal(res.statusCode, 400);
});

test('edits must be an array of edit objects with safe non-negative integers', async () => {
  for (const edits of [
    null,
    {},
    'x',
    [null],
    [1],
    [{ start: 0 }],
    [{ start: 0, deleteBytes: 1 }],
    [{ start: 0, deleteBytes: 1, insertBytes: 0, extra: 1 }],
    [{ start: -1, deleteBytes: 1, insertBytes: 0 }],
    [{ start: 0, deleteBytes: -1, insertBytes: 0 }],
    [{ start: 0, deleteBytes: 0, insertBytes: -1 }],
    [{ start: 1.5, deleteBytes: 1, insertBytes: 0 }],
    [{ start: '0', deleteBytes: 1, insertBytes: 0 }],
  ]) {
    const res = await editPlan({ size: 100, cached: [], edits });
    assert.equal(res.statusCode, 400, `expected 400 for edits=${JSON.stringify(edits)}`);
  }
});

test('an edit starting past the resource end is rejected', async () => {
  const res = await editPlan({
    size: 100,
    cached: [],
    edits: [{ start: 101, deleteBytes: 0, insertBytes: 1 }],
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().code, 'EDIT_OUT_OF_BOUNDS');
});

test('an edit deleting past the resource end is rejected', async () => {
  const res = await editPlan({
    size: 100,
    cached: [],
    edits: [{ start: 95, deleteBytes: 6, insertBytes: 0 }],
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().code, 'EDIT_RANGE_OUT_OF_BOUNDS');
});

test('a double-zero edit is rejected', async () => {
  const res = await editPlan({
    size: 100,
    cached: [],
    edits: [{ start: 10, deleteBytes: 0, insertBytes: 0 }],
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().code, 'EMPTY_EDIT');
});

test('two edits with the same start are rejected', async () => {
  const res = await editPlan({
    size: 100,
    cached: [],
    edits: [
      { start: 10, deleteBytes: 1, insertBytes: 0 },
      { start: 10, deleteBytes: 0, insertBytes: 2 },
    ],
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().code, 'DUPLICATE_EDIT_START');
});

test('a later edit starting inside a previous delete span is rejected', async () => {
  const res = await editPlan({
    size: 100,
    cached: [],
    edits: [
      { start: 10, deleteBytes: 10, insertBytes: 0 },
      { start: 19, deleteBytes: 0, insertBytes: 1 },
    ],
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().code, 'EDITS_OVERLAP');
});

test('edits are limited to 1000 items', async () => {
  const edits = Array.from({ length: 1001 }, (_, i) => ({
    start: i * 2,
    deleteBytes: 0,
    insertBytes: 1,
  }));
  const res = await editPlan({ size: 10000, cached: [], edits });
  assert.equal(res.statusCode, 400);
});

test('a new size above Number.MAX_SAFE_INTEGER is rejected', async () => {
  const res = await editPlan({
    size: Number.MAX_SAFE_INTEGER,
    cached: [],
    edits: [{ start: Number.MAX_SAFE_INTEGER, deleteBytes: 0, insertBytes: 1 }],
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().code, 'NEW_SIZE_OVERFLOW');
});

test('missing required fields are rejected by schema validation', async () => {
  for (const payload of [
    {},
    { size: 100 },
    { size: 100, cached: [] },
    { cached: [], edits: [] },
  ]) {
    const res = await editPlan(payload);
    assert.equal(res.statusCode, 400, `expected 400 for ${JSON.stringify(payload)}`);
  }
});

test('extra fields are rejected by schema validation', async () => {
  const res = await editPlan({
    size: 100,
    cached: [],
    edits: [],
    extra: 1,
  });
  assert.equal(res.statusCode, 400);
});

test('error responses carry the shared error shape', async () => {
  const res = await editPlan({
    size: 100,
    cached: [],
    edits: [{ start: 10, deleteBytes: 0, insertBytes: 0 }],
  });
  assert.equal(res.statusCode, 400);
  const body = res.json();
  assert.equal(body.statusCode, 400);
  assert.equal(body.error, 'Bad Request');
  assert.equal(typeof body.code, 'string');
  assert.equal(typeof body.message, 'string');
});

test('existing endpoints are unaffected', async () => {
  const health = await app.inject({ method: 'GET', url: '/healthz' });
  assert.equal(health.statusCode, 200);

  const plan = await app.inject({
    method: 'POST',
    url: '/plan',
    headers: { Range: 'bytes=0-99', 'content-type': 'application/json' },
    payload: JSON.stringify({ size: 10000 }),
  });
  assert.equal(plan.statusCode, 206);
  assert.equal(plan.json().segmentsCount, 1);

  const retention = await app.inject({
    method: 'POST',
    url: '/cache-retention-plan',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({
      size: 1000,
      cached: [{ start: 0, end: 99 }],
      accesses: [{ start: 0, end: 99, weight: 1 }],
      budgetBytes: 100,
    }),
  });
  assert.equal(retention.statusCode, 200);
});
