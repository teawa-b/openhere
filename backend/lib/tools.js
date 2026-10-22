import { placeTagTypes, entityTypes, rankVenueTags } from './qloo.js';
import { imageBytes } from './images.js';

// A vision pass names the room's permanent architecture once per photo. The agent uses it to place
// things ("counter along the left wall") and the image prompt uses it as the keep-list, following
// Pruna's edit formula: "Change [specific things]. Keep [named things] identical."
const surveys = new Map();
const surveyQuestion = `You are surveying a photo of a commercial interior before a renovation render. Reply with JSON only, no prose:
{"depth": "one sentence on how deep the room reads and its zones, e.g. long narrow room receding about 25 m; foreground floor bottom third, middle zone around the columns, back wall small at centre",
 "keep": [6-10 short phrases naming only the permanent structure you can see (walls, windows, doors, columns, beams, ceiling, stairs, ducts), each with where it sits in the frame; leave out wall coverings, flooring, furniture, signage and light fixtures, since a redesign will change those, e.g. "drop-ceiling grid with two rows of fluorescent lights", "two square white columns toward the back right", "glass storefront windows along the left wall", "dark doorway in the centre of the back wall"],
 "camera": "one short phrase on the viewpoint, e.g. eye level from the entrance looking toward the back wall",
 "surfaces": [3-6 current finishes or fixtures that a redesign could restyle, with position, e.g. "grey slatwall along the left wall", "stained white vinyl floor tiles"]}`;
const depths = new Map();
const ageBands = ['24_and_younger', '25_to_29', '30_to_34', '35_to_44', '45_to_54', '55_and_older'];
const bandLabel = { '24_and_younger': 'under 25', '25_to_29': '25–29', '30_to_34': '30–34', '35_to_44': '35–44', '45_to_54': '45–54', '55_and_older': '55+' };
function averageDemo(items) {
  const age = Object.fromEntries(ageBands.map(b => [b, 0])), gender = { male: 0, female: 0 };
  let total = 0;
  for (const { demo, w } of items) {
    if (!demo) continue;
    total += w;
    ageBands.forEach(b => { age[b] += w * (demo.age[b] || 0); });
    gender.male += w * (demo.gender.male || 0); gender.female += w * (demo.gender.female || 0);
  }
  const r = n => Math.round((total ? n / total : 0) * 100) / 100;
  return { age: Object.fromEntries(ageBands.map(b => [b, r(age[b])])), gender: { male: r(gender.male), female: r(gender.female) } };
}
// Cosine similarity of two age-skew profiles: +1 same crowd, -1 opposite crowd.
function similarity(a, b) {
  const x = ageBands.map(k => a[k] || 0), y = ageBands.map(k => b[k] || 0);
  const dot = x.reduce((s, v, i) => s + v * y[i], 0), n = Math.hypot(...x) * Math.hypot(...y);
  return n ? dot / n : 0;
}
function skew(d) {
  const top = ageBands.reduce((best, b) => (d.age[b] ?? -9) > (d.age[best] ?? -9) ? b : best, ageBands[0]);
  const g = (d.gender?.female || 0) - (d.gender?.male || 0);
  return `${bandLabel[top]}${Math.abs(g) >= 0.3 ? `, ${g > 0 ? 'female' : 'male'}` : ''}`;
}
// What each kind of event venue books, which local rooms seed it, and roughly how much floor a guest takes.
const slatePlans = {
  music: { venue: 'live music venue', types: ['artist'], sqftPerGuest: 9, label: 'acts' },
  comedy: { venue: 'comedy club', types: ['person', 'podcast'], sqftPerGuest: 12, label: 'comedians and live-taping podcasts' },
  sports: { venue: 'sports bar', types: ['person', 'brand'], sqftPerGuest: 15, label: 'athletes and teams' },
  talks: { venue: 'coworking space', types: ['podcast', 'brand'], sqftPerGuest: 15, label: 'podcasts and brands' }
};
const genericKeep = ['the walls, windows and doors in their current positions', 'the ceiling and its height', 'every column and structural beam', 'the floor plan'];

// Tools the agent can call. Each returns { forModel, ui, summary }: compact JSON for the LLM,
// richer data for the browser, and a one-line summary for the activity feed.
// Every Qloo tag, venue or entity the agent sees is recorded so finalize_concept can
// check that each cited signal really came from Qloo.

// Activation mode: a brand designs a pop-up, booth or takeover for one event's fans inside a real
// space. The audience is defined by interests (fans of a headliner or team, and the brand's own
// followers) rather than by who lives nearby, so these tools signal Qloo with entities, not a point.
const audiences = ['event', 'brand', 'both'];
const activationDefinitions = [
  {
    name: 'resolve_audience',
    description: 'Resolve the event (headliner, team, show) and the brand to Qloo entities. Call first. Returns the matches Qloo found so you can confirm the right ones; pass override names if a match is wrong.',
    parameters: { type: 'object', properties: {
      event_query: { type: 'string', description: 'Override the event search, e.g. "Phoebe Bridgers" or "Toronto Raptors".' },
      brand_query: { type: 'string', description: 'Override the brand search.' }
    }, additionalProperties: false }
  },
  {
    name: 'fan_taste_tags',
    description: 'Qloo place tags (ambience, decor, cuisine, beverage_offering, interests…) that describe the venues an audience rates highest: what the fans want a room to feel like. audience = event (the fans), brand (the brand\'s followers) or both (the overlap).',
    parameters: { type: 'object', properties: {
      facet: { type: 'string', enum: Object.keys(placeTagTypes) },
      audience: { type: 'string', enum: audiences, description: 'Default event.' }
    }, required: ['facet'], additionalProperties: false }
  },
  {
    name: 'fan_favourites',
    description: 'Cross-domain Qloo favourites of an audience: brands (co-sponsors, drinks, merch), artists (the playlist), podcasts, movies, tv_shows, books. With audience=both, each result shows how much the fans and the brand\'s followers each contributed, and shared=true marks real overlap.',
    parameters: { type: 'object', properties: {
      type: { type: 'string', enum: entityTypes },
      audience: { type: 'string', enum: audiences, description: 'Default both.' },
      tag_query: { type: 'string', description: 'Optional genre to narrow results, e.g. "food and beverage" or "streetwear" for brands, "indie rock" for artists.' }
    }, required: ['type'], additionalProperties: false }
  },
  {
    name: 'audience_overlap',
    description: 'Measure how well the brand fits this fanbase in Qloo: the age and gender skew of each audience, how similar they are, the tags Qloo uses to describe each, and the brands and artists both audiences love. Call before designing; cite its numbers in the concept.',
    parameters: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'fan_places',
    description: 'Places near the venue that the fans rate highest: bars, restaurants, record shops, galleries… for local partners, catering and pre-show pop-ups.',
    parameters: { type: 'object', properties: {
      category: { type: 'string', description: 'Venue category, e.g. "bar", "coffee shop", "record store". Omit for the fans\' overall favourites nearby.' },
      radius_m: { type: 'integer', minimum: 300, maximum: 8000, description: 'Default 2000.' }
    }, additionalProperties: false }
  },
  {
    name: 'fan_heatmap',
    description: 'Where the fans live and go out around the venue, as a Qloo affinity grid (12 km). Use it to place pre-event pop-ups or street promotion; the studio draws it on a map.',
    parameters: { type: 'object', properties: { audience: { type: 'string', enum: audiences, description: 'Default event.' } }, additionalProperties: false }
  }
];

const definitions = [
  {
    name: 'get_listing',
    description: 'Read the commercial space: address, neighborhood, size, rent, former use and photo.',
    parameters: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'local_taste_tags',
    description: "Qloo taste around the listing for one facet. ambience and customer_identity come from Qloo's location taste analysis (ranked by affinity); other facets are ranked from the tags of the ~40 venues Qloo scores highest for local taste. Call once per facet you care about.",
    parameters: { type: 'object', properties: { facet: { type: 'string', enum: Object.keys(placeTagTypes), description: 'Which facet to rank.' } }, required: ['facet'], additionalProperties: false }
  },
  {
    name: 'local_venues',
    description: 'Qloo place insights: venues near the listing ranked for local taste, with price level, rating, popularity and their Qloo tags. Use for competitors and to see what locals already love.',
    parameters: { type: 'object', properties: {
      category: { type: 'string', description: 'Venue category to look up, e.g. "cafe", "cocktail bar", "ramen". Defaults to the business type.' },
      radius_m: { type: 'integer', minimum: 200, maximum: 5000, description: 'Search radius in meters (default 1200).' },
      price_max: { type: 'integer', minimum: 1, maximum: 4 }
    }, additionalProperties: false }
  },
  {
    name: 'local_entities',
    description: 'Cross-domain Qloo insights: the artists, brands, movies, TV shows, books or podcasts with the highest affinity for people in this location. Use for soundtrack, decor references and brand partnerships.',
    parameters: { type: 'object', properties: {
      type: { type: 'string', enum: entityTypes },
      tag_query: { type: 'string', description: 'Optional genre to narrow results, resolved to a Qloo tag in the right family: music genres for artists ("hip hop", "jazz"), media genres for tv_show/podcast ("comedy"), brand genres for brands. Leave empty for the area\'s overall favourites; for sports teams use type brand with no tag_query.' }
    }, required: ['type'], additionalProperties: false }
  },
  {
    name: 'book_slate',
    description: 'For event venues: Qloo picks who to book (or which games/teams to programme). It sizes the room from the listing, caps Qloo popularity so acts can realistically fill (not oversell) it, seeds the search with similar local venues so results reflect their audiences, and returns ranked candidates. Programming acts must come from this tool.',
    parameters: { type: 'object', properties: {
      kind: { type: 'string', enum: ['music', 'comedy', 'sports', 'talks'], description: 'Kind of programming; defaults from the business type.' },
      genre: { type: 'string', description: 'Optional genre to narrow artists, e.g. "jazz", "hip hop".' }
    }, additionalProperties: false }
  },
  {
    name: 'check_audience_fit',
    description: 'Qloo demographic check, required before render_redesign. Compares the age and gender skew of each design tag you plan to use (decor, ambience, cuisine…) against the skew of the venues locals rank highest here. Drop or replace any tag marked mismatch, and explain it in finalize_concept.',
    parameters: { type: 'object', properties: { tags: { type: 'array', minItems: 1, maxItems: 10, items: { type: 'string' }, description: 'Exact tag names returned by local_taste_tags or other tools.' } }, required: ['tags'], additionalProperties: false }
  },
  {
    name: 'search_tags',
    description: 'Look up Qloo tag ids by keyword, optionally inside one facet.',
    parameters: { type: 'object', properties: { query: { type: 'string' }, facet: { type: 'string', enum: Object.keys(placeTagTypes) } }, required: ['query'], additionalProperties: false }
  },
  {
    name: 'render_redesign',
    description: 'Edit the real listing photo into the redesigned interior (shown as a before/after wipe of the same photo). Call once, after profiling.',
    parameters: { type: 'object', properties: {
      edit_prompt: { type: 'string', description: 'What changes, 40–90 words of plain sentences that start with "Change" or "Restyle". Name each surface or zone from the room survey and exactly what it becomes (material, colour as a name or hex, finish), which furniture goes where in the frame, and which light fixtures replace which. Describe only changes: the app appends the keep-list of permanent architecture. Positive phrasing (say what is there, never "no X"); no filler like stunning, 8k or cinematic. Place things by depth zone from room_depth (foreground, middle, back) so they keep the right scale. Any sign or lettering must give its exact words in double quotes, e.g. a neon sign reading "Aisle Nine"; otherwise describe signs without text.' },
      signals_used: { type: 'array', items: { type: 'string' }, description: 'Names of Qloo signals reflected in this edit.' }
    }, required: ['edit_prompt', 'signals_used'], additionalProperties: false }
  },
  {
    name: 'finalize_concept',
    description: 'Submit the final concept. Every design choice must cite the exact names of Qloo signals returned by earlier calls.',
    parameters: { type: 'object', properties: {
      name: { type: 'string', description: 'Concept name.' },
      tagline: { type: 'string' },
      audience: { type: 'string', description: 'Who lives and goes out here, per Qloo, in 2–3 sentences.' },
      gap: { type: 'string', description: 'What the local venue set is missing that this concept fills.' },
      offer: { type: 'string', description: 'Menu or offer and price point.' },
      design_choices: { type: 'array', minItems: 3, maxItems: 7, items: { type: 'object', properties: {
        element: { type: 'string', description: 'e.g. Lighting, Seating, Materials, Soundtrack, Signage' },
        choice: { type: 'string' },
        signals: { type: 'array', items: { type: 'string' }, minItems: 1 }
      }, required: ['element', 'choice', 'signals'], additionalProperties: false } },
      risks: { type: 'array', items: { type: 'string' }, maxItems: 3 },
      programming: { type: 'array', maxItems: 6, description: 'For venues that host events (live music, comedy, sports, talks): a booking slate drawn from local_entities results, e.g. who to book or which games to show. For an activation: the run of show (doors, moments, sets, giveaways), each anchored on a Qloo result.', items: { type: 'object', properties: {
        slot: { type: 'string', description: 'e.g. Friday headliner, Thursday residency, Sunday watch party' },
        act: { type: 'string', description: 'Exact name of the artist, comedian, team, show or podcast as Qloo returned it' },
        why: { type: 'string', description: 'One short line on the local fit' },
        signals: { type: 'array', items: { type: 'string' }, minItems: 1 }
      }, required: ['slot', 'act', 'why', 'signals'], additionalProperties: false } },
      partners: { type: 'array', maxItems: 6, description: 'Activations only: co-sponsors, drink or food partners, local venues and the playlist, each an exact Qloo name from fan_favourites or fan_places.', items: { type: 'object', properties: {
        name: { type: 'string', description: 'Exact name as Qloo returned it' },
        role: { type: 'string', description: 'e.g. Bar partner, Merch collab, Pre-show pop-up, Playlist, Co-sponsor' },
        why: { type: 'string', description: 'One line: the Qloo evidence (affinity, shared by both audiences, near the venue…)' }
      }, required: ['name', 'role', 'why'], additionalProperties: false } },
      fit: { type: 'object', description: 'Activations only: the brand × fanbase fit from audience_overlap, in plain words.', properties: { score: { type: 'integer', minimum: 0, maximum: 100 }, summary: { type: 'string' } }, required: ['score', 'summary'], additionalProperties: false }
    }, required: ['name', 'tagline', 'audience', 'gap', 'offer', 'design_choices'], additionalProperties: false }
  }
];

const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

export function createTools({ qloo, listing, business, imageModel, saveRender, look, activation = null }) {
  const state = { signals: new Map(), render: null, final: null, tagCache: new Map(), venuePool: null, audience: null, aud: null };
  const where = listing.lat != null ? { lat: listing.lat, lng: listing.lng } : { query: listing.locationQuery || listing.city };
  const record = (name, kind, source, extra = {}) => { if (name && !state.signals.has(norm(name))) state.signals.set(norm(name), { name, kind, source, ...extra }); };

  // Activation helpers: which Qloo entities stand for "the fans" and "the brand's followers".
  const needAud = () => { if (!state.aud) throw new Error('Call resolve_audience first.'); return state.aud; };
  const signalsFor = (audience = 'event') => {
    const aud = needAud();
    const ids = audience === 'both' ? [...aud.event.ids, ...aud.brand.ids] : aud[audience === 'brand' ? 'brand' : 'event'].ids;
    if (!ids.length) throw new Error(`No Qloo entities resolved for the ${audience === 'brand' ? 'brand' : 'event'}.`);
    return ids;
  };
  // Mark results both audiences drove (each contributed at least 30% of the score).
  const withShared = (list, aud) => list.map(e => {
    if (!e.share) return e;
    const sum = ids => ids.reduce((s, id) => s + (e.share[id] || 0), 0);
    const ev = sum(aud.event.ids), br = sum(aud.brand.ids);
    return { ...e, share: undefined, event_share: Math.round(ev * 100) / 100, brand_share: Math.round(br * 100) / 100, shared: ev >= 0.3 && br >= 0.3 };
  });

  async function resolveTag(query, tagType) {
    const key = `${tagType || ''}|${norm(query)}`;
    if (!state.tagCache.has(key)) state.tagCache.set(key, (await qloo.tags(query, tagType))[0] || null);
    return state.tagCache.get(key);
  }

  // The depth map is fetched alongside the survey so it is ready by the time the agent renders.
  async function depthOf() {
    const key = listing.photo || listing.id;
    if (!imageModel?.depth || !(listing.photo || listing.photoBytes)) return null;
    if (!depths.has(key)) depths.set(key, imageModel.depth(listing.photoBytes ? { bytes: listing.photoBytes, type: listing.photoType } : { url: listing.photo }).catch(() => { depths.delete(key); return null; }));
    return depths.get(key);
  }

  async function survey() {
    const key = listing.photo || listing.id;
    if (!look || !(listing.photo || listing.photoBytes)) return null;
    if (!surveys.has(key)) surveys.set(key, (async () => {
      const img = await imageBytes(listing.photoBytes ? { bytes: listing.photoBytes, type: listing.photoType } : { url: listing.photo });
      const text = await look(`data:${img.type};base64,${Buffer.from(img.bytes).toString('base64')}`, surveyQuestion);
      const json = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
      return { keep: (json.keep || []).slice(0, 10).map(String), camera: String(json.camera || ''), depth: String(json.depth || ''), surfaces: (json.surfaces || []).slice(0, 6).map(String) };
    })().catch(() => { surveys.delete(key); return null; }));  // a failed look is tried again next run
    return surveys.get(key);
  }

  const handlers = {
    async get_listing() {
      const { photoBytes, photos, details, aspect, ...info } = listing;
      const forModel = {
        ...info, photo: listing.photo ? 'available' : 'none', credit: undefined,
        rentNote: listing.kind === 'demo' ? 'Rent is an illustrative estimate, not an asking price.' : listing.kind === 'live' ? 'Live LoopNet listing; rent is the asking rate.' : undefined,
        ...(details ? { listing_name: details.name, subtype: details.subtype, size: details.sizeText, lease: details.lease, built: details.built, description: details.description, highlights: details.highlights, walk_transit_bike_scores: details.scores, street_traffic: details.traffic, transit: details.transit } : {})
      };
      depthOf();
      const room = await survey();
      if (room) Object.assign(forModel, { room_architecture: room.keep, camera_viewpoint: room.camera, room_depth: room.depth, current_finishes: room.surfaces });
      return { forModel, ui: { listing: info, room }, summary: `${listing.title}, ${listing.neighborhood || listing.city}${room ? ` · surveyed ${room.keep.length} permanent features` : ''}` };
    },
    async local_taste_tags({ facet }) {
      const tagType = placeTagTypes[facet];
      if (!tagType) throw new Error(`Unknown facet ${facet}.`);
      let tags = await qloo.areaTags(where, tagType), method = 'location taste analysis';
      if (!tags.length) {
        state.venuePool ||= qloo.localVenuePool(where);
        const pool = await state.venuePool;
        tags = rankVenueTags(pool, tagType).slice(0, 15);
        method = `tags of the ${pool.length} venues Qloo ranks highest for local taste`;
      }
      tags.forEach(t => record(t.name, 'tag', `local_taste_tags:${facet}`, { id: t.id, affinity: t.affinity }));
      return { forModel: { facet, method, tags: tags.map(({ name, affinity, venues }) => ({ name, affinity, venues })) }, ui: { facet, method, tags }, summary: tags.length ? `${facet.replace(/_/g, ' ')}: ${tags.slice(0, 5).map(t => t.name).join(', ')}` : `No ${facet} tags returned here` };
    },
    async local_venues({ category, radius_m = 1200, price_max } = {}) {
      const query = category || business;
      const tag = await resolveTag(query, 'urn:tag:genre:place');
      const venues = await qloo.places(where, { tagId: tag?.id, radius: radius_m, priceMax: price_max });
      venues.forEach(v => { record(v.name, 'place', 'local_venues', { id: v.id, affinity: v.affinity }); v.tags.forEach(t => record(t, 'tag', `venue:${v.name}`)); });
      return {
        forModel: { category: query, matched_tag: tag?.name || null, radius_m, venues: venues.map(({ image, id, ...v }) => v) },
        ui: { category: query, tag, venues },
        summary: venues.length ? `${venues.length} ${tag?.name || query} venues: ${venues.slice(0, 3).map(v => v.name).join(', ')}` : `No ${query} venues within ${radius_m} m`
      };
    },
    async local_entities({ type, tag_query }) {
      const family = { artist: 'urn:tag:genre:music', brand: 'urn:tag:genre:brand', movie: 'urn:tag:genre:media', tv_show: 'urn:tag:genre:media', podcast: 'urn:tag:genre:media', book: 'urn:tag:genre:media' }[type];
      const tag = tag_query ? await resolveTag(tag_query, family) : null;
      const entities = await qloo.entities(where, type, { tagId: tag?.id });
      entities.forEach(e => record(e.name, type, 'local_entities', { id: e.id, affinity: e.affinity }));
      return { forModel: { type, theme: tag?.name || null, entities: entities.map(({ image, id, ...e }) => e) }, ui: { type, tag, entities }, summary: entities.length ? `${type}s: ${entities.slice(0, 4).map(e => e.name).join(', ')}` : `No ${type} results for this area` };
    },
    async book_slate({ kind, genre } = {}) {
      kind ||= /comedy|stand.?up|improv/i.test(business) ? 'comedy' : /sport/i.test(business) ? 'sports' : /founder|startup|podcast|cowork/i.test(business) ? 'talks' : 'music';
      const plan = slatePlans[kind];
      // Room size → audience → how big an act can be before the room is the wrong fit.
      const capacity = listing.sqftApprox ? Math.round(listing.sqftApprox / plan.sqftPerGuest) : null;
      const popularityMax = capacity == null ? 0.93 : capacity <= 120 ? 0.85 : capacity <= 300 ? 0.9 : capacity <= 800 ? 0.94 : capacity <= 2000 ? 0.97 : 0.99;
      // Seed with similar local rooms, widening the search if none are close by.
      const tag = await resolveTag(plan.venue, 'urn:tag:genre:place');
      let seedVenues = [];
      for (const radius of [3000, 8000, 20000]) {
        seedVenues = tag ? await qloo.places(where, { tagId: tag.id, radius, take: 6 }) : [];
        if (seedVenues.length >= 2) break;
      }
      const seeds = seedVenues.slice(0, 5).map(v => v.id).filter(Boolean);
      const genreTag = genre && plan.types[0] === 'artist' ? await resolveTag(genre, 'urn:tag:genre:music') : null;
      const candidates = {};
      for (const type of plan.types) {
        const list = await qloo.entities(where, type, { seeds, popularityMax, take: 12, tagId: type === 'artist' ? genreTag?.id : undefined });
        candidates[type] = list.map(({ image, id, tags, ...e }) => e);
        list.forEach(e => record(e.name, type, 'book_slate', { id: e.id, affinity: e.affinity }));
      }
      seedVenues.forEach(v => record(v.name, 'place', 'book_slate'));
      state.slate = { kind, capacity, popularityMax, seededBy: seedVenues.map(v => v.name), genre: genreTag?.name || null };
      const total = Object.values(candidates).reduce((n, l) => n + l.length, 0);
      return {
        forModel: { ...state.slate, note: `Acts are capped at Qloo popularity ${popularityMax} for a room of about ${capacity ?? 'unknown'} guests, and ranked for fans of ${seedVenues.length ? seedVenues.map(v => v.name).join(', ') : 'this area'}.`, candidates },
        ui: { ...state.slate, candidates },
        summary: `${total} ${plan.label} for ~${capacity ?? '?'} guests${seedVenues.length ? `, seeded by ${seedVenues.slice(0, 3).map(v => v.name).join(', ')}` : ''}`
      };
    },
    async check_audience_fit({ tags = [] }) {
      // The crowd to fit: for a venue, the average Qloo demographics of the places ranked highest for local
      // taste (rank-weighted); for an activation, the fans of the event itself.
      let area, poolNames;
      if (activation) {
        const aud = needAud();
        const demo = await qloo.demographics({ entities: aud.event.ids });
        area = averageDemo(aud.event.ids.map(id => ({ demo: demo[id], w: 1 })));
        poolNames = aud.event.names;
      } else {
        state.venuePool ||= qloo.localVenuePool(where);
        const pool = (await state.venuePool).slice(0, 8);
        const areaDemo = await qloo.demographics({ entities: pool.map(e => e.entity_id).filter(Boolean) });
        area = averageDemo(pool.map((e, i) => ({ demo: areaDemo[e.entity_id], w: 1 / (1 + i * 0.2) })));
        poolNames = pool.map(e => e.name);
      }
      // The candidate tags: ids come from earlier tool results, or are resolved by name.
      const named = [];
      for (const raw of tags.slice(0, 10)) {
        const name = String(raw).replace(/^[a-z_]+:\s*/i, '').trim();
        const id = state.signals.get(norm(name))?.id || (await resolveTag(name))?.id;
        if (id && /^urn:tag:/.test(id)) named.push({ name, id });
      }
      // Review-based design tags skew older almost everywhere, so an absolute threshold rejects nearly
      // everything. Judge each tag against the other design options surfaced for this area instead:
      // a tag fits if its crowd is clearly closer to the locals' than the typical option's is.
      const baseline = [...state.signals.values()].filter(s => /^(local|fan)_taste_tags:(decor|ambience|cuisine|culinary_style|beverage_offering|menu_highlight)/.test(s.source) && /^urn:tag:/.test(s.id || '')).slice(0, 30);
      const ids = [...new Set([...named.map(t => t.id), ...baseline.map(s => s.id)])];
      state.tagDemo ||= {};
      const missing = ids.filter(id => !state.tagDemo[id]);
      if (missing.length) Object.assign(state.tagDemo, await qloo.demographics({ tags: missing }));
      const sims = ids.map(id => state.tagDemo[id]).filter(Boolean).map(d => similarity(d.age, area.age));
      const mean = sims.reduce((s, v) => s + v, 0) / (sims.length || 1);
      const sd = Math.sqrt(sims.reduce((s, v) => s + (v - mean) ** 2, 0) / (sims.length || 1)) || 0.1;
      const checks = named.map(t => {
        const d = state.tagDemo[t.id];
        if (!d) return { tag: t.name, verdict: 'unknown' };
        const fit = similarity(d.age, area.age), z = (fit - mean) / sd;
        const verdict = z >= 0.5 ? 'fits' : z <= -0.5 && fit < 0.2 ? 'mismatch' : 'neutral';
        const crowd = activation ? 'the fans' : 'the locals';
        return { tag: t.name, fit: Math.round(fit * 100) / 100, relative: Math.round(z * 10) / 10, verdict, tagSkew: skew(d), reason: `${t.name} draws a ${skew(d)} crowd in Qloo's data, further from ${crowd} (${skew(area)}) than most design options here` };
      });
      state.audience = { area: { ...area, skew: skew(area), venues: poolNames, crowd: activation ? 'fans' : 'locals' }, checks };
      const bad = checks.filter(c => c.verdict === 'mismatch');
      return {
        forModel: { area_skew: skew(area), area_age: area.age, checks, instruction: bad.length ? `Replace ${bad.map(c => c.tag).join(', ')} with tags that fit, and say why in finalize_concept.` : 'All checked tags fit or are neutral.' },
        ui: state.audience,
        summary: `${activation ? 'Fans' : 'Locals'} skew ${skew(area)}; ${checks.filter(c => c.verdict === 'fits').length} fit, ${bad.length} mismatch${bad.length ? ` (${bad.map(c => c.tag).join(', ')})` : ''}`
      };
    },
    // --- Activation tools -----------------------------------------------------------------------
    async resolve_audience({ event_query, brand_query } = {}) {
      if (!activation) throw new Error('Not an activation run.');
      // Headliners are artists; teams, leagues and brands are brands; comedians and athletes are people.
      const pick = async (query, types) => {
        for (const type of types) {
          const hits = (await qloo.search(query, type, 4)).filter(e => e.popularity == null || e.popularity > 0.2);
          if (hits.length) return { type, hits };
        }
        return { type: null, hits: [] };
      };
      const ev = await pick(event_query || activation.event, ['artist', 'brand', 'person', 'tv_show', 'podcast']);
      const br = await pick(brand_query || activation.brand, ['brand', 'artist']);
      const first = r => r.hits.slice(0, 1);
      state.aud = {
        event: { query: event_query || activation.event, type: ev.type, ids: first(ev).map(e => e.id), names: first(ev).map(e => e.name), candidates: ev.hits },
        brand: { query: brand_query || activation.brand, type: br.type, ids: first(br).map(e => e.id), names: first(br).map(e => e.name), candidates: br.hits }
      };
      [...ev.hits, ...br.hits].forEach(e => record(e.name, e.type, 'resolve_audience', { id: e.id, popularity: e.popularity }));
      const brief = side => side.hits.length ? `${side.hits[0].name} (${side.type}${side.hits[0].detail ? `, ${side.hits[0].detail}` : ''})` : 'no match';
      return {
        forModel: { event: { chosen: brief(ev), alternatives: ev.hits.slice(1).map(e => e.name) }, brand: { chosen: brief(br), alternatives: br.hits.slice(1).map(e => e.name) }, note: 'If a chosen match is wrong, call resolve_audience again with event_query or brand_query set to the right name.' },
        ui: state.aud,
        summary: `Fans of ${brief(ev)} × ${brief(br)}`
      };
    },
    async fan_taste_tags({ facet, audience = 'event' }) {
      const tagType = placeTagTypes[facet];
      if (!tagType) throw new Error(`Unknown facet ${facet}.`);
      const tags = await qloo.fanTags(signalsFor(audience), tagType);
      tags.forEach(t => record(t.name, 'tag', `fan_taste_tags:${facet}`, { id: t.id, affinity: t.affinity }));
      const who = { event: 'the fans', brand: "the brand's followers", both: 'both audiences' }[audience];
      return { forModel: { facet, audience, tags: tags.map(({ name, affinity }) => ({ name, affinity })) }, ui: { facet, audience, tags, method: `venues ${who} rate highest` }, summary: tags.length ? `${who}, ${facet.replace(/_/g, ' ')}: ${tags.slice(0, 5).map(t => t.name).join(', ')}` : `No ${facet} tags for ${who}` };
    },
    async fan_favourites({ type, audience = 'both', tag_query }) {
      const family = { artist: 'urn:tag:genre:music', brand: 'urn:tag:genre:brand', movie: 'urn:tag:genre:media', tv_show: 'urn:tag:genre:media', podcast: 'urn:tag:genre:media', book: 'urn:tag:genre:media' }[type];
      const tag = tag_query ? await resolveTag(tag_query, family) : null;
      const aud = needAud();
      const ids = signalsFor(audience);
      // Leave the brand and the headliner themselves out of the results.
      const own = new Set([...aud.brand.ids, ...aud.event.ids]);
      const list = withShared(await qloo.fanEntities(ids, type, { tagId: tag?.id, take: 12, explain: audience === 'both' }), aud).filter(e => !own.has(e.id));
      list.forEach(e => record(e.name, type, `fan_favourites:${audience}`, { id: e.id, affinity: e.affinity, shared: e.shared }));
      const shared = list.filter(e => e.shared);
      return {
        forModel: { type, audience, theme: tag?.name || null, favourites: list.map(({ image, id, tags, detail, ...e }) => e) },
        ui: { type, audience, tag, entities: list },
        summary: list.length ? `${type}s ${audience === 'both' ? 'both love' : `${audience === 'brand' ? "the brand's followers" : 'the fans'} love`}: ${(shared.length ? shared : list).slice(0, 4).map(e => e.name).join(', ')}` : `No ${type} results`
      };
    },
    async audience_overlap() {
      const aud = needAud();
      if (!aud.event.ids.length || !aud.brand.ids.length) throw new Error('Both the event and the brand must resolve to Qloo entities first.');
      const demo = await qloo.demographics({ entities: [...aud.event.ids, ...aud.brand.ids] });
      const fans = averageDemo(aud.event.ids.map(id => ({ demo: demo[id], w: 1 }))), followers = averageDemo(aud.brand.ids.map(id => ({ demo: demo[id], w: 1 })));
      const demoFit = similarity(fans.age, followers.age);
      const both = [...aud.event.ids, ...aud.brand.ids];
      const own = new Set(both);
      // Each audience's own top list, then the combined list with explainability (how much each side drove each pick).
      const top = (ids, type) => qloo.fanEntities(ids, type, { take: 15 });
      const [fanBrands, folBrands, fanArtists, folArtists, brands, artists, described] = await Promise.all([
        top(aud.event.ids, 'brand'), top(aud.brand.ids, 'brand'), top(aud.event.ids, 'artist'), top(aud.brand.ids, 'artist'),
        qloo.fanEntities(both, 'brand', { take: 12, explain: true }),
        qloo.fanEntities(both, 'artist', { take: 12, explain: true }),
        qloo.compare(aud.event.ids, aud.brand.ids).catch(() => ({ shared: [], a: [], b: [] }))
      ]);
      // Overlap = how much of one side's top 15 appears in the other's (Jaccard), per domain.
      const jaccard = (a, b) => { const A = new Set(a.map(e => e.id).filter(id => !own.has(id))), B = new Set(b.map(e => e.id).filter(id => !own.has(id))); const inter = [...A].filter(id => B.has(id)).length; const union = new Set([...A, ...B]).size; return union ? inter / union : 0; };
      const jBrands = jaccard(fanBrands, folBrands), jArtists = jaccard(fanArtists, folArtists);
      const inBoth = (a, b) => { const B = new Set(b.map(e => e.id)); return a.filter(e => B.has(e.id) && !own.has(e.id)); };
      // What to show as "both love": names in both top lists first, then combined picks each side drove at least 30%.
      const merge = (common, combined) => { const seen = new Set(common.map(e => e.id)); return [...common.map(e => ({ ...e, in_both_top: true })), ...withShared(combined, aud).filter(e => e.shared && !own.has(e.id) && !seen.has(e.id))]; };
      const sharedBrands = merge(inBoth(fanBrands, folBrands), brands), sharedArtists = merge(inBoth(fanArtists, folArtists), artists);
      [...fanBrands, ...folBrands, ...fanArtists, ...folArtists, ...sharedBrands, ...sharedArtists].forEach(e => record(e.name, e.type, 'audience_overlap', { id: e.id, affinity: e.affinity }));
      [...described.a, ...described.b, ...described.shared].forEach(t => record(t.name, 'tag', 'audience_overlap', { id: t.id }));
      // A plain, explained score: half from how alike the two crowds are (age profiles), half from how much their
      // top brands and artists overlap. A Jaccard of 0.4 or more counts as full overlap.
      const overlap = (jBrands + jArtists) / 2;
      const score = Math.round(100 * (0.5 * Math.max(0, (demoFit + 1) / 2) + 0.5 * Math.min(1, overlap * 2.5)));
      state.overlap = { score, demoFit: Math.round(demoFit * 100) / 100, overlap: { brands: Math.round(jBrands * 100) / 100, artists: Math.round(jArtists * 100) / 100 }, fans: { ...fans, skew: skew(fans) }, followers: { ...followers, skew: skew(followers) }, sharedBrands, sharedArtists, fanBrands: fanBrands.slice(0, 8), followerBrands: folBrands.slice(0, 8), described };
      const describe = list => list.slice(0, 8).map(t => t.name).join(', ');
      const names = list => list.slice(0, 10).map(e => e.in_both_top ? e.name : `${e.name} (${e.event_share}/${e.brand_share})`);
      return {
        forModel: { fit_score: score, how_scored: 'half from the similarity of the two audiences\' age profiles (cosine, -1..1), half from how much their top-15 brands and artists overlap (Jaccard; 0.4+ counts as full)', fans_skew: skew(fans), followers_skew: skew(followers), age_similarity: Math.round(demoFit * 100) / 100, overlap_brands: Math.round(jBrands * 100) / 100, overlap_artists: Math.round(jArtists * 100) / 100, shared_brands: names(sharedBrands), shared_artists: names(sharedArtists), fans_top_brands: fanBrands.slice(0, 8).map(e => e.name), followers_top_brands: folBrands.slice(0, 8).map(e => e.name), fans_described_as: describe(described.a), followers_described_as: describe(described.b), both_described_as: describe(described.shared), note: 'Entries like "Fender (0.54/0.46)" are combined picks with each side\'s share of the score.' },
        ui: state.overlap,
        summary: `Fit ${score}/100: fans skew ${skew(fans)}, followers ${skew(followers)}; top brands overlap ${Math.round(jBrands * 100)}%, artists ${Math.round(jArtists * 100)}%`
      };
    },
    async fan_places({ category, radius_m = 2000 } = {}) {
      const tag = category ? await resolveTag(category, 'urn:tag:genre:place') : null;
      const places = await qloo.fanEntities(signalsFor('event'), 'place', { tagId: tag?.id, where, radius: radius_m, take: 8 });
      places.forEach(v => { record(v.name, 'place', 'fan_places', { id: v.id, affinity: v.affinity }); });
      return { forModel: { category: category || 'all', matched_tag: tag?.name || null, radius_m, places: places.map(({ image, id, ...v }) => v) }, ui: { category, tag, venues: places }, summary: places.length ? `Fans' picks within ${radius_m} m: ${places.slice(0, 3).map(v => v.name).join(', ')}` : `No ${category || ''} places the fans rate within ${radius_m} m` };
    },
    async fan_heatmap({ audience = 'event' } = {}) {
      if (where.lat == null) throw new Error('The space needs coordinates for a heatmap.');
      const cells = await qloo.heatmap(signalsFor(audience), where);
      const hot = [...cells].sort((a, b) => (b.affinity ?? 0) - (a.affinity ?? 0)).slice(0, 5);
      state.heatmap = { audience, cells, center: where };
      return {
        forModel: { audience, cells: cells.length, hottest: hot.map(c => ({ lat: c.lat, lng: c.lng, affinity: c.affinity, popularity: c.popularity })), note: 'Affinity is relative within this grid; popularity is how busy the cell is overall.' },
        ui: state.heatmap,
        summary: cells.length ? `${cells.length} grid cells; strongest affinity ${hot[0]?.affinity ?? '?'} at ${hot[0]?.lat.toFixed(3)}, ${hot[0]?.lng.toFixed(3)}` : 'No heatmap data here'
      };
    },
    async search_tags({ query, facet }) {
      const tags = await qloo.tags(query, facet ? placeTagTypes[facet] : undefined);
      tags.forEach(t => record(t.name, 'tag', 'search_tags', { id: t.id }));
      return { forModel: { tags: tags.map(({ name, id, type }) => ({ name, id, type })) }, ui: { tags }, summary: `${tags.length} tags for “${query}”` };
    },
    async render_redesign({ edit_prompt, signals_used = [] }) {
      if (!imageModel) throw new Error('No image model is configured (set FAL_KEY or OPENAI_API_KEY).');
      if (!listing.photo && !listing.photoBytes) throw new Error('This listing has no photo to edit.');
      if (!state.audience) throw new Error('Call check_audience_fit with the design tags you plan to use before rendering.');
      if (state.render) return { forModel: { note: 'Already rendered; continue to finalize_concept.' }, ui: state.render, summary: 'Render already exists' };
      state.renderTries = (state.renderTries || 0) + 1;
      const [room, depth] = await Promise.all([survey(), depthOf()]);
      const keep = room?.keep?.length ? room.keep : genericKeep;
      // Pruna's formula: what changes (the agent's concrete edit), then a named keep-list, positive phrasing.
      // With a depth map, image 2 anchors depth and scale so the room keeps its perspective.
      const keepClause = `Keep ${keep.join('; ')} identical, seen from the same viewpoint${room?.camera ? ` (${room.camera})` : ''} with the same framing.`;
      const plain = `${edit_prompt.trim()} ${keepClause} Photorealistic interior photograph of an empty, finished room.`;
      const prompt = depth
        ? `Image 1 is the room photo to edit; image 2 is its depth map, where brighter areas are closer to the camera and darker areas are farther away. Make these changes clearly and completely: ${edit_prompt.trim()} Place every new piece at the depth and scale that image 2 shows for that part of the room, so the room keeps its full depth and perspective. ${keepClause} Output a photorealistic photo of the edited image 1 only, an empty finished room.`
        : plain;
      const image = listing.photoBytes ? { bytes: listing.photoBytes, type: listing.photoType } : { url: listing.photo };
      const result = await imageModel.edit({ image, prompt, depth, fallbackPrompt: plain, aspect: listing.aspect });
      state.render = await saveRender({ ...result, prompt, aspect: listing.aspect, listingId: listing.id, signals: signals_used });
      return { forModel: { rendered: true, render_id: state.render.id }, ui: state.render, summary: `Redesign rendered with ${result.model}` };
    },
    async finalize_concept(input) {
      // The picture is what the visitor came for: it has to be attempted before the concept is closed.
      if (imageModel && (listing.photo || listing.photoBytes) && !state.render && !state.renderTries) throw new Error('Call render_redesign before finalize_concept; the redesigned photo is the main result.');
      // Some models send nested arrays as JSON strings; accept both shapes.
      const parse = v => { if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return v; } };
      const concept = { ...input, design_choices: parse(input.design_choices), risks: parse(input.risks), programming: parse(input.programming) };
      // Smaller models sometimes send { element: choice }, a list wrapped in an object, a string encoded twice, or
      // plain lines of text; turn all of those into the expected list.
      if (typeof concept.design_choices === 'string') concept.design_choices = parse(concept.design_choices);
      if (typeof concept.design_choices === 'string') {
        concept.design_choices = concept.design_choices.split('\n').map(l => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim()).filter(Boolean)
          .map(l => { const m = l.match(/^\**([^:*]{2,40})\**:\s*(.+)$/); return m ? { element: m[1].trim(), choice: m[2].trim(), signals: [] } : l; });
      }
      const wrapped = concept.design_choices && typeof concept.design_choices === 'object' && !Array.isArray(concept.design_choices) && Object.values(concept.design_choices).find(Array.isArray);
      if (wrapped) concept.design_choices = wrapped;
      if (concept.design_choices && typeof concept.design_choices === 'object' && !Array.isArray(concept.design_choices)) {
        concept.design_choices = Object.entries(concept.design_choices).map(([element, v]) => v && typeof v === 'object' ? { element, ...v } : { element, choice: String(v), signals: [] });
      }
      if (Array.isArray(concept.design_choices)) concept.design_choices = concept.design_choices.map(d => typeof d === 'string' ? { element: 'Design', choice: d, signals: [] } : d);
      if (!Array.isArray(concept.design_choices)) throw new Error('design_choices must be an array of { element, choice, signals }.');
      concept.design_choices = concept.design_choices.map(d => ({ ...d, signals: Array.isArray(parse(d.signals)) ? parse(d.signals) : [String(d.signals || '')].filter(Boolean) }));
      // A cited signal must be a name Qloo actually returned in this run (case and punctuation aside).
      // Models sometimes prefix a citation with its tool ("book_slate: Bambu"); strip that before matching.
      const clean = name => String(name).replace(/^[a-z_]+:\s*/i, '').trim();
      const check = list => (list || []).map(raw => { const name = clean(raw); return { name, grounded: state.signals.has(norm(name)) }; });
      const partners = parse(input.partners);
      const draft = {
        ...concept,
        design_choices: concept.design_choices.map(d => ({ ...d, signals: check(d.signals) })),
        programming: Array.isArray(concept.programming) ? concept.programming.map(p => ({ ...p, grounded: check([p.act])[0].grounded, signals: check(Array.isArray(parse(p.signals)) ? parse(p.signals) : [p.act]) })) : undefined,
        partners: Array.isArray(partners) ? partners.map(p => ({ ...p, grounded: check([p.name])[0].grounded })) : undefined,
        fit: input.fit && typeof input.fit === 'object' ? { score: state.overlap?.score ?? input.fit.score, summary: String(input.fit.summary || '') } : state.overlap ? { score: state.overlap.score, summary: '' } : undefined
      };
      const ungrounded = [...draft.design_choices.flatMap(d => d.signals), ...(draft.programming || []).flatMap(p => p.signals), ...(draft.partners || []).filter(p => !p.grounded).map(p => ({ name: p.name, grounded: false }))].filter(s => !s.grounded).map(s => s.name);
      // First time round, send unverified citations back so the agent swaps in real Qloo names.
      state.finalizeAttempts = (state.finalizeAttempts || 0) + 1;
      if (ungrounded.length && state.finalizeAttempts === 1) {
        return { forModel: { accepted: false, ungrounded, fix: 'These cited signals are not names Qloo returned in this run. Replace each with the exact name of a tag, venue or entity from your earlier tool results (or drop it), then call finalize_concept again.' }, ui: { ungrounded }, summary: `Sent back ${ungrounded.length} unverified citation${ungrounded.length > 1 ? 's' : ''}` };
      }
      state.final = { ...draft, slateMeta: state.slate || undefined, audience: state.audience || undefined, overlap: state.overlap || undefined, heatmap: state.heatmap || undefined, activation: state.aud ? { event: state.aud.event.names, brand: state.aud.brand.names } : undefined };
      return { forModel: { accepted: true, ungrounded }, ui: state.final, summary: `Concept: ${concept.name}` };
    }
  };

  return {
    definitions: activation ? [...definitions, ...activationDefinitions] : definitions, state,
    async run(name, input) {
      const handler = handlers[name];
      if (!handler) throw new Error(`Unknown tool ${name}.`);
      return handler(input || {});
    },
    signals: () => [...state.signals.values()]
  };
}
