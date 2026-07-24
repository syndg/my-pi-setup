import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";

export const HASHLINE_TAG_PATTERN = "^[0-9A-F]{16}$";
export const MAX_OPERATIONS = 100;

export const readParameters = Type.Object({
  path: Type.String({
    description: "File path, relative to the project or absolute",
  }),
  offset: Type.Optional(
    Type.Integer({
      minimum: 1,
      description: "First source line to display (1-indexed)",
    }),
  ),
  limit: Type.Optional(
    Type.Integer({
      minimum: 1,
      description: "Maximum source lines to display",
    }),
  ),
});

export const operationParameters = Type.Object({
  op: StringEnum([
    "replace",
    "delete",
    "insert-before",
    "insert-after",
    "head",
    "tail",
  ] as const),
  start: Type.Optional(Type.Integer({ minimum: 1 })),
  end: Type.Optional(Type.Integer({ minimum: 1 })),
  line: Type.Optional(Type.Integer({ minimum: 1 })),
  lines: Type.Optional(
    Type.Array(
      Type.String({
        description: "One destination line; never include a newline character",
      }),
    ),
  ),
});

export const editParameters = Type.Object({
  path: Type.String({
    description: "Exact path from the [path#TAG] read header",
  }),
  tag: Type.String({
    pattern: HASHLINE_TAG_PATTERN,
    description: "16-uppercase-hex snapshot tag from read",
  }),
  operations: Type.Array(operationParameters, {
    minItems: 1,
    maxItems: MAX_OPERATIONS,
    description:
      "Operations against the original tagged snapshot and its line numbers",
  }),
});

export type ReadInput = Static<typeof readParameters>;
export type EditInput = Static<typeof editParameters>;
