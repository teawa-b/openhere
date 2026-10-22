import { readFile } from 'node:fs/promises';
import { fetchJson } from './http.js';

const seed = JSON.parse(await readFile(new URL('../data/spaces.json', import.meta.url), 'utf8'));
const userAgent = 'QlooHackathonDemo/1.0 (https://github.com/teawa-b)';
const norm = s => String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, ' ').trim();

export const demoSpaces = seed;
export const demoCities = [...new Set(seed.map(s => s.city))];

export function matchDemo(location) {
  const q = norm(location);
  if (!q) return seed;
  return seed.filter(s => [s.city, s.neighborhood, s.address].some(f => norm(f).includes(q) || q.includes(norm(s.city))));
}

// OpenStreetMap Nominatim: free, 1 request/second, needs a descriptive user agent.
let lastGeocode = 0;
export async function geocode(query, fetcher = fetch) {
  const wait = lastGeocode + 1100 - Date.now();
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastGeocode = Date.now();
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&limit=1&q=${encodeURIComponent(query)}`;
  const [hit] = await fetchJson(fetcher, url, { headers: { 'user-agent': userAgent, accept: 'application/json' } }, { label: 'Geocoder', timeout: 15000 });
  if (!hit) return null;
  const a = hit.address || {};
  return { lat: Number(hit.lat), lng: Number(hit.lon), city: a.city || a.town || a.village || a.county || '', neighborhood: a.neighbourhood || a.suburb || a.quarter || '', display: hit.display_name };
}

export async function reverseGeocode(lat, lng, fetcher = fetch) {
  const wait = lastGeocode + 1100 - Date.now();
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastGeocode = Date.now();
  const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=17&lat=${lat}&lon=${lng}`;
  const hit = await fetchJson(fetcher, url, { headers: { 'user-agent': userAgent, accept: 'application/json' } }, { label: 'Geocoder', timeout: 15000 });
  const a = hit.address || {};
  const street = [a.house_number, a.road].filter(Boolean).join(' ');
  return { lat, lng, city: a.city || a.town || a.village || a.county || '', neighborhood: a.neighbourhood || a.suburb || a.quarter || a.city_district || '', street, display: [street, a.city || a.town || a.village].filter(Boolean).join(', ') || hit.display_name || '' };
}

export function distanceKm(a, b) {
  const rad = d => d * Math.PI / 180, dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
}

// Optional live search through an Apify LoopNet actor. Off unless APIFY_TOKEN is set: scraping
// LoopNet is against its terms, so the operator decides whether to enable it.
const liveCache = new Map();
export async function liveSearch({ token, actor = 'solidcode~loopnet-com-scraper', location, fetcher = fetch }) {
  const slug = norm(location).replace(/ /g, '-');
  const cached = liveCache.get(slug);
  if (cached && Date.now() - cached.at < 24 * 3600e3) return cached.spaces;
  const url = `https://api.apify.com/v2/acts/${actor}/run-sync-get-dataset-items?timeout=120`;
  const items = await fetchJson(fetcher, url, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ location: slug, transactionType: 'for-lease', propertyType: 'retail', maxItems: 24, enrichDetails: true })
  }, { label: 'Listings provider', secrets: [token], timeout: 130000 });
  const spaces = [];
  for (const item of Array.isArray(items) ? items : []) {
    const text = `${item.name || ''} ${item.summary || ''} ${item.fullDescription || ''}`;
    const photo = item.heroImageUrl || item.imageUrl || item.image || item.images?.[0];
    if (!photo) continue;
    const address = item.streetAddress ? `${item.streetAddress}, ${item.city || ''} ${item.state || ''} ${item.postalCode || ''}`.trim() : item.address || item.name;
    spaces.push({
      id: `live-${Buffer.from(item.url || address).toString('base64url').slice(-16)}`, kind: 'live',
      title: item.name || address, address, city: item.city || location, neighborhood: item.submarket || '',
      lat: item.latitude ?? item.lat, lng: item.longitude ?? item.lng,
      formerUse: /restaurant|hood|grease|second.generation|2nd gen/i.test(text) ? 'Restaurant-ready (per listing text)' : (item.propertyType || 'Retail'),
      sqftApprox: item.sizeSqft || item.buildingSqft || undefined,
      rentText: item.leaseRate ? `${item.leaseRate} ${item.leaseRateUnit || ''}`.trim() : item.priceText || 'Rent on request',
      photo, credit: { author: item.brokerName || 'Listing broker', license: 'Listing photo', source: item.url }
    });
  }
  for (const s of spaces.filter(s => s.lat == null).slice(0, 8)) {
    try { const g = await geocode(s.address, fetcher); if (g) Object.assign(s, { lat: g.lat, lng: g.lng, neighborhood: s.neighborhood || g.neighborhood }); } catch {}
  }
  const usable = spaces.filter(s => s.lat != null);
  liveCache.set(slug, { at: Date.now(), spaces: usable });
  return usable;
}
