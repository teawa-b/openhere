import { tick, chime } from '/sound.js';
import { keepFresh } from '/fresh.js';
const $ = id => document.getElementById(id);
// Model-written text never shows an em or en dash used as punctuation (house style); a comma reads the same.
const tidy = v => typeof v === 'string' ? v.replace(/(\d)\s*–\s*(\d)/g, '$1-$2').replace(/\s*[—–]\s*/g, ', ') : v;
const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = tidy(text); return n; };
const safeUrl = v => { try { const u = new URL(v, location.origin); return ['https:', 'http:'].includes(u.protocol) ? u.href : ''; } catch { return ''; } };
const typeLabel = { restaurant: 'restaurant', cafe: 'café', bar: 'bar', 'live music venue': 'live music venue', 'comedy club': 'comedy club', 'sports bar': 'sports bar', "founders' café with a podcast studio": "founders' café" };
const slateTitle = b => activation ? 'Run of show' : /music/i.test(b) ? 'Booking slate' : /comedy/i.test(b) ? 'Opening lineup' : /sport/i.test(b) ? 'Watch-party calendar' : /founder|podcast/i.test(b) ? 'Studio & stage calendar' : 'Programming';
let taste = {}, baseRender = null, todCache = {};
let config = {}, spinning = true, map, dropMarker, point = null, business = null, activation = null, render = null, concept = null, running = false;
// What the studio calls this run: a business type, or "Brand × Event" for an activation.
const bizLabel = () => activation ? `${activation.brand} × ${activation.event}` : (typeLabel[business] || business);

function toast(text, ms = 4000) { $('toast').textContent = text; $('toast').hidden = !text; clearTimeout(toast.t); if (text) toast.t = setTimeout(() => { $('toast').hidden = true; }, ms); }
keepFresh(() => running || !$('studio').hidden, toast);
async function api(path, body) {
  const res = await fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : undefined);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
  return data;
}

// --- The globe ----------------------------------------------------------------
const dark = matchMedia('(prefers-color-scheme: dark)');
const mapStyle = () => `https://tiles.openfreemap.org/styles/${dark.matches ? 'dark' : 'positron'}`;
function initMap() {
  if (!window.maplibregl) { toast('The map could not load. Use the search box.'); return; }
  map = new maplibregl.Map({ container: 'map', style: mapStyle(), center: [-40, 32], zoom: 1.6, attributionControl: false });
  map.on('style.load', () => {
    map.setProjection({ type: 'globe' });
    // Cool neutral base map to match the page; water and parks get the faintest tint.
    const c = dark.matches
      ? { bg: '#0d0f13', water: '#141b2b', park: '#121a17', building: '#1b1f27', land: '#11141a', extrude: '#232833' }
      : { bg: '#eef0f3', water: '#d6e0f5', park: '#e1ece4', building: '#e3e6ec', land: '#e9ebef', extrude: '#dde1e8' };
    for (const layer of map.getStyle().layers) {
      if (layer.id === 'background') map.setPaintProperty(layer.id, 'background-color', c.bg);
      else if (/water/.test(layer.id) && layer.type === 'fill') map.setPaintProperty(layer.id, 'fill-color', c.water);
      else if (/park|landcover_wood|grass/.test(layer.id) && layer.type === 'fill') map.setPaintProperty(layer.id, 'fill-color', c.park);
      else if (/building/.test(layer.id) && layer.type === 'fill') map.setPaintProperty(layer.id, 'fill-color', c.building);
      else if (/landuse|residential|landcover/.test(layer.id) && layer.type === 'fill') map.setPaintProperty(layer.id, 'fill-color', c.land);
    }
    // Soft 3D buildings for the close, tilted fly-in to a listing.
    if (!map.getLayer('buildings-3d')) map.addLayer({ id: 'buildings-3d', type: 'fill-extrusion', source: 'openmaptiles', 'source-layer': 'building', minzoom: 15, paint: { 'fill-extrusion-color': c.extrude, 'fill-extrusion-height': ['coalesce', ['get', 'render_height'], 8], 'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], 0], 'fill-extrusion-opacity': ['interpolate', ['linear'], ['zoom'], 15, 0, 16, 0.85] } });
  });
  dark.addEventListener('change', () => map.setStyle(mapStyle()));
  const spin = () => { if (!spinning || map.isMoving()) return; const c = map.getCenter(); map.easeTo({ center: [c.lng + 12, c.lat], duration: 4000, easing: t => t }); };
  map.on('load', spin); map.on('moveend', spin);
  ['mousedown', 'touchstart', 'wheel'].forEach(e => map.on(e, () => { spinning = false; }));
  map.on('click', e => choosePoint({ lat: e.lngLat.lat, lng: e.lngLat.lng }));
  addSpacePins();
}

async function addSpacePins() {
  const { spaces } = await api('/api/spaces');
  for (const space of spaces) {
    const pin = el('button', 'pin'); pin.style.backgroundImage = `url("${safeUrl(space.photo)}")`; pin.title = space.title; pin.setAttribute('aria-label', space.title);
    pin.addEventListener('click', e => { e.stopPropagation(); choosePoint({ lat: space.lat, lng: space.lng, label: `${space.neighborhood}, ${space.city}` }, space); });
    new maplibregl.Marker({ element: pin }).setLngLat([space.lng, space.lat]).addTo(map);
  }
}

$('search').addEventListener('submit', async e => {
  e.preventDefault();
  const q = $('q').value.trim(); if (!q) return;
  try { const { place } = await api(`/api/geocode?q=${encodeURIComponent(q)}`); choosePoint({ lat: place.lat, lng: place.lng, label: [place.neighborhood, place.city].filter(Boolean).join(', ') || q }); $('q').blur(); }
  catch (error) { toast(error.message); }
});

// Live location: browsers only allow it on HTTPS (or localhost) and after the user agrees.
function locate() {
  if (!navigator.geolocation) return toast('This browser can’t share your location. Search instead.');
  $('locate').classList.add('busy');
  navigator.geolocation.getCurrentPosition(pos => {
    $('locate').classList.remove('busy');
    choosePoint({ lat: pos.coords.latitude, lng: pos.coords.longitude });
  }, error => {
    $('locate').classList.remove('busy');
    toast(error.code === error.PERMISSION_DENIED ? 'Location is blocked. Allow it in your browser, or search instead.' : 'Couldn’t get your location. Search instead.');
  }, { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 });
}
$('locate').addEventListener('click', locate);
$('locate-hint').addEventListener('click', locate);

// --- Step 1: a point, then "what do you want to open?" ---------------------------------
let preselected = null;
async function choosePoint(p, space = null) {
  point = p; preselected = space; spinning = false;
  listingPins.forEach(m => m.remove()); listingPins = new Map(); map?.easeTo({ pitch: 0, duration: 600 });
  $('hint').hidden = true; $('sheet').hidden = true;
  if (map) {
    dropMarker?.remove();
    if (!space) dropMarker = new maplibregl.Marker({ element: el('div', 'drop') }).setLngLat([p.lng, p.lat]).addTo(map);
    map.flyTo({ center: [p.lng, p.lat], zoom: Math.max(map.getZoom(), 14.5), duration: 1800, essential: true });
  }
  $('ask-place').textContent = p.label || 'Locating…';
  showAsk();
  if (!p.label) {
    try { const { place } = await api(`/api/reverse?lat=${p.lat}&lng=${p.lng}`); point.label = [place.neighborhood, place.city].filter(Boolean).join(', ') || place.display; point.place = place; $('ask-place').textContent = point.label; }
    catch { $('ask-place').textContent = `${p.lat.toFixed(4)}, ${p.lng.toFixed(4)}`; }
  }
}
function showAsk() {
  const ask = $('ask'); ask.hidden = false;
  ask.style.left = `${innerWidth / 2 - ask.offsetWidth / 2}px`; ask.style.top = `${innerHeight / 2 + 30}px`;
}
document.querySelectorAll('[data-type]').forEach(b => b.addEventListener('click', () => pickType(b.dataset.type)));
$('other').addEventListener('submit', e => { e.preventDefault(); const v = $('other-input').value.trim(); if (v) pickType(v); });
$('activation').addEventListener('submit', e => {
  e.preventDefault();
  const brand = $('act-brand').value.trim(), event = $('act-event').value.trim();
  if (!brand || !event) return toast('Name both the brand and the event.');
  if (!config.llm) return toast('Activations need an LLM key on the server.');
  pickType('activation', { brand, event });
});

function pickType(type, act = null) {
  business = type; activation = act; $('ask').hidden = true;
  if (preselected) return openStudio(preselected);
  showSpaces();
}

// --- Step 2: spaces nearby, as photos -------------------------------------------------------
// The nearest few first, more on request; every listing is also a photo pin on the map.
const PAGE = 4;
// Rough floor areas (sq ft) that suit each kind of venue; a listing outside the range is demoted and labelled.
const sizeFit = { restaurant: [1200, 6000], cafe: [500, 2500], bar: [800, 4000], 'live music venue': [2500, 20000], 'comedy club': [1500, 6000], 'sports bar': [2000, 8000], "founders' café with a podcast studio": [1200, 5000] };
function fitOf(space) {
  const range = sizeFit[business], sqft = space.sqftApprox;
  if (!range || !sqft) return { score: 1, label: '' };
  const [lo, hi] = range, name = typeLabel[business] || business;
  if (sqft < lo) return { score: sqft / lo, label: `Small for a ${name}` };
  if (sqft > hi) return { score: hi / sqft, label: `Large for a ${name}` };
  return { score: 2, label: 'Good fit' };
}
let nearby = [], shown = 0, listingPins = new Map();
async function showSpaces({ refetch = true } = {}) {
  const sheet = $('sheet'); sheet.hidden = false;
  $('sheet-kicker').textContent = `${bizLabel()} · ${point.label || ''}`;
  $('sheet-title').textContent = activation ? 'Pick the venue' : 'Pick a space';
  if (refetch) {
    $('cards').replaceChildren(el('p', 'empty', 'Looking around…'));
    $('cards').scrollTo({ top: 0 });
    const { spaces } = await api(`/api/spaces?lat=${point.lat}&lng=${point.lng}`).catch(() => ({ spaces: [] }));
    const near = spaces.filter(s => s.distanceKm <= 40);
    // Good-fit sizes first, then by distance.
    nearby = (near.length ? near : spaces.slice(0, 3)).map(s => ({ ...s, fit: fitOf(s) })).sort((a, b) => (b.fit.score >= 1) - (a.fit.score >= 1) || a.distanceKm - b.distanceKm);
    nearby.farAway = !near.length;
    shown = 0;
    pinListings(nearby);
  }
  shown = Math.max(shown, Math.min(PAGE, nearby.length));
  renderCards();
}
function renderCards() {
  const list = nearby.slice(0, shown).map(card);
  const items = nearby.farAway ? [el('p', 'empty', 'No spaces listed near here yet. Add a photo of one you’re looking at, or try one of these:'), ...list] : list;
  if (shown < nearby.length) {
    const more = el('button', 'more', `Show more · ${nearby.length - shown} left`);
    more.addEventListener('click', () => { shown = Math.min(nearby.length, shown + PAGE); renderCards(); $('cards').lastElementChild.previousElementSibling?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); });
    items.push(more);
  }
  items.push(uploadCard());
  $('cards').replaceChildren(...items);
}
function pinListings(list) {
  listingPins.forEach(m => m.remove()); listingPins = new Map();
  if (!map) return;
  const bounds = new maplibregl.LngLatBounds([point.lng, point.lat], [point.lng, point.lat]);
  list.forEach((space, i) => {
    if (space.lat == null || space.kind === 'demo' && document.querySelector(`.pin[title="${CSS.escape(space.title)}"]`)) return;
    const pin = el('button', 'pin listing-pin'); pin.style.backgroundImage = `url("${safeUrl(space.photo)}")`; pin.title = space.title;
    pin.append(el('span', '', String(i + 1)));
    pin.addEventListener('click', e => { e.stopPropagation(); goToSpace(space); });
    listingPins.set(space.id, new maplibregl.Marker({ element: pin }).setLngLat([space.lng, space.lat]).addTo(map));
    if (i < PAGE) bounds.extend([space.lng, space.lat]);
  });
  // Frame the nearest listings beside the sheet.
  const wide = innerWidth > 860;
  map.fitBounds(bounds, { padding: wide ? { top: 100, bottom: 80, left: 80, right: 470 } : { top: 90, bottom: innerHeight * 0.66, left: 40, right: 40 }, maxZoom: 15.5, duration: 1400 });
}
$('sheet-close').addEventListener('click', () => { $('sheet').hidden = true; $('hint').hidden = false; listingPins.forEach(m => m.remove()); listingPins = new Map(); });

// Choosing a listing flies to it, highlights its pin, then opens it.
async function goToSpace(space) {
  document.querySelectorAll('.listing-pin.active, .card.active').forEach(n => n.classList.remove('active'));
  listingPins.get(space.id)?.getElement().classList.add('active');
  [...document.querySelectorAll('.card')].find(c => c.dataset.id === space.id)?.classList.add('active');
  if (map && space.lat != null) {
    const wide = innerWidth > 860;
    map.flyTo({ center: [space.lng, space.lat], zoom: 17.3, pitch: 50, bearing: map.getBearing() - 18, duration: 1700, curve: 1.4, essential: true, padding: wide ? { right: 440 } : { bottom: innerHeight * 0.55 } });
    await new Promise(r => { map.once('moveend', r); setTimeout(r, 2200); });
  }
  return space.kind === 'live' ? pickRoom(space) : openStudio(space);
}

function card(space) {
  const b = el('button', 'card'); b.dataset.id = space.id;
  const img = el('img'); img.src = safeUrl(space.photo); img.alt = ''; img.loading = 'lazy'; img.referrerPolicy = 'no-referrer';
  const over = el('div', 'over'); over.append(el('h3', '', space.title), el('p', 'sub', `${space.neighborhood ? `${space.neighborhood}, ` : ''}${space.city}${space.distanceKm != null && space.distanceKm > 1 ? `, ${space.distanceKm < 40 ? space.distanceKm + ' km' : 'far'}` : ''}`));
  b.append(img, over);
  const price = space.rentEstimate ? `~${short(space.rentEstimate.low, space.rentEstimate.currency)}/mo` : space.rentText;
  if (price) b.append(el('span', 'price', price));
  b.append(el('span', `tag ${space.kind}`, { demo: 'Sample', live: 'Listing', own: 'Yours' }[space.kind]));
  if (space.fit?.label) b.append(el('span', `fit ${space.fit.score >= 1 ? 'good' : 'off'}`, `${space.fit.label}${space.sqftApprox ? ` · ${space.sqftApprox.toLocaleString()} sq ft` : ''}`));
  b.addEventListener('click', () => goToSpace(space));
  b.addEventListener('mouseenter', () => listingPins.get(space.id)?.getElement().classList.add('hover'));
  b.addEventListener('mouseleave', () => listingPins.get(space.id)?.getElement().classList.remove('hover'));
  return b;
}

// Live listings come with a gallery (exterior first). Let the user choose the room to redesign.
async function pickRoom(space) {
  $('sheet-title').textContent = 'Which room?';
  $('cards').scrollTo({ top: 0 });
  $('sheet-kicker').textContent = space.title;
  $('cards').replaceChildren(el('p', 'empty', 'Opening the listing…'));
  let full = space;
  try { ({ space: full } = await api(`/api/spaces/${encodeURIComponent(space.id)}/details`)); } catch (error) { toast(error.message); }
  const photos = full.photos?.length ? full.photos : [full.photo];
  const grid = el('div', 'rooms');
  const interiors = new Set(full.interiors || []);
  photos.forEach((url, i) => {
    const b = el('button', `room${interiors.has(url) ? ' interior' : ''}`);
    if (i === 0 && interiors.has(url)) b.append(el('span', 'best', 'Recommended')); const img = el('img'); img.src = safeUrl(url); img.alt = `Photo ${i + 1}`; img.loading = 'lazy'; img.referrerPolicy = 'no-referrer';
    img.addEventListener('error', () => b.remove(), { once: true });
    b.append(img); b.addEventListener('click', () => openStudio(full, url)); grid.append(b);
  });
  const facts = [full.rentText, full.sizeText].filter(Boolean).join(' · ');
  const head = el('p', 'empty', `${facts ? facts + '. ' : ''}${interiors.size ? `${interiors.size} interior photo${interiors.size > 1 ? 's' : ''} found, best first.` : 'No interior shots in this listing, so a storefront makeover works too.'} Tap the one to redesign.`);
  const back = el('button', 'link', '← All spaces'); back.addEventListener('click', () => { map?.easeTo({ pitch: 0, zoom: 15, duration: 900 }); showSpaces({ refetch: false }); });
  const link = el('a', 'link', 'View on LoopNet ↗'); link.href = safeUrl(full.credit?.source); link.target = '_blank'; link.rel = 'noreferrer';
  const row = el('div', 'room-links'); row.append(back, link);
  $('cards').replaceChildren(head, grid, row);
  $('cards').scrollTo({ top: 0 });
}
const short = (n, c) => `${c === 'USD' ? '$' : c === 'CAD' ? 'C$' : ''}${n >= 1000 ? Math.round(n / 1000) + 'k' : n}`;

function uploadCard() {
  const b = el('button', 'card upload');
  b.append(el('b', '', '+'), el('span', '', 'Use my own photo'), el('small', '', 'Snap the room you’re touring'));
  b.addEventListener('click', () => $('upload').click());
  return b;
}
$('upload').addEventListener('change', async e => {
  const file = e.target.files[0]; e.target.value = ''; if (!file) return;
  toast('Uploading…');
  try {
    const photo = await downscale(file);
    const { space } = await api('/api/spaces/custom', { photo, lat: point.lat, lng: point.lng, address: point.place?.display || '' });
    toast(''); openStudio(space);
  } catch (error) { toast(error.message); }
});
async function downscale(file, max = 1600) {
  const bitmap = await createImageBitmap(file);
  const s = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
  const c = Object.assign(document.createElement('canvas'), { width: Math.round(bitmap.width * s), height: Math.round(bitmap.height * s) });
  c.getContext('2d').drawImage(bitmap, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', .88);
}

// --- Step 3: the studio --------------------------------------------------------------------------
const who = a => ({ brand: "the brand's followers", both: 'both audiences' }[a] || 'the fans');
const say = {
  get_listing: () => 'Looking at the space',
  local_taste_tags: i => `Asking Qloo what locals love: ${String(i.facet || '').replaceAll('_', ' ')}`,
  local_venues: i => `Checking nearby ${i.category || business}s`,
  local_entities: i => `Finding the ${i.type}s this neighborhood loves`,
  search_tags: i => `Looking up “${i.query}”`,
  book_slate: () => 'Asking Qloo who to book for a room this size',
  check_audience_fit: () => activation ? 'Checking each design idea against who the fans are' : 'Checking each design idea against who actually lives here',
  resolve_audience: () => 'Finding the fans and the brand in Qloo',
  audience_overlap: () => 'Measuring how the brand fits this fanbase',
  fan_taste_tags: i => `Asking Qloo what ${who(i.audience)} want a room to feel like: ${String(i.facet || '').replaceAll('_', ' ')}`,
  fan_favourites: i => `Finding the ${i.type}s ${who(i.audience || 'both')} love`,
  fan_places: i => `Finding the ${i.category || 'places'} fans rate near the venue`,
  fan_heatmap: () => 'Mapping where the fans live around the venue',
  render_redesign: () => activation ? 'Building the activation in the room' : 'Redesigning the room',
  finalize_concept: () => 'Writing it up'
};

// --- Instant examples: replay a recorded real run (see lib/demos.js) ----------------------------------
let demoSlug = null, demoList = null;
document.querySelectorAll('[data-demo]').forEach(b => b.addEventListener('click', () => openDemo(b.dataset.demo)));
async function openDemo(slug) {
  if (running) return;
  try {
    demoList ||= (await api('/api/demos')).demos;
    const demo = demoList.find(d => d.slug === slug); if (!demo) return toast('That example is not available.');
    const { spaces } = await api('/api/spaces');
    const space = spaces.find(s => s.id === demo.request.spaceId); if (!space) return toast('That example space is missing.');
    business = demo.request.business || 'activation'; activation = demo.request.activation || null;
    point = { lat: space.lat, lng: space.lng, label: `${space.neighborhood}, ${space.city}` };
    $('hint').hidden = true; spinning = false;
    map?.jumpTo({ center: [space.lng, space.lat], zoom: 15 });
    openStudio(space, null, slug);
  } catch (error) { toast(error.message); }
}

// Listing sites refuse photo downloads from cloud servers, but this page can read the photo, so it sends the pixels
// along with the run (resized to at most 1600 px). Returns null when the photo can't be read here.
async function photoData(src) {
  try {
    const url = new URL(src, location.href);
    if (url.origin === location.origin || url.protocol !== 'https:') return null;
    // The thumbnail on the page was cached without CORS, and that copy can't be read back: ask for a fresh one.
    url.searchParams.set('cors', '1');
    const img = new Image(); img.crossOrigin = 'anonymous';
    await new Promise((ok, no) => { img.onload = ok; img.onerror = no; img.src = url.href; });
    const k = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas'); c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.88);
  } catch { return null; }
}
// The words under the hourglass while the room is being made.
const painting = text => { $('shimmer-text').textContent = text; };

async function openStudio(space, photo = null, demo = null) {
  if (running) return;
  if (!demo && !config.qloo) return toast('This server has no Qloo key yet, so the agent cannot run.');
  running = true; render = null; concept = null; taste = {}; baseRender = null; todCache = {}; runId = null; demoSlug = demo;
  $('demo-note').hidden = !demo;
  $('charts').hidden = true; $('timeline').hidden = true; $('handle').hidden = true; $('c-baseline')?.remove();
  $('sheet').hidden = true; $('drawer').hidden = true;
  const studio = $('studio'); studio.hidden = false; studio.classList.remove('enter'); void studio.offsetWidth; studio.classList.add('enter');
  $('studio-place').textContent = `${activation ? 'Activation: ' : ''}${bizLabel()}, ${space.neighborhood || space.city}`;
  $('c-name').textContent = activation ? 'Reading the fans…' : 'Reading the neighborhood…'; $('c-tag').textContent = space.title; $('c-body').hidden = true;
  $('before').src = safeUrl(photo || space.photo); $('after-wrap').hidden = true; $('slider').hidden = true; $('l-after').hidden = true; $('shimmer').hidden = false; painting(activation ? 'Reading the fans…' : 'Reading the neighbourhood…');
  $('live').className = 'live'; $('live-text').textContent = 'Starting the agent…'; tick(); $('steps').replaceChildren(); $('log').replaceChildren(); $('walk-status').hidden = true;
  const pending = new Map();
  try {
    const aspect = await photoAspect($('before'));
    // Image edits can take a minute; the server pings every 15 s, so three missed pings means the stream is dead.
    const stall = new AbortController();
    let watchdog = setTimeout(() => stall.abort(), 50000);
    const res = await fetch('/api/agent', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ spaceId: space.id, business, aspect, ...(activation ? { activation } : {}), ...(photo ? { photo } : {}), ...(demo ? { demo, pace: new URLSearchParams(location.search).get('pace') } : { photoData: await photoData(photo || space.photo), space: space.kind === 'live' ? space : undefined }) }), signal: stall.signal });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'The agent could not start.');
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      clearTimeout(watchdog); watchdog = setTimeout(() => stall.abort(), 50000);
      buffer += value;
      let i;
      while ((i = buffer.indexOf('\n\n')) >= 0) {
        const line = buffer.slice(0, i).split('\n').find(l => l.startsWith('data: ')); buffer = buffer.slice(i + 2);
        if (line) handle(JSON.parse(line.slice(6)), pending);
      }
    }
  } catch (error) { fail(error.name === 'AbortError' ? 'The agent stopped responding. Try again.' : error.message); }
  finally {
    running = false; $('shimmer').hidden = true;
    // A stream that ends without a result (server restart, network drop) should say so, not sit on "Starting…".
    if (!concept && !$('live').classList.contains('fail')) fail('The connection to the agent dropped before it finished. Try again.');
  }
}
// The nearest aspect ratio the image model supports, so the redesign frames like the original photo.
async function photoAspect(img) {
  try { await img.decode(); } catch { return undefined; }
  const r = img.naturalWidth / img.naturalHeight;
  const options = ['21:9', '16:9', '3:2', '4:3', '5:4', '1:1', '4:5', '3:4', '2:3', '9:16'];
  return options.reduce((best, o) => { const [w, h] = o.split(':').map(Number); return Math.abs(w / h - r) < Math.abs(best.d) ? { o, d: w / h - r } : best; }, { o: undefined, d: Infinity }).o;
}
function fail(message) { $('live').className = 'live fail'; $('live-text').textContent = message; $('c-name').textContent = 'That didn’t work'; }

function handle(ev, pending) {
  if (ev.type === 'start') $('mode').textContent = ev.mode === 'agent' ? `${ev.provider} · ${ev.model}` : 'Scripted mode (no LLM key on this server)';
  else if (ev.type === 'thought') { logItem('thought', ev.text); }
  else if (ev.type === 'tool_call') {
    $('live-text').textContent = (say[ev.name] || (() => ev.name))(ev.input || {}) + '…';
    if (ev.name === 'render_redesign') painting(activation ? 'Building the activation into the room…' : 'Painting your redesign. About 30 seconds…');
    const dot = el('i'); $('steps').append(dot);
    const li = logItem('tool', ''); li.querySelector('p').remove();
    li.append(el('div', 't', ev.name + (ev.input?.facet ? ` · ${ev.input.facet}` : ev.input?.type ? ` · ${ev.input.type}` : '')), el('p', '', '…'));
    pending.set(ev.id, { li, dot });
  } else if (ev.type === 'tool_result' || ev.type === 'tool_error') {
    const p = pending.get(ev.id); if (!p) return;
    p.dot.className = ev.type === 'tool_error' ? 'err' : 'on';
    p.li.querySelector('p').textContent = ev.type === 'tool_error' ? `Error: ${ev.message}` : ev.summary;
    if (ev.type === 'tool_error') p.li.classList.add('err');
    if (ev.data) { const d = el('details'); d.append(el('summary', '', 'data'), el('pre', '', JSON.stringify(ev.data, null, 2))); p.li.append(d); }
    if (ev.name === 'render_redesign' && ev.type === 'tool_result') showRender(ev.data, { sweep: true });
    if (ev.type === 'tool_result' && ev.data) collectTaste(ev.name, ev.data);
  } else if (ev.type === 'final') {
    concept = ev.concept; if (ev.render && !render) showRender(ev.render, { sweep: true }); showConcept(ev.concept); renderCharts();
    if (ev.concept.heatmap) paintHeat(ev.concept.heatmap);
    $('live').className = 'live done'; $('live-text').textContent = render ? 'Done. Drag the image to compare.' : 'Done, but the room could not be painted this time. Run it again, or pick another photo.';
    chime();
  } else if (ev.type === 'error') { fail(ev.message); logItem('err', ev.message); }
  else if (ev.type === 'done') { logItem('', `${ev.qlooCalls?.length || 0} Qloo API calls`); runId = ev.runId || null; if (concept && (demoSlug || (runId && config.llm))) offerBaseline(); }
}

// With and without Qloo: the same brief to an LLM with no tools, each pick checked against Qloo. It sits right under
// the concept; recorded examples run it straight away (it is recorded too, so it costs nothing).
let runId = null;
function offerBaseline() {
  $('c-baseline')?.remove();
  const box = el('section', 'baseline'); box.id = 'c-baseline';
  const h = el('h3', '', 'With and without Qloo'); h.append(el('small', '', 'same brief, an LLM alone')); box.append(h);
  const p = el('p', 'baseline-intro', `Ask an LLM alone for ${activation ? 'this activation' : `a ${typeLabel[business] || business} here`} and check each of its picks against what Qloo actually ranks for this crowd.`);
  const run = el('button', 'cta ghost', 'Run the check');
  box.append(p, run);
  run.addEventListener('click', async () => {
    run.disabled = true; run.textContent = 'Asking an LLM alone…';
    try {
      const b = await api('/api/baseline', demoSlug ? { demo: demoSlug } : { runId });
      run.remove(); p.remove();
      const verdicts = { ranked: ['✓', 'In Qloo\'s top results for this crowd'], known: ['·', 'Real, but Qloo does not rank it for this crowd'], unknown: ['✗', 'Not in Qloo\'s graph'] };
      box.append(el('p', 'baseline-score', `Without Qloo, ${b.counts.ranked} of ${b.total} picks hold up for this crowd`));
      b.picks.forEach(c => {
        const row = el('div', `check ${c.verdict}`), text = el('div');
        row.append(el('b', '', verdicts[c.verdict][0]));
        text.append(el('strong', '', `${c.name}`), el('p', '', `${c.kind} · ${verdicts[c.verdict][1]}${c.match && c.match !== c.name ? ` (Qloo: ${c.match})` : ''}`));
        row.append(text); box.append(row);
      });
      box.append(el('p', 'baseline-foot', `LLM alone: ${b.model}. "Holds up" means the exact name appeared in Qloo's top results for this crowd during the run. Everything Openhere picked above came from those results.`));
    } catch (error) { run.disabled = false; run.textContent = 'Run the check'; toast(error.message); }
  });
  $('walk').closest('.walk-row').after(box);
  if (demoSlug) run.click();
}
function logItem(cls, text) { const li = el('li', cls); li.append(el('p', '', text)); $('log').append(li); return li; }

// The wipe has a feathered edge; a fresh render sweeps across once so the change reveals itself.
function setCut(v) { $('compare').style.setProperty('--cut', `${v}%`); $('slider').value = v; }
function showRender(r, { sweep = false, keepBase = false } = {}) {
  if (!r?.url) return;
  render = r;
  if (!keepBase) {
    baseRender = r; todCache = { 'as-designed': r };
    document.querySelectorAll('[data-tod]').forEach(x => x.classList.toggle('on', x.dataset.tod === 'as-designed'));
    prefetchLighting(r);
  }
  const img = $('after'), url = safeUrl(r.url), first = $('after-wrap').hidden;
  const reveal = () => {
    $('after-wrap').hidden = false; $('slider').hidden = false; $('l-after').hidden = false; $('handle').hidden = false; $('shimmer').hidden = true;
    $('timeline').hidden = !baseRender;
    if (sweep || first) {
      const c = $('compare'); c.classList.remove('sweep'); setCut(100);
      requestAnimationFrame(() => requestAnimationFrame(() => { c.classList.add('sweep'); setCut(50); setTimeout(() => c.classList.remove('sweep'), 1700); }));
    }
  };
  if (first) { img.src = url; img.decode().catch(() => {}).finally(reveal); return; }
  // Cross-fade between redesign versions instead of popping.
  const next = new Image(); next.src = url;
  next.decode().catch(() => {}).finally(() => { img.classList.add('swap'); setTimeout(() => { img.src = url; img.classList.remove('swap'); reveal(); }, 300); });
}
$('slider').addEventListener('input', e => { $('compare').classList.remove('sweep'); $('compare').style.setProperty('--cut', `${e.target.value}%`); });

// Time of day: relight the same redesign (from the base render, so edits never compound).
// The three lighting variants start rendering (on Pruna) the moment a redesign lands, so switching
// time of day is usually instant. Each button shows a small pulse until its variant is ready.
function prefetchLighting(base) {
  for (const b of document.querySelectorAll('[data-tod]:not([data-tod="as-designed"])')) {
    const tod = b.dataset.tod;
    b.classList.add('loading'); b.classList.remove('ready');
    const job = api('/api/relight', { renderId: base.id, tod }).then(r => r.render);
    todCache[tod] = job;
    job.then(() => { if (baseRender === base) { b.classList.remove('loading'); b.classList.add('ready'); } }, () => { if (baseRender === base) { b.classList.remove('loading'); delete todCache[tod]; } });
  }
}
document.querySelectorAll('[data-tod]').forEach(b => b.addEventListener('click', async () => {
  const tod = b.dataset.tod;
  if (!baseRender || b.classList.contains('busy')) return;
  const base = baseRender;
  const mark = () => document.querySelectorAll('[data-tod]').forEach(x => x.classList.toggle('on', x === b));
  if (tod === 'as-designed') { mark(); return showRender(base, { keepBase: true }); }
  if (!todCache[tod]) prefetchLighting(base);
  b.classList.add('busy'); mark();
  if (b.classList.contains('loading')) { $('live').className = 'live'; $('live-text').textContent = `Finishing the ${b.textContent.replace(/^\W+/, '').toLowerCase()} lighting…`; }
  try {
    const lit = await todCache[tod];
    if (baseRender === base && b.classList.contains('on')) { showRender(lit, { keepBase: true }); $('live').className = 'live done'; $('live-text').textContent = 'Drag to compare'; }
  } catch (error) { $('live').className = 'live fail'; $('live-text').textContent = error.message; }
  finally { b.classList.remove('busy'); }
}));

// --- Qloo charts ------------------------------------------------------------------------------
function collectTaste(name, data) {
  if ((name === 'local_taste_tags' || name === 'fan_taste_tags') && data.tags?.length) taste[data.facet] = data;
  else if ((name === 'local_venues' || name === 'fan_places') && data.venues?.length) taste.venues = data;
  else if ((name === 'local_entities' || name === 'fan_favourites') && data.entities?.length) taste[data.type] = data;
  else if (name === 'fan_heatmap' && data.cells?.length) taste.heatmap = data;
  else if (name === 'audience_overlap') taste.overlap = data;
}
// The same grid on the big globe, so closing the studio lands on "where the fans are" around the venue.
let heatLegend = null;
function paintHeat(h) {
  if (!map || !h.cells?.length) return;
  const max = Math.max(...h.cells.map(c => c.affinity || 0)) || 1;
  const data = { type: 'FeatureCollection', features: h.cells.map(c => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [c.lng, c.lat] }, properties: { w: (c.affinity || 0) / max } })) };
  if (map.getSource('fanheat')) map.getSource('fanheat').setData(data);
  else {
    map.addSource('fanheat', { type: 'geojson', data });
    // Grid cells are ~1 km apart; keep the radius near that so the map reads as neighborhoods, not a blob.
    map.addLayer({ id: 'fanheat', type: 'heatmap', source: 'fanheat', paint: { 'heatmap-weight': ['interpolate', ['linear'], ['get', 'w'], 0, 0, 0.6, 0.15, 1, 1], 'heatmap-radius': ['interpolate', ['exponential', 2], ['zoom'], 8, 4, 11, 16, 14, 60], 'heatmap-intensity': .7, 'heatmap-opacity': .6, 'heatmap-color': ['interpolate', ['linear'], ['heatmap-density'], 0, 'rgba(0,82,255,0)', .25, '#cfe0ff', .55, '#0052ff', .85, '#ff5fa2', 1, '#ff2d7a'] } }, map.getLayer('buildings-3d') ? 'buildings-3d' : undefined);
  }
  heatLegend?.remove();
  heatLegend = el('div', 'heat-legend');
  heatLegend.append(el('b', '', `Where ${activation?.event || 'the'} fans are`), el('span', '', 'Qloo heatmap of affinity around the venue'));
  const x = el('button', 'x small', '×'); x.setAttribute('aria-label', 'Hide heatmap');
  x.addEventListener('click', () => { map.setLayoutProperty('fanheat', 'visibility', 'none'); heatLegend.remove(); heatLegend = null; });
  heatLegend.append(x); document.body.append(heatLegend);
  map.setLayoutProperty('fanheat', 'visibility', 'visible');
}
// A small map of where the fans over-index around the venue, from Qloo's heatmap grid.
function heatChart(h) {
  const box = el('div', 'chart wide'), head = el('h4', '', 'Where the fans are');
  head.append(el('small', '', 'Qloo heatmap · 12 km')); box.append(head);
  const holder = el('div', 'heat'); box.append(holder);
  if (!window.maplibregl) return box;
  // The box must be in the DOM before MapLibre measures it (a timeout, not rAF: background tabs pause rAF).
  setTimeout(() => {
    const mini = new maplibregl.Map({ container: holder, style: 'https://tiles.openfreemap.org/styles/positron', center: [h.center.lng, h.center.lat], zoom: 10.2, interactive: false, attributionControl: false });
    mini.on('load', () => {
      const max = Math.max(...h.cells.map(c => c.affinity || 0)) || 1;
      mini.addSource('heat', { type: 'geojson', data: { type: 'FeatureCollection', features: h.cells.map(c => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [c.lng, c.lat] }, properties: { w: (c.affinity || 0) / max } })) } });
      mini.addLayer({ id: 'heat', type: 'heatmap', source: 'heat', paint: { 'heatmap-weight': ['interpolate', ['linear'], ['get', 'w'], 0, 0, 0.6, 0.15, 1, 1], 'heatmap-radius': 12, 'heatmap-intensity': .8, 'heatmap-opacity': .7, 'heatmap-color': ['interpolate', ['linear'], ['heatmap-density'], 0, 'rgba(0,82,255,0)', .25, '#cfe0ff', .55, '#0052ff', .85, '#ff5fa2', 1, '#ff2d7a'] } });
      new maplibregl.Marker({ element: el('div', 'drop') }).setLngLat([h.center.lng, h.center.lat]).addTo(mini);
    });
  }, 0);
  return box;
}
const palette = ['#0052ff', '#18b47b', '#ff5fa2', '#f5b700', '#7a5cff'];
// Location affinities cluster near 1, so bars show each item relative to the strongest in its set.
// Qloo's ranked results as a plain list: the name, then its score (affinity, or a share of top venues).
function bars(title, items, value, { note = '', wide = false, max = 6 } = {}) {
  const rows = items.slice(0, max).map(x => ({ name: x.name, v: Number(value(x)) })).filter(x => x.name);
  if (!rows.length) return null;
  const box = el('div', `chart${wide ? ' wide' : ''}`), h = el('h4', '', title), list = el('ol', 'rank');
  if (note) h.append(el('small', '', note));
  rows.forEach(r => { const li = el('li'); li.append(el('span', '', r.name), el('span', '', Number.isFinite(r.v) ? (r.v <= 1 ? r.v.toFixed(2) : String(Math.round(r.v * 100) / 100)) : '')); list.append(li); });
  box.append(h, list);
  return box;
}
function columns(title, items, note) {
  const order = ['18 24', '25 29', '30 34', '35 44', '45 54', '55+'];
  const rows = items.filter(x => order.includes(x.name)).sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));
  if (rows.length < 2) return null;
  const hi = Math.max(...rows.map(r => r.venues || r.score || 0)) || 1;
  const box = el('div', 'chart'), h = el('h4', '', title), cols = el('div', 'cols');
  h.append(el('small', '', note)); box.append(h, cols);
  rows.forEach((r, i) => { const c = el('div'), b = el('b'); b.style.setProperty('--c', palette[(i + 1) % palette.length]); b.dataset.h = `${Math.max(8, 100 * (r.venues || r.score || 0) / hi)}%`; c.append(b, el('span', '', r.name.replace(' ', '-'))); cols.append(c); });
  return box;
}
function renderCharts() {
  const share = d => d.method?.startsWith('tags of') ? 'share of top venues' : 'affinity';
  const val = x => x.affinity ?? x.score ?? x.venues ?? x.popularity;
  const fans = Boolean(activation), aff = fans ? 'fan affinity' : 'local affinity';
  const charts = [
    taste.customer_identity && bars(fans ? 'Who the fans are' : 'Who goes out here', taste.customer_identity.tags, val, { note: share(taste.customer_identity), color: 0 }),
    taste.age_range && columns('Age', taste.age_range.tags, 'top local venues'),
    taste.ambience && bars('Mood they love', taste.ambience.tags, val, { note: share(taste.ambience), color: 2 }),
    taste.decor && bars('Decor', taste.decor.tags, val, { note: share(taste.decor), color: 3 }),
    (taste.beverage_offering || taste.cuisine || taste.menu_highlight) && bars(taste.beverage_offering ? 'Drinks' : 'Food', (taste.beverage_offering || taste.cuisine || taste.menu_highlight).tags, val, { note: 'share of top venues', color: 1 }),
    taste.interests && bars('Interests', taste.interests.tags, val, { note: share(taste.interests), color: 4 }),
    taste.heatmap && heatChart(taste.heatmap),
    taste.venues && bars(fans ? `Fans' picks nearby${taste.venues.tag ? `, ${taste.venues.tag.name}` : ''}` : `Nearby ${taste.venues.tag?.name || 'favourites'}`, taste.venues.venues, v => fans ? v.affinity ?? v.popularity : v.popularity, { note: fans ? 'fan affinity' : 'Qloo popularity', color: 0, wide: true, max: 5 }),
    taste.artist && bars(fans ? 'The playlist' : 'On their playlists', taste.artist.entities, e => e.affinity ?? e.popularity, { note: aff, color: 2 }),
    taste.brand && bars(fans ? 'Brands both love' : 'Brands they rate', taste.brand.entities, e => e.affinity ?? e.popularity, { note: aff, color: 1 }),
    taste.podcast && bars('Podcasts', taste.podcast.entities, e => e.affinity ?? e.popularity, { note: aff, color: 4 })
  ].filter(Boolean);
  // Collapsed by default: the full Qloo data behind the design, for anyone who wants to check it.
  $('charts').querySelector('.charts-title').replaceChildren(document.createTextNode(fans ? 'The fans, by Qloo ' : 'The neighborhood, by Qloo '), el('small', '', `${charts.length} views`));
  $('chart-list').replaceChildren(...charts);
  $('charts').hidden = !charts.length;
  requestAnimationFrame(() => requestAnimationFrame(() => {
    $('chart-list').querySelectorAll('b[data-w]').forEach(b => { b.style.width = b.dataset.w; });
    $('chart-list').querySelectorAll('b[data-h]').forEach(b => { b.style.height = b.dataset.h; });
  }));
}

function showConcept(c) {
  $('c-name').textContent = tidy(c.name); $('c-tag').textContent = tidy(c.tagline);
  const who = c.design_choices.flatMap(d => d.signals).filter(s => s.grounded).map(s => s.name);
  $('c-who').replaceChildren(...[...new Set(who)].slice(0, 6).map((n, i) => el('span', `chip c${i % 4}`, n)));
  $('c-choices').replaceChildren(...c.design_choices.map(d => {
    const li = el('li'), chips = el('div', 'chips');
    d.signals.forEach((s, i) => chips.append(el('span', `chip ${s.grounded ? `c${i % 4}` : 'no'}`, s.grounded ? s.name : `${s.name} (unverified)`)));
    li.append(el('b', '', d.element), el('p', '', d.choice), chips); return li;
  }));
  const placed = {};
  $('c-fit')?.remove();
  if (c.overlap) {
    const o = c.overlap, box = el('section', 'fit'); box.id = 'c-fit';
    const ring = el('div', 'ring'); ring.style.setProperty('--p', `${o.score}%`); ring.append(el('b', '', String(o.score)), el('small', '', 'fit'));
    const text = el('div');
    text.append(el('h3', '', `${c.activation?.brand?.[0] || activation?.brand} × ${c.activation?.event?.[0] || activation?.event}`));
    text.append(el('p', '', c.fit?.summary || `Fans skew ${o.fans.skew}; the brand's followers skew ${o.followers.skew}. Age profiles match ${Math.round(((o.demoFit + 1) / 2) * 100)}%.`));
    if (o.overlap) text.append(el('p', 'fit-meta', `Age match ${Math.round(((o.demoFit + 1) / 2) * 100)}%, top brands overlap ${Math.round(o.overlap.brands * 100)}%, artists ${Math.round(o.overlap.artists * 100)}%`));
    const chips = el('div', 'chips');
    [...o.sharedBrands, ...o.sharedArtists].slice(0, 8).forEach((e, i) => chips.append(el('span', `chip c${i % 4}`, e.name)));
    if (chips.children.length) { text.append(el('p', 'fit-note', 'Both audiences already love'), chips); }
    box.append(ring, text);
    placed.fit = box;
  }
  $('c-partners')?.remove();
  if (c.partners?.length) {
    const box = el('section', 'slate partners'); box.id = 'c-partners';
    const h = el('h3', '', 'Partners & playlist'); h.append(el('small', '', 'picked by Qloo')); box.append(h);
    c.partners.forEach(p => {
      const row = el('div', 'slot'), right = el('div');
      right.append(el('strong', '', p.name), el('p', '', p.why));
      if (!p.grounded) right.append(el('span', 'chip no', 'not from Qloo'));
      row.append(el('b', '', p.role), right); box.append(row);
    });
    placed.partners = box;
  }
  $('c-audience')?.remove();
  if (c.audience?.checks?.length) {
    const box = el('section', 'audience'); box.id = 'c-audience';
    const h = el('h3', '', 'Audience check'); h.append(el('small', '', 'by Qloo')); box.append(h);
    box.append(el('p', 'audience-area', c.audience.area.crowd === 'fans' ? `Fans of ${c.audience.area.venues?.join(', ') || activation?.event} skew ${c.audience.area.skew} in Qloo's data.` : `The venues locals rank highest here draw a crowd that skews ${c.audience.area.skew}.`));
    for (const chk of c.audience.checks) {
      const row = el('div', `check ${chk.verdict}`);
      row.append(el('b', '', chk.verdict === 'fits' ? '✓' : chk.verdict === 'mismatch' ? '✗' : '·'));
      const text = el('div'); text.append(el('strong', '', chk.tag), el('p', '', chk.verdict === 'mismatch' ? `Dropped: ${chk.reason}.` : chk.verdict === 'fits' ? 'Fits: closer to the locals’ age mix than most design options here.' : 'In range for this crowd.'));
      row.append(text); box.append(row);
    }
    $('c-choices').closest('section').after(box);
  }
  $('c-slate')?.remove();
  if (c.programming?.length) {
    const slate = el('section', 'slate'); slate.id = 'c-slate';
    const h = el('h3', '', slateTitle(business)); h.append(el('small', '', 'picked by Qloo')); slate.append(h);
    const m = c.slateMeta;
    if (m) slate.append(el('p', 'slate-meta', `Sized for ~${m.capacity ?? '?'} guests (Qloo popularity ≤ ${m.popularityMax})${m.seededBy?.length ? ` · ranked for fans of ${m.seededBy.slice(0, 3).join(', ')}` : ''}`));
    c.programming.forEach((p, i) => {
      const row = el('div', 'slot'), right = el('div');
      right.append(el('strong', '', p.act), el('p', '', p.why));
      if (!p.grounded) right.append(el('span', 'chip no', 'not from Qloo'));
      row.append(el('b', '', p.slot), right); slate.append(row);
    });
    placed.slate = slate;
  }
  // Most important first: the fit, then the programme, then partners.
  $('walk').closest('.walk-row').after(...[placed.fit, placed.slate, placed.partners].filter(Boolean));
  $('c-body').hidden = false;
  $('refine').hidden = !render; $('walk').hidden = !render || !(config.liveWorld || config.world);
  $('walk3d').hidden = !render || !config.room3d;
}

$('refine').addEventListener('submit', async e => {
  e.preventDefault();
  const instruction = $('refine-input').value.trim(); if (!instruction || !render) return;
  $('shimmer').hidden = false; painting('Applying your change…'); $('live').className = 'live'; $('live-text').textContent = 'Applying your change…';
  try { const { render: next } = await api('/api/refine', { renderId: render.id, instruction }); showRender(next); $('refine-input').value = ''; $('live').className = 'live done'; $('live-text').textContent = 'Updated. Drag to compare.'; }
  catch (error) { $('live').className = 'live fail'; $('live-text').textContent = error.message; }
  finally { $('shimmer').hidden = true; }
});

// The redesign lifted into 3D (widened, then given depth; see lib/depth3d.js): walk it with WASD or on a headset.
$('walk3d').addEventListener('click', () => {
  if (render) window.open(`/room3d?${new URLSearchParams({ img: render.url, name: concept?.name || '' })}`, '_blank', 'noopener');
});
$('walk').addEventListener('click', async () => {
  if (!render) return;
  // Real-time world model (fal Lingbot World 2) when available; World Labs splats otherwise.
  if (config.liveWorld) {
    // The painting's own link too, so any server instance can start the walk (see /api/live/start).
    const q = new URLSearchParams({ render: render.id, name: concept?.name || '', tagline: concept?.tagline || '', ...(/^https:/.test(render.url) ? { img: render.url } : {}) });
    return window.open(`/live?${q}`, '_blank', 'noopener');
  }
  $('walk').disabled = true;
  try { const { worldId } = await api('/api/world', { renderId: render.id, concept: concept && { name: concept.name, tagline: concept.tagline } }); pollWorld(worldId); }
  catch (error) { toast(error.message); $('walk').disabled = false; }
});
async function pollWorld(id) {
  const status = $('walk-status'); status.hidden = false;
  const started = Date.now();
  for (;;) {
    let data;
    try { data = await api(`/api/world/${encodeURIComponent(id)}`); } catch (error) { status.textContent = error.message; break; }
    if (data.done) {
      if (data.error) { status.textContent = `3D build failed: ${data.error}`; break; }
      status.replaceChildren(); const a = el('a', '', 'Your 3D space is ready. Step inside.'); a.href = `/walk?id=${encodeURIComponent(id)}`; a.target = '_blank'; status.append(a);
      break;
    }
    status.textContent = `Building the 3D space… ${data.progress != null ? Math.round(data.progress) + '%' : `${((Date.now() - started) / 60000).toFixed(1)} min`} (about 5 min)`;
    await new Promise(r => setTimeout(r, 8000));
  }
  $('walk').disabled = false;
}

$('why').addEventListener('click', () => { $('drawer').hidden = false; });
$('drawer-close').addEventListener('click', () => { $('drawer').hidden = true; });
$('studio-close').addEventListener('click', () => {
  if (running) return toast('Hang on, the agent is still working.');
  $('studio').hidden = true; $('hint').hidden = false;
  // After an activation, pull back to the fan heatmap around the venue.
  if (concept?.heatmap && map) map.flyTo({ center: [concept.heatmap.center.lng, concept.heatmap.center.lat], zoom: 10.6, pitch: 35, duration: 1800, essential: true });
});
addEventListener('keydown', e => { if (e.key === 'Escape') { if (!$('drawer').hidden) $('drawer').hidden = true; else if (!$('ask').hidden) $('ask').hidden = true; } });
addEventListener('resize', () => { if (!$('ask').hidden) showAsk(); });

try { config = await api('/api/config'); } catch { toast('Could not reach the server.'); }
initMap();
// Deep link to an example, e.g. /?demo=redbull-bridgers (used in the write-up and for screenshots).
const linked = new URLSearchParams(location.search).get('demo');
if (linked) openDemo(linked);
