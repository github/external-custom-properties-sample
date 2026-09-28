// Intercepts the GitHub API so the sample's endpoint calls can be observed without network
// access, and without app.js knowing it is under test.
//
// This module is preloaded with --import, ahead of app.js. It does two separate things:
//
//   1. Swaps the global fetch dispatcher for an undici MockAgent, which supplies the responses.
//   2. Wraps global fetch to record each outgoing request.
//
// Recording happens at the fetch boundary rather than inside the MockAgent reply callbacks,
// because the request body Octokit passes to fetch is a plain string on every supported Node
// version, whereas the shape undici hands to a dispatcher is an internal detail that has
// differed between releases.
//
// Requests are appended to the file named by MOCK_RECORD_PATH, one JSON object per line.

import { appendFileSync } from "node:fs";
import { MockAgent, setGlobalDispatcher } from "undici";

const recordPath = process.env.MOCK_RECORD_PATH;
const scenario = process.env.MOCK_SCENARIO ?? "happy";
const org = process.env.MOCK_ORG ?? "acme-org";
const installationId = Number(process.env.MOCK_INSTALLATION_ID ?? 42);

const agent = new MockAgent();
// Any request not intercepted below should fail loudly rather than reach the network.
agent.disableNetConnect();
setGlobalDispatcher(agent);

const api = agent.get("https://api.github.com");

// Octokit leaves the body as an unparsed string unless the response says it is JSON, which
// would hide the structured resource/field/code the sample matches registration errors on.
const JSON_HEADERS = { headers: { "content-type": "application/json" } };

// --- Recording -------------------------------------------------------------------------------

const realFetch = globalThis.fetch;

globalThis.fetch = async function recordingFetch(input, init) {
  if (recordPath) {
    const request = input instanceof Request ? input : null;
    const url = new URL(request ? request.url : String(input));
    const method = (init?.method ?? request?.method ?? "GET").toUpperCase();

    let body;
    const raw = init?.body ?? (request ? await request.clone().text() : undefined);
    if (typeof raw === "string" && raw.length > 0) {
      try {
        body = JSON.parse(raw);
      } catch {
        body = raw;
      }
    }

    appendFileSync(
      recordPath,
      `${JSON.stringify({ method, path: `${url.pathname}${url.search}`, body })}\n`
    );
  }

  return realFetch(input, init);
};

// --- Responses -------------------------------------------------------------------------------

// Octokit exchanges the app JWT for an installation token before any other call.
api
  .intercept({ path: `/app/installations/${installationId}/access_tokens`, method: "POST" })
  .reply(
    201,
    {
      token: "ghs_mock_installation_token",
      expires_at: "2099-01-01T00:00:00Z",
      permissions: { organization_external_properties_for_repos: "admin" },
    },
    JSON_HEADERS
  )
  .persist();

// Endpoint 1: register the namespace.
const registration = api.intercept({
  path: `/orgs/${org}/properties/installations`,
  method: "POST",
});

if (scenario === "already-registered") {
  registration.reply(
    422,
    {
      message: `GitHub app installation ${installationId} is already registered.`,
      errors: [
        { resource: "ExternalCustomProperties", field: "installation_id", code: "already_exists" },
      ],
    },
    JSON_HEADERS
  );
} else if (scenario === "forbidden") {
  registration.reply(403, { message: "Resource not accessible by integration" }, JSON_HEADERS);
} else {
  registration.reply(
    201,
    { display_name: process.env.DISPLAY_NAME, installation: { id: installationId } },
    JSON_HEADERS
  );
}

// The sample writes to the first repository in the organization.
api
  .intercept({ path: (path) => path.startsWith(`/orgs/${org}/repos`), method: "GET" })
  .reply(200, [{ name: "example-repo" }], JSON_HEADERS)
  .persist();

// Endpoint 3: batch write. The real API answers 204 with no body.
api
  .intercept({ path: `/orgs/${org}/properties/installations/values`, method: "PATCH" })
  .reply(204, "")
  .persist();

// Endpoint 6: read back the definitions, which the sample uses to verify the write.
api
  .intercept({ path: `/orgs/${org}/properties/installations/schema`, method: "GET" })
  .reply(
    200,
    [
      { property_name: "environment" },
      { property_name: "last_synced" },
      { property_name: "service" },
      { property_name: "team" },
    ],
    JSON_HEADERS
  )
  .persist();
