import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { diffSnapshots } from '../src/cache-diff.js';

const app = buildApp();
const url = '/cache-snapshot-diff';

function post(payload) {
  return app.inject({
    method: 'POST',
    url,
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify(payload),
  });
}

function frag(start, bytesOrString) {
  const data =
    typeof bytesOrString === 'string'
      ? Buffer.from(bytesOrString, 'latin1')
      : Buffer.from(bytesOrString);
  return { start, dataBase64: data.toString('base64') };
}

// Build a fragment whose bytes repeat the given list cyclically.
function repeated(start, length, byteValues) {
  const data = Buffer.alloc(length);
  for (let i = 0; i < length; i += 1) data[i] = byteValues[i % byteValues.length];
  return { start, dataBase64: data.toString('base64') };
}

test('an empty resource returns empty intervals and zero counts', async () => {
  const res = await post({ size: 0, before: [], after: [] });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), {
    statusCode: 200,
    resource: { size: 0 },
    ranges: [],
    counts: { equalBytes: 0, changedBytes: 0, unknownBytes: 0 },
  });
});

test('a fully cached identical resource is one equal interval', async () => {
  const payload = {
    size: 10,
    before: [frag(0, 'abcdefghij')],
    after: [frag(0, 'abcdefghij')],
  };
  const res = await post(payload);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), {
    statusCode: 200,
    resource: { size: 10 },
    ranges: [{ start: 0, end: 9, kind: 'equal' }],
    counts: { equalBytes: 10, changedBytes: 0, unknownBytes: 0 },
  });
});

test('a fully cached resource that changed everywhere is one changed interval', async () => {
  const res = await post({
    size: 5,
    before: [frag(0, 'aaaaa')],
    after: [frag(0, 'bbbbb')],
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json().ranges, [{ start: 0, end: 4, kind: 'changed' }]);
  assert.deepEqual(res.json().counts, { equalBytes: 0, changedBytes: 5, unknownBytes: 0 });
});

test('only positions present in both snapshots are equal or changed', async () => {
  // before covers [0,7] = aaaaaaaa; after covers [4,9] = aaabbb.
  // overlap [4,7]: [4,6] are 'a' on both sides -> equal; position 7 is
  // 'a' vs 'b' -> changed; [0,3] and [8,9] are missing on one side ->
  // unknown.
  const res = await post({
    size: 10,
    before: [frag(0, 'aaaaaaaa')],
    after: [frag(4, 'aaabbb')],
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.deepEqual(body.ranges, [
    { start: 0, end: 3, kind: 'unknown' },
    { start: 4, end: 6, kind: 'equal' },
    { start: 7, end: 7, kind: 'changed' },
    { start: 8, end: 9, kind: 'unknown' },
  ]);
  // The two unknown pieces are not adjacent, so stay split.
  assert.deepEqual(body.counts, { equalBytes: 3, changedBytes: 1, unknownBytes: 6 });
});

test('equal, changed and unknown runs are reported and adjacent runs merge', async () => {
  // before [0,9] = abcdefghij ; after [0,9] = aXcXefghiZ? keep size 10:
  // after = "aXcXefghij" -> positions 1 and 3 differ, single changed runs.
  const res = await post({
    size: 10,
    before: [frag(0, 'abcdefghij')],
    after: [frag(0, 'aXcXefghij')],
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json().ranges, [
    { start: 0, end: 0, kind: 'equal' },
    { start: 1, end: 1, kind: 'changed' },
    { start: 2, end: 2, kind: 'equal' },
    { start: 3, end: 3, kind: 'changed' },
    { start: 4, end: 9, kind: 'equal' },
  ]);
  assert.deepEqual(res.json().counts, { equalBytes: 8, changedBytes: 2, unknownBytes: 0 });
});

test('adjacent changed bytes merge into one interval even across fragment boundaries', async () => {
  // before: two adjacent fragments "abcdefghij"; after differs on [4,7].
  const res = await post({
    size: 10,
    before: [frag(0, 'abcde'), frag(5, 'fghij')],
    after: [frag(0, 'abcdXXXXij')],
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json().ranges, [
    { start: 0, end: 3, kind: 'equal' },
    { start: 4, end: 7, kind: 'changed' },
    { start: 8, end: 9, kind: 'equal' },
  ]);
  assert.deepEqual(res.json().counts, { equalBytes: 6, changedBytes: 4, unknownBytes: 0 });
});

test('fragments inside each group are merged and overlaps must agree', async () => {
  // before: [0,9] supplied twice with identical overlap -> merged.
  // after: [0,4] + [5,9] adjacent -> merged; bytes at 8,9 differ ("ZZ").
  const res = await post({
    size: 10,
    before: [frag(0, 'abcdefghij'), frag(0, 'abcde')],
    after: [frag(0, 'abcde'), frag(5, 'fghZZ')],
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.deepEqual(body.ranges, [
    { start: 0, end: 7, kind: 'equal' },
    { start: 8, end: 9, kind: 'changed' },
  ]);
  assert.deepEqual(body.counts, { equalBytes: 8, changedBytes: 2, unknownBytes: 0 });
});

test('inconsistent overlapping fragments in before are rejected naming the snapshot', async () => {
  const res = await post({
    size: 10,
    before: [frag(0, 'aaaaaa'), frag(4, 'XXX')],
    after: [frag(0, 'aaaaaa')],
  });
  assert.equal(res.statusCode, 409);
  const body = res.json();
  assert.equal(body.code, 'FRAGMENT_CONFLICT');
  assert.equal(body.snapshot, 'before');
  assert.deepEqual(body.conflicts, [{ start: 4, end: 5 }]);
});

test('inconsistent overlapping fragments in after are rejected naming the snapshot', async () => {
  const res = await post({
    size: 10,
    before: [frag(0, 'aaaaaa')],
    after: [frag(0, 'aaaaaa'), frag(5, 'X')],
  });
  assert.equal(res.statusCode, 409);
  const body = res.json();
  assert.equal(body.code, 'FRAGMENT_CONFLICT');
  assert.equal(body.snapshot, 'after');
  assert.deepEqual(body.conflicts, [{ start: 5, end: 5 }]);
});

test('before conflicts take priority over after conflicts', async () => {
  const res = await post({
    size: 10,
    before: [frag(0, 'aaaaaa'), frag(4, 'X')],
    after: [frag(0, 'aaaaaa'), frag(5, 'X')],
  });
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().snapshot, 'before');
});

test('no fragments at all marks the whole resource unknown', async () => {
  const res = await post({ size: 100, before: [], after: [] });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json().ranges, [{ start: 0, end: 99, kind: 'unknown' }]);
  assert.deepEqual(res.json().counts, { equalBytes: 0, changedBytes: 0, unknownBytes: 100 });
});

test('one-sided coverage is unknown and adjacent unknown runs merge', async () => {
  // before covers [0,9]; after covers nothing -> whole resource unknown in
  // one merged interval.
  const res = await post({ size: 20, before: [frag(0, 'aaaaaaaaaa')], after: [] });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json().ranges, [{ start: 0, end: 19, kind: 'unknown' }]);
  assert.deepEqual(res.json().counts, { equalBytes: 0, changedBytes: 0, unknownBytes: 20 });
});

test('unknown holes on both sides of an overlap merge across the covered tail', async () => {
  // before covers [5,9]; after covers [5,14]. overlap [5,9] equal; unknown
  // is [0,4] and [10,19] (the before-only tail plus the uncovered tail are
  // not adjacent, but [10,14] then [15,19] merge inside the second piece).
  const res = await post({
    size: 20,
    before: [frag(5, 'aaaaa')],
    after: [frag(5, 'aaaaaaaaaa')],
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.deepEqual(body.ranges, [
    { start: 0, end: 4, kind: 'unknown' },
    { start: 5, end: 9, kind: 'equal' },
    { start: 10, end: 19, kind: 'unknown' },
  ]);
  assert.deepEqual(body.counts, { equalBytes: 5, changedBytes: 0, unknownBytes: 15 });
});

test('ranges always cover the whole resource and counts sum to size', async () => {
  // Mosaic: before [2,11], after [8,17], with a few changed bytes.
  const before = Buffer.from('abcdefghij', 'latin1'); // [2..11]
  const afterBuf = Buffer.from('KLMNOPQRST', 'latin1'); // [8..17], all differ
  const res = await post({
    size: 20,
    before: [{ start: 2, dataBase64: before.toString('base64') }],
    after: [{ start: 8, dataBase64: afterBuf.toString('base64') }],
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  let covered = 0;
  let cursor = 0;
  for (const interval of body.ranges) {
    assert.equal(interval.start, cursor, 'intervals must be contiguous from 0');
    assert.ok(['equal', 'changed', 'unknown'].includes(interval.kind));
    covered += interval.end - interval.start + 1;
    cursor = interval.end + 1;
  }
  assert.equal(cursor, 20);
  assert.equal(covered, 20);
  const { equalBytes, changedBytes, unknownBytes } = body.counts;
  assert.equal(equalBytes + changedBytes + unknownBytes, 20);
  // Overlap [8,11] has 4 fully differing bytes.
  assert.equal(changedBytes, 4);
  assert.equal(equalBytes, 0);
  assert.equal(unknownBytes, 16);
});

test('the 1 MiB limit applies to both groups combined', async () => {
  const res = await post({
    size: 3 * 1024 * 1024,
    before: [repeated(0, 600 * 1024, [97])],
    after: [repeated(600 * 1024, 600 * 1024, [98])],
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().code, 'FRAGMENTS_TOO_LARGE');
});

test('exactly 1 MiB combined across both groups is accepted', async () => {
  const half = 512 * 1024;
  const res = await post({
    size: 2 * 1024 * 1024,
    before: [repeated(0, half, [97])],
    after: [
      {
        start: 0,
        dataBase64: Buffer.alloc(half, 97).toString('base64'),
      },
    ],
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.counts.equalBytes, half);
  assert.equal(body.counts.unknownBytes, 2 * 1024 * 1024 - half);
});

test('out-of-bounds fragments name the offending group', async () => {
  const res = await post({
    size: 10,
    before: [],
    after: [frag(8, 'abc')], // covers 8,9,10 -> past end
  });
  assert.equal(res.statusCode, 400);
  const body = res.json();
  assert.equal(body.code, 'FRAGMENT_OUT_OF_BOUNDS');
  assert.match(body.message, /after\[0\]/);
});

test('non-canonical base64 in either group is rejected', async () => {
  for (const [group, dataBase64] of [
    ['before', '####'],
    ['after', 'QR=='],
  ]) {
    const res = await post({
      size: 10,
      before: group === 'before' ? [{ start: 0, dataBase64 }] : [],
      after: group === 'after' ? [{ start: 0, dataBase64 }] : [],
    });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().code, 'INVALID_FRAGMENT_BASE64');
  }
});

test('strict validation rejects string numbers and extra fields', async () => {
  const good = frag(0, 'a');
  for (const payload of [
    { size: '10', before: [], after: [] },
    { size: 10, before: [], after: [], extra: 1 },
    { size: 10, before: [{ ...good, end: 0 }], after: [] },
  ]) {
    const res = await post(payload);
    assert.equal(res.statusCode, 400);
  }
});

test('missing required fields are rejected', async () => {
  const res = await post({ size: 10, before: [] });
  assert.equal(res.statusCode, 400);
});

test('fragments at the safe-integer boundary are handled exactly', async () => {
  // A 4-byte resource sitting right at Number.MAX_SAFE_INTEGER: exact
  // interval arithmetic must not lose one byte in counts or interval ends.
  const last = Number.MAX_SAFE_INTEGER;
  const size = last; // resource spans [0, MAX_SAFE_INTEGER - 1]
  const start = size - 4;
  const res = await post({
    size,
    before: [frag(start, 'abcd')],
    after: [frag(start, 'abXd')],
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.deepEqual(body.ranges, [
    { start: 0, end: start - 1, kind: 'unknown' },
    { start, start, end: start + 1, kind: 'equal' },
    { start: start + 2, end: start + 2, kind: 'changed' },
    { start: start + 3, end: size - 1, kind: 'equal' },
  ]);
  assert.equal(body.counts.equalBytes, 3);
  assert.equal(body.counts.changedBytes, 1);
  assert.equal(body.counts.unknownBytes, size - 4);
  assert.equal(
    body.counts.equalBytes + body.counts.changedBytes + body.counts.unknownBytes,
    Number.MAX_SAFE_INTEGER,
  );
});

test('the core function accepts direct input and rejects a bad size', () => {
  const ok = diffSnapshots({ size: 1, before: [frag(0, 'a')], after: [frag(0, 'a')] });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.counts.equalBytes, 1);

  for (const size of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    const bad = diffSnapshots({ size, before: [], after: [] });
    assert.equal(bad.statusCode, 400);
    assert.equal(bad.code, 'INVALID_SIZE');
  }
});
