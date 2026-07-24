import assert from "node:assert/strict";
import test from "node:test";
import {
  SnapshotCollisionError,
  SnapshotStore,
  UnknownSnapshotError,
  computeTag,
} from "./snapshot-store.ts";

const canonical = "/real/project/a.ts";
const identity = (text: string) => computeTag(`bytes:${text}`);

function record(
  store: SnapshotStore,
  input: {
    displayPath?: string;
    text: string;
    seenLines: number[];
    canonicalPath?: string;
    resolvedPath?: string;
    byteIdentity?: string;
  },
) {
  return store.recordRead({
    canonicalPath: input.canonicalPath ?? canonical,
    resolvedPath: input.resolvedPath ?? canonical,
    displayPath: input.displayPath ?? "a.ts",
    text: input.text,
    byteIdentity: input.byteIdentity ?? identity(input.text),
    seenLines: input.seenLines,
  });
}

test("records 64-bit SHA-256 prefix tags and unions seen-row provenance", () => {
  const store = new SnapshotStore();
  const first = store.recordRead({
    canonicalPath: canonical,
    displayPath: "a.ts",
    text: "a\nb\nc\n",
    seenLines: [1],
  });
  const second = store.recordRead({
    canonicalPath: canonical,
    displayPath: "./a.ts",
    text: "a\nb\nc\n",
    seenLines: [3],
  });

  assert.equal(first.tag, computeTag("a\nb\nc\n"));
  assert.match(first.tag, /^[0-9A-F]{16}$/);
  assert.equal(first.tag, second.tag);
  assert.deepEqual([...store.getForEdit("a.ts", first.tag).seenLines], [1, 3]);
  assert.equal(
    store.getForPreview("./a.ts", first.tag)?.canonicalPath,
    canonical,
  );
});

test("detects same-path tag collisions without fusing provenance", () => {
  const store = new SnapshotStore({ tagger: () => "AAAAAAAAAAAAAAAA" });
  store.recordRead({
    canonicalPath: canonical,
    displayPath: "a.ts",
    text: "first",
    seenLines: [1],
  });
  assert.throws(
    () =>
      store.recordRead({
        canonicalPath: canonical,
        displayPath: "a.ts",
        text: "second",
        seenLines: [2],
      }),
    SnapshotCollisionError,
  );
  assert.deepEqual(
    [...store.getForEdit("a.ts", "AAAAAAAAAAAAAAAA").seenLines],
    [1],
  );
});

test("post-edit issuance replaces historical seen-row provenance on a revert", () => {
  const store = new SnapshotStore();
  const original = record(store, {
    text: "a\nb\nc\nd\n",
    seenLines: [1, 2, 3, 4],
  });
  const changed = store.recordEdit({
    canonicalPath: canonical,
    resolvedPath: canonical,
    displayPath: "a.ts",
    text: "A\nb\nc\nd\n",
    byteIdentity: identity("A\nb\nc\nd\n"),
    seenLines: [1, 2],
  });
  assert.notEqual(changed.tag, original.tag);

  const reverted = store.recordEdit({
    canonicalPath: canonical,
    resolvedPath: canonical,
    displayPath: "a.ts",
    text: "a\nb\nc\nd\n",
    byteIdentity: identity("a\nb\nc\nd\n"),
    seenLines: [1],
  });
  assert.equal(reverted.tag, original.tag);
  assert.deepEqual([...reverted.seenLines], [1]);
});

test("issued-tag ledger survives version eviction and fails closed at capacity", () => {
  const tags = new Map([
    ["first", "AAAAAAAAAAAAAAAA"],
    ["middle", "BBBBBBBBBBBBBBBB"],
    ["collision", "AAAAAAAAAAAAAAAA"],
  ]);
  const store = new SnapshotStore({
    maxVersionsPerPath: 1,
    maxIssuedTags: 2,
    tagger: (text) => tags.get(text)!,
  });
  record(store, { text: "first", seenLines: [1] });
  record(store, { text: "middle", seenLines: [1] });
  assert.throws(
    () => record(store, { text: "collision", seenLines: [1] }),
    SnapshotCollisionError,
  );

  const reissue = new SnapshotStore({
    maxVersionsPerPath: 1,
    tagger: (text) => tags.get(text)!,
  });
  const issued = record(reissue, { text: "first", seenLines: [1] });
  record(reissue, { text: "middle", seenLines: [1] });
  assert.equal(
    record(reissue, { text: "first", seenLines: [1] }).tag,
    issued.tag,
  );

  const byteEvicted = new SnapshotStore({
    maxBytes: 8,
    maxVersionsPerPath: 4,
    tagger: (text) =>
      text === "first" || text === "third"
        ? "AAAAAAAAAAAAAAAA"
        : "BBBBBBBBBBBBBBBB",
  });
  record(byteEvicted, { text: "first", seenLines: [1] });
  record(byteEvicted, { text: "middle", seenLines: [1] });
  assert.throws(
    () => record(byteEvicted, { text: "third", seenLines: [1] }),
    SnapshotCollisionError,
  );

  const bounded = new SnapshotStore({ maxIssuedTags: 1 });
  const first = record(bounded, { text: "same", seenLines: [1] });
  assert.equal(
    record(bounded, { text: "same", seenLines: [1] }).tag,
    first.tag,
  );
  assert.throws(
    () =>
      record(bounded, {
        displayPath: "other.ts",
        text: "other",
        seenLines: [1],
      }),
    /ledger capacity/,
  );
});

test("aliases and repeated-read provenance stay bounded without losing current rows", () => {
  const store = new SnapshotStore({
    maxAliasesPerPath: 2,
    maxSeenLinesPerSnapshot: 2,
  });
  const first = record(store, {
    displayPath: "first.ts",
    text: "a\nb\nc",
    seenLines: [1, 2],
  });
  record(store, {
    displayPath: "second.ts",
    text: "a\nb\nc",
    seenLines: [2],
  });
  const current = record(store, {
    displayPath: "third.ts",
    text: "a\nb\nc",
    seenLines: [3],
  });
  assert.equal(store.getForPreview("first.ts", first.tag), undefined);
  assert.ok(store.getForPreview("second.ts", first.tag));
  assert.deepEqual([...current.seenLines], [3]);
  assert.throws(
    () =>
      record(store, {
        displayPath: "fourth.ts",
        text: "a\nb\nc",
        seenLines: [1, 2, 3],
      }),
    /displayed rows exceed/,
  );
});

test("bounded retention evicts old versions and clear invalidates every tag", () => {
  const store = new SnapshotStore({ maxVersionsPerPath: 1, maxBytes: 100 });
  const old = store.recordRead({
    canonicalPath: canonical,
    displayPath: "a.ts",
    text: "old",
    seenLines: [1],
  });
  const current = store.recordRead({
    canonicalPath: canonical,
    displayPath: "a.ts",
    text: "new",
    seenLines: [1],
  });
  assert.throws(() => store.getForEdit("a.ts", old.tag), UnknownSnapshotError);
  assert.equal(store.getForEdit("a.ts", current.tag).text, "new");

  store.clear();
  assert.equal(store.size, 0);
  assert.throws(
    () => store.getForEdit("a.ts", current.tag),
    UnknownSnapshotError,
  );
});
