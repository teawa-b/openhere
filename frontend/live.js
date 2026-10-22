const $ = id => document.getElementById(id);
const params = new URLSearchParams(location.search);
const renderId = params.get('render');
const concept = { name: params.get('name') || '', tagline: params.get('tagline') || '' };
const post = async (path, body) => {
  const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
  return data;
};

// Lighting presets, applied as a world-description update while you walk.
const times = {
  morning: 'Early morning: soft cool daylight through the windows, lights off, quiet and fresh.',
  afternoon: 'Bright afternoon: strong natural daylight, lively and airy, warm sunlight patches on the floor.',
  golden: 'Golden hour: low warm sunset light streaming in, long shadows, pendant lights just turned on.',
  evening: 'Evening: dark blue dusk outside, warm pendant and candle light inside, intimate and glowing.',
  late: 'Late night: night outside the windows, dim amber lighting, candles on tables, moody bar atmosphere.'
};

let pc, channel, liveId, world, heartbeat, busyPrompt = false;
$('live-name').textContent = concept.name || 'Your redesign';
document.title = concept.name || 'Walk inside';
// The walkthrough wears this app's wordmark.
const logos = { openhere: ['open', 'here'] };
fetch('/api/config').then(r => r.json()).then(c => {
  const [a, b] = logos[c.site] || [c.siteName || '', ''];
  const logo = $('live-logo'); logo.textContent = a; if (b) logo.append(Object.assign(document.createElement('b'), { textContent: b }));
  document.title = `${concept.name || 'Walk inside'} — ${c.siteName}`;
}).catch(() => {});
if (!renderId) $('gate-status').textContent = 'Open this from a finished redesign.';

$('enter').addEventListener('click', async () => {
  $('enter').disabled = true;
  try { await connect(); }
  catch (error) { $('gate-status').textContent = error.message; $('enter').disabled = false; teardown(); }
});

async function connect() {
  status('Reserving a world-model GPU…');
  const start = await post('/api/live/start', { renderId, image: params.get('img') || undefined, concept });
  ({ liveId, world } = start);
  $('poster').src = world.url;
  pc = new RTCPeerConnection({ iceServers: start.iceServers });
  pc.addTransceiver('video', { direction: 'recvonly' });
  pc.ontrack = e => { $('video').srcObject = e.streams[0] || new MediaStream([e.track]); };
  pc.onconnectionstatechange = () => { if (['failed', 'closed'].includes(pc.connectionState)) ended('The connection dropped.'); };
  channel = pc.createDataChannel('control');
  channel.onopen = () => {
    status('Building the world from your redesign…');
    channel.send(JSON.stringify({ type: 'configure', image_url: world.url, prompt: world.prompt, enable_prompt_expansion: true }));
  };
  channel.onmessage = e => onMessage(typeof e.data === 'string' ? e.data : new TextDecoder().decode(e.data));
  await pc.setLocalDescription(await pc.createOffer());
  // fal's bridge takes one complete offer (no trickle ICE), so wait for candidates to settle.
  await gathered(pc);
  status('Connecting…');
  const answer = await post('/api/live/session', { liveId, sdp: pc.localDescription.sdp, type: 'offer' });
  await pc.setRemoteDescription({ type: answer.type, sdp: answer.sdp });
  heartbeat = setInterval(beat, 5000);
  $('video').addEventListener('playing', () => { $('gate').hidden = true; $('poster').hidden = true; $('times').hidden = false; $('hint').hidden = false; }, { once: true });
}

function gathered(peer) {
  return new Promise(resolve => {
    if (peer.iceGatheringState === 'complete') return resolve();
    let quiet;
    const done = () => { clearTimeout(quiet); clearTimeout(cap); resolve(); };
    const cap = setTimeout(done, 6000);
    peer.addEventListener('icegatheringstatechange', () => peer.iceGatheringState === 'complete' && done());
    peer.addEventListener('icecandidate', e => { clearTimeout(quiet); if (!e.candidate) done(); else if (/ typ relay/.test(e.candidate.candidate)) quiet = setTimeout(done, 400); });
  });
}

async function beat() {
  try {
    const r = await post('/api/live/heartbeat', { liveId });
    if (!r.alive) return ended(r.reason === 'time' ? 'Session time is up. Thanks for walking through!' : 'The session ended.');
    $('clock').hidden = false;
    $('clock').textContent = `${Math.floor(r.secondsLeft / 60)}:${String(r.secondsLeft % 60).padStart(2, '0')} left`;
  } catch {}
}

function onMessage(raw) {
  let msg; try { msg = JSON.parse(raw); } catch { return; }
  if (msg.type === 'prompt_applied') { busyPrompt = false; document.querySelectorAll('[data-time]').forEach(b => b.disabled = false); }
  else if (msg.type === 'error') status(`World model: ${msg.error}`);
  else if (msg.type === 'stream_exhausted') ended('This world has run its course. Enter again for a fresh walk.');
}

function status(text) { $('gate-status').textContent = text; }
function ended(text) {
  teardown();
  $('gate').hidden = false; $('times').hidden = true; $('hint').hidden = true;
  $('gate').querySelector('h1').textContent = 'That’s the tour.';
  status(text); $('enter').disabled = false; $('enter').textContent = 'Walk again';
}
function teardown() {
  clearInterval(heartbeat);
  try { channel?.readyState === 'open' && channel.send(JSON.stringify({ type: 'stop' })); } catch {}
  try { pc?.close(); } catch {}
  if (liveId) navigator.sendBeacon?.('/api/live/end', new Blob([JSON.stringify({ liveId })], { type: 'application/json' }));
  pc = channel = null; liveId = null;
}
addEventListener('pagehide', teardown);

// Controls: held commands go in `active`, newly pressed ones in `activated`, as fal's schema asks.
const keymap = { w: 'forward', a: 'left', s: 'backward', d: 'right', arrowup: 'look_up', arrowdown: 'look_down', arrowleft: 'look_left', arrowright: 'look_right' };
const held = new Set();
function sendCommands(activated = []) {
  if (channel?.readyState !== 'open') return;
  channel.send(JSON.stringify({ type: 'commands', active: [...held], activated }));
}
function press(cmd) { if (held.has(cmd)) return; held.add(cmd); sendCommands([cmd]); }
function release(cmd) { if (held.delete(cmd)) sendCommands(); }
addEventListener('keydown', e => { const c = keymap[e.key.toLowerCase()]; if (c) { e.preventDefault(); press(c); } });
addEventListener('keyup', e => { const c = keymap[e.key.toLowerCase()]; if (c) release(c); });
addEventListener('blur', () => { held.clear(); sendCommands(); });
document.querySelectorAll('[data-cmd]').forEach(b => {
  b.addEventListener('pointerdown', () => press(b.dataset.cmd));
  ['pointerup', 'pointerleave', 'pointercancel'].forEach(t => b.addEventListener(t, () => release(b.dataset.cmd)));
});
// Drag on the video to look around.
let drag = null;
const video = $('video');
video.addEventListener('pointerdown', e => { drag = { x: e.clientX, y: e.clientY }; video.setPointerCapture(e.pointerId); });
video.addEventListener('pointermove', e => {
  if (!drag) return;
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y, t = 18;
  for (const [cond, cmd] of [[dx < -t, 'look_left'], [dx > t, 'look_right'], [dy < -t, 'look_up'], [dy > t, 'look_down']]) cond ? press(cmd) : release(cmd);
});
video.addEventListener('pointerup', () => { drag = null; ['look_left', 'look_right', 'look_up', 'look_down'].forEach(release); });

document.querySelectorAll('[data-time]').forEach(b => b.addEventListener('click', () => {
  if (busyPrompt || channel?.readyState !== 'open') return;
  busyPrompt = true;
  document.querySelectorAll('[data-time]').forEach(x => { x.disabled = true; x.classList.toggle('on', x === b); });
  channel.send(JSON.stringify({ type: 'prompt', prompt: `${world.prompt} ${times[b.dataset.time]}`.slice(0, 2000) }));
  setTimeout(() => { busyPrompt = false; document.querySelectorAll('[data-time]').forEach(x => x.disabled = false); }, 15000);
}));
