# External custom properties example server

A runnable GitHub App that writes external custom properties to repositories in an organization.

**New to external custom properties?** Start with [Integrating custom properties with an external system](https://docs.github.com/en/organizations/managing-organization-settings/sync-external-custom-properties), which explains what they are, how namespacing and registration work, and the permissions an app needs. This README covers configuring and running *this* server.

---

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Permissions and who registers](#permissions-and-who-registers)
3. [Step 1: Get a Webhook Proxy URL](#step-1-get-a-webhook-proxy-url)
4. [Step 2: Register a GitHub App](#step-2-register-a-github-app)
5. [Step 3: Generate and Store Credentials](#step-3-generate-and-store-credentials)
6. [Step 4: Run the Example Server](#step-4-run-the-example-server)
7. [Step 5: Install the App on Your Organization](#step-5-install-the-app-on-your-organization)
8. [Step 6: Test the Integration](#step-6-test-the-integration)
9. [API Reference](#api-reference)
10. [Reading external custom property values](#reading-external-custom-property-values)
11. [Troubleshooting](#troubleshooting)
12. [Contributing](#contributing)
13. [Support](#support)
14. [Maintainers](#maintainers)
15. [Security](#security)
16. [License](#license)

---

## Prerequisites

- **Node.js** version 24 or greater, which includes a compatible **npm** ([download](https://nodejs.org/))
- A **GitHub organization** with at least one repository
- A webhook proxy for local development — this guide uses [Smee.io](https://smee.io/)

If you're new to building GitHub Apps, the [Quickstart for building GitHub Apps](https://docs.github.com/en/apps/creating-github-apps/writing-code-for-a-github-app/quickstart) provides a general introduction to the concepts used here.

---

## Permissions and who registers

Before an app can write values, its installation must be registered with a display name. The app can do this itself, or an organization administrator can do it on the app's behalf — which one applies depends on the permission level the app is granted.

**This example server registers itself**, so it asks for **Admin** on the "External custom properties for repositories" organization permission.

For the full permission model — including when to choose Admin versus Read and write, and who can register on an app's behalf — see [Selecting permissions](https://docs.github.com/en/organizations/managing-organization-settings/sync-external-custom-properties#selecting-permissions). The access level and token types each endpoint requires are listed in [Permissions required for GitHub Apps](https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps#organization-permissions-for-external-custom-properties-for-repositories).

---

## Step 1: Get a Webhook Proxy URL

In order to develop your app locally, you need a way to forward webhooks from GitHub to your local machine. This guide uses [Smee.io](https://smee.io/) as a free webhook proxy.

1. In your browser, navigate to [https://smee.io/](https://smee.io/)
2. Click **Start a new channel**
3. Copy the full URL under "Webhook Proxy URL" (e.g. `https://smee.io/abc123...`)

Save this URL — you'll use it when registering your GitHub App and when starting the example server.

> **Note:** Smee.io is intended for local development only. When you deploy your app to production, you'll replace this with your server's public webhook endpoint.

---

## Step 2: Register a GitHub App

For full details on app registration, see [Registering a GitHub App](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app). The steps below cover the settings specific to External custom properties.

1. Navigate to your organization's settings:
   **Organization page → Settings → Developer settings → GitHub Apps → New GitHub App**

2. Fill in the basic details:
   - **GitHub App name**: e.g. `my-org-external-custom-properties`
   - **Homepage URL**: Your app's repository or company URL

3. Configure webhooks:
   - **Webhooks**: Ensure "Active" is checked
   - **Webhook URL**: Your Smee.io proxy URL from Step 1
   - **Webhook secret**: Enter a random secret string — save this for later

4. Set permissions:
   - Under **Organization permissions**, find **"External custom properties for repositories"** and select **Admin**.

   > **Why Admin?** This example server registers its own namespace on installation, which requires Admin. If you'd rather an org owner control namespacing, select **Read and write** instead — see [Selecting permissions](https://docs.github.com/en/organizations/managing-organization-settings/sync-external-custom-properties#selecting-permissions).

5. Subscribe to events:
   - Check the **Installation** event (this fires when the app is installed on an org)

   > **Note:** The example server uses the `installation.created` event to register and write an initial batch of properties as soon as the app is installed. If you're building your own implementation, consider which events make sense for your use case — for example, `repository.created` to tag new repos, `push` to update properties after deploys, or no webhook at all if you prefer a purely scheduled/cron-based approach.

6. Installation scope:
   - Select **"Only on this account"** (you can change this later)

7. Click **Create GitHub App**

---

## Step 3: Generate and Store Credentials

1. After creating the app, note the **App ID** shown on the app settings page.

2. Under **"Private keys"**, click **Generate a private key**. A `.pem` file will download — keep this safe.

3. In the `example-server/` directory, copy the env template and fill in your values:

   ```bash
   cd example-server
   cp .env.example .env
   ```

4. Open `.env` and update the values:

   ```
   APP_ID="12345"
   WEBHOOK_SECRET="your-webhook-secret"
   PRIVATE_KEY_PATH="./your-app-name.2026-06-10.private-key.pem"
   DISPLAY_NAME="acme"
   ```

   - **APP_ID**: The App ID from your app's settings page
   - **WEBHOOK_SECRET**: The webhook secret you chose in Step 2
   - **PRIVATE_KEY_PATH**: Path to the `.pem` file you downloaded
   - **DISPLAY_NAME**: The namespace display name to register. Properties appear in GitHub as `<DISPLAY_NAME>.<property_name>`. For the length and character rules, see [Register an app installation for external custom properties](https://docs.github.com/en/rest/orgs/custom-properties#register-an-app-installation-for-external-custom-properties).

5. Move the downloaded `.pem` file into the `example-server/` directory (or update the path in `.env` to point to its location).

---

## Step 4: Run the Example Server

The `example-server/` directory contains a Node.js application that demonstrates the typical calling pattern:

1. **Listens for the `installation.created` webhook** — when the app is installed on an org, it:
   1. **Registers** the namespace (`DISPLAY_NAME`) for the installation.
   2. **Writes** a set of external custom properties to the org's first repository.
   3. **Reads** the property definitions back to verify the write.
2. **Runs a periodic sync** — every 60 minutes by default, it iterates all installations, fetches the first repo in each org, and re-writes properties (including a `last_synced` timestamp so you can verify the sync is working). Configurable through `SYNC_INTERVAL_MINUTES`, clamped to between 5 minutes and one week. The sync assumes the installation is already registered.

Every API call lives in a clearly-named helper function — `registerNamespace`, `writeExternalCustomProperties`, and `readOrgSchema` for the automatic flow, plus `getRegisteredInstallations`, `updateExternalCustomPropertyValues`, `deleteExternalCustomPropertyValues`, `readRepositoryCustomPropertyValues`, `readRepositoryCustomPropertiesWithGraphql`, and `readRepositoryCustomPropertyWithGraphql` — so you can copy them into your own implementation.

The automatic webhook flow is register → batch write → definitions read. The remaining helpers list visible registrations, sparsely update or unset one property, explicitly delete one property, and read values with REST or GraphQL. They are not wired into the webhook, periodic sync, or startup flow. `app.js` collects them in `runOptInExamples`, which nothing calls: run it yourself to see the read-only calls against the first repository in each organization. The two examples that change values stay commented out, so the destructive delete is never called automatically.

For a detailed walkthrough of how GitHub Apps handle webhook events in Node.js, see [Building a GitHub App that responds to webhook events](https://docs.github.com/en/apps/creating-github-apps/writing-code-for-a-github-app/building-a-github-app-that-responds-to-webhook-events).

### Install dependencies

```bash
cd example-server
npm install
```

### Start the webhook proxy (terminal 1)

```bash
npx smee -u YOUR_WEBHOOK_PROXY_URL -t http://localhost:3000/api/webhook
```

Replace `YOUR_WEBHOOK_PROXY_URL` with the URL from Smee.io.

### Start the server (terminal 2)

```bash
npm run server
```

You should see:

```
Server is listening for events at: http://localhost:3000/api/webhook
Registering namespace "acme" on new installations
Periodic sync scheduled every 60 minutes
```

---

## Step 5: Install the App on Your Organization

1. From your app's settings page, click **"Public page"** (in the left sidebar)
2. Click **Install**
3. Select your organization
4. Click **Install**

> **Note:** You won't be asked to pick individual repositories. See [Install the app](https://docs.github.com/en/organizations/managing-organization-settings/sync-external-custom-properties#4-install-the-app) for why.

When the installation completes, GitHub sends an `installation.created` webhook event to your configured webhook URL. The example server registers the namespace, writes external custom properties to the org's first repository, and reads the schema back.

---

## Step 6: Test the Integration

1. Install the app on your organization (Step 5 above)
2. Watch the terminal running the server — you should see:
   ```
   Received installation.created event for org: my-org
   Registering namespace "acme" for org: my-org
   Registered namespace "acme" for installation 42 in my-org
   Fetching repositories for org: my-org...
   Writing external custom properties to repos in my-org: my-repo
   Successfully wrote external custom properties in my-org (HTTP 204)
   Reading external custom property schema for org: my-org
   Registered property names for my-org: environment, last_synced, service, team
   ```
3. Navigate to your organization's **Settings → Custom properties** to see the external custom properties attached to your repository (shown as `acme.environment`, `acme.service`, etc.)
4. Wait for the periodic sync (or set `SYNC_INTERVAL_MINUTES=5` in `.env`, the fastest the sync will run, to test more quickly) and verify that the `last_synced` property updates with the current timestamp

---


## API Reference

Each endpoint links to its entry in the [REST API reference](https://docs.github.com/en/rest/orgs/custom-properties), which documents the request body, responses, and error cases for that endpoint. Between them, those entries also cover display name rules, property name and value constraints, request size limits, and cleanup behavior. The access level and token types each endpoint requires are listed in [Permissions required for GitHub Apps](https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps#organization-permissions-for-external-custom-properties-for-repositories). The [setup guide](https://docs.github.com/en/organizations/managing-organization-settings/sync-external-custom-properties#3-create-the-automation) lists them in the order an integration typically calls them, and each has a matching helper in [`example-server/app.js`](example-server/app.js).

| Endpoint | Helper function |
|----------|-----------------|
| [`POST /orgs/{org}/properties/installations`](https://docs.github.com/en/rest/orgs/custom-properties#register-an-app-installation-for-external-custom-properties) | `registerNamespace` |
| [`GET /orgs/{org}/properties/installations`](https://docs.github.com/en/rest/orgs/custom-properties#get-registered-app-installations-for-external-custom-properties) | `getRegisteredInstallations` |
| [`GET /orgs/{org}/properties/installations/schema`](https://docs.github.com/en/rest/orgs/custom-properties#get-all-external-custom-properties-for-a-github-app-installation-in-an-organization) | `readOrgSchema` |
| [`PATCH /orgs/{org}/properties/installations/values`](https://docs.github.com/en/rest/orgs/custom-properties#create-or-update-external-custom-property-values-for-organization-repositories) | `writeExternalCustomProperties` |
| [`PATCH /orgs/{org}/properties/installations/values/{property_name}`](https://docs.github.com/en/rest/orgs/custom-properties#create-or-update-external-custom-property-values-for-a-property-across-organization-repositories) | `updateExternalCustomPropertyValues` |
| [`DELETE /orgs/{org}/properties/installations/values/{property_name}`](https://docs.github.com/en/rest/orgs/custom-properties#remove-all-external-custom-property-values-for-a-property-across-all-organization-repositories) | `deleteExternalCustomPropertyValues` |

---

## Reading external custom property values

External custom properties are read back through the existing custom properties APIs — there is no separate read API. Use the namespace-qualified name, such as `acme.environment`.

- **REST:** [Get all custom property values for a repository](https://docs.github.com/en/rest/repos/custom-properties#get-all-custom-property-values-for-a-repository)
- **GraphQL:** the `repositoryCustomPropertyValues` and `repositoryCustomPropertyValue` fields on the [`Repository` object](https://docs.github.com/en/graphql/reference/objects#repository)

For working examples of both, see `readRepositoryCustomPropertyValues`, `readRepositoryCustomPropertiesWithGraphql`, and `readRepositoryCustomPropertyWithGraphql` in [`example-server/app.js`](example-server/app.js).

---

## Troubleshooting

Error responses and their meanings are documented with each endpoint in the [REST API reference](https://docs.github.com/en/rest/orgs/custom-properties).

### Webhook not received

- Verify your Smee proxy is running and connected
- Check that the app's webhook URL matches your Smee channel URL
- Ensure the "Installation" event is subscribed in your app settings
- Check the **Advanced** tab on your app's settings page to see recent webhook deliveries and any failures

---

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for how to set up the project and submit a pull request, and [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) for the terms of participation.

## Support

This sample is under active development and maintained by GitHub staff. See [SUPPORT.md](SUPPORT.md) for how to get help, including where to raise questions about the API itself rather than this sample.

## Maintainers

Maintained by the owners listed in [CODEOWNERS](.github/CODEOWNERS).

## Security

See [SECURITY.md](SECURITY.md) for how to report a security vulnerability. Please do not report vulnerabilities through public issues or pull requests.

## License

This project is licensed under the terms of the MIT open source license. See [LICENSE](LICENSE) for the full terms.
