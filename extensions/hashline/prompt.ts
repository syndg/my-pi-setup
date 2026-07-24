export const READ_DESCRIPTION =
  "Read text files with a session-local [path#TAG] header and 1-indexed N:line rows for the paired edit tool. Images and unsafe oversized/error outputs retain Pi's normal behavior. Text output keeps Pi's 2,000-line/50KB source truncation and continuation notices.";

export const READ_SNIPPET =
  "Read file contents with Hashline snapshot tags and numbered source rows";

export const READ_GUIDELINES = [
  "Use read before edit; only numbered rows actually shown by read or a successful edit result are eligible edit anchors.",
  "After a stale/unrecognized-tag error, or whenever the needed row is outside fresh edit-result context, use read before retrying.",
];

export const EDIT_DESCRIPTION =
  "Edit one previously read text file using strict snapshot-tagged line operations. Supply path and 16-hex tag exactly from read. All operation line numbers address the original snapshot; concrete anchors/ranges must have been displayed by read. Supports replace, delete, insert-before, insert-after, head, and tail, then returns a fresh tag with bounded numbered post-edit context. The complete transaction preflights before one Pi-compatible direct write; stale, unseen, overlapping, invalid, and no-op edits fail.";

export const EDIT_SNIPPET =
  "Edit one tagged file with strict replace/delete/insert-before/insert-after/head/tail line operations";

export const EDIT_GUIDELINES = [
  "Use edit only with the path, tag, and original line numbers from a Hashline read in this session.",
  "For edit operations: replace/delete use inclusive start/end; insert-before/insert-after use line; head/tail need only lines. Every lines item is one newline-free destination row.",
  "Edit may target only numbered rows actually shown by read; never infer or edit unseen rows.",
  "After edit, re-ground from its fresh [path#TAG] numbered context; call read when the next target is outside those rows, context was truncated, or any stale/error occurred.",
];
