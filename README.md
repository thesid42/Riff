# Riff

Riff is a local campaign experiment workspace. It saves campaign briefs and presents campaign results when the API has real data. A campaign’s creative composer can request editable Liquid headline suggestions and, only after an explicit user action, create paid BFL image or video drafts. It does not simulate traffic or start campaigns.

Riff is intended for local, single-user use. The server binds to loopback and has no authentication for public hosting.

## Example campaign image

[View the generated image draft](artifacts/image-campaign/quiet-pages.jpg). It comes from a fictional campaign and contains unwanted lettering, so review it before use.

## Current phase

Implemented:

- Results-first dashboard with campaign selection, metric details, experiments, lessons, and provider configuration status.
- Campaign drafts persisted in SQLite. Saving a draft does not start traffic or creative generation.
- Creative composer with editable Liquid headline suggestions, manual-copy fallback, and explicit paid BFL image generation. Generated images and their shared headline variants are saved as reviewable drafts.
- Video generation is enabled with `BFL_VIDEO_ENABLED=true`. Controls include duration, aspect ratio, HD/Full HD resolution, audio, and draft quality; draft quality requires HD. It is disabled by default.
- Each saved variant has a **View image** or **Watch video** action. The focused viewer shows the complete image or a video with playback controls; **Open original** opens the locally saved asset in its own tab. Viewing saved media does not call a generation provider.
- Server-side adapter foundations for Liquid AI, RawTree, classic Tinybird, and Black Forest Labs.
- Empty analytics shown as not started; rates and costs without outcomes shown as “—”.

Campaign execution, traffic simulation, continuous model-driven reviews, and live analytics refresh are planned for a later phase. There is no launch endpoint or background scheduler. Opening the app and saving a draft do not contact providers; headline suggestions call Liquid, and the explicit image/video generation action uses BFL credits. Integration status reports local configuration; it does not verify provider connectivity.

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

Provider credentials stay on the server. Do not put them in `VITE_` variables, browser storage, source control, or chat. After changing `.env`, restart the local API. Opening the app and saving a draft do not send provider requests. Asking Liquid for headlines sends a model request; generating an image or video requires an explicit click and uses BFL credits.

### Liquid AI

The integration targets an OpenAI-compatible endpoint serving a Liquid model. [Liquid’s llama.cpp guide](https://docs.liquid.ai/deployment/on-device/llama-cpp) documents the `/v1/chat/completions` interface.

Set `LIQUID_BASE_URL` to the server’s `/v1` base URL, `LIQUID_MODEL` to its model name, and `LIQUID_API_KEY` only if the server requires it. For example, a separately started local server can use `http://127.0.0.1:8080/v1` and `lfm2.5-1.2b-instruct`. This app does not install models, download them, or run inference at startup.

#### Liquid scenario runner

`npm run test:liquid` creates an offline report with a deterministic `MockedLiquid` transport; it does not load `.env` or contact a provider. The report covers an initial headline test, a low-sample review, and a returning-to-first-time visitor shift. All briefs, evidence, counts, and two mock ad image placeholders are synthetic; the same local placeholder is reused for both versions.

Use `npm run test:liquid -- --live` to opt into up to three sequential Liquid requests. Live mode is pinned to `LIQUID_BASE_URL=https://openrouter.ai/api/v1` and `LIQUID_MODEL=liquid/lfm-2.5-2.6b:free`; it requires a non-empty `LIQUID_API_KEY` in `.env` and has no fallback model or retries. Only exact allowlisted decision-validation errors continue to the next independent scenario; provider, network, authentication, refusal, truncation, redirect, and other errors stop further requests. Any scenario error or unexpected valid action makes the run exit non-zero. Only the Liquid decision requests are live: the runner does not call BFL, analytics providers, ad platforms, or the campaign database.

The live report records each validated structured decision, request ID when returned, token usage, finish reason, and latency. On failure, it includes only a bounded, sanitized provider error detail, never the response body. Its action comparison checks only whether the returned action matches the scenario expectation; it does not grade semantic correctness. HTML, Markdown, and JSON reports are written under `output/liquid-mocks/`, which is ignored by Git. The report includes the synthetic scenario inputs and local mock image placeholders, not raw HTTP responses, credentials, or hidden reasoning traces.

The tested model profile has a **65,536-token context window**. The runner sets a **4,096-token completion limit**; prompt and completion tokens still share the model's total context capacity. Offline fixture reports have no provider context window or authentication check. Authentication is checked only when live mode makes its first OpenRouter request. No BFL credits or image requests are used by this runner.

### Analytics

Riff provides two separate adapters selected with `ANALYTICS_PROVIDER`. RawTree and classic Tinybird use different credentials and API contracts.

- **RawTree:** set `ANALYTICS_PROVIDER=rawtree`, `RAWTREE_API_KEY`, and the database and table settings. [RawTree’s API](https://rawtree.com/docs/reference/api) accepts event arrays and read-only SQL. This build sends no inserts.
- **Classic Tinybird:** set `ANALYTICS_PROVIDER=tinybird`, the workspace’s regional `TINYBIRD_BASE_URL`, and separate ingest and read tokens. The data source and parameterized query definitions are in `integrations/tinybird`; deploy them to your workspace before using this adapter. Riff does not deploy resources automatically. See Tinybird’s [Events API](https://www.tinybird.co/docs/api-reference/events-api) and [Pipe endpoints](https://www.tinybird.co/docs/api-reference/pipe-api/api-endpoints).

Event spend uses integer cents. Events carry stable IDs, and metric queries deduplicate IDs before aggregation. Writes are not automatically retried after uncertain outcomes.

### Black Forest Labs

Set `BFL_API_KEY`; `BFL_MODEL` selects the image endpoint. The [BFL generation guide](https://docs.bfl.ai/quick_start/generating_images) describes submission, status checks, and result delivery. Image generation is available only through the reviewed creative composer action and uses BFL credits; returned image assets are saved locally for later review. Video generation uses `BFL_VIDEO_MODEL=flux-3-video` and is gated by `BFL_VIDEO_ENABLED`, which defaults to `false`. Set it to `true` and restart the server to enable the Video selector. The [FLUX 3 API reference](https://docs.bfl.ai/api-reference/utility/generate-a-video-with-flux-3) documents the text-to-video contract. Riff starts with a five-second HD draft and audio off; each explicit generation uses credits. Generated concepts remain drafts and are not ads or campaign launches.

## Verification

```sh
npm run typecheck
npm test
npm run build
```

Automated tests use temporary SQLite databases and injected HTTP fixtures; they do not contact live providers or start a campaign. Separate manual live smoke tests exercised one campaign from Liquid headline advice through reviewed copy, BFL image generation, local asset display, and reload, followed by one five-second HD draft video with audio off. The video was saved locally as an MP4; browser decoding and byte-range delivery were verified. The generated image contained unwanted lettering and requires human review. These checks establish integration behavior, not creative quality or campaign performance.

## Project structure

```text
src/                    React dashboard
shared/                 Domain types, validation, metric definitions
server/                 Local HTTP API and SQLite storage
server/providers/        Sponsor HTTP adapters
integrations/tinybird/   Data-source and query definitions
tests/                  Offline verification
```
