import { randomBytes } from "node:crypto";

import { CODE_MODE_LIMITS } from "./limits.ts";

export const PROGRAM_PATH = "/workspace/program.ts";

const byteLength = (value: string) => Buffer.byteLength(value, "utf8");

export function createResultSentinel() {
  return `__PI_CODE_MODE_RESULT_${randomBytes(24).toString("hex")}__`;
}

export function buildProgram(source: string, sentinel: string) {
  if (byteLength(source) > CODE_MODE_LIMITS.maxSourceBytes) {
    throw new RangeError(
      `Code Mode source exceeds ${CODE_MODE_LIMITS.maxSourceBytes} bytes`,
    );
  }

  const encodedSentinel = JSON.stringify(sentinel);

  return [
    "const __codeModeRawTools = globalThis.tools;",
    "const __codeModePendingTools = new Set();",
    "const __codeModeWrapTool = (target) => new Proxy(function () {}, {",
    "  get(_unused, property) {",
    "    return __codeModeWrapTool(target[property]);",
    "  },",
    "  apply(_unused, _thisArg, args) {",
    "    const pending = Promise.resolve(Reflect.apply(target, undefined, args)).then((value) => {",
    `      if (value && typeof value === "object" && value.__codeModeBridgeError === ${encodedSentinel}) {`,
    '        throw new Error(typeof value.message === "string" ? value.message : "Code Mode operation failed");',
    "      }",
    "      return value;",
    "    });",
    "    __codeModePendingTools.add(pending);",
    "    pending.then(() => __codeModePendingTools.delete(pending), () => __codeModePendingTools.delete(pending));",
    "    return pending;",
    "  },",
    "});",
    "globalThis.tools = __codeModeWrapTool(__codeModeRawTools);",
    "let __codeModeValue;",
    "try {",
    "  __codeModeValue = await (async () => {",
    source,
    "  })();",
    '  if (__codeModePendingTools.size > 0) throw new Error("Every Code Mode tool call must be awaited");',
    "} catch (error) {",
    '  console.error("Code Mode guest error: " + (error && typeof error.message === "string" ? error.message : "Program failed"));',
    "  throw error;",
    "}",
    "let __codeModeSerialized;",
    "try {",
    "  __codeModeSerialized = JSON.stringify({",
    '    hasValue: typeof __codeModeValue !== "undefined",',
    "    value: __codeModeValue,",
    "  });",
    "} catch (error) {",
    '  console.error("Code Mode guest error: return value is not JSON-serializable");',
    "  throw error;",
    "}",
    `console.log(${encodedSentinel} + __codeModeSerialized);`,
    "",
  ].join("\n");
}
