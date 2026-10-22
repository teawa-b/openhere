import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../backend/server.js';
import { createQloo, point, tagList } from '../backend/lib/qloo.js';
import { createTools } from '../backend/lib/tools.js';
import { redact } from '../backend/lib/http.js';

const QKEY = 'qloo-secret-key', AKEY = 'anthropic-secret-key', FKEY = 'fal-secret-key';

// A fake upstream world: Qloo, Claude, fal.ai and World Labs.
function fakeUpstreams(log = []) {
  let claudeTurn = 0;
  return async (url, options = {}) => {
    url = new URL(url);
    log.push({ host: url.host, path: url.pathname, params: Object.fromEntries(url.searchParams), headers: options.headers, body: options.body });
    if (url.host === 'hackathon.api.qloo.com') {
      assert.equal(options.headers['X-Api-Key'], QKEY);
      if (url.pathname === '/v2/tags') return Response.json({ success: true, results: { tags: [{ id: 'urn:tag:genre:place:restaurant:cafe', name: 'Cafe', types: ['urn:tag:genre:place'] }] } });
      const type = url.searchParams.get('filter.type');
      if (type === 'urn:demographics') {
        const ids = (url.searchParams.get('signal.interests.tags') || url.searchParams.get('signal.interests.entities') || '').split(',');
        const young = { '24_and_younger': 0.2, '25_to_29': 0.7, '30_to_34': 0.5, '35_to_44': -0.1, '45_to_54': -0.5, '55_and_older': -0.8 };
        const old = Object.fromEntries(Object.entries(young).map(([k, v]) => [k, -v]));
        return Response.json({ success: true, results: { demographics: ids.map(id => ({ entity_id: id, query: { age: /cozy/i.test(id) ? old : young, gender: { male: 0, female: 0 } } })) } });
      }
      if (type === 'urn:tag') return Response.json({ success: true, results: { tags: [
        { tag_id: 'urn:tag:decor:qloo:exposed_brick', name: 'Exposed Brick', query: { affinity: 0.91 } },
        { tag_id: 'urn:tag:ambience:qloo:cozy', name: 'Cozy', query: { affinity: 0.87 } }
      ] } });
      if (type === 'urn:entity:place') return Response.json({ success: true, results: { entities: [{ name: 'Sam James Coffee', entity_id: 'p1', popularity: 0.8, properties: { address: '1 Queen St W', price_level: 2 }, tags: [{ name: 'Espresso Bar' }] }] } });
      return Response.json({ success: true, results: { entities: [{ name: 'Charlotte Day Wilson', entity_id: 'a1', query: { affinity: 0.7 } }] } });
    }
    if (url.host === 'api.anthropic.com') {
      assert.equal(options.headers['x-api-key'], AKEY);
      const body = JSON.parse(options.body);
      assert.ok(body.tools.some(t => t.name === 'local_taste_tags'));
      const turns = [
        [{ type: 'text', text: 'Reading the space.' }, { type: 'tool_use', id: 't1', name: 'get_listing', input: {} }],
        [{ type: 'tool_use', id: 't2', name: 'local_taste_tags', input: { facet: 'decor' } }, { type: 'tool_use', id: 't3', name: 'local_venues', input: { category: 'cafe' } }, { type: 'tool_use', id: 't4', name: 'local_entities', input: { type: 'artist' } }],
        [{ type: 'tool_use', id: 't4b', name: 'check_audience_fit', input: { tags: ['Exposed Brick', 'Cozy'] } }],
        [{ type: 'tool_use', id: 't5', name: 'render_redesign', input: { edit_prompt: 'Exposed brick cafe', signals_used: ['Exposed Brick'] } }],
        [{ type: 'tool_use', id: 't6', name: 'finalize_concept', input: { name: 'Brickwork', tagline: 't', audience: 'a', gap: 'g', offer: 'o', design_choices: [
          { element: 'Walls', choice: 'Brick', signals: ['Exposed Brick'] },
          { element: 'Music', choice: 'R&B', signals: ['Charlotte Day Wilson'] },
          { element: 'Mood', choice: 'Velvet', signals: ['Invented Signal'] }
        ] } }]
      ];
      // Each later request must carry the tool results for the previous turn.
      if (claudeTurn > 0) assert.equal(body.messages.at(-1).content[0].type, 'tool_result');
      return Response.json({ content: turns[Math.min(claudeTurn++, turns.length - 1)] });
    }
    if (url.host === 'fal.run') {
      assert.equal(url.pathname, '/openai/gpt-image-2.5/flare/edit');
      assert.equal(JSON.parse(options.body).quality, 'medium');
      assert.equal(options.headers.authorization, `Key ${FKEY}`);
      const body = JSON.parse(options.body);
      assert.equal(body.image_urls[0], 'data:image/jpeg;base64,/9j/');
      return Response.json({ images: [{ url: 'https://v3.fal.media/files/render.jpg' }] });
    }
    if (url.host === 'api.worldlabs.ai') {
      if (url.pathname.endsWith('worlds:generate')) return Response.json({ operation_id: 'op-1', done: false });
      return Response.json({ done: true, response: { world_id: 'w1', world_marble_url: 'https://marble.worldlabs.ai/world/w1', assets: { splats: { spz_urls: { '500k': 'https://cdn.worldlabs.ai/w1-500k.spz' } } } } });
    }
    if (url.host === 'thumb.wikimedia.org') return new Response(new Uint8Array([0xff, 0xd8, 0xff]), { headers: { 'content-type': 'image/jpeg' } });
    if (url.host === 'cdn.worldlabs.ai') return new Response(new Uint8Array([1, 2, 3]));
    throw new Error(`Unexpected request to ${url}`);
  };
}

async function serve(t, env, fetcher) {
  const server = http.createServer(createApp({ env, fetcher }));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => server.close(r)));
  return `http://127.0.0.1:${server.address().port}`;
}

async function readEvents(res) {
  const text = await res.text();
  return text.split('\n\n').map(c => c.split('\n').find(l => l.startsWith('data: '))).filter(Boolean).map(l => JSON.parse(l.slice(6)));
}

test('location signals use WKT points (longitude first) and tag responses normalise', () => {
  assert.equal(point({ lat: 43.64106, lng: -79.4339 }), 'POINT(-79.433900 43.641060)');
  assert.deepEqual(tagList({ results: { tags: [{ tag_id: 'urn:tag:x', name: 'X', query: { affinity: 0.5 } }] } })[0], { id: 'urn:tag:x', name: 'X', type: undefined, affinity: 0.5, popularity: undefined });
  assert.deepEqual(redact({ error: `bad key ${QKEY}` }, [QKEY]), { error: 'bad key [redacted]' });
});

test('Qloo client sends documented taste-analysis and place parameters', async () => {
  const log = [];
  const qloo = createQloo({ key: QKEY, fetcher: fakeUpstreams(log) });
  await qloo.areaTags({ lat: 40.7, lng: -74 }, 'urn:tag:decor:qloo');
  assert.deepEqual(log[0].params, { 'filter.type': 'urn:tag', 'filter.parents.types': 'urn:entity:place', 'filter.tag.types': 'urn:tag:decor:qloo', take: '15', 'signal.location': 'POINT(-74.000000 40.700000)' });
  await qloo.places({ lat: 40.7, lng: -74 }, { tagId: 'urn:tag:genre:place:restaurant:cafe', radius: 800 });
  assert.equal(log[1].params['filter.location'], 'POINT(-74.000000 40.700000)');
  assert.equal(log[1].params['filter.location.radius'], '800');
  assert.equal(log[1].params['filter.tags'], 'urn:tag:genre:place:restaurant:cafe');
  await qloo.entities({ query: 'Parkdale' }, 'artist');
  assert.equal(log[2].params['signal.location.query'], 'Parkdale');
  assert.equal(log[2].params['filter.type'], 'urn:entity:artist');
});

test('finalize_concept flags cited signals that Qloo never returned', async () => {
  const tools = createTools({ qloo: createQloo({ key: QKEY, fetcher: fakeUpstreams() }), listing: { id: 'x', lat: 1, lng: 2, title: 'T' }, business: 'cafe', imageModel: null, saveRender: async r => r });
  await tools.run('local_taste_tags', { facet: 'decor' });
  const draft = { name: 'n', tagline: 't', audience: 'a', gap: 'g', offer: 'o', design_choices: [{ element: 'e', choice: 'c', signals: ['exposed brick', 'Made Up'] }] };
  const first = await tools.run('finalize_concept', draft);
  assert.equal(first.forModel.accepted, false, 'unverified citations are sent back once');
  assert.deepEqual(first.forModel.ungrounded, ['Made Up']);
  assert.equal(tools.state.final, null);
  assert.equal((await tools.run('finalize_concept', { ...draft, design_choices: [{ element: 'e', choice: 'c', signals: ['Exposed Brick lighting'] }] })).forModel.ungrounded[0], 'Exposed Brick lighting', 'partial matches do not count');
  const out = { forModel: { ungrounded: ['Made Up'] }, ui: { design_choices: [{ signals: [{ name: 'exposed brick', grounded: true }, { name: 'Made Up', grounded: false }] }] } };
  assert.deepEqual(out.ui.design_choices[0].signals, [{ name: 'exposed brick', grounded: true }, { name: 'Made Up', grounded: false }]);
  assert.deepEqual(out.forModel.ungrounded, ['Made Up']);
  await assert.rejects(tools.run('render_redesign', { edit_prompt: 'x', signals_used: [] }), /No image model/);
});

test('agent loop drives Qloo, image and finalize tools end to end and never leaks keys', async t => {
  const log = [];
  const base = await serve(t, { QLOO_API_KEY: QKEY, ANTHROPIC_API_KEY: AKEY, FAL_KEY: FKEY, WORLDLABS_API_KEY: 'wl-secret' }, fakeUpstreams(log));
  const config = await fetch(`${base}/api/config`).then(r => r.json());
  assert.equal(config.qloo, true); assert.match(config.llm, /Claude/); assert.equal(config.world, true);
  const res = await fetch(`${base}/api/agent`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ spaceId: 'to-1337-queen-w', business: 'cafe' }) });
  assert.equal(res.headers.get('content-type'), 'text/event-stream; charset=utf-8');
  const events = await readEvents(res);
  const raw = JSON.stringify(events);
  for (const secret of [QKEY, AKEY, FKEY]) assert.equal(raw.includes(secret), false);
  assert.deepEqual(events.filter(e => e.type === 'tool_result').map(e => e.name), ['get_listing', 'local_taste_tags', 'local_venues', 'local_entities', 'check_audience_fit', 'render_redesign', 'finalize_concept', 'finalize_concept'], 'the invented signal is sent back once, then accepted with a flag');
  const final = events.find(e => e.type === 'final');
  assert.equal(final.render.url, 'https://v3.fal.media/files/render.jpg');
  const grounded = Object.fromEntries(final.concept.design_choices.flatMap(d => d.signals).map(s => [s.name, s.grounded]));
  assert.deepEqual(grounded, { 'Exposed Brick': true, 'Charlotte Day Wilson': true, 'Invented Signal': false });
  assert.ok(events.at(-1).qlooCalls.length >= 4);
  assert.ok(log.some(l => l.params?.['signal.location'] === 'POINT(-79.433900 43.641060)'));

  // 3D: start a world from the render, poll it, and stream the proxied splat.
  const post = (path, body) => fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const { worldId } = await post('/api/world', { renderId: final.render.id, concept: { name: 'Brickwork' } }).then(r => r.json());
  const generate = log.find(l => l.path.endsWith('worlds:generate'));
  assert.equal(generate.headers['WLT-Api-Key'], 'wl-secret');
  assert.deepEqual(JSON.parse(generate.body).world_prompt.image_prompt, { source: 'uri', uri: 'https://v3.fal.media/files/render.jpg' });
  const world = await fetch(`${base}/api/world/${worldId}`).then(r => r.json());
  assert.equal(world.done, true); assert.deepEqual(world.assets.splat, ['500k']); assert.equal(world.splats, undefined);
  const asset = await fetch(`${base}/api/world/${worldId}/asset?res=500k`);
  assert.deepEqual([...new Uint8Array(await asset.arrayBuffer())], [1, 2, 3]);
  assert.equal((await fetch(`${base}/api/world/${worldId}/asset?res=full_res`)).status, 404);
});

test('scripted mode runs without an LLM and is labelled as such', async t => {
  const base = await serve(t, { QLOO_API_KEY: QKEY }, fakeUpstreams());
  const events = await readEvents(await fetch(`${base}/api/agent`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ spaceId: 'nyc-210-tenth-ave', business: 'bar' }) }));
  assert.equal(events[0].mode, 'scripted');
  const final = events.find(e => e.type === 'final');
  assert.ok(final.concept.design_choices.length >= 3);
  assert.ok(final.concept.design_choices.every(d => d.signals.every(s => s.grounded)));
  assert.equal(events.some(e => e.name === 'render_redesign'), false);
});

test('API guards: origin, missing keys, validation and limits', async t => {
  const base = await serve(t, { QLOO_API_KEY: QKEY, AGENT_RUNS_PER_HOUR: '1' }, fakeUpstreams());
  const post = (path, body, headers = {}) => fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  assert.equal((await post('/api/agent', { spaceId: 'to-1337-queen-w', business: 'cafe' }, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await post('/api/agent', { spaceId: 'nope', business: 'cafe' })).status, 400);
  assert.equal((await post('/api/world', { renderId: 'x' })).status, 503);
  assert.equal((await post('/api/spaces/custom', { address: '1 Main St', photo: 'data:text/html;base64,PGI+' })).status, 400);
  await (await post('/api/agent', { spaceId: 'to-1337-queen-w', business: 'cafe' })).text();
  assert.equal((await post('/api/agent', { spaceId: 'to-1337-queen-w', business: 'cafe' })).status, 429);
  const spaces = await fetch(`${base}/api/spaces?location=chelsea`).then(r => r.json());
  assert.deepEqual(spaces.spaces.map(s => s.id), ['nyc-210-tenth-ave']);
  const none = await fetch(`${base}/api/spaces?location=Lagos`).then(r => r.json());
  assert.equal(none.spaces.length, 0); assert.match(none.note, /Add a space/);
});

test('RealtyAPI LoopNet results map to spaces; details expose gallery, rent and traffic', async () => {
  const { nearbyListings, listingDetails } = await import('../backend/lib/realty.js');
  const calls = [];
  const fetcher = async (url, options) => {
    url = new URL(url); calls.push(url);
    assert.equal(options.headers['x-realtyapi-key'], 'realty-secret');
    if (url.pathname === '/search/bycoordinates') return Response.json({ message: 'Success', searchResults: [
      { id: '1', url: 'https://www.loopnet.com/Listing/1/', address: '2598 Folsom St', cityState: 'San Francisco, CA', zipCode: '94110', city: 'San Francisco', price: '$4.60 /SF/MO', sizeLabel: '1,950 SF', propertyType: 'Restaurant', photo: 'https://images1.loopnet.com/a.jpg', brokers: '[{"company":"Acme"}]', latitude: 37.75, longitude: -122.41 },
      { id: '2', address: '1 Office Pl', propertyType: 'Office', photo: 'https://images1.loopnet.com/b.jpg', latitude: 37.7, longitude: -122.4 },
      { id: '3', address: 'No photo', propertyType: 'Retail', latitude: 37.7, longitude: -122.4 }
    ] });
    return Response.json({ detail: { name: 'Corner Café', photos: ['https://images1.loopnet.com/a.jpg', 'https://images1.loopnet.com/c.jpg'], price: '$4.60 /SF/MO', availableSpaces: [{ size: '1,950 SF', spaceUse: '$55.20 /SF/YR $4.60 /SF/MO $107,640 /YR $8,970 /MO', buildOut: 'Triple Net (NNN)' }], facts: { 'Property Subtype': 'Restaurant' }, scores: { walk: { score: 100 } }, trafficCounts: [{ location: 'Shotwell St', crossStreet: '20th St', volume: '1,964', distance: '0.16 mi' }] } });
  };
  const { spaces } = await nearbyListings({ key: 'realty-secret', lat: 37.7512, lng: -122.4141, fetcher });
  assert.equal(calls[0].searchParams.get('searchType'), 'For_Lease');
  assert.deepEqual(spaces.map(s => s.listingId), ['1', '2']);
  assert.deepEqual([spaces[0].title, spaces[0].rentText, spaces[0].sqftApprox, spaces[0].credit.author], ['2598 Folsom St', '$4.60 /SF/MO', 1950, 'Acme']);
  await nearbyListings({ key: 'realty-secret', lat: 37.7513, lng: -122.4142, fetcher });
  assert.equal(calls.length, 1, 'nearby searches in the same cell are cached');
  const details = await listingDetails({ key: 'realty-secret', listingId: '1', fetcher });
  assert.deepEqual([details.rentText, details.subtype, details.photos.length, details.scores.walk], ['$8,970/mo', 'Restaurant', 2, 100]);
  assert.match(details.traffic[0], /Shotwell St @ 20th St: 1,964\/day/);
});

test('live walkthrough signals through fal WMA bridge, hides the key and enforces the time cap', async () => {
  const { createLive } = await import('../backend/lib/live.js');
  const calls = [];
  const fetcher = async (url, options) => {
    url = new URL(url); const body = JSON.parse(options.body); calls.push({ path: url.pathname, body });
    assert.equal(url.host, 'wma.fal.run');
    assert.equal(options.headers.authorization, 'Key fal-secret');
    if (url.pathname === '/ice') return Response.json({ ice_servers: [{ urls: 'turn:relay.example:443', username: 'u', credential: 'c' }] });
    if (url.pathname === '/session') return Response.json({ sdp: 'v=0 answer', type: 'answer', session_id: 'sess-1' });
    return Response.json({ alive: true });
  };
  const live = createLive({ key: 'fal-secret', maxSeconds: 60, fetcher });
  const started = await live.start({ url: 'https://v3b.fal.media/r.jpg', prompt: 'a bar' });
  assert.equal(calls[0].body.app_id, 'robbyant/lingbot-world-2');
  assert.equal(started.iceServers.length, 1);
  const answer = await live.session(started.liveId, 'v=0 offer', 'offer');
  assert.deepEqual([answer.type, answer.sdp, calls[1].body.sdp], ['answer', 'v=0 answer', 'v=0 offer']);
  await assert.rejects(live.session(started.liveId, 'v=0 offer'), /already connected/);
  const beat = await live.heartbeat(started.liveId);
  assert.equal(beat.alive, true); assert.ok(beat.secondsLeft <= 60);
  assert.equal(calls[2].body.session_id, 'sess-1');
  // Past the cap the server stops renewing the lease instead of forwarding the heartbeat.
  const capped = createLive({ key: 'fal-secret', maxSeconds: 0, fetcher });
  const s2 = await capped.start({ url: 'u', prompt: 'p' }); await capped.session(s2.liveId, 'v=0 offer');
  const n = calls.length;
  assert.deepEqual(await capped.heartbeat(s2.liveId), { alive: false, reason: 'time' });
  assert.equal(calls.length, n);
});

test('Pruna p-image-edit: uploads the photo, follows the status URL, and falls back to FLUX when Pruna fails', async () => {
  const { chooseImageModel } = await import('../backend/lib/images.js');
  const seen = [];
  let failPruna = false, polls = 0;
  const fetcher = async (url, options = {}) => {
    url = new URL(url); seen.push(url.host + url.pathname);
    if (url.host === 'thumb.wikimedia.org') return new Response(new Uint8Array([0xff, 0xd8, 0xff]), { headers: { 'content-type': 'image/jpeg' } });
    if (url.host === 'api.pruna.ai') {
      assert.equal(options.headers.apikey, 'pruna-secret');
      if (url.pathname === '/v1/files') return Response.json({ urls: { get: 'https://api.pruna.ai/v1/files/abc' } }, { status: 201 });
      if (url.pathname === '/v1/predictions') {
        if (failPruna) return Response.json({ error: 'busy' }, { status: 503 });
        const body = JSON.parse(options.body);
        assert.equal(options.headers.Model, 'p-image-edit');
        assert.deepEqual(body.input.images, ['https://api.pruna.ai/v1/files/abc']);
        assert.equal(body.input.aspect_ratio, 'match_input_image');
        return Response.json({ id: 'p1', get_url: 'https://api.pruna.ai/v1/predictions/status/p1' }, { status: 201 });
      }
      polls++;
      return Response.json(polls < 2 ? { status: 'processing' } : { status: 'succeeded', generation_url: 'https://api.pruna.ai/v1/predictions/delivery/x.jpeg' });
    }
    if (url.host === 'fal.run') return Response.json({ images: [{ url: 'https://v3.fal.media/fallback.jpg' }] });
    throw new Error(`Unexpected ${url}`);
  };
  const model = chooseImageModel({ PRUNAAI_KEY: 'pruna-secret', FAL_KEY: 'fal-secret', IMAGE_PROVIDER: 'pruna' }, fetcher);
  const image = { url: 'https://thumb.wikimedia.org/room.jpg' };
  const r = await model.edit({ image, prompt: 'Change the walls to brick. Keep the windows identical.' });
  assert.deepEqual([r.url, r.model, polls], ['https://api.pruna.ai/v1/predictions/delivery/x.jpeg', 'pruna/p-image-edit', 2]);
  failPruna = true;
  const fb = await model.edit({ image, prompt: 'x' });
  assert.equal(fb.url, 'https://v3.fal.media/fallback.jpg');
});

test('finalize_concept accepts design choices sent as a JSON string', async () => {
  const tools = createTools({ qloo: createQloo({ key: QKEY, fetcher: fakeUpstreams() }), listing: { id: 'x', lat: 1, lng: 2, title: 'T' }, business: 'cafe', imageModel: null, saveRender: async r => r });
  await tools.run('local_taste_tags', { facet: 'ambience' });
  const out = await tools.run('finalize_concept', { name: 'n', tagline: 't', audience: 'a', gap: 'g', offer: 'o', design_choices: JSON.stringify([{ element: 'Mood', choice: 'c', signals: ['Cozy'] }]) });
  assert.deepEqual(out.ui.design_choices[0].signals, [{ name: 'Cozy', grounded: true }]);
});

test('event venues get a booking brief, and slate acts are checked against Qloo results', async () => {
  const { systemPrompt, venueGuide } = await import('../backend/lib/agent.js');
  assert.match(venueGuide('sports bar'), /watch-party calendar/);
  assert.match(venueGuide('comedy club'), /podcast/);
  assert.match(venueGuide('live music venue'), /booking slate/);
  assert.equal(venueGuide('restaurant'), '');
  assert.match(systemPrompt('sports bar'), /Every programming act must be a name book_slate returned/);
  const tools = createTools({ qloo: createQloo({ key: QKEY, fetcher: fakeUpstreams() }), listing: { id: 'x', lat: 1, lng: 2, title: 'T' }, business: 'sports bar', imageModel: null, saveRender: async r => r });
  await tools.run('local_entities', { type: 'artist' });
  const slate = { name: 'n', tagline: 't', audience: 'a', gap: 'g', offer: 'o',
    design_choices: [{ element: 'e', choice: 'c', signals: ['Charlotte Day Wilson'] }],
    programming: [{ slot: 'Friday', act: 'Charlotte Day Wilson', why: 'local fave', signals: ['Charlotte Day Wilson'] }, { slot: 'Saturday', act: 'Made Up Band', why: 'x', signals: ['Made Up Band'] }] };
  assert.equal((await tools.run('finalize_concept', slate)).forModel.accepted, false);
  const out = await tools.run('finalize_concept', slate);
  assert.deepEqual(out.ui.programming.map(p => p.grounded), [true, false]);
});

test('lighting variants: Pruna relights a render per time of day, cached per render', async t => {
  let prunaEdits = 0;
  const base = fakeUpstreams();
  const fetcher = async (url, options = {}) => {
    const u = new URL(url);
    if (u.host === 'api.pruna.ai') {
      if (u.pathname === '/v1/files') return Response.json({ urls: { get: 'https://api.pruna.ai/v1/files/r' } }, { status: 201 });
      prunaEdits++;
      const body = JSON.parse(options.body);
      assert.equal(body.input.turbo, true);
      assert.match(body.input.prompt, /^Change the lighting to (early morning|golden hour|night)/);
      return Response.json({ status: 'succeeded', generation_url: `https://api.pruna.ai/v1/predictions/delivery/${prunaEdits}.jpeg` });
    }
    if (u.host === 'v3.fal.media') return new Response(new Uint8Array([0xff, 0xd8, 0xff]), { headers: { 'content-type': 'image/jpeg' } });
    return base(url, options);
  };
  const app = await serve(t, { QLOO_API_KEY: QKEY, ANTHROPIC_API_KEY: AKEY, FAL_KEY: FKEY, PRUNAAI_KEY: 'pruna-secret' }, fetcher);
  const events = await readEvents(await fetch(`${app}/api/agent`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ spaceId: 'to-1337-queen-w', business: 'cafe' }) }));
  const renderId = events.find(e => e.type === 'final').render.id;
  const relight = tod => fetch(`${app}/api/relight`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ renderId, tod }) }).then(r => r.json());
  const [morning, golden, night, again] = await Promise.all([relight('morning'), relight('golden'), relight('night'), relight('morning')]);
  assert.equal(prunaEdits, 3, 'one Pruna edit per time of day; repeats are served from cache');
  assert.equal(morning.render.id, again.render.id);
  assert.ok(golden.render.url && night.render.url);
  assert.equal(morning.render.model, 'pruna/p-image-edit');
  assert.equal((await fetch(`${app}/api/relight`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ renderId, tod: 'noon' }) })).status, 400);
});

test('book_slate sizes the room, caps Qloo popularity and seeds with similar local venues', async () => {
  const log = [];
  const qloo = createQloo({ key: QKEY, fetcher: fakeUpstreams(log) });
  const small = createTools({ qloo, listing: { id: 'x', lat: 37.78, lng: -122.4, title: 'T', sqftApprox: 693 }, business: 'live music venue', imageModel: null, saveRender: async r => r });
  const out = await small.run('book_slate', {});
  assert.deepEqual([out.ui.kind, out.ui.capacity, out.ui.popularityMax], ['music', 77, 0.85]);
  const artistCall = log.find(l => l.params?.['filter.type'] === 'urn:entity:artist');
  assert.equal(artistCall.params['filter.popularity.max'], '0.85');
  assert.equal(artistCall.params['signal.interests.entities'], 'p1', 'seeded with the nearby venue Qloo returned');
  assert.equal(artistCall.params['signal.location'], 'POINT(-122.400000 37.780000)');
  assert.ok(small.state.signals.has('charlotte day wilson'), 'slate candidates count as grounded signals');
  const big = createTools({ qloo, listing: { id: 'y', lat: 1, lng: 2, title: 'T', sqftApprox: 20000 }, business: 'sports bar', imageModel: null, saveRender: async r => r });
  const sports = await big.run('book_slate', {});
  assert.deepEqual([sports.ui.kind, sports.ui.capacity, sports.ui.popularityMax], ['sports', 1333, 0.97]);
});

test('check_audience_fit compares design tags with the crowd the top local venues draw', async () => {
  const tools = createTools({ qloo: createQloo({ key: QKEY, fetcher: fakeUpstreams() }), listing: { id: 'x', lat: 1, lng: 2, title: 'T', photo: 'https://example.com/p.jpg' }, business: 'cafe', imageModel: { edit: async () => ({ url: 'https://example.com/r.jpg', model: 'm' }) }, saveRender: async r => r });
  await tools.run('local_taste_tags', { facet: 'decor' });
  await assert.rejects(tools.run('render_redesign', { edit_prompt: 'x', signals_used: [] }), /check_audience_fit/);
  const out = await tools.run('check_audience_fit', { tags: ['Exposed Brick', 'Cozy'] });
  const byTag = Object.fromEntries(out.ui.checks.map(c => [c.tag, c.verdict]));
  assert.deepEqual(byTag, { 'Exposed Brick': 'fits', Cozy: 'mismatch' });
  assert.match(out.ui.checks.find(c => c.tag === 'Cozy').reason, /Cozy draws a 55\+ crowd in Qloo's data, further from the locals \(25–29\)/);
  assert.match(out.forModel.instruction, /Replace Cozy/);
});
