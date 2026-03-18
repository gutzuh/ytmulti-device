'use strict';

const http = require('http');
const path = require('path');
const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');
const { SessionManager } = require('./server/session');

const PORT = process.env.PORT || 3000;
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const sessions = new SessionManager();

// ── REST API ──────────────────────────────────────────────────────────────────

app.get('/api/devices', (_req, res) => res.json({ devices: sessions.getDevices() }));
app.get('/api/playback', (_req, res) => res.json({ playback: sessions.getPlaybackState() }));
app.get('/api/jams', (_req, res) => res.json({ jams: sessions.getJams() }));
app.get('/api/jams/:code', (req, res) => {
  const jam = sessions.getJamState(req.params.code.toUpperCase());
  if (!jam) return res.status(404).json({ error: 'Jam not found' });
  res.json({ jam });
});

const INVIDIOUS = [
  'https://inv.nadeko.net',
  'https://vid.puffyan.us',
  'https://invidious.fdn.fr',
  'https://y.com.sb',
  'https://invidious.nerdvpn.de',
];

async function invidiousFetch(path, timeout = 6000) {
  let lastErr;
  for (const base of INVIDIOUS) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeout);
      const res = await fetch(`${base}${path}`, { signal: ctrl.signal });
      clearTimeout(t);
      if (!res.ok) { lastErr = new Error(res.status); continue; }
      return await res.json();
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

/** Search YouTube */
app.get('/api/search', async (req, res) => {
  const { q, type = 'video', page = 1 } = req.query;
  if (!q) return res.status(400).json({ error: 'Missing q' });
  try {
    const data = await invidiousFetch(`/api/v1/search?q=${encodeURIComponent(q)}&type=${type}&page=${page}`);
    const results = data
      .filter(v => v.type === 'video')
      .slice(0, 12)
      .map(v => ({
        videoId: v.videoId,
        title: v.title,
        author: v.author,
        thumbnail: v.videoThumbnails?.[0]?.url || `https://i.ytimg.com/vi/${v.videoId}/hqdefault.jpg`,
        duration: v.lengthSeconds || 0,
      }));
    res.json({ results });
  } catch (err) {
    res.status(502).json({ error: 'Search unavailable' });
  }
});

/** Search suggestions (autocomplete) */
app.get('/api/suggest', async (req, res) => {
  const { q } = req.query;
  if (!q) return res.json({ suggestions: [] });
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    const r = await fetch(
      `https://suggestqueries.google.com/complete/search?client=youtube&ds=yt&q=${encodeURIComponent(q)}&callback=f`,
      { signal: ctrl.signal }
    );
    clearTimeout(t);
    const text = await r.text();
    // Response is JSONP: f([...]) — extract the array
    const json = JSON.parse(text.replace(/^f\(/, '').replace(/\)$/, ''));
    const suggestions = (json[1] || []).slice(0, 8).map(s => s[0] || s);
    res.json({ suggestions });
  } catch {
    // Fallback — return empty
    res.json({ suggestions: [] });
  }
});

/** Trending music */
app.get('/api/trending', async (req, res) => {
  try {
    const data = await invidiousFetch('/api/v1/trending?type=music&region=BR');
    const results = data.slice(0, 10).map(v => ({
      videoId: v.videoId,
      title: v.title,
      author: v.author,
      thumbnail: v.videoThumbnails?.[0]?.url || `https://i.ytimg.com/vi/${v.videoId}/hqdefault.jpg`,
      duration: v.lengthSeconds || 0,
    }));
    res.json({ results });
  } catch {
    res.status(502).json({ error: 'Trending unavailable' });
  }
});

// ─── HTTP server ──────────────────────────────────────────────────────────────

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// ── Shared room state ─────────────────────────────────────────────────────────

const roomState = {
  videoId: null,
  isPlaying: false,
  currentTime: 0,
  track: null,
  updatedAt: Date.now(),
};

// Private jams: Map<code, { name, password, hostId, deviceIds[], isPlaying, videoId, track, currentTime, updatedAt }>
const privateJams = new Map();

function makeJamCode() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

function getEstimatedTime(st) {
  if (st.isPlaying) {
    return st.currentTime + (Date.now() - st.updatedAt) / 1000;
  }
  return st.currentTime;
}

function getRoomPayload() {
  return {
    videoId: roomState.videoId,
    isPlaying: roomState.isPlaying,
    currentTime: getEstimatedTime(roomState),
    track: roomState.track,
  };
}

// ── Broadcast helpers ──────────────────────────────────────────────────────────

function broadcast(ids, payload) {
  const msg = JSON.stringify(payload);
  for (const id of ids) {
    const ws = sessions.getWs(id);
    if (ws?.readyState === WebSocket.OPEN) ws.send(msg);
  }
}

function broadcastAll(payload) {
  broadcast(sessions.getDevices().map(d => d.id), payload);
}

function broadcastDevices() {
  // Include private jam info in each device record for the "Devices" page
  const devices = sessions.getDevices().map(d => ({
    ...d,
    inJam: d._jamCode ? privateJams.has(d._jamCode) : false,
    jamName: d._jamCode ? (privateJams.get(d._jamCode)?.name || null) : null,
  }));
  broadcastAll({ type: 'devices', devices });
}

function broadcastRoom() {
  broadcastAll({ type: 'room_state', room: getRoomPayload() });
}

function broadcastJam(code) {
  const jam = privateJams.get(code);
  if (!jam) return;
  broadcast(jam.deviceIds, {
    type: 'jam_state',
    jam: {
      code,
      name: jam.name,
      hasPassword: !!jam.password,
      hostId: jam.hostId,
      deviceIds: jam.deviceIds,
      videoId: jam.videoId,
      isPlaying: jam.isPlaying,
      currentTime: getEstimatedTime(jam),
      track: jam.track,
    },
  });
}

// ── WebSocket ──────────────────────────────────────────────────────────────────

wss.on('connection', (ws) => {
  let deviceId = null;
  let jamCode = null;   // private jam the device is in

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); }
    catch { ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' })); return; }

    switch (msg.type) {

      // ── Register ───────────────────────────────────────────────────────────
      case 'register': {
        if (deviceId) return;
        deviceId = sessions.registerDevice(msg.deviceName, msg.deviceType, ws);
        ws.send(JSON.stringify({
          type: 'registered',
          deviceId,
          room: getRoomPayload(),
          playback: sessions.getPlaybackState(),
        }));
        broadcastDevices();
        break;
      }

      // ── Heartbeat ──────────────────────────────────────────────────────────
      case 'heartbeat': {
        if (!deviceId) return;
        sessions.heartbeat(deviceId);
        ws.send(JSON.stringify({ type: 'heartbeat_ack' }));
        break;
      }

      // ── Load video (public room + optional jam sync) ───────────────────────
      case 'load_video': {
        if (!deviceId) return;
        const { videoId, track } = msg;
        if (!videoId) return;

        if (jamCode) {
          // Load in private jam
          const jam = privateJams.get(jamCode);
          if (jam) {
            jam.videoId = videoId;
            jam.isPlaying = true;
            jam.currentTime = 0;
            jam.updatedAt = Date.now();
            if (track) jam.track = track;
            broadcastJam(jamCode);
          }
        } else {
          // Load in public room
          roomState.videoId = videoId;
          roomState.isPlaying = true;
          roomState.currentTime = 0;
          roomState.updatedAt = Date.now();
          if (track) { roomState.track = track; sessions.updateTrack(track); }
          sessions.applyControl('play', null);
          broadcastRoom();
          broadcastDevices();
        }
        break;
      }

      // ── Playback control ───────────────────────────────────────────────────
      case 'control': {
        if (!deviceId) return;
        const { action, value } = msg;
        const allowed = ['play', 'pause', 'seek', 'volume'];
        if (!allowed.includes(action)) return;

        const target = jamCode ? privateJams.get(jamCode) : roomState;
        if (!target) return;

        if (action === 'play') {
          target.currentTime = getEstimatedTime(target);
          target.isPlaying = true;
          target.updatedAt = Date.now();
        } else if (action === 'pause') {
          target.currentTime = getEstimatedTime(target);
          target.isPlaying = false;
          target.updatedAt = Date.now();
        } else if (action === 'seek') {
          target.currentTime = value;
          target.updatedAt = Date.now();
        }

        if (jamCode) {
          broadcastJam(jamCode);
        } else {
          sessions.applyControl(action, value);
          broadcastRoom();
          if (action === 'volume') broadcastAll({ type: 'control', action: 'volume', value });
        }
        break;
      }

      // ── Track metadata update ──────────────────────────────────────────────
      case 'update_track': {
        if (!deviceId) return;
        if (jamCode) {
          const jam = privateJams.get(jamCode);
          if (jam) { jam.track = msg.track; broadcastJam(jamCode); }
        } else {
          roomState.track = msg.track;
          sessions.updateTrack(msg.track);
          broadcastAll({ type: 'track_updated', track: msg.track });
        }
        break;
      }

      // ── Queue next/prev (broadcast to all in same room/jam) ───────────────
      case 'queue_next':
      case 'queue_prev': {
        if (!deviceId) return;
        if (jamCode) broadcastJam(jamCode);   // participants handle locally
        else broadcastAll({ type: msg.type });
        break;
      }

      // ── Create private jam ─────────────────────────────────────────────────
      case 'create_jam': {
        if (!deviceId) return;
        if (jamCode) {
          ws.send(JSON.stringify({ type: 'error', message: 'Already in a jam' }));
          return;
        }
        const code = makeJamCode();
        const jam = {
          name: msg.jamName || 'Jam Session',
          password: msg.password || null,
          hostId: deviceId,
          deviceIds: [deviceId],
          videoId: roomState.videoId,
          isPlaying: false,
          currentTime: getEstimatedTime(roomState),
          updatedAt: Date.now(),
          track: roomState.track,
        };
        privateJams.set(code, jam);
        jamCode = code;
        const dev = sessions.getDevice(deviceId);
        if (dev) dev._jamCode = code;
        ws.send(JSON.stringify({
          type: 'jam_created',
          jam: {
            code,
            name: jam.name,
            hasPassword: !!jam.password,
            hostId: jam.hostId,
            deviceIds: jam.deviceIds,
            videoId: jam.videoId,
            isPlaying: jam.isPlaying,
            currentTime: jam.currentTime,
            track: jam.track,
          },
        }));
        broadcastDevices();
        break;
      }

      // ── Join private jam ───────────────────────────────────────────────────
      case 'join_jam': {
        if (!deviceId) return;
        const code = (msg.code || '').toUpperCase().trim();
        const jam = privateJams.get(code);
        if (!jam) {
          ws.send(JSON.stringify({ type: 'error', message: 'Jam not found' }));
          return;
        }
        if (jam.password && jam.password !== msg.password) {
          ws.send(JSON.stringify({ type: 'error', message: 'Wrong password' }));
          return;
        }
        if (!jam.deviceIds.includes(deviceId)) jam.deviceIds.push(deviceId);
        jamCode = code;
        const dev = sessions.getDevice(deviceId);
        if (dev) dev._jamCode = code;
        ws.send(JSON.stringify({
          type: 'jam_joined',
          jam: {
            code,
            name: jam.name,
            hasPassword: !!jam.password,
            hostId: jam.hostId,
            deviceIds: jam.deviceIds,
            videoId: jam.videoId,
            isPlaying: jam.isPlaying,
            currentTime: getEstimatedTime(jam),
            track: jam.track,
          },
        }));
        broadcastJam(code);
        broadcastDevices();
        break;
      }

      // ── Leave jam ──────────────────────────────────────────────────────────
      case 'leave_jam': {
        if (!deviceId || !jamCode) return;
        const jam = privateJams.get(jamCode);
        if (jam) {
          jam.deviceIds = jam.deviceIds.filter(id => id !== deviceId);
          if (jam.deviceIds.length === 0) privateJams.delete(jamCode);
          else broadcastJam(jamCode);
        }
        const dev = sessions.getDevice(deviceId);
        if (dev) delete dev._jamCode;
        jamCode = null;
        ws.send(JSON.stringify({ type: 'jam_left' }));
        broadcastDevices();
        break;
      }

      default:
        ws.send(JSON.stringify({ type: 'error', message: `Unknown: ${msg.type}` }));
    }
  });

  ws.on('close', () => {
    if (!deviceId) return;
    if (jamCode) {
      const jam = privateJams.get(jamCode);
      if (jam) {
        jam.deviceIds = jam.deviceIds.filter(id => id !== deviceId);
        if (jam.deviceIds.length === 0) privateJams.delete(jamCode);
        else broadcastJam(jamCode);
      }
    }
    sessions.removeDevice(deviceId);
    broadcastDevices();
  });

  ws.on('error', (err) => console.error('WS error:', err.message));
});

// ── Heartbeat pruning ──────────────────────────────────────────────────────────

const pruneInterval = setInterval(() => {
  sessions.pruneStale();
  broadcastDevices();
}, 30_000);

// ── Start ──────────────────────────────────────────────────────────────────────

if (require.main === module) {
  server.listen(PORT, () => console.log(`ytmulti-device server running on http://localhost:${PORT}`));
}

module.exports = { app, server, wss, sessions, broadcast };
server.on('close', () => clearInterval(pruneInterval));
