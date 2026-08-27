import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  getCodeModeDiagnosticPath,
  logDiagnostic,
  MAX_DIAGNOSTIC_LOG_BYTES,
} from "./src/mcp/errors.ts";

const ENV_AGENT_DIR = "PI_CODING_AGENT_DIR";

test("diagnostics persist without writing directly to the terminal", async (t) => {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-code-mode-diagnostics-"));
  const previousAgentDir = process.env[ENV_AGENT_DIR];
  process.env[ENV_AGENT_DIR] = agentDir;
  t.after(async () => {
    if (previousAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
    else process.env[ENV_AGENT_DIR] = previousAgentDir;
    await rm(agentDir, { recursive: true, force: true });
  });

  const writes: unknown[][] = [];
  const original = console.error;
  console.error = (...values: unknown[]) => writes.push(values);
  const secret = "opaque-diagnostic-secret";
  let diagnosticId: string;
  try {
    diagnosticId = logDiagnostic(
      "MCP call failed",
      new Error(`transport reflected ${secret}\u001b[31m`),
      [secret],
    );
  } finally {
    console.error = original;
  }

  const diagnostic = await readFile(getCodeModeDiagnosticPath(), "utf8");
  assert.deepEqual(writes, []);
  assert.match(diagnostic, new RegExp(diagnosticId));
  assert.match(diagnostic, /MCP call failed/);
  assert.match(diagnostic, /\[REDACTED\]/);
  assert.doesNotMatch(diagnostic, /opaque-diagnostic|\u001b|\[31m/);
  const path = getCodeModeDiagnosticPath();
  assert.equal((await stat(path)).mode & 0o777, 0o600);

  await writeFile(path, Buffer.alloc(MAX_DIAGNOSTIC_LOG_BYTES, "x"));
  const rotatedId = logDiagnostic(
    "MCP retry failed",
    new Error("second transport failure"),
  );
  const [active, previous] = await Promise.all([
    readFile(path, "utf8"),
    readFile(`${path}.old`),
  ]);
  assert.match(active, new RegExp(rotatedId));
  assert.equal(Buffer.byteLength(active), (await stat(path)).size);
  assert.equal(Buffer.byteLength(previous), MAX_DIAGNOSTIC_LOG_BYTES);
  assert.ok(Buffer.byteLength(active) < MAX_DIAGNOSTIC_LOG_BYTES);
});
