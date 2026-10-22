import { fetchJson } from './http.js';
import { imageBytes } from './images.js';

// World Labs Marble turns the redesigned photo into a walkable Gaussian-splat world (~5 minutes).
const base = 'https://api.worldlabs.ai/marble/v1';

export function createWorlds({ key, model = 'marble-1.1', fetcher = fetch }) {
  const headers = { 'WLT-Api-Key': key, 'content-type': 'application/json' };
  const opts = timeout => ({ label: 'World Labs', secrets: [key], timeout });
  return {
    async start({ image, caption, name }) {
      // Prefer a public URL; otherwise send the bytes inline.
      const imagePrompt = image.url ? { source: 'uri', uri: image.url } : { source: 'data_base64', data_base64: Buffer.from((await imageBytes(image, fetcher)).bytes).toString('base64') };
      const body = { display_name: name.slice(0, 64), model, world_prompt: { type: 'image', image_prompt: imagePrompt, text_prompt: caption?.slice(0, 1500), is_pano: false } };
      const op = await fetchJson(fetcher, `${base}/worlds:generate`, { method: 'POST', headers, body: JSON.stringify(body) }, opts(60000));
      return { operationId: op.operation_id };
    },
    async status(operationId) {
      const op = await fetchJson(fetcher, `${base}/operations/${encodeURIComponent(operationId)}`, { headers }, opts(20000));
      if (op.error) return { done: true, error: op.error.message || 'World generation failed.' };
      if (!op.done) return { done: false, progress: op.metadata?.progress_percentage ?? op.metadata?.progress ?? null };
      const world = op.response || {};
      const spz = world.assets?.splats?.spz_urls || {};
      return {
        done: true,
        worldId: world.world_id || world.id,
        marbleUrl: world.world_marble_url,
        thumbnail: world.assets?.thumbnail_url,
        splats: { '100k': spz['100k'], '500k': spz['500k'], full_res: spz.full_res },
        collider: world.assets?.mesh?.collider_mesh_url,
        pano: world.assets?.imagery?.pano_url
      };
    }
  };
}
