import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const enabled = process.env.PI_CODE_MODE_PACKAGING_E2E === "1";
const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

function digest(value: Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

test(
  "Code Mode installs and runs from a clean copied Pi agent layout",
  { skip: !enabled },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "pi-code-mode-package-"));
    const home = join(root, "home");
    const agent = join(home, ".pi", "agent");
    t.after(() => rm(root, { recursive: true, force: true }));
    await mkdir(join(home, ".pi"), { recursive: true });

    await execFileAsync(
      "rsync",
      [
        "-a",
        "--exclude",
        "node_modules",
        "--exclude",
        ".git",
        `${repositoryRoot}/`,
        `${agent}/`,
      ],
      { timeout: 30_000 },
    );
    const lockPath = join(agent, "package-lock.json");
    const before = digest(await readFile(lockPath));
    const environment = {
      ...process.env,
      HOME: home,
      PI_CODE_MODE_CONTEXT7_E2E: "0",
      PI_CODE_MODE_PACKAGING_E2E: "0",
    };
    await execFileAsync("npm", ["install", "--ignore-scripts"], {
      cwd: agent,
      env: environment,
      timeout: 120_000,
    });
    assert.equal(digest(await readFile(lockPath)), before);

    await execFileAsync("npm", ["run", "check"], {
      cwd: agent,
      env: environment,
      timeout: 120_000,
    });
    await execFileAsync("npm", ["--prefix", "extensions/code-mode", "test"], {
      cwd: agent,
      env: environment,
      timeout: 120_000,
    });
    await execFileAsync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `Promise.all([import("just-bash"), import("@modelcontextprotocol/client"), import("@napi-rs/keyring"), import("recheck")]).then(([bash, mcp, keyring, recheck]) => { if (typeof bash.Bash !== "function" || typeof mcp.Client !== "function" || typeof keyring.Entry !== "function" || typeof recheck.checkSync !== "function") process.exit(1); });`,
      ],
      { cwd: agent, env: environment, timeout: 30_000 },
    );
  },
);
