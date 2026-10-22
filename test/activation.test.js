import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../backend/server.js';

const QKEY = 'qloo-secret-key', AKEY = 'anthropic-secret-key', FKEY = 'fal-secret-key';

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

test('activation mode: resolves both audiences, measures overlap with explainability, maps fans and grounds partners', async t => {
  const log = [];
  let turn = 0;
  const ids = { pb: 'AFBC-PB', rb: 'RB-409F' };
  const fetcher = async (url, options = {}) => {
    url = new URL(url);
    log.push({ host: url.host, path: url.pathname, params: Object.fromEntries(url.searchParams), body: options.body });
    if (url.host === 'hackathon.api.qloo.com') {
      const p = url.searchParams;
      if (url.pathname === '/search') {
        const q = p.get('query'), type = p.get('types');
        if (/bridgers/i.test(q)) return Response.json({ results: type === 'urn:entity:artist' ? [{ name: 'Phoebe Bridgers', entity_id: ids.pb, popularity: 0.99, types: ['urn:entity:artist'] }] : [] });
        if (/red bull/i.test(q)) return Response.json({ results: type === 'urn:entity:brand' ? [{ name: 'Red Bull', entity_id: ids.rb, popularity: 0.99, types: ['urn:entity:brand'] }] : [] });
        return Response.json({ results: [] });
      }
      if (url.pathname === '/v2/analysis/compare') {
        assert.equal(p.get('a.signal.interests.entities'), ids.pb); assert.equal(p.get('b.signal.interests.entities'), ids.rb);
        return Response.json({ results: { tags: [], a: [{ tag_id: 'urn:tag:theme:qloo:heartbreak', name: 'Heartbreak', subtype: 'urn:tag:theme:qloo' }], b: [{ tag_id: 'urn:tag:genre:brand:energy_drink', name: 'Energy Drink', subtype: 'urn:tag:genre:brand' }] } });
      }
      if (url.pathname === '/v2/tags') return Response.json({ results: { tags: /neon/i.test(p.get('filter.query')) ? [] : [{ id: 'urn:tag:genre:place:bar', name: 'Bar', types: ['urn:tag:genre:place'] }] } });
      const type = p.get('filter.type'), signals = (p.get('signal.interests.entities') || '').split(',');
      if (type === 'urn:demographics') return Response.json({ results: { demographics: signals.map(id => ({ entity_id: id, query: { age: id === ids.pb ? { '24_and_younger': 0.3, '25_to_29': 0.3, '35_to_44': -0.6 } : { '24_and_younger': 0.4, '25_to_29': 0.2, '35_to_44': -0.5 }, gender: { male: 0, female: 0 } } })) } });
      if (type === 'urn:heatmap') { assert.equal(p.get('filter.location'), 'POINT(-79.433900 43.641060)'); return Response.json({ results: { heatmap: [{ location: { latitude: 43.65, longitude: -79.4 }, query: { affinity: 1, affinity_rank: 0.99, popularity: 0.5 } }, { location: { latitude: 43.7, longitude: -79.5 }, query: { affinity: 0.4, affinity_rank: 0.5, popularity: 0.9 } }] } }); }
      if (type === 'urn:tag') return Response.json({ results: { tags: [{ tag_id: 'urn:tag:decor:qloo:industrial', name: 'Industrial', query: { affinity: 0.78 } }, { tag_id: 'urn:tag:ambience:qloo:cozy', name: 'Cozy', query: { affinity: 0.74 } }] } });
      if (type === 'urn:entity:place') { assert.equal(p.get('filter.location.radius'), '2000'); return Response.json({ results: { entities: [{ name: 'Xpace Cultural Centre', entity_id: 'pl1', query: { affinity: 0.89 }, properties: {}, tags: [] }] } }); }
      // Explainability: Fender is driven by both audiences; Gatorade only by the brand's followers.
      const explain = p.get('feature.explainability') === 'true';
      const ex = (a, b) => explain ? { explainability: { 'signal.interests.entities': [{ entity_id: ids.pb, score: a }, { entity_id: ids.rb, score: b }] } } : {};
      if (type === 'urn:entity:brand') return Response.json({ results: { entities: [{ name: 'Fender', entity_id: 'b1', query: { affinity: 0.93, ...ex(0.55, 0.45) } }, { name: 'Gatorade', entity_id: 'b2', query: { affinity: 0.9, ...ex(0.05, 0.95) } }, { name: 'Red Bull', entity_id: ids.rb, query: { affinity: 0.99, ...ex(0.5, 0.5) } }] } });
      return Response.json({ results: { entities: [{ name: 'Charli XCX', entity_id: 'a1', query: { affinity: 0.91, ...ex(0.56, 0.44) } }] } });
    }
    if (url.host === 'api.anthropic.com') {
      const body = JSON.parse(options.body);
      // The chatbot check: no tools, a JSON answer with one real Qloo name, one known-but-unranked brand, one invention.
      if (!body.tools.length) return Response.json({ content: [{ type: 'text', text: '{"picks":[{"kind":"decor","name":"Industrial"},{"kind":"decor","name":"Neon Pink"},{"kind":"brand","name":"Gatorade"},{"kind":"artist","name":"Charli XCX"},{"kind":"place","name":"The Imaginary Lounge"}]}' }] });
      assert.ok(body.tools.some(t => t.name === 'audience_overlap'));
      assert.match(body.system, /Red Bull's activation for fans of Phoebe Bridgers/);
      const turns = [
        [{ type: 'tool_use', id: 't1', name: 'get_listing', input: {} }, { type: 'tool_use', id: 't2', name: 'resolve_audience', input: {} }],
        [{ type: 'tool_use', id: 't3', name: 'audience_overlap', input: {} }, { type: 'tool_use', id: 't4', name: 'fan_taste_tags', input: { facet: 'decor' } }, { type: 'tool_use', id: 't5', name: 'fan_favourites', input: { type: 'brand' } }, { type: 'tool_use', id: 't6', name: 'fan_places', input: { category: 'bar' } }, { type: 'tool_use', id: 't7', name: 'fan_heatmap', input: {} }],
        [{ type: 'tool_use', id: 't8', name: 'check_audience_fit', input: { tags: ['Industrial'] } }],
        [{ type: 'tool_use', id: 't9', name: 'render_redesign', input: { edit_prompt: 'Red Bull lightbox', signals_used: ['Industrial'] } }],
        [{ type: 'tool_use', id: 't10', name: 'finalize_concept', input: { name: 'Backstage Pass', tagline: 't', audience: 'a', gap: 'g', offer: 'o', design_choices: [{ element: 'Walls', choice: 'Steel', signals: ['Industrial'] }], partners: [{ name: 'Fender', role: 'Co-sponsor', why: 'both love' }, { name: 'Xpace Cultural Centre', role: 'Pre-show pop-up', why: 'near' }, { name: 'Monster Energy', role: 'Co-sponsor', why: 'guess' }], programming: [{ slot: 'Doors', act: 'Charli XCX', why: 'w', signals: ['Charli XCX'] }], fit: { score: 10, summary: 'A natural fit.' } } }],
        [{ type: 'tool_use', id: 't11', name: 'finalize_concept', input: { name: 'Backstage Pass', tagline: 't', audience: 'a', gap: 'g', offer: 'o', design_choices: [{ element: 'Walls', choice: 'Steel', signals: ['Industrial'] }], partners: [{ name: 'Fender', role: 'Co-sponsor', why: 'both love' }], fit: { score: 10, summary: 'A natural fit.' } } }]
      ];
      return Response.json({ content: turns[Math.min(turn++, turns.length - 1)] });
    }
    if (url.host === 'fal.run') return Response.json({ images: [{ url: 'https://v3.fal.media/files/booth.jpg' }] });
    if (url.host === 'thumb.wikimedia.org') return new Response(new Uint8Array([0xff, 0xd8, 0xff]), { headers: { 'content-type': 'image/jpeg' } });
    throw new Error(`Unexpected request to ${url}`);
  };
  const base = await serve(t, { QLOO_API_KEY: QKEY, ANTHROPIC_API_KEY: AKEY, FAL_KEY: FKEY }, fetcher);
  const post = body => fetch(`${base}/api/agent`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await post({ spaceId: 'to-1337-queen-w', activation: { brand: 'Red Bull' } })).status, 400, 'both names are required');
  const events = await readEvents(await post({ spaceId: 'to-1337-queen-w', activation: { brand: 'Red Bull', event: 'Phoebe Bridgers' } }));
  const result = name => events.find(e => e.type === 'tool_result' && e.name === name);
  assert.deepEqual(result('resolve_audience').data.event.names, ['Phoebe Bridgers']);
  const overlap = result('audience_overlap').data;
  assert.deepEqual(overlap.sharedBrands.map(b => [b.name, b.in_both_top]), [['Fender', true], ['Gatorade', true]], 'names in both top-15 lists count as shared; the brand itself is left out');
  assert.deepEqual(overlap.overlap, { brands: 1, artists: 1 }, 'identical top lists give full Jaccard overlap');
  assert.ok(overlap.score > 50 && overlap.score <= 100, `fit score ${overlap.score}`);
  assert.equal(result('fan_favourites').data.entities.find(e => e.name === 'Gatorade').shared, false);
  assert.equal(result('fan_heatmap').data.cells.length, 2);
  assert.equal(result('check_audience_fit').data.area.crowd, 'fans');
  const finals = events.filter(e => e.type === 'tool_result' && e.name === 'finalize_concept');
  assert.equal(finals.length, 2, 'the invented partner is sent back once');
  assert.deepEqual(finals[0].data.ungrounded, ['Monster Energy']);
  const final = events.find(e => e.type === 'final').concept;
  assert.deepEqual(final.partners.map(p => [p.name, p.grounded]), [['Fender', true]]);
  assert.deepEqual(final.fit, { score: overlap.score, summary: 'A natural fit.' }, 'the fit score comes from Qloo, not the model');
  assert.deepEqual(final.activation, { event: ['Phoebe Bridgers'], brand: ['Red Bull'] });
  assert.equal(final.heatmap.cells.length, 2);
  assert.ok(log.some(l => l.params['feature.explainability'] === 'true'));

  // The chatbot check reuses this run's Qloo results: a pick holds up only if Qloo ranked it for this crowd.
  const { runId } = events.find(e => e.type === 'done');
  assert.ok(runId);
  const baseline = await fetch(`${base}/api/baseline`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ runId }) }).then(r => r.json());
  assert.deepEqual(baseline.picks.map(c => [c.name, c.verdict]), [['Industrial', 'ranked'], ['Neon Pink', 'unknown'], ['Gatorade', 'ranked'], ['Charli XCX', 'ranked'], ['The Imaginary Lounge', 'unknown']]);
  assert.deepEqual(baseline.counts, { ranked: 3, known: 0, unknown: 2 });
  assert.equal((await fetch(`${base}/api/baseline`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ runId: 'nope' }) })).status, 404);
});
