import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { access, cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const extensionDirectory = path.dirname(fileURLToPath(import.meta.url));

test("runtime npm ci installs diff without a nested Pi package instance", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "hashline-install-"));
  try {
    await cp(
      path.join(extensionDirectory, "package.json"),
      path.join(directory, "package.json"),
    );
    await cp(
      path.join(extensionDirectory, "package-lock.json"),
      path.join(directory, "package-lock.json"),
    );
    await execFileAsync(
      "npm",
      ["ci", "--omit=dev", "--omit=peer", "--ignore-scripts"],
      { cwd: directory, timeout: 120_000 },
    );
    const require = createRequire(path.join(directory, "package.json"));
    assert.match(require.resolve("diff"), /node_modules[\\/]diff/);
    await assert.rejects(
      access(path.join(directory, "node_modules", "@earendil-works")),
      /ENOENT/,
    );
    const packageJson = JSON.parse(
      await readFile(path.join(directory, "package.json"), "utf8"),
    );
    for (const peer of Object.keys(packageJson.peerDependencies)) {
      assert.equal(packageJson.peerDependenciesMeta?.[peer]?.optional, true);
    }
    const setup = await readFile(
      path.join(extensionDirectory, "..", "..", "SETUP.md"),
      "utf8",
    );
    assert.match(
      setup,
      /npm --prefix extensions\/hashline ci --omit=dev --omit=peer/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
