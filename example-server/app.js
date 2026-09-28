import dotenv from "dotenv";
import { App } from "octokit";
import { createNodeMiddleware } from "@octokit/webhooks";
import fs from "fs";
import http from "http";

// quiet suppresses dotenv's own startup banner, which would otherwise be the first thing a
// reader sees. Errors are still reported.
dotenv.config({ quiet: true });

// --- Configuration ---

// Every value below is required. Exiting here with a specific message is friendlier than
// failing later inside an API call or while reading the private key.
function requireEnv(name, hint) {
  const value = process.env[name];
  if (!value) {
    console.error(`${name} is not set. ${hint}`);
    process.exit(1);
  }
  return value;
}

const appId = requireEnv("APP_ID", "Set it in .env to your GitHub App's ID, shown on the app settings page.");
const webhookSecret = requireEnv(
  "WEBHOOK_SECRET",
  "Set it in .env to the webhook secret you configured when creating the app."
);
const privateKeyPath = requireEnv(
  "PRIVATE_KEY_PATH",
  "Set it in .env to the path of the .pem private key you generated for the app."
);
const displayName = requireEnv(
  "DISPLAY_NAME",
  "Set it in .env to the namespace display name to register " +
    "(1–15 characters, alphanumeric only, unique within the org)."
);

// The sync runs on a fixed schedule, clamped to a practical range: often enough to be useful,
// rarely enough not to hammer the API. Both bounds sit far inside setInterval's signed 32-bit
// millisecond limit, so the delay can neither overflow nor fall below the timer's resolution.
const DEFAULT_SYNC_INTERVAL_MINUTES = 60;
const MIN_SYNC_INTERVAL_MINUTES = 5;
const MAX_SYNC_INTERVAL_MINUTES = 7 * 24 * 60; // one week

// Number() rather than parseInt() so that a value like "60 minutes" is rejected instead of
// being silently truncated to 60.
const requestedSyncIntervalMinutes = Number(
  process.env.SYNC_INTERVAL_MINUTES ?? DEFAULT_SYNC_INTERVAL_MINUTES
);

// Zero, negative, and non-numeric values are rejected rather than clamped: they are typos
// rather than preferences, and silently turning them into a working interval hides the mistake.
if (!Number.isFinite(requestedSyncIntervalMinutes) || requestedSyncIntervalMinutes <= 0) {
  console.error(
    `SYNC_INTERVAL_MINUTES must be a positive number of minutes. ` +
      `Received: "${process.env.SYNC_INTERVAL_MINUTES}".`
  );
  process.exit(1);
}

const syncIntervalMinutes = Math.min(
  Math.max(requestedSyncIntervalMinutes, MIN_SYNC_INTERVAL_MINUTES),
  MAX_SYNC_INTERVAL_MINUTES
);

if (syncIntervalMinutes !== requestedSyncIntervalMinutes) {
  console.warn(
    `SYNC_INTERVAL_MINUTES is ${requestedSyncIntervalMinutes}; using ${syncIntervalMinutes} ` +
      `instead. The sync runs no more often than every ${MIN_SYNC_INTERVAL_MINUTES} minutes ` +
      `and no less often than every ${MAX_SYNC_INTERVAL_MINUTES} minutes (one week).`
  );
}

const syncIntervalMs = syncIntervalMinutes * 60 * 1000;

let privateKey;
try {
  privateKey = fs.readFileSync(privateKeyPath, "utf8");
} catch (error) {
  console.error(
    `Could not read the private key at "${privateKeyPath}": ${error.message}\n` +
      `Check that PRIVATE_KEY_PATH in .env points to the .pem file you downloaded.`
  );
  process.exit(1);
}

const app = new App({
  appId,
  privateKey,
  webhooks: {
    secret: webhookSecret,
  },
});

// Every REST request sends the API version header. GraphQL requests do not use it.
const API_VERSION_HEADERS = { "x-github-api-version": "2022-11-28" };

// --- Properties to write ---
// Customize these for your use case.

function getProperties() {
  return [
    { property_name: "environment", value: "production" },
    { property_name: "service", value: "web" },
    { property_name: "team", value: "platform-engineering" },
    { property_name: "last_synced", value: new Date().toISOString() },
  ];
}

// --- Endpoint 1: Register this installation's namespace (display name) ---
// POST /orgs/{org}/properties/installations
//
// Requires the app installation to have ADMIN on "External custom properties for repositories".
// Registration is a one-time, immutable step that reserves `display_name` as this
// installation's namespace in the org. Values are surfaced as "<display_name>.<property_name>".
//
// Returns true if the installation is registered (now or previously), false if it could not
// be registered here (e.g. the app only has Write and must be registered by an org admin).
async function registerNamespace(octokit, org) {
  console.log(`Registering namespace "${displayName}" for org: ${org}`);

  try {
    const response = await octokit.request("POST /orgs/{org}/properties/installations", {
      org,
      display_name: displayName,
      headers: API_VERSION_HEADERS,
    });
    console.log(
      `Registered namespace "${response.data.display_name}" ` +
      `for installation ${response.data.installation.id} in ${org}`
    );
    return true;
  } catch (error) {
    const status = error.response?.status;
    const errors = error.response?.data?.errors || [];

    // Already registered — treat as success and continue.
    if (status === 422 && errors.some((e) => e.field === "installation_id" && e.code === "already_exists")) {
      console.log(`Namespace already registered for ${org}. Continuing.`);
      return true;
    }

    // Display name already taken by another app in this org — cannot proceed with this name.
    if (status === 422 && errors.some((e) => e.field === "display_name" && e.code === "already_exists")) {
      console.error(
        `Display name "${displayName}" is already in use by another app in ${org}. ` +
        `Choose a different DISPLAY_NAME in .env.`
      );
      return false;
    }

    // App installation lacks ADMIN and cannot self-register.
    if (status === 403) {
      console.warn(
        `This app installation cannot register itself in ${org} (it needs ADMIN on ` +
        `"External custom properties for repositories"). An org admin — or a user/token with the ` +
        `organization_external_properties_for_repos:admin fine-grained permission — must call the ` +
        `registration endpoint with this installation's installation_id (see the README, ` +
        `"Write-only apps"). Value writes will fail until the installation is registered.`
      );
      return false;
    }

    logRequestError(`registering namespace for ${org}`, error);
    return false;
  }
}

// --- Endpoint 2: Get registered GitHub App installations ---
// GET /orgs/{org}/properties/installations
//
// Returns the registrations visible to the authenticated caller.
async function getRegisteredInstallations(octokit, org) {
  try {
    const response = await octokit.request("GET /orgs/{org}/properties/installations", {
      org,
      headers: API_VERSION_HEADERS,
    });
    return response.data;
  } catch (error) {
    logRequestError(`getting registered app installations for ${org}`, error);
    throw error;
  }
}

// --- Endpoint 3: Write external custom property values ---
// PATCH /orgs/{org}/properties/installations/values
//
// Requires the app installation to have WRITE (or Admin) on "External custom properties for repositories".
// The installation must already be registered; otherwise the API returns 422 "not registered".
async function writeExternalCustomProperties(octokit, org, repositoryNames, properties) {
  console.log(`Writing external custom properties to repos in ${org}: ${repositoryNames.join(", ")}`);

  try {
    await octokit.request("PATCH /orgs/{org}/properties/installations/values", {
      org,
      repository_names: repositoryNames,
      properties,
      headers: API_VERSION_HEADERS,
    });
    console.log(`Successfully wrote external custom properties in ${org} (HTTP 204)`);
    return true;
  } catch (error) {
    if (isNotRegisteredError(error)) {
      console.warn(
        `Cannot write properties to ${org}: the app installation is not registered yet. ` +
        `Register the namespace first (or wait for an org admin to register a write-only app).`
      );
      return false;
    }

    logRequestError(`writing properties in ${org}`, error);
    return false;
  }
}

// --- Endpoint 4: Update one external custom property across repositories ---
// PATCH /orgs/{org}/properties/installations/values/{property_name}
//
// A null value unsets the named property for that repository.
// Called only from runOptInExamples, where the call is commented out by default.
// eslint-disable-next-line no-unused-vars
async function updateExternalCustomPropertyValues(
  octokit,
  org,
  propertyName,
  repositoryValues
) {
  try {
    await octokit.request(
      "PATCH /orgs/{org}/properties/installations/values/{property_name}",
      {
        org,
        property_name: propertyName,
        repository_values: repositoryValues,
        headers: API_VERSION_HEADERS,
      }
    );
    console.log(
      `Successfully updated external custom property "${propertyName}" in ${org} (HTTP 204)`
    );
    return true;
  } catch (error) {
    if (isNotRegisteredError(error)) {
      console.warn(
        `Cannot update "${propertyName}" in ${org}: the app installation is not registered yet.`
      );
      return false;
    }

    logRequestError(`updating external custom property "${propertyName}" in ${org}`, error);
    return false;
  }
}

// --- Endpoint 5: Remove one external custom property across the organization ---
// DELETE /orgs/{org}/properties/installations/values/{property_name}
// Called only from runOptInExamples, where the call is commented out by default.
// eslint-disable-next-line no-unused-vars
async function deleteExternalCustomPropertyValues(octokit, org, propertyName) {
  try {
    await octokit.request(
      "DELETE /orgs/{org}/properties/installations/values/{property_name}",
      {
        org,
        property_name: propertyName,
        headers: API_VERSION_HEADERS,
      }
    );
    console.log(
      `Removed external custom property "${propertyName}" from all repositories in ${org} ` +
      `(HTTP 204)`
    );
    return true;
  } catch (error) {
    if (error.response?.status === 404) {
      console.warn(
        `Delete request for external custom property "${propertyName}" in ${org} returned HTTP 404.`
      );
      logRequestError(`removing external custom property "${propertyName}" in ${org}`, error);
      return false;
    }

    if (isNotRegisteredError(error)) {
      console.warn(
        `Cannot remove "${propertyName}" in ${org}: the app installation is not registered yet.`
      );
      return false;
    }

    logRequestError(`removing external custom property "${propertyName}" in ${org}`, error);
    return false;
  }
}

// --- Endpoint 6: Read the registered property schema ---
// GET /orgs/{org}/properties/installations/schema
//
// Requires the app installation to have READ (or higher) on "External custom properties for repositories".
// Returns the sorted, unique property names visible to this installation. Useful to verify a write.
async function readOrgSchema(octokit, org) {
  console.log(`Reading external custom property schema for org: ${org}`);

  try {
    const response = await octokit.request("GET /orgs/{org}/properties/installations/schema", {
      org,
      headers: API_VERSION_HEADERS,
    });
    const names = response.data.map((definition) => definition.property_name);
    console.log(`Registered property names for ${org}: ${names.join(", ") || "(none)"}`);
    return names;
  } catch (error) {
    if (isNotRegisteredError(error)) {
      console.warn(`Cannot read schema for ${org}: the app installation is not registered yet.`);
      return [];
    }

    logRequestError(`reading schema for ${org}`, error);
    throw error;
  }
}

// --- Read repository custom property values with REST ---
// GET /repos/{owner}/{repo}/properties/values
async function readRepositoryCustomPropertyValues(octokit, owner, repo) {
  try {
    const response = await octokit.request(
      "GET /repos/{owner}/{repo}/properties/values",
      {
        owner,
        repo,
        headers: API_VERSION_HEADERS,
      }
    );
    return response.data;
  } catch (error) {
    logRequestError(`reading custom property values for ${owner}/${repo}`, error);
    throw error;
  }
}

// --- Read repository custom property values with GraphQL ---
//
// `repositoryCustomPropertyValues` lists the values visible on a repository. Pass the previous
// page's `pageInfo.endCursor` as `cursor` while `pageInfo.hasNextPage` is true.
async function readRepositoryCustomPropertiesWithGraphql(octokit, owner, repo, cursor = null) {
  const data = await octokit.graphql(
    `query RepositoryCustomPropertyValues($owner: String!, $repo: String!, $cursor: String) {
      repository(owner: $owner, name: $repo) {
        repositoryCustomPropertyValues(first: 100, after: $cursor) {
          nodes {
            propertyName
            value
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }
    }`,
    { owner, repo, cursor }
  );

  return data.repository.repositoryCustomPropertyValues;
}

// --- Read one qualified property with GraphQL ---
//
// Pass the namespace-qualified name, such as "acme.environment". This field returns an error when
// the property does not exist or has no value on the repository, so keep it in its own request and
// return null instead of failing the surrounding read.
async function readRepositoryCustomPropertyWithGraphql(octokit, owner, repo, propertyName) {
  try {
    const data = await octokit.graphql(
      `query RepositoryCustomPropertyValue(
        $owner: String!
        $repo: String!
        $propertyName: String!
      ) {
        repository(owner: $owner, name: $repo) {
          repositoryCustomPropertyValue(propertyName: $propertyName) {
            propertyName
            value
          }
        }
      }`,
      { owner, repo, propertyName }
    );

    return data.repository.repositoryCustomPropertyValue;
  } catch (error) {
    const unsetProperty = (error.errors || []).some(
      (e) =>
        e.type === "NOT_FOUND" && (e.path || []).includes("repositoryCustomPropertyValue")
    );
    if (unsetProperty) {
      console.log(
        `No value for "${propertyName}" on ${owner}/${repo}.`
      );
      return null;
    }

    throw error;
  }
}

// --- Helper: detect the "installation not registered" error ---
// When the installation has not registered a namespace, the values and schema endpoints return
// 422 with a structured error identifying the resource, field, and code. We match that full
// discriminator (resource + field + code), falling back to the exact message. Matching on the
// resource alone would misclassify other external custom properties validation errors as a
// registration failure.

const NOT_REGISTERED_MESSAGE =
  /^The GitHub App installation \d+ is not registered for external custom properties on this organization\.$/;

function isNotRegisteredError(error) {
  if (error.response?.status !== 422) {
    return false;
  }
  const message = error.response?.data?.message || "";
  const errors = error.response?.data?.errors || [];
  const matchesStructured = errors.some(
    (e) =>
      e.resource === "ExternalCustomProperties" &&
      e.field === "installation_id" &&
      e.code === "unprocessable"
  );
  return matchesStructured || NOT_REGISTERED_MESSAGE.test(message);
}

// --- Helper: consistent error logging ---

function logRequestError(context, error) {
  if (error.response) {
    console.error(
      `Error ${context}: Status ${error.response.status} — ${JSON.stringify(error.response.data)}`
    );
  } else {
    console.error(`Error ${context}:`, error);
  }
}

// --- Helper: fetch the first repo in an org (this sample writes to one repo) ---

async function getFirstRepoName(octokit, org) {
  const reposResponse = await octokit.request("GET /orgs/{org}/repos", {
    org,
    per_page: 1,
    sort: "full_name",
    headers: API_VERSION_HEADERS,
  });
  const repos = reposResponse.data;
  return repos.length > 0 ? repos[0].name : null;
}

// --- Webhook handler: installation.created ---
// Full calling pattern: register the namespace, then write values, then read the schema to verify.

async function handleInstallationCreated({ octokit, payload }) {
  const org = payload.installation.account.login;

  console.log(`Received installation.created event for org: ${org}`);

  const registered = await registerNamespace(octokit, org);
  if (!registered) {
    console.log(`Skipping writes for ${org} until the installation is registered.`);
    return;
  }

  console.log(`Fetching repositories for org: ${org}...`);
  const firstRepo = await getFirstRepoName(octokit, org);
  if (!firstRepo) {
    console.log(`No repositories found in org ${org}. Skipping.`);
    return;
  }

  const written = await writeExternalCustomProperties(octokit, org, [firstRepo], getProperties());
  if (!written) {
    console.log(
      `Skipping schema verification for ${org} because the external custom properties write did not succeed.`
    );
    return;
  }

  try {
    await readOrgSchema(octokit, org);
  } catch {
    // Verification is best-effort after registration and writing have completed.
  }
}

app.webhooks.on("installation.created", handleInstallationCreated);

app.webhooks.onError((error) => {
  if (error.name === "AggregateError") {
    console.error(`Error processing request: ${error.event}`);
  } else {
    console.error(error);
  }
});

// --- Periodic sync ---
// Re-applies properties on a schedule to catch drift or newly added repos. Assumes the
// installation is already registered (from the installation.created flow, or by an org admin for
// write-only apps). If it is not yet registered, writeExternalCustomProperties logs a clear message.

async function periodicSync() {
  console.log(`[Sync] Running periodic sync...`);

  try {
    for await (const { installation } of app.eachInstallation.iterator()) {
      const octokit = await app.getInstallationOctokit(installation.id);
      const org = installation.account.login;

      const firstRepo = await getFirstRepoName(octokit, org);
      if (!firstRepo) {
        console.log(`[Sync] No repos for org ${org}. Skipping.`);
        continue;
      }

      await writeExternalCustomProperties(octokit, org, [firstRepo], getProperties());
    }

    console.log(`[Sync] Periodic sync complete.`);
  } catch (error) {
    console.error(`[Sync] Error during periodic sync:`, error);
  }
}

setInterval(periodicSync, syncIntervalMs);

// --- Opt-in examples ---
// Nothing calls this function. Calling runOptInExamples(app) yourself performs the read-only
// requests below against the first repository in each installed organization. The two examples
// that change values are left commented out.

// eslint-disable-next-line no-unused-vars
async function runOptInExamples(app) {
  for await (const { installation } of app.eachInstallation.iterator()) {
    const octokit = await app.getInstallationOctokit(installation.id);
    const org = installation.account.login;

    // List the registrations visible to this caller.
    await getRegisteredInstallations(octokit, org);

    const repo = await getFirstRepoName(octokit, org);
    if (!repo) {
      console.log(`[Examples] No repos for org ${org}. Skipping read examples.`);
      continue;
    }

    // Read the values on one repository with REST, then with GraphQL.
    await readRepositoryCustomPropertyValues(octokit, org, repo);
    await readRepositoryCustomPropertiesWithGraphql(octokit, org, repo);

    // Read one value by its namespace-qualified name. Returns null when it is not set.
    await readRepositoryCustomPropertyWithGraphql(
      octokit,
      org,
      repo,
      `${displayName}.environment`
    );

    // Sparsely set one property on some repositories, and unset it on others.
    // await updateExternalCustomPropertyValues(octokit, org, "environment", [
    //   { repository_name: "api", value: "production" },
    //   { repository_name: "web", value: null },
    // ]);

    // WARNING: this removes the named property and all of its values across the organization.
    // await deleteExternalCustomPropertyValues(octokit, org, "deprecated_property");
  }
}

// --- HTTP Server ---

const port = process.env.PORT || 3000;
const host = process.env.NODE_ENV === "production" ? "0.0.0.0" : "localhost";
const path = "/api/webhook";
const localWebhookUrl = `http://${host}:${port}${path}`;

const middleware = createNodeMiddleware(app.webhooks, { path });

http.createServer(middleware).listen(port, () => {
  console.log(`Server is listening for events at: ${localWebhookUrl}`);
  console.log(`Registering namespace "${displayName}" on new installations`);
  console.log(`Periodic sync scheduled every ${syncIntervalMinutes} minutes`);
  console.log("Press Ctrl + C to quit.");
});
