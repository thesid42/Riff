export interface ProductImagePromptContext {
  product: string;
  audience?: string;
}

export const PRODUCT_IMAGE_COMPOSITIONS = ['hero', 'editorial-setting', 'graphic-flatlay'] as const;
export type ProductImageComposition = typeof PRODUCT_IMAGE_COMPOSITIONS[number];

/** Build up to three distinct, positive product-photography directions without adding product facts. */
export function buildProductImagePrompts(context: ProductImagePromptContext, count = PRODUCT_IMAGE_COMPOSITIONS.length): string[] {
  const product = cleanContext(context.product, 'the product described in the campaign brief', 300);
  const audience = cleanContext(context.audience ?? '', '', 500);
  const safeCount = Math.max(0, Math.min(PRODUCT_IMAGE_COMPOSITIONS.length, Math.floor(count)));
  return PRODUCT_IMAGE_COMPOSITIONS.slice(0, safeCount).map((composition) => buildProductImagePrompt({ product, audience }, composition));
}

export function buildProductImagePrompt(context: ProductImagePromptContext, composition: ProductImageComposition = 'hero'): string {
  const product = cleanContext(context.product, 'the product described in the campaign brief', 300);
  const audience = cleanContext(context.audience ?? '', '', 500);
  const subject = `Single ${product}, faithful to its described silhouette and details; keep named colors, materials, and patterns on their named parts. Unspecified surfaces remain plain and unbranded. Photography only; layout typography is added later. ${physicalStaging(product)}`;
  if (composition === 'editorial-setting') {
    const setting = audience
      ? `a calm everyday setting relevant to ${audience}`
      : 'a calm, contemporary everyday setting';
    return `${subject} Composition: grounded on a matte surface in ${setting}, with layered depth and open copy space. Style: refined editorial still-life photography, tactile realism, restrained color. Lighting: soft window light, bounce fill, polished highlights, delicate shadows.`;
  }
  if (composition === 'graphic-flatlay') {
    const angle = /\b(mug|cup|bottle|vase|jar)\b/i.test(product)
      ? 'elevated three-quarter tabletop view of the upright product, fully supported on a single level surface, with warm-stone and soft-sage backdrop planes'
      : 'overhead graphic flat lay, diagonal placement on a single level surface, warm-stone and soft-sage background color fields';
    return `${subject} Composition: ${angle}, complete silhouette, open copy space. Style: premium art-directed catalog photography, crisp realism, authentic texture. Lighting: upper-left softbox, grounded contact shadow, tonal depth.`;
  }
  return `${subject} Composition: complete three-quarter hero, slightly off-center on warm ivory with open copy space. Style: elegant editorial product photography, tactile realism, composed color. Lighting: broad softbox, bounce fill, controlled highlights, grounded contact shadow.`;
}

function physicalStaging(product: string): string {
  if (/\b(notebook|journal|sketchbook)\b/i.test(product)) {
    const closure = /\belastic\b/i.test(product) ? ' The elastic follows a straight band around the closed book.' : '';
    const cover = product.match(/\bwith\s+([^,.;]{1,80}\bcover)\b/i)?.[1];
    const visibleCover = cover ? ` The entire visible front face is ${cover}, edge to edge.` : ' The entire visible front face is the intact outer cover described in the brief.';
    return `Stage the notebook fully closed: flat intact front cover, straight binding, aligned paper block.${visibleCover} Interior patterns remain inside, concealed beneath the closed cover.${closure}`;
  }
  if (/\b(mug|cup)\b/i.test(product)) {
    const handle = /\bhandle\b/i.test(product) ? ' Its single handle attaches naturally at two points.' : '';
    return `Stand the cup upright on its solid base; show the open top rim and inner wall from a slightly elevated angle.${handle}`;
  }
  if (/\b(bottle|vase|jar)\b/i.test(product)) return 'Stand the intact product upright on its stable base; preserve realistic connected parts and believable proportions.';
  return 'Stage the complete intact product in a natural resting position with realistic connected parts and believable proportions.';
}

function cleanContext(value: string, fallback: string, maxLength: number): string {
  const clean = value.trim().replace(/[\p{Cc}\uFFFD]/gu, ' ').replace(/\s+/g, ' ').slice(0, maxLength).trim();
  return clean || fallback;
}
