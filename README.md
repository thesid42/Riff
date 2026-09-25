# Riff

Riff is a local campaign experiment workspace. This foundation build saves campaign drafts and presents campaign results when the API has real data. It does not simulate traffic, generate ads, or start campaigns.

Riff is intended for local, single-user use. The server binds to loopback and has no authentication for public hosting.

## Current phase

Implemented:

- Results-first dashboard with campaign selection, metric details, experiments, lessons, and provider configuration status.
- Campaign drafts persisted in SQLite. Saving a draft does not start traffic or creative generation.
- Server-side adapter foundations for Liquid AI, RawTree, classic Tinybird, and Black Forest Labs.
- Empty analytics shown as not started; rates and costs without outcomes shown as “—”.

Campaign execution, traffic simulation, model-driven reviews, generated asset storage, and live analytics refresh are planned for a later phase. There is no launch endpoint or background scheduler. Provider adapters are not triggered by dashboard actions. Integration status reports local configuration; it does not verify provider connectivity.

## Run locally

Requires **Node.js 24** and npm. SQLite is supplied by Node; no separate database service is needed.

```sh
npm ci
npm run dev
```

Open `http://127.0.0.1:5173`. Vite proxies `/api` to the local API on port 3001. Copy `.env.example` to `.env` to configure optional providers. Draft campaigns are stored in `.data/riff.sqlite` by default; set `DATABASE_PATH` to use another location.

For a production build served locally:

```sh
npm run build
npm start
```

Open `http://127.0.0.1:3001`. Starting the server does not run a campaign or contact sponsors.

## Provider setup

Provider credentials stay on the server. Do not put them in `VITE_` variables, browser storage, source control, or chat. After changing `.env`, restart the local API. Opening the app and saving a draft do not send provider requests.

### Liquid AI

The integration targets an OpenAI-compatible endpoint serving a Liquid model. [Liquid’s llama.cpp guide](https://docs.liquid.ai/deployment/on-device/llama-cpp) documents the `/v1/chat/completions` interface.

Set `LIQUID_BASE_URL` to the server’s `/v1` base URL, `LIQUID_MODEL` to its model name, and `LIQUID_API_KEY` only if the server requires it. For example, a separately started local server can use `http://127.0.0.1:8080/v1` and `lfm2.5-1.2b-instruct`. This app does not install models, download them, or run inference at startup.

### Analytics

Riff provides two separate adapters selected with `ANALYTICS_PROVIDER`. RawTree and classic Tinybird use different credentials and API contracts.

- **RawTree:** set `ANALYTICS_PROVIDER=rawtree`, `RAWTREE_API_KEY`, and the database and table settings. [RawTree’s API](https://rawtree.com/docs/reference/api) accepts event arrays and read-only SQL. This build sends no inserts.
- **Classic Tinybird:** set `ANALYTICS_PROVIDER=tinybird`, the workspace’s regional `TINYBIRD_BASE_URL`, and separate ingest and read tokens. The data source and parameterized query definitions are in `integrations/tinybird`; deploy them to your workspace before using this adapter. Riff does not deploy resources automatically. See Tinybird’s [Events API](https://www.tinybird.co/docs/api-reference/events-api) and [Pipe endpoints](https://www.tinybird.co/docs/api-reference/pipe-api/api-endpoints).

Event spend uses integer cents. Events carry stable IDs, and metric queries deduplicate IDs before aggregation. Writes are not automatically retried after uncertain outcomes.

### Black Forest Labs

Set `BFL_API_KEY`; `BFL_MODEL` selects the image endpoint. The [BFL generation guide](https://docs.bfl.ai/quick_start/generating_images) describes submission, status checks, and result delivery. No paid image generation is triggered by opening the app or saving a draft. Delivery URLs expire, so future execution code must persist downloaded images and job IDs before showing durable campaign assets.

## Verification

```sh
npm run typecheck
npm test
npm run build
```

Tests use temporary SQLite databases and injected HTTP fixtures. They do not require provider credentials, contact live providers, or start a campaign. Live account access and model quality require separate verification if campaign execution is added later.

## Project structure

```text
src/                    React dashboard
shared/                 Domain types, validation, metric definitions
server/                 Local HTTP API and SQLite storage
server/providers/        Sponsor HTTP adapters
integrations/tinybird/   Data-source and query definitions
tests/                  Offline verification
```
