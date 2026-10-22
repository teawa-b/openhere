import * as THREE from 'three';
import { VRButton } from 'three/addons/webxr/VRButton.js';
import { SparkRenderer, SplatMesh } from '@sparkjsdev/spark';

const $ = id => document.getElementById(id);
const worldId = new URLSearchParams(location.search).get('id');
const api = async (path, body) => {
  const res = await fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : undefined);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
  return data;
};

const renderer = new THREE.WebGLRenderer({ antialias: false });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.xr.enabled = true;
document.body.append(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b0712);
const camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.05, 200);
// The rig carries the camera so VR head tracking and thumbstick locomotion compose.
const rig = new THREE.Group();
rig.add(camera);
scene.add(rig);
scene.add(new SparkRenderer({ renderer, sortRadial: true, enableLod: true, maxPixelRadius: 512 }));

addEventListener('resize', () => { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight); });

let yaw = 0, pitch = 0;
const keys = new Set();
addEventListener('keydown', e => { if (e.target.tagName !== 'INPUT') keys.add(e.key.toLowerCase()); });
addEventListener('keyup', e => keys.delete(e.key.toLowerCase()));
let drag = null;
renderer.domElement.addEventListener('pointerdown', e => { drag = { x: e.clientX, y: e.clientY }; renderer.domElement.setPointerCapture(e.pointerId); });
renderer.domElement.addEventListener('pointermove', e => {
  if (!drag) return;
  yaw += (e.clientX - drag.x) * 0.004; pitch = Math.max(-1.2, Math.min(1.2, pitch + (e.clientY - drag.y) * 0.004));
  drag = { x: e.clientX, y: e.clientY };
});
addEventListener('pointerup', () => { drag = null; });
const held = new Set();
document.querySelectorAll('.pad button').forEach(b => {
  const on = () => held.add(b), off = () => held.delete(b);
  b.addEventListener('pointerdown', on); b.addEventListener('pointerup', off); b.addEventListener('pointerleave', off);
});

const clock = new THREE.Clock();
const forward = new THREE.Vector3(), right = new THREE.Vector3(), move = new THREE.Vector3();
const limit = 8;
renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.1), speed = 1.6 * dt;
  move.set(0, 0, 0);
  if (!renderer.xr.isPresenting) {
    for (const b of held) { if (b.dataset.turn) yaw += Number(b.dataset.turn) * 1.4 * dt; if (b.dataset.move === 'f') move.z -= 1; if (b.dataset.move === 'b') move.z += 1; }
    if (keys.has('w') || keys.has('arrowup')) move.z -= 1;
    if (keys.has('s') || keys.has('arrowdown')) move.z += 1;
    if (keys.has('a') || keys.has('arrowleft')) move.x -= 1;
    if (keys.has('d') || keys.has('arrowright')) move.x += 1;
    if (keys.has('q')) rig.position.y -= speed;
    if (keys.has('e')) rig.position.y += speed;
    camera.rotation.set(-pitch, -yaw, 0, 'YXZ');
    forward.set(-Math.sin(-yaw), 0, -Math.cos(-yaw)); right.set(-forward.z, 0, forward.x);
    rig.position.addScaledVector(forward, -move.z * speed).addScaledVector(right, move.x * speed);
  } else {
    // Thumbsticks: left stick walks relative to where you look, right stick snap-free turns.
    for (const source of renderer.xr.getSession()?.inputSources || []) {
      const axes = source.gamepad?.axes; if (!axes || axes.length < 4) continue;
      if (source.handedness === 'right') rig.rotation.y -= axes[2] * 1.5 * dt;
      else {
        const dir = new THREE.Vector3(); camera.getWorldDirection(dir); dir.y = 0; dir.normalize();
        const side = new THREE.Vector3(-dir.z, 0, dir.x);
        rig.position.addScaledVector(dir, -axes[3] * speed).addScaledVector(side, axes[2] * speed);
      }
    }
  }
  rig.position.x = THREE.MathUtils.clamp(rig.position.x, -limit, limit);
  rig.position.z = THREE.MathUtils.clamp(rig.position.z, -limit, limit);
  renderer.render(scene, camera);
});

async function load() {
  if (!worldId) { $('loading').textContent = 'No walkthrough selected.'; return; }
  const world = await api(`/api/world/${encodeURIComponent(worldId)}`);
  if (!world.done) { $('loading').textContent = `Still building this world (${world.progress ?? '…'}%). This page will refresh.`; setTimeout(load, 8000); return; }
  if (world.error) { $('loading').textContent = `This world failed to build: ${world.error}`; return; }
  $('title').textContent = world.concept?.name || 'Your redesigned space';
  $('tagline').textContent = world.concept?.tagline || '';
  if (world.marbleUrl) { const a = Object.assign(document.createElement('a'), { href: world.marbleUrl, target: '_blank', rel: 'noreferrer', textContent: 'Open in Marble ↗' }); $('tagline').append(document.createElement('br'), a); }
  const mobile = matchMedia('(pointer: coarse)').matches;
  const res = world.assets.splat.includes(mobile ? '100k' : '500k') ? (mobile ? '100k' : '500k') : world.assets.splat[0];
  const splat = new SplatMesh({ url: `/api/world/${encodeURIComponent(worldId)}/asset?res=${res}` });
  // World Labs splats use an inverted Y axis relative to three.js.
  splat.quaternion.set(1, 0, 0, 0);
  scene.add(splat);
  await splat.initialized;
  $('loading').hidden = true;
  if (navigator.xr) navigator.xr.isSessionSupported('immersive-vr').then(ok => { if (ok) { document.body.append(VRButton.createButton(renderer)); $('help').textContent += ' · or enter VR'; } });
}
load().catch(error => { $('loading').textContent = error.message; });

$('change').addEventListener('submit', async e => {
  e.preventDefault();
  const instruction = $('change-input').value.trim();
  const world = await api(`/api/world/${encodeURIComponent(worldId)}`).catch(() => null);
  if (!instruction || !world?.render) return;
  const button = $('change').querySelector('button'); button.disabled = true;
  try {
    $('change-status').textContent = 'Editing the design…';
    const { render } = await api('/api/refine', { renderId: world.render.id, instruction });
    $('change-status').textContent = 'Rebuilding the 3D world (~5 min)…';
    const next = await api('/api/world', { renderId: render.id, concept: world.concept });
    location.href = `/walk?id=${encodeURIComponent(next.worldId)}`;
  } catch (error) { $('change-status').textContent = error.message; button.disabled = false; }
});
