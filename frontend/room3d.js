// Walk inside a painted room in 3D, with WASD (drag or arrow keys to look) or a headset (Enter VR). Two kinds of room:
// - ?img=<painting>: the painting lifted into 3D by fal's MoGe-2 (lib/depth3d.js), built on the spot in a few
//   seconds. It is the painting itself with real depth, seen from the front, so you step into it rather than turn
//   round in it. ?room=<name>-depth is one of these saved with the site.
// - ?room=<name>: a Hunyuan World mesh (scripts/world-to-glb.js), 360 degrees with baked colours.
// jsDelivr's +esm builds rewrite the loader's bare "three" import to the same URL, so both share one copy.
const THREE = await import('https://cdn.jsdelivr.net/npm/three@0.180.0/+esm');
const { GLTFLoader } = await import('https://cdn.jsdelivr.net/npm/three@0.180.0/examples/jsm/loaders/GLTFLoader.js/+esm');
const $ = id => document.getElementById(id);
const params = new URLSearchParams(location.search);
const name = params.get('room') || '';
// Paintings come from this site or from fal's image CDN; saved rooms only from /img/<name>.glb.
const painting = (() => { try { const u = new URL(params.get('img'), location.origin); return params.has('img') && (u.origin === location.origin || /\.fal\.media$/.test(u.hostname)) ? u.href : null; } catch { return null; } })();
const file = /^[a-z0-9-]{1,60}$/.test(name) ? `/img/${name}.glb` : null;
$('w3-name').textContent = params.get('name') || '';
$('w3-note').textContent = painting || name.endsWith('-depth') ? 'The painting, lifted into 3D. Step in with W and look around the furniture.' : 'A 3D room built from the painting by Hunyuan World. It looks best near where you start.';

const canvas = $('view');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.xr.enabled = true;
const scene = new THREE.Scene(); scene.background = new THREE.Color(0x1d1218);
// A depth room keeps the painting's own narrow lens.
const depth = Boolean(painting) || name.endsWith('-depth');
const camera = new THREE.PerspectiveCamera(depth ? 28 : 85, 1, 0.02, 60);
// The rig is what walks; the camera turns inside it (and, in VR, the headset moves it).
const rig = new THREE.Group(); rig.add(camera); scene.add(rig);
let yaw = 0, pitch = 0;
const resize = () => {
  renderer.setSize(innerWidth, innerHeight, false); camera.aspect = innerWidth / innerHeight;
  // A depth room fills the window across: about 46 degrees wide, however tall or narrow the window is.
  if (depth) camera.fov = Math.min(37, 2 * Math.atan(Math.tan(23 * Math.PI / 180) / camera.aspect) * 180 / Math.PI);
  camera.updateProjectionMatrix();
};
addEventListener('resize', resize); resize();

const status = text => { $('w3-load').querySelector('p').textContent = text; };
const progress = e => { if (e.total) $('w3-progress').style.width = `${Math.round(100 * e.loaded / e.total)}%`; };
const post = async (url, body) => {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'The 3D room could not be built.');
  return data;
};
// onload rather than decode(): decode() can wait forever in a tab that is in the background.
const loadImage = src => new Promise((resolve, reject) => { const img = new Image(); img.crossOrigin = 'anonymous'; img.onload = () => resolve(img); img.onerror = () => reject(new Error('The painting could not be loaded.')); img.src = src; });
// Put the full painting on a mesh that was built from a small copy of it.
function sharpen(gltf, img) {
  const tex = new THREE.Texture(img); tex.flipY = false; tex.colorSpace = THREE.SRGBColorSpace; tex.needsUpdate = true;
  gltf.scene.traverse(o => { if (o.isMesh) o.material.map = tex; });
}
// Build a room from a painting: widen it to 21:9, send a small copy for depth (the mesh has one point per pixel),
// then put the full wide painting back on the mesh.
async function fromPainting(src) {
  status('Painting the room out to the sides…');
  const u = new URL(src);
  const { image } = await post('/api/room3d/widen', { painting: u.origin === location.origin ? u.pathname : src });
  const img = await loadImage(image);
  const c = document.createElement('canvas'); c.width = 640; c.height = Math.round(640 * img.naturalHeight / img.naturalWidth);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  status('Building it in 3D…');
  const data = await post('/api/room3d', { image: c.toDataURL('image/jpeg', 0.9) });
  const gltf = await new GLTFLoader().loadAsync(data.glb, progress);
  sharpen(gltf, img);
  return gltf;
}
let gltf;
try {
  if (painting) gltf = await fromPainting(painting);
  else if (file) {
    gltf = await new GLTFLoader().loadAsync(file, progress);
    // A saved depth room ships its full painting beside it.
    const full = depth && await loadImage(`/img/${name}.jpg`).catch(() => null);
    if (full) sharpen(gltf, full);
  }
  else throw new Error('No 3D room here yet.');
} catch (error) { status(error.message); throw error; }
let spread = 0.46;
if (depth) {
  let map = null; spread = 0;
  gltf.scene.traverse(o => {
    if (!o.isMesh) return;
    map = o.material.map; o.material = new THREE.MeshBasicMaterial({ map, side: THREE.DoubleSide });
    // How wide the painting's lens was: the widest point seen, as a slope from the camera.
    const p = o.geometry.attributes.position;
    for (let i = 0; i < p.count; i += 7) spread = Math.max(spread, Math.abs(p.getX(i) / p.getZ(i)));
  });
  // Stepping sideways uncovers what the painting never showed behind the furniture. A far, dimmed copy of the
  // painting fills those gaps with the room's own colours instead of a hole.
  const far = 9, w = 2 * far * spread * 1.25, back = new THREE.Mesh(new THREE.PlaneGeometry(w, w * 0.75), new THREE.MeshBasicMaterial({ map, color: 0x9a8f88 }));
  back.position.z = -far; scene.add(back);
}
else {
  gltf.scene.rotation.x = -Math.PI / 2;
  gltf.scene.traverse(o => { if (o.isMesh) { o.material.vertexColors = true; o.material.side = THREE.DoubleSide; } });
}
scene.add(gltf.scene);
$('w3-load').hidden = true;

// Keys: walking and looking; the matching on-screen key lights up.
const held = new Set();
const key = (k, on) => { const el = document.querySelector(`[data-k="${k}"]`); if (el) el.classList.toggle('on', on); on ? held.add(k) : held.delete(k); };
// A real key or drag always hands the clock back to the person, even after a filming script has driven it.
addEventListener('keydown', e => { const k = e.key.toLowerCase(); if (['w', 'a', 's', 'd', 'arrowleft', 'arrowright', 'arrowup', 'arrowdown'].includes(k)) { e.preventDefault(); manual = false; key(k, true); } });
addEventListener('keyup', e => key(e.key.toLowerCase(), false));
let drag = null;
canvas.addEventListener('pointerdown', e => { manual = false; drag = [e.clientX, e.clientY]; canvas.setPointerCapture(e.pointerId); });
canvas.addEventListener('pointermove', e => { if (!drag) return; yaw -= (e.clientX - drag[0]) * 0.004; pitch = pitch - (e.clientY - drag[1]) * 0.004; drag = [e.clientX, e.clientY]; });
canvas.addEventListener('pointerup', () => { drag = null; });

// The room is reconstructed around where the painting was "taken"; stay close to it so it holds together. A depth
// room only exists in front of you, so you can step into it but not turn far away from it.
const RADIUS = 0.35, SPEED = 0.45, TURN = depth ? 0.5 : 1.1;
// A wider painting (see lib/depth3d.js) leaves more room to turn and to step sideways before its edges show.
const edge = Math.atan(spread);
const LOOK = depth ? { yaw: Math.max(0.1, edge - 0.45), pitch: 0.1 } : { yaw: Infinity, pitch: 1.2 };
const SIDE = 0.4 * spread / 0.46;
const keepIn = p => {
  if (depth) { p.x = Math.max(-SIDE, Math.min(SIDE, p.x)); p.z = Math.max(-1.1, Math.min(0.2, p.z)); return; }
  const r = Math.hypot(p.x, p.z); if (r > RADIUS) p.multiplyScalar(RADIUS / r);
};
const clock = new THREE.Clock(), fwd = new THREE.Vector3(), side = new THREE.Vector3();
let manual = false;
const step = dt => {
  if (held.has('arrowleft')) yaw += TURN * dt; if (held.has('arrowright')) yaw -= TURN * dt;
  if (held.has('arrowup')) pitch += TURN * dt; if (held.has('arrowdown')) pitch -= TURN * dt;
  yaw = Math.max(-LOOK.yaw, Math.min(LOOK.yaw, yaw)); pitch = Math.max(-LOOK.pitch, Math.min(LOOK.pitch, pitch));
  if (!renderer.xr.isPresenting) camera.rotation.set(pitch, yaw, 0, 'YXZ');
  fwd.set(-Math.sin(yaw), 0, -Math.cos(yaw)); side.set(-fwd.z, 0, fwd.x);
  const move = new THREE.Vector3();
  if (held.has('w')) move.add(fwd); if (held.has('s')) move.sub(fwd); if (held.has('d')) move.add(side); if (held.has('a')) move.sub(side);
  if (move.lengthSq()) { rig.position.addScaledVector(move.normalize(), SPEED * dt); keepIn(rig.position); }
};
renderer.setAnimationLoop(() => { const dt = Math.min(clock.getDelta(), 0.05); if (!manual) step(dt); renderer.render(scene, camera); });

// Headsets: an immersive session puts you in the room at standing eye level.
if (navigator.xr && await navigator.xr.isSessionSupported('immersive-vr').catch(() => false)) {
  $('w3-vr').hidden = false;
  $('w3-vr').addEventListener('click', async () => {
    const session = await navigator.xr.requestSession('immersive-vr', { optionalFeatures: ['local-floor'] });
    renderer.xr.setReferenceSpaceType('local');
    await renderer.xr.setSession(session);
  });
}
// For filming: press and release keys from a script, and advance time one video frame at a time so the walk
// plays at real speed however slowly the frames are captured.
window.walk = { press: k => key(k, true), release: k => key(k, false), look: (y, p = 0) => { yaw = y; pitch = p; }, frame: dt => { manual = true; step(dt); renderer.render(scene, camera); } };
