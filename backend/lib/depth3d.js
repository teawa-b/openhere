import { fetchJson, UpstreamError } from './http.js';

// A painting lifted into a walkable 3D room, in two cheap steps on fal:
// 1. widen: Luma Photon Reframe (Flash) paints the room out to 21:9, so there is more of it to turn and step into
//    (about a cent).
// 2. build: MoGe-2 estimates the depth of every pixel and returns a textured mesh (glTF, camera at the origin
//    looking down -Z) in a few seconds, for well under a cent. The mesh keeps surfaces joined across depth jumps,
//    so stepping sideways stretches the furniture's edges a little instead of tearing holes in the room. It has one
//    vertex per input pixel, so the browser sends a small copy and puts the full painting back on the mesh.
export function createDepth3d({ key, fetcher = fetch }) {
  const run = (model, body, label, timeout) => fetchJson(fetcher, `https://fal.run/${model}`, {
    method: 'POST', headers: { authorization: `Key ${key}`, 'content-type': 'application/json' }, body: JSON.stringify(body)
  }, { label, secrets: [key], timeout });
  const falMedia = url => /^https:\/\/[\w.-]+\.fal\.media\//.test(url || '');
  return {
    async widen(imageUrl) {
      const data = await run('fal-ai/luma-photon/flash/reframe', {
        image_url: imageUrl, aspect_ratio: '21:9',
        prompt: 'The same room continuing naturally to the left and right, in the same lighting, palette and style.'
      }, 'fal Luma Reframe', 120000);
      const url = data.images?.[0]?.url;
      if (!falMedia(url)) throw new UpstreamError('fal Luma Reframe returned no image.');
      return url;
    },
    async build(dataUrl) {
      if (typeof dataUrl !== 'string' || !/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(dataUrl) || dataUrl.length > 500_000) {
        throw Object.assign(new Error('Send the painting as a small JPEG.'), { status: 400 });
      }
      const data = await run('fal-ai/moge-2', { image_url: dataUrl, edge_threshold: 0.5, export_ply: false }, 'fal MoGe-2', 90000);
      const url = data.model_mesh?.url;
      if (!falMedia(url)) throw new UpstreamError('fal MoGe-2 returned no mesh.');
      return { url, fovX: data.fov_x, fovY: data.fov_y };
    },
    // The mesh is streamed through this server so the page only ever talks to its own origin.
    async open(url) {
      const res = await fetcher(url, { signal: AbortSignal.timeout(60000) });
      if (!res.ok) throw new UpstreamError(`fal media returned HTTP ${res.status}.`);
      return res;
    }
  };
}
