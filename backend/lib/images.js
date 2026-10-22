import { fetchJson, UpstreamError } from './http.js';

// Edits the listing's real photo so the before/after stays believable.
// An image is { url } (public) or { bytes, type } (an upload or a previous render).

export async function imageBytes(image, fetcher = fetch) {
  if (image.bytes) return image;
  let response;
  try { response = await fetcher(image.url, { signal: AbortSignal.timeout(20000), headers: { 'user-agent': 'QlooHackathonDemo/1.0' } }); }
  catch { throw new UpstreamError('Could not download the listing photo.'); }
  if (!response.ok) throw new UpstreamError(`Listing photo returned HTTP ${response.status}.`);
  return { bytes: Buffer.from(await response.arrayBuffer()), type: (response.headers.get('content-type') || 'image/jpeg').split(';')[0] };
}

const dataUri = image => `data:${image.type};base64,${Buffer.from(image.bytes).toString('base64')}`;

// Prefer sending the photo inline (Wikimedia rejects fal's fetcher). Some CDNs (LoopNet's) block
// server downloads but let fal fetch the URL itself, so fall back to the URL.
async function falImageInput(image, fetcher) {
  try { return dataUri(await imageBytes(image, fetcher)); }
  catch (error) { if (image.url) return image.url; throw error; }
}

export const aspectRatios = ['21:9', '16:9', '3:2', '4:3', '5:4', '1:1', '4:5', '3:4', '2:3', '9:16'];

// FLUX 3 Edit is the default: in a bake-off on the same empty room it kept 71% of the original
// edges in place (nano-banana-pro 50%, Kontext 47–51%), so the before/after slider lines up.
// It frames the output like the source photo by itself ("auto" aspect).
export const defaultImageModel = 'blackforestlabs/flux-3/edit-image';

// 1k (~30 s) rather than 2k (~90 s): the studio shows it at screen size and waiting longer hurts more.
export async function falEdit({ key, image, prompt, aspect, fetcher = fetch, model = defaultImageModel, resolution = '1k' }) {
  const input = await falImageInput(image, fetcher);
  const body = model.startsWith('blackforestlabs/flux-3')
    ? { prompt, image_urls: [input], resolution, aspect_ratio: 'auto', output_format: 'jpeg' }
    : { prompt, image_urls: [input], num_images: 1, output_format: 'jpeg', ...(aspectRatios.includes(aspect) ? { aspect_ratio: aspect } : {}) };
  const data = await fetchJson(fetcher, `https://fal.run/${model}`, {
    method: 'POST',
    headers: { authorization: `Key ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify(body)
  }, { label: 'fal.ai image edit', secrets: [key], timeout: 180000 });
  const url = data.images?.[0]?.url;
  if (!url) throw new UpstreamError('The image model returned no image.');
  return { url, type: 'image/jpeg', model };
}

// Pruna p-image-edit: ~3–10 s and $0.01 per edit. With an anchored "change X, keep Y identical"
// prompt it kept 75% of the room's edges in place in our bake-off (FLUX 3 Edit: 71% in ~30 s).
// Pruna can't fetch some CDNs (LoopNet answers 403), so we always upload the bytes ourselves.
// A depth map (brighter = nearer) of the source photo. Passed to Pruna as image 2 so new furniture
// sits at the right depth and scale and the camera stays put: in tests it raised the depth match
// between photo and redesign from 0.77 to 0.93 on a room where the plain edit re-framed the shot.
export async function depthMap({ key, image, fetcher = fetch }) {
  const source = await imageBytes(image, fetcher);
  const data = await fetchJson(fetcher, 'https://fal.run/fal-ai/image-preprocessors/depth-anything/v2', {
    method: 'POST', headers: { authorization: `Key ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ image_url: dataUri(source) })
  }, { label: 'Depth map', secrets: [key], timeout: 60000 });
  if (!data.image?.url) throw new UpstreamError('The depth model returned no image.');
  return imageBytes({ url: data.image.url }, fetcher);
}

async function prunaUpload(key, image, fetcher) {
  const form = new FormData();
  form.append('content', new Blob([image.bytes], { type: image.type }), `ref.${image.type.split('/')[1] || 'jpg'}`);
  const file = await fetchJson(fetcher, 'https://api.pruna.ai/v1/files', { method: 'POST', headers: { apikey: key }, body: form }, { label: 'Pruna upload', secrets: [key], timeout: 30000 });
  if (!file.urls?.get) throw new UpstreamError('Pruna did not accept the image.');
  return file.urls.get;
}

export async function prunaEdit({ key, image, prompt, depth, fast = false, fetcher = fetch }) {
  const source = await imageBytes(image, fetcher);
  const refs = await Promise.all([prunaUpload(key, source, fetcher), ...(depth ? [prunaUpload(key, depth, fetcher)] : [])]);
  const file = { urls: { get: refs[0] } };
  let job = await fetchJson(fetcher, 'https://api.pruna.ai/v1/predictions', {
    method: 'POST',
    headers: { apikey: key, Model: 'p-image-edit', 'Try-Sync': 'true', 'content-type': 'application/json' },
    // turbo suits quick lighting tweaks; structural redesigns read better with it off (Pruna's guidance).
    body: JSON.stringify({ input: { prompt, images: refs, aspect_ratio: 'match_input_image', turbo: fast } })
  }, { label: 'Pruna image edit', secrets: [key], timeout: 60000 });
  // Try-Sync answers inline when it can; otherwise poll the status URL.
  for (let i = 0; !job.generation_url && job.get_url && i < 60; i++) {
    if (job.status === 'failed' || job.error) break;
    await new Promise(r => setTimeout(r, 1000));
    job = { ...job, ...(await fetchJson(fetcher, job.get_url, { headers: { apikey: key } }, { label: 'Pruna status', secrets: [key], timeout: 15000 })) };
  }
  if (!job.generation_url) throw new UpstreamError(`Pruna edit failed: ${job.error || job.message || job.status || 'no image'}`);
  return { url: job.generation_url, type: 'image/jpeg', model: 'pruna/p-image-edit' };
}

export async function openaiEdit({ key, image, prompt, fetcher = fetch, model = 'gpt-image-1' }) {
  const source = await imageBytes(image, fetcher);
  const form = new FormData();
  form.append('model', model);
  form.append('prompt', prompt);
  form.append('size', '1536x1024');
  form.append('quality', 'medium');
  form.append('input_fidelity', 'high');
  form.append('image', new Blob([source.bytes], { type: source.type }), `space.${source.type.split('/')[1] || 'jpg'}`);
  const data = await fetchJson(fetcher, 'https://api.openai.com/v1/images/edits', {
    method: 'POST', headers: { authorization: `Bearer ${key}` }, body: form
  }, { label: 'OpenAI image edit', secrets: [key], timeout: 180000 });
  const b64 = data.data?.[0]?.b64_json;
  if (!b64) throw new UpstreamError('The image model returned no image.');
  return { bytes: Buffer.from(b64, 'base64'), type: 'image/png', model };
}

// GPT Image 2.5 Flare (via fal) is the default editor: precise edits that change what's asked and keep
// composition intact, ~24 s at medium in a three-room bake-off (GPT Image 2: ~33 s; Pruna: fast but
// weaker edits). Medium for the redesign; low for quick relights and follow-up changes.
export async function gptImageEdit({ key, image, prompt, fast = false, quality, fetcher = fetch, model = 'openai/gpt-image-2.5/flare/edit' }) {
  const data = await fetchJson(fetcher, `https://fal.run/${model}`, {
    method: 'POST',
    headers: { authorization: `Key ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ prompt, image_urls: [await falImageInput(image, fetcher)], quality: quality || (fast ? 'low' : 'medium'), image_size: 'auto', output_format: 'jpeg' })
  }, { label: 'GPT Image edit', secrets: [key], timeout: 180000 });
  const url = data.images?.[0]?.url;
  if (!url) throw new UpstreamError('The image model returned no image.');
  return { url, type: 'image/jpeg', model: model.replace(/^openai\//, '').replace(/\/edit$/, '') };
}

// Text to image, for rooms that exist only as a taste profile (no photo to edit): GPT Image 2.5 Flare on fal.
// image_size takes fal's presets (landscape_4_3, landscape_16_9, square_hd…) or { width, height }.
export async function gptImageGenerate({ key, prompt, size = 'landscape_4_3', quality = 'medium', fetcher = fetch, model = 'openai/gpt-image-2.5/flare/text-to-image' }) {
  const data = await fetchJson(fetcher, `https://fal.run/${model}`, {
    method: 'POST',
    headers: { authorization: `Key ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ prompt, image_size: size, quality, num_images: 1, output_format: 'jpeg' })
  }, { label: 'GPT Image', secrets: [key], timeout: 180000 });
  const url = data.images?.[0]?.url;
  if (!url) throw new UpstreamError('The image model returned no image.');
  return { url, type: 'image/jpeg', model: model.replace(/^openai\//, '').replace(/\/text-to-image$/, '') };
}

export function chooseImageModel(env, fetcher = fetch) {
  const prunaKey = env.PRUNAAI_KEY || env.PRUNA_API_KEY;
  const fal = env.FAL_KEY ? opts => falEdit({ ...opts, fetcher, key: env.FAL_KEY, model: env.FAL_IMAGE_MODEL || undefined, resolution: env.FAL_IMAGE_RESOLUTION || undefined }) : null;
  const pruna = prunaKey ? opts => prunaEdit({ ...opts, fetcher, key: prunaKey }) : null;
  // Lighting variants (morning / golden hour / night) are simple global edits: Pruna's turbo mode does
  // them in a few seconds, so they can be generated the moment the redesign lands.
  const relightWith = edit => pruna
    ? async opts => { try { return await pruna({ ...opts, fast: true }); } catch { return edit({ ...opts, fast: true }); } }
    : opts => edit({ ...opts, fast: true });
  if (env.FAL_KEY && env.IMAGE_PROVIDER !== 'pruna') return {
    label: `GPT Image (${env.GPT_IMAGE_MODEL || 'openai/gpt-image-2.5/flare/edit'})`,
    get relight() { return relightWith(this.edit); },
    generate: opts => gptImageGenerate({ ...opts, fetcher, key: env.FAL_KEY, quality: env.GPT_IMAGE_QUALITY || undefined }),
    edit: async opts => {
      try { return await gptImageEdit({ ...opts, fetcher, key: env.FAL_KEY, quality: env.GPT_IMAGE_QUALITY || undefined, model: env.GPT_IMAGE_MODEL || undefined }); }
      catch (error) {
        const prompt = opts.fallbackPrompt || opts.prompt;
        if (pruna) { try { return await pruna({ ...opts, prompt, depth: undefined }); } catch {} }
        return fal({ ...opts, prompt });
      }
    }
  };
  if (prunaKey) return {
    label: 'Pruna p-image-edit',
    get relight() { return relightWith(this.edit); },
    depth: env.FAL_KEY ? image => depthMap({ key: env.FAL_KEY, image, fetcher }) : null,
    edit: async opts => {
      try { return await prunaEdit({ ...opts, fetcher, key: prunaKey }); }
      catch (error) { if (!fal) throw error; return fal({ ...opts, prompt: opts.fallbackPrompt || opts.prompt }); } // FLUX 3 Edit as a slower fallback
    }
  };
  if (env.FAL_KEY) return { label: `fal.ai ${env.FAL_IMAGE_MODEL || 'FLUX 3 Edit'}`, edit: opts => falEdit({ ...opts, fetcher, key: env.FAL_KEY, model: env.FAL_IMAGE_MODEL || undefined, resolution: env.FAL_IMAGE_RESOLUTION || undefined }) };
  if (env.OPENAI_API_KEY) return { label: `OpenAI ${env.OPENAI_IMAGE_MODEL || 'gpt-image-1'} edit`, edit: opts => openaiEdit({ ...opts, fetcher, key: env.OPENAI_API_KEY, model: env.OPENAI_IMAGE_MODEL || undefined }) };
  return null;
}
