import { randomUUID } from 'node:crypto';
import { fetchJson } from './http.js';

// Real-time walkthrough: fal's Lingbot World 2 streams a generated world over WebRTC, starting
// from the redesign render. Signalling follows fal's WMA bridge (as used by @fal-ai/client's
// realtime `wma` transport): POST /ice for TURN credentials, POST /session with one complete SDP
// offer, then POST /session/heartbeat every 5 s to keep the lease. Video and the "control" data
// channel then run peer-to-peer, so the browser never sees the fal key.
// The server owns the heartbeat path, so it can end sessions at a hard time cap to bound cost.
const bridge = 'https://wma.fal.run';

export function createLive({ key, model = 'robbyant/lingbot-world-2', maxSeconds = 180, fetcher = fetch }) {
  const sessions = new Map();
  const call = (path, body, timeout = 20000) => fetchJson(fetcher, `${bridge}${path}`, {
    method: 'POST', headers: { authorization: `Key ${key}`, 'content-type': 'application/json' }, body: JSON.stringify(body)
  }, { label: 'fal realtime', secrets: [key], timeout });
  const prune = () => { const now = Date.now(); for (const [id, s] of sessions) if (now - s.startedAt > (maxSeconds + 600) * 1000) sessions.delete(id); };

  return {
    model, maxSeconds,
    async start(render) {
      prune();
      const { ice_servers: iceServers = [] } = await call('/ice', { app_id: model }, 8000);
      const id = randomUUID();
      sessions.set(id, { id, render, startedAt: Date.now(), sessionId: null });
      return { liveId: id, iceServers, maxSeconds };
    },
    async session(liveId, sdp, type = 'offer') {
      const s = sessions.get(liveId);
      if (!s) throw Object.assign(new Error('Unknown live session.'), { status: 404 });
      if (s.sessionId) throw Object.assign(new Error('This session is already connected.'), { status: 409 });
      if (typeof sdp !== 'string' || sdp.length > 20000 || type !== 'offer') throw Object.assign(new Error('Invalid offer.'), { status: 400 });
      // The bridge may wait for a free GPU, so allow a generous negotiation window.
      const answer = await call('/session', { app_id: model, sdp, type }, 90000);
      s.sessionId = answer.session_id;
      s.startedAt = Date.now();
      return { sdp: answer.sdp, type: answer.type, render: s.render };
    },
    async heartbeat(liveId) {
      const s = sessions.get(liveId);
      if (!s?.sessionId) return { alive: false };
      const left = maxSeconds - (Date.now() - s.startedAt) / 1000;
      // Past the cap we stop renewing the lease; fal ends the session after missed heartbeats.
      if (left <= 0) { sessions.delete(liveId); return { alive: false, reason: 'time' }; }
      const status = await call('/session/heartbeat', { session_id: s.sessionId }, 4000).catch(() => ({ alive: true }));
      return { alive: status.alive !== false, secondsLeft: Math.round(left) };
    },
    end(liveId) { sessions.delete(liveId); }
  };
}
