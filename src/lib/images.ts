/**
 * Reference pictures: colour extraction and decoding.
 *
 * The pictures themselves never leave the browser. They are used by the
 * renderer, which runs here, so uploading them would cost bandwidth and
 * privacy for nothing. What *is* sent is a handful of hex colours pulled out
 * of them, which is all the director needs to bend the palette towards the
 * user's own world.
 */

export interface Reference {
  id: string;
  file: File;
  bitmap: ImageBitmap;
  thumbnail: string;   // object URL, for the UI
  colours: string[];
}

const SAMPLE_SIZE = 96;      // extraction grid; bigger adds nothing useful
const MAX_DIMENSION = 2560;  // downscale huge phone photos before rendering

/**
 * Dominant colours by coarse histogram in HSL space.
 *
 * Not k-means: k-means on a photograph reliably returns five shades of the
 * same beige. Bucketing by hue and keeping the most *saturated* representative
 * of each populated bucket returns colours a person would actually name.
 */
export function extractColours(bitmap: ImageBitmap, count = 4): string[] {
  const canvas = document.createElement('canvas');
  const scale = Math.min(1, SAMPLE_SIZE / Math.max(bitmap.width, bitmap.height));
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));

  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return [];
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);

  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);

  const HUE_BUCKETS = 12;
  const buckets = new Map<number, { r: number; g: number; b: number; s: number; n: number }>();

  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 128) continue;
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const max = Math.max(r, g, b) / 255;
    const min = Math.min(r, g, b) / 255;
    const l = (max + min) / 2;

    // Skip near-black and near-white: they are the background of most photos
    // and they tell us nothing about its colour.
    if (l < 0.08 || l > 0.95) continue;
    const d = max - min;
    const s = d === 0 ? 0 : l > 0.5 ? d / (2 - max - min) : d / (max + min);

    let h = 0;
    if (d !== 0) {
      const rn = r / 255, gn = g / 255, bn = b / 255;
      if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6;
      else if (max === gn) h = ((bn - rn) / d + 2) / 6;
      else h = ((rn - gn) / d + 4) / 6;
    }

    // Greys go in their own bucket so a monochrome photo still yields one.
    const key = s < 0.12 ? -1 : Math.floor(h * HUE_BUCKETS) % HUE_BUCKETS;
    const bucket = buckets.get(key) || { r: 0, g: 0, b: 0, s: 0, n: 0 };
    // Weight by saturation so a bucket's average leans towards its vivid
    // members rather than being washed out by its dull ones.
    const weight = 0.25 + s;
    bucket.r += r * weight;
    bucket.g += g * weight;
    bucket.b += b * weight;
    bucket.s += weight;
    bucket.n += 1;
    buckets.set(key, bucket);
  }

  const total = [...buckets.values()].reduce((n, b) => n + b.n, 0) || 1;

  return [...buckets.entries()]
    .filter(([, b]) => b.n / total > 0.02)
    .sort((a, b) => b[1].n - a[1].n)
    .slice(0, count)
    .map(([, b]) => {
      const to = (v: number) => Math.round(Math.min(255, v / b.s)).toString(16).padStart(2, '0');
      return `#${to(b.r)}${to(b.g)}${to(b.b)}`;
    });
}

/** Decode a picture file, downscaling anything absurdly large. */
export async function loadReference(file: File): Promise<Reference> {
  let bitmap = await createImageBitmap(file);

  if (Math.max(bitmap.width, bitmap.height) > MAX_DIMENSION) {
    const scale = MAX_DIMENSION / Math.max(bitmap.width, bitmap.height);
    const resized = await createImageBitmap(bitmap, {
      resizeWidth: Math.round(bitmap.width * scale),
      resizeHeight: Math.round(bitmap.height * scale),
      resizeQuality: 'high',
    });
    bitmap.close();
    bitmap = resized;
  }

  return {
    id: `${file.name}-${file.size}-${file.lastModified}`,
    file,
    bitmap,
    thumbnail: URL.createObjectURL(file),
    colours: extractColours(bitmap),
  };
}

export function releaseReference(reference: Reference): void {
  URL.revokeObjectURL(reference.thumbnail);
  reference.bitmap.close();
}

/** Colours from every reference, most common first, deduplicated. */
export function mergeColours(references: Reference[], limit = 6): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const columns = Math.max(0, ...references.map((r) => r.colours.length));
  for (let i = 0; i < columns; i++) {
    for (const reference of references) {
      const colour = reference.colours[i];
      if (!colour || seen.has(colour)) continue;
      seen.add(colour);
      out.push(colour);
      if (out.length >= limit) return out;
    }
  }
  return out;
}
