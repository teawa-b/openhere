import { fetchJson } from './http.js';

// Live commercial listings from LoopNet via RealtyAPI (https://www.realtyapi.io).
// Every call spends from a small monthly allowance, so searches and details are cached.
const base = 'https://loopnet.realtyapi.io';
const searchCache = new Map(), detailCache = new Map();
const foodFriendly = /restaurant|retail|storefront|bar|cafe|food/i;

function parseJson(value) { if (typeof value !== 'string') return value; try { return JSON.parse(value); } catch { return null; } }
const firstNumber = text => { const m = String(text ?? '').replace(/,/g, '').match(/\d+(?:\.\d+)?/); return m ? Number(m[0]) : undefined; };

export function toSpace(item) {
  const brokers = parseJson(item.brokers) || [];
  return {
    id: `loopnet-${item.id}`, kind: 'live', listingId: String(item.id),
    title: item.address || 'LoopNet listing',
    address: [item.address, item.cityState, item.zipCode].filter(Boolean).join(', '),
    city: item.city || '', neighborhood: '',
    lat: item.latitude, lng: item.longitude,
    formerUse: [item.propertyType, item.buildingInfo].filter(Boolean).join(' · '),
    sqftApprox: firstNumber(item.sizeLabel) ?? firstNumber(item.availableSpace),
    sizeText: item.sizeLabel || item.availableSpace || undefined,
    rentText: item.price || 'Rent on request',
    description: String(item.description || '').slice(0, 600),
    photo: item.photo,
    credit: { author: brokers[0]?.company || brokers[0]?.name || 'LoopNet', license: 'Listing photo via LoopNet', source: item.url }
  };
}

export async function nearbyListings({ key, lat, lng, radiusMiles = 1.5, fetcher = fetch }) {
  const cell = `${lat.toFixed(2)},${lng.toFixed(2)}`;
  const hit = searchCache.get(cell);
  if (hit && Date.now() - hit.at < 12 * 3600e3) return hit;
  const url = new URL('/search/bycoordinates', base);
  url.search = new URLSearchParams({ latitude: lat.toFixed(5), longitude: lng.toFixed(5), radius: String(radiusMiles), searchType: 'For_Lease', propertyType: 'Restaurant,Retail', resultCount: '25' }).toString();
  const data = await fetchJson(fetcher, url, { headers: { 'x-realtyapi-key': key, accept: 'application/json' } }, { label: 'Listings (RealtyAPI)', secrets: [key], timeout: 45000 });
  const all = (data.searchResults || []).filter(i => i.id && i.photo && i.latitude != null).map(toSpace);
  // The upstream type filter is loose; keep storefront/restaurant space when there is enough of it.
  const suited = all.filter(s => foodFriendly.test(s.formerUse));
  const result = { at: Date.now(), spaces: suited.length >= 3 ? suited : all };
  searchCache.set(cell, result);
  return result;
}

// LoopNet serves the same photo in several sizes; /115/ is a ~25 KB thumbnail, enough for a vision
// model to tell an interior from an exterior, a floor plan or a tenant logo.
const thumb = url => url.replace(/\/\d+\/image\.jpg$/, '/115/image.jpg');
export async function rankInteriors({ photos, look, fetcher = fetch, max = 16 }) {
  const candidates = photos.slice(0, max);
  const thumbs = await Promise.all(candidates.map(async url => {
    try { const r = await fetcher(thumb(url), { signal: AbortSignal.timeout(10000) }); if (!r.ok) return null; return `data:image/jpeg;base64,${Buffer.from(await r.arrayBuffer()).toString('base64')}`; } catch { return null; }
  }));
  const usable = candidates.map((url, i) => ({ url, uri: thumbs[i] })).filter(x => x.uri);
  if (!usable.length) return { interiors: [] };
  const text = await look(usable.map(x => x.uri), `These are ${usable.length} photos from one commercial real-estate listing, numbered 1 to ${usable.length} in order. Which show the inside of the space, usable as the "before" photo for an interior redesign render (a wide view of a room, ideally empty or lightly furnished)? Leave out exteriors, street views, aerials, maps, floor plans, logos and close-ups. Reply with JSON only: {"interiors": [photo numbers, best first]}`);
  let picked = [];
  try { picked = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)).interiors || []; } catch {}
  return { interiors: picked.map(n => usable[Number(n) - 1]?.url).filter(Boolean) };
}

// Full listing: the photo gallery (usually exterior first, interiors after), monthly rent,
// sub-type, walk/transit scores and street traffic counts the agent can reason about.
export async function listingDetails({ key, listingId, fetcher = fetch }) {
  if (detailCache.has(listingId)) return detailCache.get(listingId);
  const url = new URL('/details/byid', base);
  url.search = new URLSearchParams({ id: listingId }).toString();
  const { detail: d = {} } = await fetchJson(fetcher, url, { headers: { 'x-realtyapi-key': key, accept: 'application/json' } }, { label: 'Listing details (RealtyAPI)', secrets: [key], timeout: 45000 });
  const space = d.availableSpaces?.[0] || {};
  const monthly = String(space.spaceUse || '').match(/\$[\d,]+(?:\.\d+)?\s*\/MO(?!.*SF)/) || String(space.spaceUse || '').match(/\$[\d,]+ \/MO/);
  const details = {
    name: d.name, photos: (d.photos || []).filter(p => typeof p === 'string').slice(0, 40),
    rentText: monthly?.[0]?.replace(/\s*\/MO/, '/mo') || d.price || undefined,
    sizeText: space.size || d.facts?.['Total Space Available'],
    subtype: d.facts?.['Property Subtype'], lease: space.buildOut, built: d.facts?.['Year Built/Renovated'] || d.buildingInfo,
    description: String(d.description || '').slice(0, 900),
    highlights: (d.highlights || []).slice(0, 6),
    scores: Object.fromEntries(Object.entries(d.scores || {}).map(([k, v]) => [k, v?.score])),
    traffic: (d.trafficCounts || []).slice(0, 4).map(t => `${t.location} @ ${t.crossStreet}: ${t.volume}/day (${t.distance})`),
    transit: (d.transportation?.transit || []).slice(0, 3).map(t => `${t.name}, ${t.time}`)
  };
  detailCache.set(listingId, details);
  return details;
}
