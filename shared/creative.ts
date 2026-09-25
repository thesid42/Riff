import { z } from 'zod';

export const creativeImageRequestSchema = z.object({
  requestId: z.string().uuid(),
  headlines: z.array(z.string().trim().min(1).max(120)).min(2).max(3)
    .refine(values => new Set(values.map(value => value.toLocaleLowerCase())).size === values.length, 'Headlines must be unique.'),
  imagePrompt: z.string().trim().min(1).max(4_000),
}).strict();

export type CreativeImageRequest = z.infer<typeof creativeImageRequestSchema>;

export const creativeVideoOptionsSchema = z.object({
  durationSeconds: z.number().int().min(5).max(20).default(5),
  resolution: z.enum(['hd', 'fhd']).default('hd'),
  aspectRatio: z.enum(['1:1', '16:9', '9:16']).default('1:1'),
  generateAudio: z.boolean().default(false),
  draft: z.boolean().default(true),
}).strict().superRefine((options, ctx) => {
  if (options.draft && options.resolution !== 'hd') {
    ctx.addIssue({ code: 'custom', path: ['draft'], message: 'Draft video generation is only available at HD resolution.' });
  }
});

export type CreativeVideoOptions = z.infer<typeof creativeVideoOptionsSchema>;

export const creativeVideoRequestSchema = z.object({
  requestId: z.string().uuid(),
  headlines: creativeImageRequestSchema.shape.headlines,
  imagePrompt: z.string().trim().min(1).max(4_000),
  videoOptions: creativeVideoOptionsSchema.default({ durationSeconds: 5, resolution: 'hd', aspectRatio: '1:1', generateAudio: false, draft: true }),
}).strict();

export type CreativeVideoRequest = z.infer<typeof creativeVideoRequestSchema>;

export type CreativeImageJobStatus = 'submitting' | 'generating' | 'ready' | 'failed' | 'uncertain';

export interface CreativeImageJob {
  id: string;
  campaignId: string;
  headlines: string[];
  imagePrompt: string;
  mediaType: 'image' | 'video';
  status: CreativeImageJobStatus;
  imageUrl: string | null;
  videoUrl: string | null;
  videoOptions: CreativeVideoOptions | null;
  error: string | null;
  providerTaskId: string | null;
  createdAt: string;
  updatedAt: string;
}
