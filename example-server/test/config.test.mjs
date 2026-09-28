// Tests run the server the same way a reader does: as a process, with an environment.
//
// Nothing in app.js is exported or restructured for the benefit of these tests. The sample is
// meant to be read top to bottom and copied, so it is exercised from the outside instead.

import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";

const serverDir = dirname(dirname(fileURLToPath(import.meta.url)));

let workDir;
let privateKeyPath;

before(() => {
  workDir = mkdtempSync(join(tmpdir(), "external-custom-properties-test-"));
  privateKeyPath = join(workDir, "private-key.pem");

  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  writeFileSync(privateKeyPath, privateKey.export({ type: "pkcs8", format: "pem" }));
});

after(() => {
  rmSync(workDir, { recursive: true, force: true });
});

// Starts the server with the given environment. A valid configuration leaves the process
// listening, so rather than waiting a fixed period, this resolves as soon as the last startup
// line appears and then stops the process. An invalid configuration exits on its own.
function start(env = {}) {
  const READY = "Press Ctrl + C to quit.";

  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(serverDir, "app.js")], {
      // Run from a temporary directory, not from the server directory. dotenv.config() reads
      // .env relative to the working directory, and the README tells developers to create one
      // there — it would otherwise supply the very variables these tests remove.
      cwd: workDir,
      // A bare environment keeps the developer's shell out of the result as well.
      env: { PATH: process.env.PATH, ...env },
    });

    let output = "";
    let settled = false;

    const finish = (started, exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(safetyNet);
      resolve({ output, exitCode, started });
    };

    const onData = (chunk) => {
      output += chunk;
      if (output.includes(READY)) {
        child.kill("SIGKILL");
        finish(true, null);
      }
    };

    // Never reached in a passing run; it stops a hung process from stalling the suite.
    const safetyNet = setTimeout(() => {
      child.kill("SIGKILL");
      finish(false, null);
    }, 10000);

    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("close", (code) => finish(false, code));
  });
}

function validEnv(overrides = {}) {
  return {
    APP_ID: "12345",
    WEBHOOK_SECRET: "test-secret",
    PRIVATE_KEY_PATH: privateKeyPath,
    DISPLAY_NAME: "acme",
    ...overrides,
  };
}

describe("required configuration", () => {
  for (const name of ["APP_ID", "WEBHOOK_SECRET", "PRIVATE_KEY_PATH", "DISPLAY_NAME"]) {
    it(`reports ${name} by name when it is missing`, async () => {
      const env = validEnv();
      delete env[name];

      const { output, exitCode } = await start(env);

      assert.equal(exitCode, 1, `expected a non-zero exit, got: ${output}`);
      assert.match(output, new RegExp(`${name} is not set`));
    });
  }

  it("explains an unreadable private key and names the path", async () => {
    const missing = join(workDir, "does-not-exist.pem");
    const { output, exitCode } = await start(validEnv({ PRIVATE_KEY_PATH: missing }));

    assert.equal(exitCode, 1);
    assert.match(output, /Could not read the private key/);
    assert.ok(output.includes(missing), "the message should name the path it tried");
    assert.match(output, /PRIVATE_KEY_PATH/);
  });
});

describe("sync interval", () => {
  // Rejected outright: these are mistakes rather than preferences, so clamping would hide them.
  for (const value of ["abc", "60 minutes", "0", "-5"]) {
    it(`rejects ${JSON.stringify(value)}`, async () => {
      const { output, exitCode } = await start(validEnv({ SYNC_INTERVAL_MINUTES: value }));

      assert.equal(exitCode, 1, `expected a non-zero exit, got: ${output}`);
      assert.match(output, /SYNC_INTERVAL_MINUTES must be a positive number/);
    });
  }

  // Clamped: a real interval, just outside the range the sample supports.
  for (const [value, effective] of [
    ["1", 5],
    ["0.000001", 5],
    ["43200", 10080],
  ]) {
    it(`clamps ${value} to ${effective} minutes`, async () => {
      const { output, started } = await start(validEnv({ SYNC_INTERVAL_MINUTES: value }));

      assert.ok(started, `expected the server to start, got: ${output}`);
      assert.match(output, new RegExp(`using ${effective} instead`));
      assert.match(output, new RegExp(`Periodic sync scheduled every ${effective} minutes`));
    });
  }

  for (const value of ["5", "10080"]) {
    it(`accepts ${value} unchanged`, async () => {
      const { output, started } = await start(validEnv({ SYNC_INTERVAL_MINUTES: value }));

      assert.ok(started, `expected the server to start, got: ${output}`);
      assert.doesNotMatch(output, /instead/);
      assert.match(output, new RegExp(`Periodic sync scheduled every ${value} minutes`));
    });
  }

  it("defaults to 60 minutes when unset", async () => {
    const { output, started } = await start(validEnv());

    assert.ok(started, `expected the server to start, got: ${output}`);
    assert.match(output, /Periodic sync scheduled every 60 minutes/);
  });
});

describe("startup output", () => {
  // The README shows this output in Step 4. Pinning it here means a dependency that starts
  // printing on load, as dotenv did, fails the build instead of quietly making the guide wrong.
  it("matches what the README documents", async () => {
    const { output, started } = await start(validEnv());

    assert.ok(started, `expected the server to start, got: ${output}`);

    const lines = output.split("\n").filter((line) => line.trim());
    assert.equal(
      lines[0],
      "Server is listening for events at: http://localhost:3000/api/webhook",
      "the first line a reader sees should be the server's own output"
    );
    assert.match(output, /Registering namespace "acme" on new installations/);
    assert.match(output, /Press Ctrl \+ C to quit\./);
  });
});
