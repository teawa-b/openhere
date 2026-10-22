import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createQloo, qlooHosts } from './lib/qloo.js';
import { chooseLlm } from './lib/llm.js';
import { chooseImageModel, aspectRatios } from './lib/images.js';
import { createWorlds } from './lib/world.js';
import { createTools } from './lib/tools.js';
import { runAgent, runScripted } from './lib/agent.js';
import { demoSpaces, demoCities, matchDemo, geocode, reverseGeocode, distanceKm, liveSearch } from './lib/listings.js';
import { createLimiter } from './lib/limits.js';
import { nearbyListings, listingDetails, rankInteriors } from './lib/realty.js';
import { createLive } from './lib/live.js';
import { createDepth3d } from './lib/depth3d.js';
import { loadDemo, listDemos, replay, demoRender } from './lib/demos.js';

// Openhere's backend: serves the pages in ../frontend and the API behind the map, the agent, the live walk and the 3D walk.
const files = {
  '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/openhere.css': ['openhere.css', 'text/css'],
  '/style.css': ['style.css', 'text/css'], '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
  '/walk': ['walk.html', 'text/html'], '/walk.js': ['walk.js', 'text/javascript'],
  '/live': ['live.html', 'text/html'], '/live.js': ['live.js', 'text/javascript'],
  '/room3d': ['room3d.html', 'text/html'], '/room3d.js': ['room3d.js', 'text/javascript'], '/room.css': ['room.css', 'text/css'],
  '/sound.js': ['sound.js', 'text/javascript'], '/fresh.js': ['fresh.js', 'text/javascript']
};
const cdn = 'https://cdn.jsdelivr.net';
// The walkthrough's import map is inline, so it is allowed by hash rather than 'unsafe-inline'.
const walkHtml = await readFile(new URL('../frontend/walk.html', import.meta.url), 'utf8');
const importMap = walkHtml.match(/<script type="importmap">([\s\S]*?)<\/script>/)[1];
const importMapHash = createHash('sha256').update(importMap).digest('base64');
const csp = {
  // The map is MapLibre GL from jsDelivr with OpenFreeMap tiles (free, no key).
  home: `default-src 'self'; img-src 'self' https: data: blob:; style-src 'self' ${cdn} https://fonts.googleapis.com; font-src https://fonts.gstatic.com ${cdn}; script-src 'self' ${cdn}; worker-src 'self' blob:; child-src blob:; connect-src 'self' https://tiles.openfreemap.org; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`,
  // The live walkthrough plays a WebRTC stream; media flows peer-to-peer, signalling goes through this server.
  live: "default-src 'self'; img-src 'self' https: data: blob:; media-src 'self' blob:; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
  walk: `default-src 'self'; img-src 'self' https: data: blob:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self' ${cdn} 'sha256-${importMapHash}' 'wasm-unsafe-eval'; worker-src 'self' blob:; connect-src 'self' ${cdn} data: blob:; base-uri 'none'; frame-ancestors 'none'`,
  // The 3D room loads three.js from jsDelivr.
  room3d: `default-src 'self'; img-src 'self' https: data: blob:; style-src 'self' ${cdn} https://fonts.googleapis.com; font-src https://fonts.gstatic.com ${cdn}; script-src 'self' ${cdn}; frame-src https://www.youtube.com https://www.youtube-nocookie.com; connect-src 'self' blob: ${cdn}; base-uri 'none'; frame-ancestors 'none'`
};

// Time-of-day lighting, written per Pruna's edit formula ("Change X. Keep Y identical.").
const timesOfDay = {
  morning: 'Change the lighting to early morning: soft cool daylight from the windows, interior lamps switched off, pale blue-white tones.',
  golden: 'Change the lighting to golden hour: low warm sunset light streaming in from the windows, long soft shadows, pendant lights glowing amber.',
  night: 'Change the lighting to night: deep navy darkness outside the windows, warm amber pendant and candle light inside, glowing tables.'
};

// Bounded in-memory stores. A single instance is enough for a demo; restarts clear them.
function boundedMap(limit) {
  const map = new Map();
  return { get: k => map.get(k), set(k, v) { map.set(k, v); while (map.size > limit) map.delete(map.keys().next().value); return v; }, has: k => map.has(k), values: () => [...map.values()] };
}

export function createApp({ env = process.env, fetcher = fetch } = {}) {
  const custom = boundedMap(200), renders = boundedMap(300), worlds = boundedMap(200), runs = boundedMap(100);
  const llm = chooseLlm(env, fetcher), imageModel = chooseImageModel(env, fetcher);
  const worldClient = env.WORLDLABS_API_KEY ? createWorlds({ key: env.WORLDLABS_API_KEY, model: env.WORLDLABS_MODEL || undefined, fetcher }) : null;
  const depth3d = env.FAL_KEY ? createDepth3d({ key: env.FAL_KEY, fetcher }) : null;
  const live = env.FAL_KEY ? createLive({ key: env.FAL_KEY, model: env.FAL_WORLD_MODEL || undefined, maxSeconds: Number(env.LIVE_MAX_SECONDS || 180), fetcher }) : null;
  const qlooHost = qlooHosts.includes(env.QLOO_API_HOST) ? env.QLOO_API_HOST : qlooHosts[0];
  const limit = createLimiter({
    agent: [Number(env.AGENT_RUNS_PER_HOUR || 5), 3600e3],
    agentIpDaily: [Number(env.AGENT_RUNS_PER_IP_PER_DAY || 12), 86400e3],
    refine: [Number(env.REFINES_PER_HOUR || 8), 3600e3],
    baseline: [Number(env.BASELINES_PER_HOUR || 12), 3600e3],
    relight: [Number(env.RELIGHTS_PER_HOUR || 20), 3600e3],
    world: [Number(env.WORLDS_PER_HOUR || 3), 3600e3],
    upload: [20, 3600e3],
    geocode: [120, 3600e3],
    listings: [Number(env.LISTING_SEARCHES_PER_HOUR || 20), 3600e3],
    worldDaily: [Number(env.WORLDS_PER_DAY || 25), 86400e3, true],
    agentDaily: [Number(env.AGENT_RUNS_PER_DAY || 200), 86400e3, true],
    live: [Number(env.LIVE_SESSIONS_PER_HOUR || 2), 3600e3],
    liveIpDaily: [Number(env.LIVE_SESSIONS_PER_IP_PER_DAY || 3), 86400e3],
    liveDaily: [Number(env.LIVE_SESSIONS_PER_DAY || 20), 86400e3, true],
    room3d: [Number(env.ROOMS_3D_PER_HOUR || 20), 3600e3],
    room3dDaily: [Number(env.ROOMS_3D_PER_DAY || 300), 86400e3, true]
  });

  const findSpace = id => demoSpaces.find(s => s.id === id) || custom.get(id);
  const publicSpace = s => { const { photoBytes, photoType, ...rest } = s; return { ...rest, photo: s.photoBytes ? `/api/photo/${s.id}` : s.photo }; };
  async function saveRender(result) {
    const id = randomUUID();
    const render = { id, url: result.url || `/api/render/${id}`, model: result.model, prompt: result.prompt, aspect: result.aspect, signals: result.signals, listingId: result.listingId, parent: result.parent };
    renders.set(id, { ...render, remoteUrl: result.url, bytes: result.bytes, type: result.type });
    return render;
  }
  const renderImage = r => r.remoteUrl ? { url: r.remoteUrl } : { bytes: r.bytes, type: r.type };
  // A render made on this instance, or one from a recorded example (any instance can serve those).
  const getRender = async id => renders.get(String(id || '')) || (await demoRender(id).then(r => r && renders.set(r.id, { ...r })));

  return async function handle(req, res) {
    const send = (status, value, headers = {}) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers }); res.end(JSON.stringify(value)); };
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    // Who is asking, for the limits. Behind a proxy (Railway) the real address is the one the proxy adds: X-Real-IP,
    // or the last X-Forwarded-For entry. The first entry is whatever the visitor sent, so it can't be trusted.
    const ip = String(req.headers['x-real-ip'] || String(req.headers['x-forwarded-for'] || '').split(',').pop() || req.socket.remoteAddress || '').trim();
    try {
      const url = new URL(req.url, 'http://localhost');
      const path = url.pathname;
      // Static images and 3D rooms shipped with the app (logos, the examples). Names are restricted, so no path tricks.
      const image = path.match(/^\/img\/([a-z0-9-]+)\.(jpg|png|webp|glb)$/);
      if (req.method === 'GET' && image) {
        const bytes = await readFile(new URL(`../frontend/img/${image[1]}.${image[2]}`, import.meta.url)).catch(() => null);
        if (!bytes) return send(404, { error: 'Not found' });
        res.writeHead(200, { 'Content-Type': image[2] === 'glb' ? 'model/gltf-binary' : `image/${image[2] === 'jpg' ? 'jpeg' : image[2]}`, 'Cache-Control': 'public, max-age=86400' });
        return res.end(bytes);
      }
      const entry = files[path];
      if (req.method === 'GET' && entry) {
        const [name, type] = entry;
        res.setHeader('Content-Security-Policy', csp[['walk', 'live', 'room3d'].find(p => path.startsWith(`/${p}`))] || csp.home);
        res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-cache' });
        return res.end(await readFile(new URL(`../frontend/${name}`, import.meta.url)));
      }
      if (req.method === 'GET' && path === '/api/health') return send(200, { ok: true, version: env.VERCEL_DEPLOYMENT_ID || env.VERCEL_URL || 'local' });
      if (req.method === 'GET' && path === '/api/demos') return send(200, { demos: await listDemos('openhere') });
      if (req.method === 'GET' && path === '/api/config') {
        return send(200, { site: 'openhere', siteName: 'Openhere', qloo: Boolean(env.QLOO_API_KEY), qlooHost, llm: llm?.label || null, image: imageModel?.label || null, world: Boolean(worldClient), liveWorld: live ? { model: live.model, maxSeconds: live.maxSeconds } : null, room3d: Boolean(depth3d), live: Boolean(env.REALTYAPI_KEY || env.APIFY_TOKEN), demoCities });
      }
      if (req.method === 'GET' && (path === '/api/geocode' || path === '/api/reverse')) {
        if (!limit.take('geocode', ip)) return send(429, { error: 'Too many searches. Slow down a little.' });
        if (path === '/api/geocode') {
          const q = (url.searchParams.get('q') || '').trim().slice(0, 160);
          if (!q) return send(400, { error: 'Type a place.' });
          const place = await geocode(q, fetcher);
          return place ? send(200, { place }) : send(404, { error: `Couldn't find “${q}”.` });
        }
        const lat = Number(url.searchParams.get('lat')), lng = Number(url.searchParams.get('lng'));
        if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return send(400, { error: 'Invalid point.' });
        return send(200, { place: await reverseGeocode(lat, lng, fetcher) });
      }
      if (req.method === 'GET' && path === '/api/spaces') {
        const location = (url.searchParams.get('location') || '').slice(0, 120);
        const lat = Number(url.searchParams.get('lat')), lng = Number(url.searchParams.get('lng'));
        const near = url.searchParams.has('lat') && Number.isFinite(lat) && Number.isFinite(lng);
        const pool = [...demoSpaces, ...custom.values().filter(s => s.kind === 'own')];
        let spaces = (near ? pool.map(s => ({ ...s, distanceKm: Math.round(distanceKm({ lat, lng }, s) * 10) / 10 })).sort((a, b) => a.distanceKm - b.distanceKm) : matchDemo(location)).map(publicSpace), source = 'demo', note = '';
        if (near && env.REALTYAPI_KEY) {
          if (!limit.take('listings', ip)) note = 'Live listing searches are paused for a bit; showing sample spaces.';
          else {
            try {
              const live = await nearbyListings({ key: env.REALTYAPI_KEY, lat, lng, fetcher });
              // A listing without coordinates is pinned to the searched point so Qloo still profiles the right area.
              const located = live.spaces.map(s => ({ ...s, lat: s.lat ?? lat, lng: s.lng ?? lng, approximate: s.lat == null }));
              located.forEach(s => custom.set(s.id, s));
              spaces = [...located.map(s => publicSpace({ ...s, distanceKm: Math.round(distanceKm({ lat, lng }, s) * 10) / 10 })).sort((a, b) => a.distanceKm - b.distanceKm), ...spaces];
              source = 'live';
              if (!located.length) note = 'No restaurant or retail spaces listed for lease right around here.';
            } catch (error) { note = `Live listings unavailable: ${error.message}`; }
          }
        }
        if (env.APIFY_TOKEN && location && url.searchParams.get('live') === '1') {
          try { const live = await liveSearch({ token: env.APIFY_TOKEN, actor: env.APIFY_ACTOR || undefined, location, fetcher }); live.forEach(s => custom.set(s.id, s)); spaces = [...live.map(publicSpace), ...spaces]; source = 'live'; }
          catch (error) { note = `Live listings unavailable: ${error.message}`; }
        }
        if (!spaces.length && !near) note ||= `No demo spaces in “${location}” yet. Add a space you're touring with a photo and address.`;
        return send(200, { spaces, source, note });
      }
      let match = path.match(/^\/api\/spaces\/([\w-]+)\/details$/);
      if (req.method === 'GET' && match) {
        const space = findSpace(match[1]);
        if (!space) return send(404, { error: 'Unknown space.' });
        if (space.kind !== 'live' || !env.REALTYAPI_KEY) return send(200, { space: publicSpace(space) });
        if (!space.details) {
          if (!limit.take('listings', ip)) return send(429, { error: 'Too many listing lookups. Try again shortly.' });
          const details = await listingDetails({ key: env.REALTYAPI_KEY, listingId: space.listingId, fetcher });
          Object.assign(space, { details, photos: details.photos.length ? details.photos : [space.photo], rentText: details.rentText || space.rentText, sizeText: details.sizeText || space.sizeText, title: space.title });
          // Put usable interior shots first so the picker (and the default choice) starts with a real room.
          if (llm?.look && space.photos.length > 1) {
            const { interiors } = await rankInteriors({ photos: space.photos, look: (llm.fast || llm).look, fetcher }).catch(() => ({ interiors: [] }));
            space.interiors = interiors;
            space.photos = [...interiors, ...space.photos.filter(p => !interiors.includes(p))];
          }
        }
        return send(200, { space: publicSpace(space) });
      }
      match = path.match(/^\/api\/photo\/([\w-]+)$/);
      if (req.method === 'GET' && match) {
        const space = custom.get(match[1]);
        if (!space?.photoBytes) return send(404, { error: 'Not found' });
        res.writeHead(200, { 'Content-Type': space.photoType, 'Cache-Control': 'private, max-age=3600' });
        return res.end(space.photoBytes);
      }
      match = path.match(/^\/api\/render\/([\w-]+)$/);
      if (req.method === 'GET' && match) {
        const render = await getRender(match[1]);
        if (!render) return send(404, { error: 'This render has expired.' });
        if (render.remoteUrl) { res.writeHead(302, { Location: render.remoteUrl }); return res.end(); }
        res.writeHead(200, { 'Content-Type': render.type, 'Cache-Control': 'private, max-age=3600' });
        return res.end(render.bytes);
      }
      // A room's 3D mesh, streamed from fal (see lib/depth3d.js). The link carries the fal file itself, so any
      // server instance can answer it; only fal's own media host is ever fetched.
      if (req.method === 'GET' && path === '/api/room3d/mesh') {
        const src = url.searchParams.get('u') || '';
        if (!depth3d || !/^https:\/\/[\w.-]+\.fal\.media\/[\w./-]+\.glb$/.test(src)) return send(404, { error: 'Not found' });
        const upstream = await depth3d.open(src);
        res.writeHead(200, { 'Content-Type': 'model/gltf-binary', 'Cache-Control': 'public, max-age=86400' });
        for await (const chunk of upstream.body) res.write(chunk);
        return res.end();
      }
      match = path.match(/^\/api\/world\/([\w.:-]+)(\/asset)?$/);
      if (req.method === 'GET' && match) {
        const world = worlds.get(match[1]);
        if (!world || !worldClient) return send(404, { error: 'Unknown walkthrough.' });
        if (!world.result?.done) {
          const status = await worldClient.status(world.operationId);
          if (status.done) world.result = status; else return send(200, { done: false, progress: status.progress, startedAt: world.startedAt, render: world.render });
        }
        if (!match[2]) return send(200, { ...world.result, splats: undefined, collider: undefined, render: world.render, concept: world.concept, assets: { splat: Object.keys(world.result.splats || {}).filter(k => world.result.splats[k]), collider: Boolean(world.result.collider) } });
        // Assets are proxied so the browser only talks to this origin, and only to URLs World Labs returned.
        const kind = url.searchParams.get('kind');
        const target = kind === 'collider' ? world.result.collider : world.result.splats?.[url.searchParams.get('res') || '500k'];
        if (!target) return send(404, { error: 'Asset not available.' });
        const upstream = await fetcher(target, { signal: AbortSignal.timeout(120000) });
        if (!upstream.ok) return send(502, { error: `World asset returned HTTP ${upstream.status}.` });
        res.writeHead(200, { 'Content-Type': kind === 'collider' ? 'model/gltf-binary' : 'application/octet-stream', 'Cache-Control': 'private, max-age=86400' });
        for await (const chunk of upstream.body) res.write(chunk);
        return res.end();
      }

      if (req.method !== 'POST') return send(404, { error: 'Not found' });
      const origin = req.headers.origin;
      if (origin) { let host; try { host = new URL(origin).host; } catch {} if (host !== req.headers.host) return send(403, { error: 'Requests must come from this app.' }); }

      // Photo uploads and the listing photo sent with a run need more room than the JSON endpoints.
      const body = await readBody(req, path === '/api/spaces/custom' ? 9_000_000 : path === '/api/agent' ? 4_800_000 : path === '/api/room3d' ? 600_000 : 32_000);

      // Instant demos: replay a recorded real run (no live calls, no run limit). See lib/demos.js.
      const demoSite = { '/api/agent': 'openhere' }[path];
      if (demoSite && body.demo) {
        const demo = await loadDemo(demoSite, body.demo);
        if (!demo) return send(404, { error: 'That example is not available.' });
        // Re-register the recorded renders so refine, relight and the live walkthrough work from a replay.
        for (const r of demo.renders || []) if (!renders.has(r.id)) renders.set(r.id, { ...r, url: r.url, remoteUrl: r.remoteUrl });
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        const emit = event => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`); };
        // An optional slower pace (ms per step, capped) lets the explainer videos film the steps arriving.
        try { await replay(demo, emit, { step: Math.min(1500, Math.max(140, Number(body.pace) || 140)) }); } finally { res.end(); }
        return;
      }

      if (path === '/api/spaces/custom') {
        if (!limit.take('upload', ip)) return send(429, { error: 'Too many uploads. Try again later.' });
        let address = String(body.address || '').trim().slice(0, 200);
        const pin = Number.isFinite(body.lat) && Number.isFinite(body.lng) && Math.abs(body.lat) <= 90 && Math.abs(body.lng) <= 180 ? { lat: body.lat, lng: body.lng } : null;
        const m = String(body.photo || '').match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/);
        if (!address && !pin) return send(400, { error: 'Add the street address of the space.' });
        if (!m) return send(400, { error: 'Add a JPEG, PNG or WebP photo of the space.' });
        const bytes = Buffer.from(m[2], 'base64');
        if (bytes.length > 6_000_000) return send(413, { error: 'Use a photo under 6 MB.' });
        const place = pin ? { ...pin, ...(await reverseGeocode(pin.lat, pin.lng, fetcher).catch(() => ({}))) } : await geocode(address, fetcher);
        address ||= place.display || `${pin.lat.toFixed(5)}, ${pin.lng.toFixed(5)}`;
        if (!place) return send(400, { error: 'Could not find that address. Add the city and postcode.' });
        const space = { id: `own-${randomUUID().slice(0, 8)}`, kind: 'own', title: String(body.title || '').slice(0, 80) || address.split(',')[0], address, city: place.city || '', neighborhood: place.neighborhood || '', lat: pin?.lat ?? place.lat, lng: pin?.lng ?? place.lng, formerUse: String(body.formerUse || '').slice(0, 160) || 'Not specified', sqftApprox: Number(body.sqft) || undefined, rentText: String(body.rent || '').slice(0, 40) || undefined, photoBytes: bytes, photoType: m[1], credit: { author: 'Uploaded by you', license: 'Private' } };
        custom.set(space.id, space);
        return send(200, { space: publicSpace(space) });
      }

      if (path === '/api/agent') {
        // A live listing found by another server instance is sent back by the page; only its plain details are kept.
        const sent = body.space && typeof body.space === 'object' && /^loopnet-[\w-]{1,40}$/.test(String(body.space.id || '')) && Number.isFinite(body.space.lat) && Number.isFinite(body.space.lng)
          ? Object.fromEntries(Object.entries({ id: body.space.id, kind: 'live', title: body.space.title, address: body.space.address, city: body.space.city, neighborhood: body.space.neighborhood, rentText: body.space.rentText, sizeText: body.space.sizeText, formerUse: body.space.formerUse, photo: body.space.photo, lat: body.space.lat, lng: body.space.lng }).map(([k, v]) => [k, typeof v === 'string' ? v.slice(0, 300) : v]))
          : null;
        let found = findSpace(String(body.spaceId || '')) || (sent?.id === body.spaceId ? sent : null);
        // Listing sites (LoopNet) refuse downloads from cloud servers, fal's included, but the visitor's browser can
        // read the photo; the page sends it, and the redesign edits those exact pixels.
        const sentPhoto = String(body.photoData || '').match(/^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/);
        if (found && sentPhoto) { const bytes = Buffer.from(sentPhoto[1], 'base64'); if (bytes.length <= 3_500_000) found = { ...found, photoBytes: bytes, photoType: 'image/jpeg' }; }
        // A live listing has a gallery; the user picks which room to redesign (only photos from that listing).
        const chosen = found && body.photo && found.photos?.includes(body.photo) ? { ...found, photo: body.photo } : found;
        const space = chosen && aspectRatios.includes(body.aspect) ? { ...chosen, aspect: body.aspect } : chosen;
        // Activation mode: a brand × event pair instead of a business type.
        const clean = v => String(v || '').trim().replace(/\s+/g, ' ').slice(0, 80);
        const activation = body.activation && typeof body.activation === 'object' ? { event: clean(body.activation.event), brand: clean(body.activation.brand) } : null;
        const business = activation ? `${activation.brand} activation for ${activation.event} fans` : clean(body.business).slice(0, 60);
        if (!space) return send(400, { error: 'Choose a space first.' });
        if (activation && (!activation.event || !activation.brand)) return send(400, { error: 'Name the event (a headliner, team or show) and the brand.' });
        if (activation && !llm) return send(503, { error: 'Activations need an LLM key on the server (OPENROUTER_API_KEY, ANTHROPIC_API_KEY or OPENAI_API_KEY).' });
        if (!business) return send(400, { error: 'Choose a business type.' });
        if (!env.QLOO_API_KEY) return send(503, { error: 'This server has no Qloo API key configured.' });
        if (!limit.take('agent', ip) || !limit.take('agentIpDaily', ip) || !limit.take('agentDaily', 'all')) return send(429, { error: 'The agent is busy: run limit reached. Try again in a while.' });
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        const emit = event => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`); };
        const heartbeat = setInterval(() => !res.writableEnded && res.write(': ping\n\n'), 15000);
        const qloo = createQloo({ key: env.QLOO_API_KEY, host: qlooHost, fetcher });
        const tools = createTools({ qloo, listing: space, business, imageModel, saveRender, look: llm?.look, activation });
        try {
          if (llm) await runAgent({ llm, tools, business, listing: space, notes: String(body.notes || ''), emit, activation });
          else await runScripted({ tools, business, emit, hasImages: Boolean(imageModel) });
        } catch (error) { emit({ type: 'error', message: error.message }); }
        finally {
          clearInterval(heartbeat);
          // Keep what Qloo returned in this run so the chatbot check can test a tool-less answer against it.
          const runId = randomUUID();
          runs.set(runId, { signals: tools.signals(), business, activation, listing: { title: space.title, address: space.address, neighborhood: space.neighborhood, city: space.city } });
          emit({ type: 'done', qlooCalls: qloo.calls, runId }); res.end();
        }
        return;
      }

      // "Why not just ask a chatbot?": the same brief, answered by the LLM with no tools, then each pick
      // checked against Qloo. A pick holds up when it is a real Qloo name that ranked in this crowd's
      // top results during the run; it is merely plausible when Qloo knows it but did not rank it here.
      if (path === '/api/baseline') {
        // A replayed demo carries the chatbot check recorded with it.
        if (body.demo) { const demo = await loadDemo('openhere', body.demo); return demo?.baseline ? send(200, demo.baseline) : send(404, { error: 'No recorded chatbot check for this example.' }); }
        const run = runs.get(String(body.runId || ''));
        if (!run) return send(404, { error: 'That run has expired. Run the agent again.' });
        if (!llm) return send(503, { error: 'No LLM key on the server.' });
        if (run.baseline) return send(200, run.baseline);
        if (!limit.take('baseline', ip)) return send(429, { error: 'Chatbot check limit reached. Try again later.' });
        const { listing, business, activation } = run;
        const where = [listing.neighborhood, listing.city].filter(Boolean).join(', ');
        const brief = activation
          ? `Design ${activation.brand}'s pop-up activation for fans of ${activation.event} inside "${listing.title}" (${listing.address}).`
          : `Design a ${business} to open in "${listing.title}" (${listing.address}).`;
        const session = llm.create({
          system: 'You are a creative director. Answer from your own knowledge only. Reply with JSON only, no prose.',
          tools: [],
          user: `${brief} Give exactly 8 specific picks for ${activation ? 'these fans' : `the people who go out in ${where}`} as JSON: {"picks":[{"kind":"decor","name":"..."},...]} with kinds: three "decor" (short decor or ambience descriptors, e.g. "Exposed Brick", "Cozy"), two "brand" (brands to partner with), two "artist" (artists for the playlist), one "place" (a real venue near ${listing.address} to partner with). Names only, each 1–4 words.`
        });
        const { text } = await session.next();
        let picks = [];
        try { picks = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)).picks.slice(0, 8); } catch { return send(502, { error: 'The chatbot did not answer in the expected shape.' }); }
        const qloo = createQloo({ key: env.QLOO_API_KEY, host: qlooHost, fetcher });
        const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
        const known = new Map(run.signals.map(s => [norm(s.name), s]));
        const checks = await Promise.all(picks.map(async p => {
          const name = String(p.name || '').slice(0, 60), kind = ['decor', 'brand', 'artist', 'place'].includes(p.kind) ? p.kind : 'decor';
          const hit = known.get(norm(name));
          let exists = Boolean(hit), match = hit?.name || null;
          if (!exists) {
            try {
              const found = kind === 'decor' ? await qloo.tags(name) : await qloo.search(name, kind === 'place' ? 'place' : kind, 3);
              const same = found.find(f => norm(f.name) === norm(name)) || found.find(f => norm(f.name).includes(norm(name)) || norm(name).includes(norm(f.name)));
              if (same) { exists = true; match = same.name; }
            } catch {}
          }
          return { kind, name, verdict: hit ? 'ranked' : exists ? 'known' : 'unknown', match, source: hit?.source || null };
        }));
        const counts = { ranked: checks.filter(c => c.verdict === 'ranked').length, known: checks.filter(c => c.verdict === 'known').length, unknown: checks.filter(c => c.verdict === 'unknown').length };
        run.baseline = { model: session.model, picks: checks, counts, total: checks.length };
        return send(200, run.baseline);
      }

      // Time-of-day variants of a render. The studio requests all three as soon as a redesign lands,
      // so they are usually ready before anyone clicks; results are cached per render.
      if (path === '/api/relight') {
        const render = await getRender(body.renderId);
        const tod = String(body.tod || '');
        if (!render) return send(404, { error: 'That render has expired. Run the agent again.' });
        if (!timesOfDay[tod]) return send(400, { error: 'Unknown time of day.' });
        if (!imageModel) return send(503, { error: 'No image model is configured.' });
        render.relights ||= {};
        if (!render.relights[tod]) {
          if (!limit.take('relight', ip)) return send(429, { error: 'Relight limit reached. Try again later.' });
          const prompt = `${timesOfDay[tod]} Keep every wall, window, door, piece of furniture, material and sign identical, with the same camera angle and framing.`;
          const relight = imageModel.relight || (opts => imageModel.edit({ ...opts, fast: true }));
          render.relights[tod] = relight({ image: renderImage(render), prompt, aspect: render.aspect })
            .then(result => saveRender({ ...result, prompt: timesOfDay[tod], aspect: render.aspect, listingId: render.listingId, signals: render.signals, parent: render.id }));
          render.relights[tod].catch(() => { delete render.relights[tod]; });
        }
        return send(200, { render: await render.relights[tod] });
      }

      if (path === '/api/refine') {
        const render = await getRender(body.renderId);
        const instruction = String(body.instruction || '').trim().slice(0, 400);
        if (!render) return send(404, { error: 'That render has expired. Run the agent again.' });
        if (!instruction) return send(400, { error: 'Describe the change.' });
        if (!imageModel) return send(503, { error: 'No image model is configured.' });
        if (!limit.take('refine', ip)) return send(429, { error: 'Change limit reached. Try again later.' });
        const prompt = `${instruction} Keep everything else in the photo identical: every wall, window, door, piece of furniture, material and the camera angle and framing.`;
        // Quick lighting tweaks (time of day) use the fast path; free-form changes use full quality.
        const result = await imageModel.edit({ image: renderImage(render), prompt, aspect: render.aspect, fast: body.fast === true });
        return send(200, { render: await saveRender({ ...result, prompt: instruction, aspect: render.aspect, listingId: render.listingId, signals: render.signals, parent: render.id }) });
      }

      if (path.startsWith('/api/live/')) {
        if (!live) return send(503, { error: 'Live walkthroughs need a fal key on the server.' });
        const liveId = String(body.liveId || '');
        if (path === '/api/live/start') {
          const image = /^https:\/\/[\w.-]+\.fal\.media\/[\w./-]+$/.test(String(body.image || '')) ? body.image : null;
          const render = (await getRender(body.renderId)) || (image && { remoteUrl: image, prompt: '' });
          if (!render?.remoteUrl) return send(404, { error: 'That render has expired. Run the agent again.' });
          if (!limit.take('live', ip) || !limit.take('liveIpDaily', ip) || !limit.take('liveDaily', 'all')) return send(429, { error: 'Live walkthrough limit reached. Try again later.' });
          const concept = body.concept && typeof body.concept === 'object' ? { name: String(body.concept.name || '').slice(0, 80), tagline: String(body.concept.tagline || '').slice(0, 160) } : {};
          const world = { url: render.remoteUrl, prompt: `Walking through ${concept.name || 'a redesigned venue'}, a newly renovated interior. ${String(render.prompt || '').split('\n')[0].slice(0, 900)}`, concept };
          return send(200, { ...(await live.start(world)), world });
        }
        if (path === '/api/live/session') return send(200, await live.session(liveId, body.sdp, body.type));
        if (path === '/api/live/heartbeat') return send(200, await live.heartbeat(liveId));
        if (path === '/api/live/end') { live.end(liveId); return send(200, { ok: true }); }
        return send(404, { error: 'Not found' });
      }

      // A painting widened to 21:9 first, so its 3D room has more to walk into. The painting is one of this site's
      // images, a render made here, or a fal image.
      if (path === '/api/room3d/widen') {
        if (!depth3d) return send(503, { error: '3D rooms need a fal key on the server.' });
        const src = String(body.painting || '');
        let image = null;
        const local = src.match(/^\/img\/([a-z0-9-]+)\.(jpg|png)$/), made = src.match(/^\/api\/render\/([\w-]+)$/);
        if (local) { const bytes = await readFile(new URL(`../frontend/img/${local[1]}.${local[2]}`, import.meta.url)).catch(() => null); if (bytes) image = `data:image/${local[2] === 'jpg' ? 'jpeg' : 'png'};base64,${bytes.toString('base64')}`; }
        else if (made) { const r = await getRender(made[1]); image = r?.remoteUrl || (r?.bytes ? `data:${r.type};base64,${Buffer.from(r.bytes).toString('base64')}` : null); }
        else if (/^https:\/\/[\w.-]+\.fal\.media\/[\w./-]+$/.test(src)) image = src;
        if (!image) return send(404, { error: 'That painting has expired. Build the room again.' });
        if (!limit.take('room3d', ip) || !limit.take('room3dDaily', 'all')) return send(429, { error: '3D room limit reached. Try again later.' });
        return send(200, { image: await depth3d.widen(image) });
      }

      if (path === '/api/room3d') {
        if (!depth3d) return send(503, { error: '3D rooms need a fal key on the server.' });
        if (!limit.take('room3d', ip) || !limit.take('room3dDaily', 'all')) return send(429, { error: '3D room limit reached. Try again later.' });
        const room = await depth3d.build(body.image);
        return send(200, { glb: `/api/room3d/mesh?${new URLSearchParams({ u: room.url })}`, fovX: room.fovX });
      }

      if (path === '/api/world') {
        if (!worldClient) return send(503, { error: 'This server has no World Labs key, so 3D walkthroughs are off.' });
        const render = await getRender(body.renderId);
        if (!render) return send(404, { error: 'That render has expired. Run the agent again.' });
        if (render.worldOp) return send(200, { worldId: render.worldOp });
        if (!limit.take('world', ip) || !limit.take('worldDaily', 'all')) return send(429, { error: '3D walkthrough limit reached. Try again later.' });
        const concept = body.concept && typeof body.concept === 'object' ? { name: String(body.concept.name || '').slice(0, 80), tagline: String(body.concept.tagline || '').slice(0, 160) } : null;
        const { operationId } = await worldClient.start({ image: renderImage(render), caption: `Interior of ${concept?.name || 'a redesigned venue'}: ${render.prompt}`, name: concept?.name || 'Openhere walkthrough' });
        worlds.set(operationId, { operationId, startedAt: Date.now(), render: { id: render.id, url: render.url }, concept });
        render.worldOp = operationId;
        return send(200, { worldId: operationId });
      }

      return send(404, { error: 'Not found' });
    } catch (error) {
      if (res.headersSent) { try { res.end(); } catch {} return; }
      send(error.status && error.status < 600 ? error.status : 400, { error: error.message, ...(error.details ? { details: error.details } : {}) });
    }
  };
}

async function readBody(req, max) {
  let raw = '';
  for await (const chunk of req) { raw += chunk; if (raw.length > max) throw Object.assign(new Error('Request too large.'), { status: 413 }); }
  try { const body = JSON.parse(raw); if (body && typeof body === 'object') return body; } catch {}
  throw Object.assign(new Error('Invalid JSON.'), { status: 400 });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3300);
  const host = process.env.HOST || (process.env.PORT ? '0.0.0.0' : '127.0.0.1');
  http.createServer(createApp()).listen(port, host, () => console.log(`Openhere running at http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`));
}
