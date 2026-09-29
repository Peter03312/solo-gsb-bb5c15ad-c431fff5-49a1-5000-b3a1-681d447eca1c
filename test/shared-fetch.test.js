import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';

const app = buildApp();
const url = '/shared-fetch-plan';

function plan(payload) {
  return app.inject({
    method: 'POST',
    url,
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify(payload),
  });
}

const base = { size: 1000, maxFetchBytes: 200, maxGapBytes: 10 };

test('overlapping demands merge into one fetch', async () => {
  const res = await plan({
    ...base,
    clients: [
      { clientId: 'A', ranges: [{ start: 0, end: 99 }] },
      { clientId: 'B', ranges: [{ start: 50, end: 199 }] },
    ],
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.deepEqual(body.demands, [{ start: 0, end: 199 }]);
  assert.equal(body.demandsBytes, 200);
  assert.equal(body.fetchesCount, 1);
  assert.deepEqual(body.fetches.map((f) => [f.start, f.end, f.bytes, f.rangeHeader]), [
    [0, 199, 200, 'bytes=0-199'],
  ]);
  assert.equal(body.fetchedBytes, 200);
  assert.equal(body.extraBytes, 0);
});

test('a small gap is bridged when the merged length fits the ceiling', async () => {
  const res = await plan({
    ...base,
    clients: [
      { clientId: 'A', ranges: [{ start: 0, end: 99 }] }, // 100 bytes
      { clientId: 'B', ranges: [{ start: 105, end: 199 }] }, // gap bytes 100-104 = 5
    ],
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.deepEqual(body.demands, [
    { start: 0, end: 99 },
    { start: 105, end: 199 },
  ]);
  assert.equal(body.demandsBytes, 195);
  assert.deepEqual(body.fetches.map((f) => [f.start, f.end]), [[0, 199]]);
  assert.equal(body.fetchedBytes, 200);
  assert.equal(body.extraBytes, 5);
});

test('a gap larger than maxGapBytes is not bridged', async () => {
  const res = await plan({
    ...base,
    clients: [
      { clientId: 'A', ranges: [{ start: 0, end: 99 }] },
      { clientId: 'B', ranges: [{ start: 111, end: 199 }] }, // gap = 11
    ],
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.deepEqual(body.fetches.map((f) => [f.start, f.end]), [
    [0, 99],
    [111, 199],
  ]);
  assert.equal(body.fetchedBytes, 189);
  assert.equal(body.extraBytes, 0);
});

test('a bridgeable gap is left as separate fetches when merging exceeds the ceiling', async () => {
  const res = await plan({
    size: 1000,
    maxFetchBytes: 199,
    maxGapBytes: 10,
    clients: [
      { clientId: 'A', ranges: [{ start: 0, end: 99 }] },
      { clientId: 'B', ranges: [{ start: 105, end: 199 }] }, // gap 5 but merge = 200 bytes
    ],
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.deepEqual(body.fetches.map((f) => [f.start, f.end]), [
    [0, 99],
    [105, 199],
  ]);
  assert.equal(body.extraBytes, 0);
});

test('a demand larger than the ceiling is split left to right', async () => {
  const res = await plan({
    size: 1000,
    maxFetchBytes: 250,
    maxGapBytes: 0,
    clients: [{ clientId: 'A', ranges: [{ start: 0, end: 599 }] }],
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.deepEqual(body.fetches.map((f) => [f.start, f.end, f.bytes]), [
    [0, 249, 250],
    [250, 499, 250],
    [500, 599, 100],
  ]);
  assert.deepEqual(
    body.fetches.map((f) => f.rangeHeader),
    ['bytes=0-249', 'bytes=250-499', 'bytes=500-599'],
  );
});

test('chunks split from the same demand never merge across the ceiling', async () => {
  const res = await plan({
    size: 1000,
    maxFetchBytes: 150,
    maxGapBytes: 5,
    clients: [{ clientId: 'A', ranges: [{ start: 0, end: 299 }] }],
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.deepEqual(body.fetches.map((f) => [f.start, f.end]), [
    [0, 149],
    [150, 299],
  ]);
});

test('the later chunk of a split demand bridges the next demand', async () => {
  const res = await plan({
    size: 1000,
    maxFetchBytes: 200,
    maxGapBytes: 10,
    clients: [
      { clientId: 'A', ranges: [{ start: 0, end: 249 }] }, // split 0-199 / 200-249
      { clientId: 'B', ranges: [{ start: 260, end: 300 }] }, // gap 250-259 = 10
    ],
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.deepEqual(body.fetches.map((f) => [f.start, f.end, f.bytes]), [
    [0, 199, 200],
    [200, 300, 101],
  ]);
  assert.equal(body.demandsBytes, 250 + 41);
  assert.equal(body.fetchedBytes, 301);
  assert.equal(body.extraBytes, 10);
});

test('adjacent demands merge during dedup and cost no extra bytes', async () => {
  const res = await plan({
    ...base,
    clients: [
      { clientId: 'A', ranges: [{ start: 0, end: 99 }] },
      { clientId: 'B', ranges: [{ start: 100, end: 199 }] },
    ],
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.deepEqual(body.demands, [{ start: 0, end: 199 }]);
  assert.deepEqual(body.fetches.map((f) => [f.start, f.end]), [[0, 199]]);
  assert.equal(body.extraBytes, 0);
});

test('per-client coverage lists the bytes each fetch supplies', async () => {
  const res = await plan({
    size: 1000,
    maxFetchBytes: 200,
    maxGapBytes: 10,
    clients: [
      { clientId: 'A', ranges: [{ start: 0, end: 249 }] },
      { clientId: 'B', ranges: [{ start: 260, end: 300 }] },
    ],
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  const [a, b] = body.clients;
  assert.equal(a.clientId, 'A');
  assert.equal(a.demandedBytes, 250);
  assert.equal(a.coveredBytes, 250);
  assert.deepEqual(a.coverage, [
    { fetchIndex: 1, start: 0, end: 199, bytes: 200 },
    { fetchIndex: 2, start: 200, end: 249, bytes: 50 },
  ]);
  assert.equal(b.clientId, 'B');
  assert.equal(b.demandedBytes, 41);
  assert.equal(b.coveredBytes, 41);
  assert.deepEqual(b.coverage, [{ fetchIndex: 2, start: 260, end: 300, bytes: 41 }]);
});

test('bridged gap bytes are never reported as client coverage', async () => {
  const res = await plan({
    ...base,
    clients: [
      { clientId: 'A', ranges: [{ start: 0, end: 99 }] },
      { clientId: 'B', ranges: [{ start: 105, end: 199 }] },
    ],
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.deepEqual(body.clients[0].coverage, [{ fetchIndex: 1, start: 0, end: 99, bytes: 100 }]);
  assert.deepEqual(body.clients[1].coverage, [{ fetchIndex: 1, start: 105, end: 199, bytes: 95 }]);
});

test('duplicate and overlapping ranges within a client are deduplicated', async () => {
  const res = await plan({
    ...base,
    clients: [
      {
        clientId: 'A',
        ranges: [
          { start: 0, end: 49 },
          { start: 30, end: 99 },
          { start: 0, end: 49 },
        ],
      },
    ],
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.deepEqual(body.demands, [{ start: 0, end: 99 }]);
  assert.equal(body.demandsBytes, 100);
  assert.deepEqual(body.clients[0].ranges, [{ start: 0, end: 99 }]);
  assert.equal(body.clients[0].demandedBytes, 100);
  assert.equal(body.clients[0].coveredBytes, 100);
});

test('unordered intervals are sorted and client coverage may span multiple fetches', async () => {
  const res = await plan({
    size: 1000,
    maxFetchBytes: 50,
    maxGapBytes: 0,
    clients: [
      {
        clientId: 'A',
        ranges: [
          { start: 100, end: 149 },
          { start: 0, end: 49 },
        ],
      },
    ],
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.deepEqual(body.fetches.map((f) => [f.start, f.end]), [
    [0, 49],
    [100, 149],
  ]);
  assert.deepEqual(body.clients[0].ranges, [
    { start: 0, end: 49 },
    { start: 100, end: 149 },
  ]);
  assert.deepEqual(body.clients[0].coverage, [
    { fetchIndex: 1, start: 0, end: 49, bytes: 50 },
    { fetchIndex: 2, start: 100, end: 149, bytes: 50 },
  ]);
});

test('three identical clients share a single fetch', async () => {
  const res = await plan({
    ...base,
    clients: [
      { clientId: 'A', ranges: [{ start: 10, end: 19 }] },
      { clientId: 'B', ranges: [{ start: 10, end: 19 }] },
      { clientId: 'C', ranges: [{ start: 10, end: 19 }] },
    ],
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.deepEqual(body.fetches.map((f) => [f.start, f.end]), [[10, 19]]);
  assert.equal(body.demandsBytes, 10);
  assert.equal(body.fetchedBytes, 10);
  assert.equal(body.extraBytes, 0);
  assert.equal(body.clientsCount, 3);
  for (const client of body.clients) {
    assert.deepEqual(client.coverage, [{ fetchIndex: 1, start: 10, end: 19, bytes: 10 }]);
  }
});

test('a client with empty ranges is listed with empty coverage', async () => {
  const res = await plan({
    ...base,
    clients: [
      { clientId: 'idle', ranges: [] },
      { clientId: 'busy', ranges: [{ start: 0, end: 9 }] },
    ],
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.deepEqual(body.demands, [{ start: 0, end: 9 }]);
  const idle = body.clients.find((c) => c.clientId === 'idle');
  assert.deepEqual(idle.ranges, []);
  assert.equal(idle.demandedBytes, 0);
  assert.equal(idle.coveredBytes, 0);
  assert.deepEqual(idle.coverage, []);
});

test('no clients returns an empty plan', async () => {
  const res = await plan({ ...base, clients: [] });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.deepEqual(body.demands, []);
  assert.equal(body.demandsBytes, 0);
  assert.equal(body.fetchesCount, 0);
  assert.deepEqual(body.fetches, []);
  assert.equal(body.fetchedBytes, 0);
  assert.equal(body.extraBytes, 0);
  assert.deepEqual(body.clients, []);
});

test('an empty resource returns an empty plan', async () => {
  const res = await plan({ size: 0, clients: [], maxFetchBytes: 100, maxGapBytes: 0 });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.deepEqual(body.fetches, []);
  assert.equal(body.fetchedBytes, 0);
  assert.equal(body.extraBytes, 0);
});

test('maxGapBytes zero keeps a one-byte gap unbridged', async () => {
  const res = await plan({
    size: 1000,
    maxFetchBytes: 200,
    maxGapBytes: 0,
    clients: [
      { clientId: 'A', ranges: [{ start: 0, end: 99 }] },
      { clientId: 'B', ranges: [{ start: 101, end: 199 }] },
    ],
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.deepEqual(body.fetches.map((f) => [f.start, f.end]), [
    [0, 99],
    [101, 199],
  ]);
  assert.equal(body.extraBytes, 0);
});

test('large offsets stay within safe-integer precision', async () => {
  const size = Number.MAX_SAFE_INTEGER;
  const res = await plan({
    size,
    maxFetchBytes: 1000,
    maxGapBytes: 0,
    clients: [
      { clientId: 'A', ranges: [{ start: size - 1000, end: size - 1 }] },
    ],
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.deepEqual(body.fetches.map((f) => [f.start, f.end]), [[size - 1000, size - 1]]);
  assert.equal(body.fetchedBytes, 1000);
  assert.equal(body.extraBytes, 0);
});

test('non-integer or negative size is rejected', async () => {
  for (const size of [-1, 1.5, '1000', Number.MAX_SAFE_INTEGER + 1]) {
    const res = await plan({ ...base, size, clients: [] });
    assert.equal(res.statusCode, 400, `expected 400 for size=${size}`);
  }
});

test('maxFetchBytes must be a positive safe integer', async () => {
  for (const maxFetchBytes of [0, -5, 1.5, '100']) {
    const res = await plan({ size: 100, clients: [], maxFetchBytes, maxGapBytes: 0 });
    assert.equal(res.statusCode, 400, `expected 400 for maxFetchBytes=${maxFetchBytes}`);
  }
});

test('maxGapBytes must be a non-negative safe integer', async () => {
  for (const maxGapBytes of [-1, 1.5, '10']) {
    const res = await plan({ size: 100, clients: [], maxFetchBytes: 100, maxGapBytes });
    assert.equal(res.statusCode, 400, `expected 400 for maxGapBytes=${maxGapBytes}`);
  }
});

test('clients must be an array of client objects', async () => {
  for (const clients of [null, {}, 'x', [null], [1], [{ ranges: [] }]]) {
    const res = await plan({ ...base, clients });
    assert.equal(res.statusCode, 400, `expected 400 for clients=${JSON.stringify(clients)}`);
  }
});

test('duplicate clientId is rejected', async () => {
  const res = await plan({
    ...base,
    clients: [
      { clientId: 'A', ranges: [{ start: 0, end: 9 }] },
      { clientId: 'A', ranges: [{ start: 0, end: 9 }] },
    ],
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().code, 'DUPLICATE_CLIENT_ID');
});

test('empty or whitespace-only clientId is rejected', async () => {
  const resEmpty = await plan({ ...base, clients: [{ clientId: '', ranges: [] }] });
  assert.equal(resEmpty.statusCode, 400);

  const resBlank = await plan({ ...base, clients: [{ clientId: '   ', ranges: [] }] });
  assert.equal(resBlank.statusCode, 400);
  assert.equal(resBlank.json().code, 'INVALID_CLIENT_ID');
});

test('ranges must be an array', async () => {
  const res = await plan({ ...base, clients: [{ clientId: 'A', ranges: {} }] });
  assert.equal(res.statusCode, 400);
});

test('interval bounds must be non-negative safe integers', async () => {
  for (const ranges of [
    [{ start: -1, end: 9 }],
    [{ start: 0, end: -1 }],
    [{ start: 0.5, end: 9 }],
    [{ start: 0, end: 9.5 }],
    [{ start: '0', end: 9 }],
    [null],
    [{ start: 0 }],
  ]) {
    const res = await plan({ ...base, clients: [{ clientId: 'A', ranges }] });
    assert.equal(res.statusCode, 400, `expected 400 for ranges=${JSON.stringify(ranges)}`);
  }
});

test('an interval with start after end is rejected', async () => {
  const res = await plan({
    ...base,
    clients: [{ clientId: 'A', ranges: [{ start: 50, end: 10 }] }],
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().code, 'INVALID_RANGE_ORDER');
});

test('an interval reaching past the resource end is rejected', async () => {
  const res = await plan({
    ...base,
    clients: [{ clientId: 'A', ranges: [{ start: 90, end: 1000 }] }],
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().code, 'RANGE_OUT_OF_BOUNDS');
});

test('any range is out of bounds on an empty resource', async () => {
  const res = await plan({
    size: 0,
    clients: [{ clientId: 'A', ranges: [{ start: 0, end: 0 }] }],
    maxFetchBytes: 10,
    maxGapBytes: 0,
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().code, 'RANGE_OUT_OF_BOUNDS');
});

test('missing required fields and extra fields are rejected', async () => {
  for (const payload of [
    {},
    { size: 100, clients: [] },
    { size: 100, clients: [], maxFetchBytes: 10 },
    { size: 100, clients: [], maxFetchBytes: 10, maxGapBytes: 0, extra: 1 },
    {
      size: 100,
      clients: [{ clientId: 'A', ranges: [{ start: 0, end: 9 }], extra: 1 }],
      maxFetchBytes: 10,
      maxGapBytes: 0,
    },
  ]) {
    const res = await plan(payload);
    assert.equal(res.statusCode, 400, `expected 400 for ${JSON.stringify(payload)}`);
  }
});

test('more than 10000 total intervals is rejected even when spread over clients', async () => {
  const res = await plan({
    size: 100000,
    maxFetchBytes: 10,
    maxGapBytes: 0,
    clients: [
      { clientId: 'A', ranges: Array.from({ length: 6000 }, (_, i) => ({ start: i, end: i })) },
      { clientId: 'B', ranges: Array.from({ length: 6000 }, (_, i) => ({ start: i + 7000, end: i + 7000 })) },
    ],
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().code, 'TOO_MANY_RANGES');
});

test('more than 1000 clients is rejected', async () => {
  const res = await plan({
    ...base,
    clients: Array.from({ length: 1001 }, (_, i) => ({
      clientId: `c${i}`,
      ranges: [],
    })),
  });
  assert.equal(res.statusCode, 400);
});

test('error responses carry the shared error shape', async () => {
  const res = await plan({
    ...base,
    clients: [{ clientId: 'A', ranges: [{ start: 9, end: 0 }] }],
  });
  assert.equal(res.statusCode, 400);
  const body = res.json();
  assert.equal(body.statusCode, 400);
  assert.equal(body.error, 'Bad Request');
  assert.equal(typeof body.code, 'string');
  assert.equal(typeof body.message, 'string');
});

test('existing /plan endpoint is unaffected', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/plan',
    headers: { Range: 'bytes=0-99', 'content-type': 'application/json' },
    payload: JSON.stringify({ size: 10000 }),
  });
  assert.equal(res.statusCode, 206);
  assert.equal(res.json().segmentsCount, 1);
});
