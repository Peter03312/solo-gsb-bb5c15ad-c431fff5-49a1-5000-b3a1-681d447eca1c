import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { diffSnapshots } from '../src/snapshot-diff.js';

const app = buildApp();
const url = '/snapshot-diff';

function diff(payload) {
  return app.inject({
    method: 'POST',
    url,
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify(payload),
  });
}

const b64 = (stringOrBuffer) => Buffer.from(stringOrBuffer).toString('base64');
const frag = (start, bytes) => ({ start, dataBase64: b64(bytes) });

test('identical full snapshots are all same', async () => {
  const payload = {
    size: 10,
    before: [frag(0, 'aaaaaaaaaa')],
    after: [frag(0, 'aaaaaaaaaa')],
  };
  const res = await diff(payload);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), {
    statusCode: 200,
    size: 10,
    intervals: [{ start: 0, end: 9, classification: 'same' }],
    sameBytes: 10,
    changedBytes: 0,
    unknownBytes: 0,
  });
});

test('a fully covered update reports one changed interval', async () => {
  const res = await diff({
    size: 8,
    before: [frag(0, 'abcdefgh')],
    after: [frag(0, 'abXdeXgh')],
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.deepEqual(body.intervals, [
    { start: 0, end: 1, classification: 'same' },
    { start: 2, end: 2, classification: 'changed' },
    { start: 3, end: 4, classification: 'same' },
    { start: 5, end: 5, classification: 'changed' },
    { start: 6, end: 7, classification: 'same' },
  ]);
  assert.equal(body.sameBytes, 6);
  assert.equal(body.changedBytes, 2);
  assert.equal(body.unknownBytes, 0);
});

test('positions missing on either side are unknown', async () => {
  // before covers [0,9], after covers [5,14] in a 20-byte resource; only
  // [5,9] is present on both sides.
  const res = await diff({
    size: 20,
    before: [frag(0, 'aaaaaaaaaa')],
    after: [frag(5, 'aaaaaaaaaa')],
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.deepEqual(body.intervals, [
    { start: 0, end: 4, classification: 'unknown' },
    { start: 5, end: 9, classification: 'same' },
    { start: 10, end: 19, classification: 'unknown' },
  ]);
  assert.equal(body.sameBytes, 5);
  assert.equal(body.changedBytes, 0);
  assert.equal(body.unknownBytes, 15);
  assert.equal(body.sameBytes + body.changedBytes + body.unknownBytes, 20);
});

test('same, changed and unknown runs interleave and stay merged', async () => {
  // Common coverage [0,11]: same [0,2], changed [3,4], same [5,7],
  // changed [8,8], same [9,11]; tails unknown.
  const res = await diff({
    size: 16,
    before: [frag(0, Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]))],
    after: [
      frag(0, Buffer.from([0, 1, 2, 9, 9, 5, 6, 7, 9, 9, 10, 11])),
      frag(12, Buffer.from([12])),
    ],
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.deepEqual(body.intervals, [
    { start: 0, end: 2, classification: 'same' },
    { start: 3, end: 4, classification: 'changed' },
    { start: 5, end: 7, classification: 'same' },
    { start: 8, end: 8, classification: 'changed' },
    { start: 9, end: 12, classification: 'same' },
    { start: 13, end: 15, classification: 'unknown' },
  ]);
  assert.equal(body.sameBytes, 3 + 3 + 4);
  assert.equal(body.changedBytes, 3);
  assert.equal(body.unknownBytes, 3);
  assert.equal(body.sameBytes + body.changedBytes + body.unknownBytes, 16);
});

test('overlapping agreeing fragments merge within a snapshot', async () => {
  const res = await diff({
    size: 10,
    before: [
      frag(0, 'aaaaa'),
      frag(3, 'aaaaaaa'), // overlaps [3,4] with identical bytes, extends to 9
    ],
    after: [frag(0, 'aaaaaaaaaa')],
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.deepEqual(body.intervals, [{ start: 0, end: 9, classification: 'same' }]);
  assert.equal(body.sameBytes, 10);
});

test('disagreeing overlap in before rejects the comparison naming before', async () => {
  const res = await diff({
    size: 10,
    before: [frag(0, 'aaaaaaaaaa'), frag(5, 'XXXXX')],
    after: [frag(0, 'aaaaaaaaaa')],
  });
  assert.equal(res.statusCode, 409);
  const body = res.json();
  assert.equal(body.code, 'FRAGMENT_CONFLICT');
  assert.equal(body.snapshot, 'before');
  assert.deepEqual(body.intervals, [{ start: 5, end: 9 }]);
});

test('disagreeing overlap in after rejects the comparison naming after', async () => {
  const res = await diff({
    size: 8,
    before: [frag(0, 'aaaaaaaa')],
    after: [frag(0, 'aaaXXX'), frag(3, 'aaaaa')],
  });
  assert.equal(res.statusCode, 409);
  const body = res.json();
  assert.equal(body.code, 'FRAGMENT_CONFLICT');
  assert.equal(body.snapshot, 'after');
  assert.deepEqual(body.intervals, [{ start: 3, end: 5 }]);
});

test('adjacent differing conflict runs merge into one interval', async () => {
  const res = await diff({
    size: 10,
    before: [frag(0, 'abcdefghij'), frag(0, 'XXXXXXXXXX')],
    after: [frag(0, 'abcdefghij')],
  });
  assert.equal(res.statusCode, 409);
  assert.deepEqual(res.json().intervals, [{ start: 0, end: 9 }]);
});

test('empty resource with empty groups returns empty intervals and zero counts', async () => {
  const res = await diff({ size: 0, before: [], after: [] });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), {
    statusCode: 200,
    size: 0,
    intervals: [],
    sameBytes: 0,
    changedBytes: 0,
    unknownBytes: 0,
  });
});

test('a non-zero resource with no fragments is all unknown', async () => {
  const res = await diff({ size: 7, before: [], after: [] });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.deepEqual(body.intervals, [{ start: 0, end: 6, classification: 'unknown' }]);
  assert.equal(body.unknownBytes, 7);
});

test('identical content on both sides split across different fragments still compares', async () => {
  const res = await diff({
    size: 12,
    before: [frag(0, 'aaaaaa'), frag(6, 'bbbbbb')],
    after: [frag(3, 'aaabbbbb'), frag(0, 'aaaa')],
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.deepEqual(body.intervals, [
    { start: 0, end: 10, classification: 'same' },
    { start: 11, end: 11, classification: 'unknown' },
  ]);
  assert.equal(body.sameBytes, 11);
  assert.equal(body.unknownBytes, 1);
});

test('combined decoded bytes of both groups above 1 MiB are rejected', async () => {
  const half = 512 * 1024;
  const one = Buffer.alloc(half, 0x61);
  const res = await diff({
    size: 2 * 1024 * 1024,
    before: [frag(0, one)],
    after: [frag(half, one), frag(2 * half, Buffer.alloc(1, 0x62))],
  });
  assert.equal(res.statusCode, 400);
  const body = res.json();
  assert.equal(body.code, 'FRAGMENTS_TOO_LARGE');
  assert.equal(body.snapshot, 'after');
});

test('exactly 1 MiB across both groups is accepted', async () => {
  const half = 512 * 1024;
  const one = Buffer.alloc(half, 0x61);
  const res = await diff({
    size: half + 1,
    before: [frag(0, one)],
    after: [frag(0, one)],
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.deepEqual(body.intervals, [
    { start: 0, end: half - 1, classification: 'same' },
    { start: half, end: half, classification: 'unknown' },
  ]);
  assert.equal(body.sameBytes, half);
  assert.equal(body.unknownBytes, 1);
});

test('a fragment running past the resource end is rejected and named', async () => {
  const res = await diff({
    size: 4,
    before: [frag(0, 'aaaa')],
    after: [frag(3, 'aa')],
  });
  assert.equal(res.statusCode, 400);
  const body = res.json();
  assert.equal(body.code, 'FRAGMENT_OUT_OF_BOUNDS');
  assert.equal(body.snapshot, 'after');
});

test('a fragment starting at size is out of bounds', async () => {
  const res = await diff({
    size: 4,
    before: [frag(4, 'a')],
    after: [],
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().code, 'FRAGMENT_OUT_OF_BOUNDS');
});

test('non-canonical base64 is rejected', async () => {
  const res = await diff({
    size: 4,
    before: [{ start: 0, dataBase64: 'YW==' }], // decodes to "a" but canonical form is "YQ=="
    after: [],
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().code, 'INVALID_FRAGMENT_BASE64');
});

test('size outside the schema range is rejected by the strict validator', async () => {
  const res = await diff({ size: Number.MAX_SAFE_INTEGER + 1, before: [], after: [] });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().code, 'FST_ERR_VALIDATION');
});

test('the module reports INVALID_SIZE for non-integer input directly', async () => {
  // The HTTP schema cannot express a non-integer number after strict
  // validation; the module still guards it for direct callers.
  assert.equal(diffSnapshots({ size: 1.5, before: [], after: [] }).code, 'INVALID_SIZE');
});

test('strict validator rejects unknown fields and coerced types', async () => {
  const resOk = await diff({ size: 2, before: [], after: [], extra: 1 });
  assert.equal(resOk.statusCode, 400);

  const resString = await diff({ size: '10', before: [], after: [] });
  assert.equal(resString.statusCode, 400);

  const resMissing = await diff({ size: 10, before: [] });
  assert.equal(resMissing.statusCode, 400);
});

test('huge resource coordinates stay interval based and counts cover the resource', async () => {
  const max = Number.MAX_SAFE_INTEGER;
  // before covers [0,3]; after covers [1,2] (different bytes) and the last
  // four bytes [max-3,max-1]. The only both-present intersection is [1,2].
  const res = await diff({
    size: max,
    before: [frag(0, 'abcd')],
    after: [
      frag(1, 'ZZ'),
      frag(max - 4, 'wxyz'),
    ],
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.deepEqual(body.intervals, [
    { start: 0, end: 0, classification: 'unknown' },
    { start: 1, end: 2, classification: 'changed' },
    { start: 3, end: max - 1, classification: 'unknown' },
  ]);
  assert.equal(body.changedBytes, 2);
  assert.equal(body.sameBytes, 0);
  assert.equal(body.unknownBytes, max - 2);
  assert.equal(body.sameBytes + body.changedBytes + body.unknownBytes, max);
});

test('unknown intervals adjacent to compared runs do not merge across classes', async () => {
  // before covers [0,5] ("aabbcc"), after covers [2,7] ("bbccdd"); common
  // coverage [2,5] with identical bytes.
  const res = await diff({
    size: 8,
    before: [frag(0, 'aabbcc')],
    after: [frag(2, 'bbccdd')],
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.deepEqual(body.intervals, [
    { start: 0, end: 1, classification: 'unknown' },
    { start: 2, end: 5, classification: 'same' },
    { start: 6, end: 7, classification: 'unknown' },
  ]);
  assert.equal(body.sameBytes, 4);
  assert.equal(body.unknownBytes, 4);
});
