# Riff

Riff is a local campaign experiment workspace. It saves campaign briefs, creates reviewable image or video drafts, and runs simulated audience experiments when requested. Liquid suggests headlines and judges them as audience personas; Black Forest Labs generates the visuals. Riff does not publish ads or buy real traffic.

Riff is intended for local, single-user use. The server binds to loopback and has no authentication for public hosting.

## Example finished image ads

Three fictional product scenarios, with BFL photography and locally rendered headline/CTA layouts: [notebook](artifacts/image-campaign/notebook-ad.png), [bottle](artifacts/image-campaign/bottle-ad.png), and [mug](artifacts/image-campaign/mug-ad.png). Each PNG is 1080 × 1350. These are visual quality samples, not performance-tested ads.

## Current phase

Implemented:

- Results-first dashboard with campaign selection, metric details, experiments, lessons, and provider configuration status.
- Campaign drafts persisted in SQLite. Saving a draft does not start traffic or creative generation.
- Creative composer with editable Liquid headline suggestions, manual-copy fallback, and a separate visual direction for each of 2–3 versions. Generating a batch makes one paid BFL request per version, sequentially. Existing drafts that share one asset remain available. The Versions editor and saved drafts start collapsed; image defaults use coordinated hero, editorial-setting, and graphic compositions, with explicit physical staging for notebooks and vessels.
- The newest creative batch is previewed directly below generation controls, including in-progress and partial results. Each completed image can be inspected or exported without expanding Versions. Older batches stay in a collapsed archive; loading saved previews does not start generation.
- Finished image ads combine the complete photo, saved headline, and **Join the waitlist** call-to-action in a 1080 × 1350 portrait layout. Inspect and download the finished PNG, or open the original photo separately. Typography is rendered locally rather than generated into the photograph; composing or exporting an existing image makes no paid request and does not change its saved caption or source asset.
- Video generation is enabled with `BFL_VIDEO_ENABLED=true`. Controls include duration, aspect ratio, HD/Full HD resolution, audio, and draft quality; draft quality requires HD. It is disabled by default.
- Each saved variant has a **View image** or **Watch video** action. The focused viewer shows the complete image or a video with playback controls; **Open original** opens the locally saved asset in its own tab. Viewing saved media does not call a generation provider.
- Expanded previews have previous/next arrows, a version counter, and keyboard arrow navigation within the opened batch. Finished ads stay in their finished layout; unavailable versions are skipped. Video navigation pauses the previous clip and does not autoplay the next one.
- Experiment setup on the Experiments tab: filter persona profiles, add custom personas, choose agent count and concurrency, then explicitly start, pause, or resume a wave. Select a completed creative batch with **Select for experiment** to associate its assets with the matching headlines; without a selected batch, the wave uses text only.
- Experiments separates the next-wave brief, audience and run controls from recorded results. Optional audience filters, advanced controls and older experiments are collapsed. Result cards use the captions and media saved with that experiment, and only the latest wave receives current metrics. Text-only snapshots are labeled explicitly; generating images later does not attach them retrospectively. Selecting a saved creative adopts its saved headlines for the next wave.
- Simulated responses, progress, decisions, and lessons are saved locally; configured analytics adapters ingest and summarize simulated events. These are model-generated responses, not measurements from real customers.
- Server-side adapter foundations for Liquid AI, RawTree, classic Tinybird, and Black Forest Labs.
- Empty analytics shown as not started; rates and costs without outcomes shown as “—”.
- The sign-up graph shows cumulative **simulated** outcomes from the latest persona wave. Its horizontal axis is elapsed time and its vertical axis is sign-up count. Steps represent recorded outcomes; the legend identifies each headline, including versions with zero sign-ups. Metrics identify their actual analytics source, including SQLite fallback. Results by round preserve the history of the experiment loop.

Opening the app and saving a draft do not contact providers. Headline suggestions call Liquid; generating media uses BFL credits; starting or resuming a wave runs Liquid persona requests and sends analytics events. Integration status reports local configuration; it does not verify provider connectivity.

When a ready creative is selected, persona judges receive its stored image or video together with the headline and product facts. Without a selected creative, they evaluate text only. A feed-scroll model translates responses into simulated skips, clicks and sign-ups. These remain synthetic predictions; they do not establish real ad effectiveness or isolate a headline's effect when complete concepts differ.

The experiment loop can continue with revised headlines, audience profiles and creative according to its configured limits. `MAX_AUTO_ROUNDS`, `SUCCESS_CLICK_RATE_THRESHOLD` and `AUTO_CREATIVE_ENABLED` control the stopping rules and whether following rounds may generate new images. Starting a wave authorizes the configured loop; opening the app does not start it.

Creative batches persist each version's progress. If a request fails or has an unknown outcome, remaining versions stop and successful outputs stay viewable. Reloading progress does not submit another paid request, and interrupted requests are never automatically resubmitted.

New headlines are limited to 60 characters, including spaces and punctuation. The editor and API count Unicode code points consistently and reject over-limit copy instead of cutting words. Older saved captions remain viewable; shorten an over-limit draft before generating a new creative or starting a new experiment. Liquid is prompted for finished ad copy, with explanations kept separate.

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

Port 3001 serves the last production build. After pulling source changes, run `npm run build` again and refresh the page. For source changes to appear automatically while developing, use `npm run dev` and open port 5173.

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

- **RawTree:** set `ANALYTICS_PROVIDER=rawtree`, `RAWTREE_API_KEY`, and the database and table settings. [RawTree’s API](https://rawtree.com/docs/reference/api) accepts event arrays and read-only SQL. Explicitly started persona waves send simulated events.
- **Classic Tinybird:** set `ANALYTICS_PROVIDER=tinybird`, the workspace’s regional `TINYBIRD_BASE_URL`, and separate ingest and read tokens. The data source and parameterized query definitions are in `integrations/tinybird`; deploy them to your workspace before using this adapter. Riff does not deploy resources automatically. See Tinybird’s [Events API](https://www.tinybird.co/docs/api-reference/events-api) and [Pipe endpoints](https://www.tinybird.co/docs/api-reference/pipe-api/api-endpoints).

Event spend uses integer cents. Events carry stable IDs, and metric queries deduplicate IDs before aggregation. Writes are not automatically retried after uncertain outcomes.

### Black Forest Labs

Set `BFL_API_KEY`; `BFL_MODEL` selects the image endpoint. The [BFL generation guide](https://docs.bfl.ai/quick_start/generating_images) describes submission, status checks, and result delivery. Image generation is available only through the reviewed creative composer action and uses BFL credits; returned image assets are saved locally for later review. FLUX.2 Pro requests disable prompt upsampling so the reviewed direction is passed without that expansion; other configured endpoints retain their supported request fields.

Image defaults follow BFL's [FLUX.2 prompting guidance](https://docs.bfl.ai/guides/prompting_guide_flux2): the supplied product and its physical pose come before composition, photographic style, and lighting. Custom directions remain editable and saved media is never silently regenerated. Text-only briefs cannot guarantee exact manufactured-product fidelity; inspect geometry and details before using an export.

To review the three fictional notebook, bottle, and mug scenarios without making requests, run `node --import tsx scripts/image-quality-scenarios.ts`. Add `--live` to generate up to three images using the configured BFL model, or `--scenario=notebook-hero` (also `bottle-editorial` and `mug-flatlay`) to select individual cases. Live runs retain prompts, provider task IDs and original images under `.data/image-quality/`, stop on failure or uncertainty, and never automatically regenerate. They do not modify campaigns or run a simulation.

Video generation uses `BFL_VIDEO_MODEL=flux-3-video` and is gated by `BFL_VIDEO_ENABLED`, which defaults to `false`. Set it to `true` and restart the server to enable the Video selector. The [FLUX 3 API reference](https://docs.bfl.ai/api-reference/utility/generate-a-video-with-flux-3) documents the text-to-video contract. Riff starts with a five-second HD draft and audio off. Both image and video batches make one request per reviewed version; the button shows the count before submission. Generated concepts remain drafts and are not published ads.

Existing API callers that omit `variantPrompts` retain the single shared-asset behavior. Supplying one unique `variantPrompts` entry per headline creates a distinct batch, returns `202` with a saved job, and exposes progress through the existing creative GET route. Starting a wave with media requires an explicit completed `creativeJobId` whose campaign and headlines match the request.

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
