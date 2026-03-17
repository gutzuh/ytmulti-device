'use strict';

const http = require('http');
const path = require('path');
const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');
const { SessionManager } = require('./server/session');

const PORT = process.env.PORT || 3000;

// ─── Express app ─────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const sessions = new SessionManager();

// ── REST API ──────────────────────────────────────────────────────────────────

/** List all connected devices */
app.get('/api/devices', (_req, res) => {
  res.json({ devices: sessions.getDevices() });
});

/** Get current playback state */
app.get('/api/playback', (_req, res) => {
  res.json({ playback: sessions.getPlaybackState() });
});

/** List all active jam sessions */
app.get('/api/jams', (_req, res) => {
  res.json({ jams: sessions.getJams() });
});

/** Get a single jam session by code */
app.get('/api/jams/:code', (req, res) => {
  const jam = sessions.getJamState(req.params.code.toUpperCase());
  if (!jam) return res.status(404).json({ error: 'Jam session not found' });
  res.json({ jam });
});

// ─── HTTP server ──────────────────────────────────────────────────────────────

const server = http.createServer(app);

// ─── WebSocket server ─────────────────────────────────────────────────────────

const wss = new WebSocketServer({ server });

/**
 * Broadcast a message to a list of device ids.
 * @param {string[]} deviceIds
 * @param {object}   payload
 */
function broadcast(deviceIds, payload) {
  const msg = JSON.stringify(payload);
  for (const id of deviceIds) {
    const ws = sessions.getWs(id);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(msg);
    }
  }
}

/**
 * Broadcast the current device list to every connected device.
 */
function broadcastDevices() {
  const devices = sessions.getDevices();
  const ids = devices.map(d => d.id);
  broadcast(ids, { type: 'devices', devices });
}

/**
 * Broadcast the current playback state to every connected device.
 */
function broadcastPlayback() {
  const devices = sessions.getDevices();
  const ids = devices.map(d => d.id);
  broadcast(ids, { type: 'playback_state', state: sessions.getPlaybackState() });
}

/**
 * Broadcast the current jam state to every participant of a jam.
 * @param {string} jamCode
 */
function broadcastJam(jamCode) {
  const jam = sessions.getJamState(jamCode);
  if (!jam) return;
  broadcast(jam.deviceIds, { type: 'jam_state', jam });
}

wss.on('connection', (ws) => {
  let deviceId = null;

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
      return;
    }

    switch (msg.type) {
      // ── Registration ─────────────────────────────────────────────────────
      case 'register': {
        if (deviceId) {
          ws.send(JSON.stringify({ type: 'error', message: 'Already registered' }));
          return;
        }
        deviceId = sessions.registerDevice(msg.deviceName, msg.deviceType, ws);
        ws.send(JSON.stringify({
          type: 'registered',
          deviceId,
          playback: sessions.getPlaybackState(),
        }));
        broadcastDevices();
        break;
      }

      // ── Heartbeat ────────────────────────────────────────────────────────
      case 'heartbeat': {
        if (!deviceId) return;
        sessions.heartbeat(deviceId);
        ws.send(JSON.stringify({ type: 'heartbeat_ack' }));
        break;
      }

      // ── Playback transfer ────────────────────────────────────────────────
      case 'transfer_to': {
        if (!deviceId) return;
        const targetId = msg.deviceId;
        if (!targetId) {
          ws.send(JSON.stringify({ type: 'error', message: 'deviceId required' }));
          return;
        }
        const ok = sessions.transferTo(targetId);
        if (!ok) {
          ws.send(JSON.stringify({ type: 'error', message: 'Target device not found' }));
          return;
        }
        // Tell the new active device to start playing.
        broadcast([targetId], { type: 'become_active', playback: sessions.getPlaybackState() });
        broadcastPlayback();
        broadcastDevices();
        break;
      }

      // ── Playback control ─────────────────────────────────────────────────
      case 'control': {
        if (!deviceId) return;
        const { action, value } = msg;
        const allowedActions = ['play', 'pause', 'next', 'prev', 'seek', 'volume'];
        if (!allowedActions.includes(action)) {
          ws.send(JSON.stringify({ type: 'error', message: 'Unknown action' }));
          return;
        }
        sessions.applyControl(action, value);

        const state = sessions.getPlaybackState();
        const { activeDeviceId } = state;

        // Forward control to the active device so it can act on it.
        if (activeDeviceId) {
          broadcast([activeDeviceId], { type: 'control', action, value });
        }

        // Also propagate to jam participants if active device is in a jam.
        const activeDev = sessions.getDevice(activeDeviceId);
        if (activeDev && activeDev.jamCode) {
          sessions.applyJamControl(activeDev.jamCode, action, value);
          broadcastJam(activeDev.jamCode);
        }

        broadcastPlayback();
        break;
      }

      // ── Track update (active device reports what's playing) ──────────────
      case 'update_track': {
        if (!deviceId) return;
        const state = sessions.getPlaybackState();
        // Only the active device (or any jam host) may update the track.
        if (deviceId === state.activeDeviceId) {
          sessions.updateTrack(msg.track);
          broadcastPlayback();
        }
        // Also update jam track if sender is a jam host.
        const dev = sessions.getDevice(deviceId);
        if (dev && dev.jamCode) {
          const jam = sessions.getJamState(dev.jamCode);
          if (jam && jam.hostDeviceId === deviceId) {
            sessions.updateJamTrack(dev.jamCode, msg.track);
            broadcastJam(dev.jamCode);
          }
        }
        break;
      }

      // ── Jam: create ──────────────────────────────────────────────────────
      case 'create_jam': {
        if (!deviceId) return;
        try {
          const { jamCode, jam } = sessions.createJam(deviceId, msg.jamName);
          ws.send(JSON.stringify({
            type: 'jam_created',
            jamCode,
            jam: sessions.getJamState(jamCode),
          }));
          broadcastDevices();
        } catch (err) {
          ws.send(JSON.stringify({ type: 'error', message: err.message }));
        }
        break;
      }

      // ── Jam: join ────────────────────────────────────────────────────────
      case 'join_jam': {
        if (!deviceId) return;
        const code = (msg.jamCode || '').toUpperCase();
        if (!code) {
          ws.send(JSON.stringify({ type: 'error', message: 'jamCode required' }));
          return;
        }
        try {
          sessions.joinJam(deviceId, code);
          const jam = sessions.getJamState(code);
          ws.send(JSON.stringify({ type: 'jam_joined', jam }));
          broadcastJam(code);
          broadcastDevices();
        } catch (err) {
          ws.send(JSON.stringify({ type: 'error', message: err.message }));
        }
        break;
      }

      // ── Jam: leave ───────────────────────────────────────────────────────
      case 'leave_jam': {
        if (!deviceId) return;
        const leftCode = sessions.leaveJam(deviceId);
        ws.send(JSON.stringify({ type: 'jam_left' }));
        if (leftCode) {
          broadcastJam(leftCode);
          broadcastDevices();
        }
        break;
      }

      // ── Jam: control (from any participant) ──────────────────────────────
      case 'jam_control': {
        if (!deviceId) return;
        const dev = sessions.getDevice(deviceId);
        if (!dev || !dev.jamCode) {
          ws.send(JSON.stringify({ type: 'error', message: 'Not in a jam session' }));
          return;
        }
        const jam = sessions.getJamState(dev.jamCode);
        if (!jam) return;
        // Only the host may control the jam.
        if (jam.hostDeviceId !== deviceId) {
          ws.send(JSON.stringify({ type: 'error', message: 'Only the host may control the jam' }));
          return;
        }
        const allowedJamActions = ['play', 'pause', 'seek'];
        if (!allowedJamActions.includes(msg.action)) {
          ws.send(JSON.stringify({ type: 'error', message: 'Unknown jam action' }));
          return;
        }
        sessions.applyJamControl(dev.jamCode, msg.action, msg.value);
        broadcastJam(dev.jamCode);
        // Forward the control command to all jam participants.
        broadcast(jam.deviceIds, { type: 'control', action: msg.action, value: msg.value });
        break;
      }

      default:
        ws.send(JSON.stringify({ type: 'error', message: `Unknown message type: ${msg.type}` }));
    }
  });

  ws.on('close', () => {
    if (!deviceId) return;
    const dev = sessions.getDevice(deviceId);
    const jamCode = dev ? dev.jamCode : null;
    sessions.removeDevice(deviceId);
    broadcastDevices();
    broadcastPlayback();
    if (jamCode) broadcastJam(jamCode);
  });

  ws.on('error', (err) => {
    console.error('WebSocket error:', err.message);
  });
});

// ─── Heartbeat pruning ────────────────────────────────────────────────────────

const pruneInterval = setInterval(() => {
  const removed = sessions.pruneStale();
  if (removed.length > 0) {
    broadcastDevices();
    broadcastPlayback();
  }
}, 30_000);

// ─── Start ────────────────────────────────────────────────────────────────────

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`ytmulti-device server running on http://localhost:${PORT}`);
  });
}

module.exports = { app, server, wss, sessions, broadcast };

// Clean up interval when server closes (important for tests).
server.on('close', () => clearInterval(pruneInterval));
