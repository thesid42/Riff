import { config as loadDotenv } from 'dotenv';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { BflClient } from '../server/providers/bfl.js';
import { ProviderError } from '../server/providers/common.js';
import { buildProductImagePrompt, type ProductImageComposition } from '../shared/image-prompts.js';

// Deliberately fictional products: this checks three difficult photographic cases
// without changing campaign data or sending customer material to a provider.
const scenarios: Array<{ id: string; product: string; audience: string; composition: ProductImageComposition; headline: string; review: string[] }> = [
  {
    id: 'notebook-hero',
    product: 'an A5 notebook with a plain terracotta fabric cover, cream paper, a subtle grey dot grid on the interior pages, and a matching terracotta elastic closure',
    audience: 'designers who sketch and keep handwritten notes',
    composition: 'hero',
    headline: 'Make room for your next idea',
    review: ['Plain cover; dots confined to paper', 'Believable binding and elastic closure', 'Complete silhouette and controlled shadow'],
  },
  {
    id: 'bottle-editorial',
    product: 'a 750 ml cylindrical stainless-steel bottle with a matte deep-blue finish, a matching screw cap, and a plain unbranded surface',
    audience: 'commuters packing a bottle for the working day',
    composition: 'editorial-setting',
    headline: 'A little blue for your everyday',
    review: ['Cap and bottle have plausible proportions', 'Metal highlights stay controlled', 'Setting supports rather than obscures the bottle'],
  },
  {
    id: 'mug-flatlay',
    product: 'an empty cylindrical ceramic mug with a warm ivory satin glaze, a single rounded loop handle, and a smooth matching ivory interior',
    audience: 'people who enjoy a calm desk space',
    composition: 'graphic-flatlay',
    headline: 'A quieter moment, beautifully made',
    review: ['Handle attaches naturally at two points', 'Rim and visible interior have sound geometry', 'Clean visual hierarchy and material texture'],
  },
];

const args = process.argv.slice(2);
const live = args.includes('--live');
const selectedIds = args.filter(arg => arg.startsWith('--scenario=')).map(arg => arg.slice('--scenario='.length));
if (args.some(arg => arg !== '--live' && !arg.startsWith('--scenario=')) || selectedIds.some(id => !scenarios.some(scenario => scenario.id === id))) {
  throw new Error('Usage: node --import tsx scripts/image-quality-scenarios.ts [--live] [--scenario=notebook-hero|bottle-editorial|mug-flatlay]');
}
const inputs = scenarios.filter(scenario => !selectedIds.length || selectedIds.includes(scenario.id)).map(scenario => ({ ...scenario, prompt: buildProductImagePrompt(scenario, scenario.composition) }));
if (!live) {
  console.log(JSON.stringify({ mode: 'preview-only', paidRequests: 0, scenarios: inputs }, null, 2));
} else {
  loadDotenv({ quiet: true });
  const key = process.env.BFL_API_KEY?.trim();
  if (!key) throw new Error('BFL_API_KEY is required for the explicitly requested live run.');
  const model = process.env.BFL_MODEL?.trim() || 'flux-2-pro';
  const client = new BflClient(key, fetch, model);
  const directory = resolve('.data', 'image-quality', new Date().toISOString().replace(/[:.]/g, '-'));
  await mkdir(directory, { recursive: true });
  const report = {
    model, width: 1024, height: 1024, createdAt: new Date().toISOString(),
    note: 'Independent live image samples for human review; no simulation or automatic regeneration.',
    results: inputs.map(input => ({ ...input, status: 'not-run', taskId: null as string | null, file: null as string | null, error: null as string | null })),
  };
  const save = () => writeFile(resolve(directory, 'review.json'), JSON.stringify(report, null, 2), 'utf8');
  await save();
  console.log(`Quality review directory: ${directory}`);
  for (const result of report.results) {
    const signal = AbortSignal.timeout(120_000);
    try {
      result.status = 'submitting';
      await save();
      const submission = await client.submit(result.prompt, report.width, report.height, signal);
      result.taskId = submission.id;
      result.status = 'generating';
      await save();
      console.log(`${result.id}: submitted`);
      for (;;) {
        const polled = await client.poll(submission, signal);
        if (polled.status === 'Ready' && polled.downloadImage) {
          const image = await polled.downloadImage();
          const extension = image.contentType === 'image/png' ? 'png' : image.contentType === 'image/webp' ? 'webp' : 'jpg';
          result.file = `${result.id}.${extension}`;
          await writeFile(resolve(directory, result.file), image.bytes);
          result.status = 'ready';
          await save();
          console.log(`${result.id}: ready (${result.file})`);
          break;
        }
        if (!['Pending', 'Reasoning', 'Generating'].includes(polled.status)) throw new Error(`Provider ended with ${polled.status}.`);
        await delay(1_500, undefined, { signal });
      }
    } catch (error) {
      result.status = 'stopped';
      result.error = error instanceof ProviderError ? error.message : 'The image could not be confirmed; review the saved provider task before another request.';
      await save();
      console.error(`${result.id}: ${result.error}`);
      process.exitCode = 1;
      break;
    }
  }
}
