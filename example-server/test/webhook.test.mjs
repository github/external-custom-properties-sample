// Exercises the API calls the sample makes when an installation webhook arrives.
//
// As in config.test.mjs, app.js is unchanged. The server runs as a process and is driven through
// its real webhook endpoint with a properly signed payload; the GitHub API it calls is
// intercepted by test/helpers/github-api-mock.mjs, preloaded with --import.

import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { createHmac, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";

const testDir = dirname(fileURLToPath(import.meta.url));
const serverDir = dirname(testDir);
const mockPath = join(testDir, "helpers", "github-api-mock.mjs");

const ORG = "acme-org";
const INSTALLATION_ID = 42;
const WEBHOOK_SECRET = "test-webhook-secret";
const DISPLAY_NAME = "acme";

let workDir;
let privateKeyPath;
let port = 3100;

before(() => {
  workDir = mkdtempSync(join(tmpdir(), "external-custom-properties-api-"));
  privateKeyPath = join(workDir, "private-key.pem");

  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  writeFileSync(privateKeyPath, privateKey.export({ type: "pkcs8", format: "pem" }));
});

after(() => {
  rmSync(workDir, { recursive: true, force: true });
});

// Runs the server until it has finished handling one installation.created webhook, then returns
// every GitHub API request it made, in order.
async function deliverInstallationWebhook({ scenario = "happy" } = {}) {
  const recordPath = join(workDir, `calls-${scenario}-${port}.jsonl`);
  const serverPort = port++;

  const child = spawn(process.execPath, ["--import", mockPath, join(serverDir, "app.js")], {
    // Run from the temporary directory so dotenv cannot pick up a developer's .env.
    cwd: workDir,
    env: {
      PATH: process.env.PATH,
      APP_ID: "12345",
      WEBHOOK_SECRET,
      PRIVATE_KEY_PATH: privateKeyPath,
      DISPLAY_NAME,
      PORT: String(serverPort),
      MOCK_RECORD_PATH: recordPath,
      MOCK_SCENARIO: scenario,
      MOCK_ORG: ORG,
      MOCK_INSTALLATION_ID: String(INSTALLATION_ID),
    },
  });

  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));

  try {
    await waitFor(() => output.includes("Press Ctrl + C to quit."), "the server to start", output);

    const payload = JSON.stringify({
      action: "created",
      installation: { id: INSTALLATION_ID, account: { login: ORG } },
    });

    const signature = createHmac("sha256", WEBHOOK_SECRET).update(payload).digest("hex");

    const response = await fetch(`http://127.0.0.1:${serverPort}/api/webhook`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "installation",
        "x-github-delivery": `test-${serverPort}`,
        "x-hub-signature-256": `sha256=${signature}`,
      },
      body: payload,
    });

    assert.equal(response.status, 200, `webhook was rejected: ${await response.text()}`);

    // The handler finishes asynchronously; wait for its last log line rather than guessing.
    const settled = scenario === "forbidden" ? "Skipping writes" : "Registered property names";
    await waitFor(() => output.includes(settled), `the handler to finish (${settled})`, output);
  } finally {
    child.kill("SIGKILL");
  }

  const calls = existsSync(recordPath)
    ? readFileSync(recordPath, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];

  // The token exchange is Octokit's own bookkeeping rather than part of the sample's flow.
  return { calls: calls.filter((c) => !c.path.includes("access_tokens")), output };
}

async function waitFor(condition, description, snapshot) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${description}. Output so far:\n${snapshot}`);
}

describe("installation webhook", () => {
  it("registers, writes values, then reads the definitions back", async () => {
    const { calls } = await deliverInstallationWebhook();

    assert.deepEqual(
      calls.map((call) => `${call.method} ${call.path.split("?")[0]}`),
      [
        `POST /orgs/${ORG}/properties/installations`,
        `GET /orgs/${ORG}/repos`,
        `PATCH /orgs/${ORG}/properties/installations/values`,
        `GET /orgs/${ORG}/properties/installations/schema`,
      ],
      "the documented calling pattern is register, then write, then verify"
    );
  });

  it("registers the namespace using the configured display name", async () => {
    const { calls } = await deliverInstallationWebhook();
    const registration = calls.find((call) => call.method === "POST");

    assert.deepEqual(registration.body, { display_name: DISPLAY_NAME });
  });

  it("writes the sample's properties to the organization's first repository", async () => {
    const { calls } = await deliverInstallationWebhook();
    const write = calls.find((call) => call.method === "PATCH");

    assert.deepEqual(write.body.repository_names, ["example-repo"]);
    assert.deepEqual(
      write.body.properties.map((property) => property.property_name).sort(),
      ["environment", "last_synced", "service", "team"],
      "every property returned by getProperties should be sent"
    );

    const lastSynced = write.body.properties.find((p) => p.property_name === "last_synced");
    assert.ok(
      !Number.isNaN(Date.parse(lastSynced.value)),
      `last_synced should be a timestamp, got ${lastSynced.value}`
    );
  });
});

describe("registration errors", () => {
  it("treats an already-registered installation as success and still writes", async () => {
    const { calls, output } = await deliverInstallationWebhook({ scenario: "already-registered" });

    assert.match(output, /Namespace already registered/);
    assert.ok(
      calls.some((call) => call.method === "PATCH"),
      "a 422 already_exists should not stop the write"
    );
  });

  it("stops before writing when the installation may not register itself", async () => {
    const { calls, output } = await deliverInstallationWebhook({ scenario: "forbidden" });

    assert.match(output, /cannot register itself/);
    assert.equal(
      calls.filter((call) => call.method === "PATCH").length,
      0,
      "values must not be written for an installation that is not registered"
    );
  });
});
