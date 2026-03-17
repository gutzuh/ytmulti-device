'use strict';

const http   = require('http');
const request = require('supertest');
const { WebSocket } = require('ws');
const { app, server, sessions, wss } = require('../server');

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Open a WebSocket to the test server and return a helper object. */
function wsConnect(address) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(address);
    const pending = [];
    const waiters  = [];

    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      // Check if any type-filtered waiter is satisfied first.
      const idx = waiters.findIndex(w => !w.type || w.type === msg.type);
      if (idx !== -1) {
        const waiter = waiters.splice(idx, 1)[0];
        clearTimeout(waiter.timer);
        waiter.resolve(msg);
      } else {
        pending.push(msg);
      }
    });

    ws.on('error', reject);

    ws.once('open', () => {
      resolve({
        ws,
        send: (payload) => ws.send(JSON.stringify(payload)),
        /**
         * Wait for the next inbound message (optionally of a specific type).
         * @param {string} [type]   If given, skip messages of other types.
         * @param {number} [timeout]
         */
        next: (type, timeout = 3000) => {
          // Allow calling as next() or next(3000) for backwards compat.
          if (typeof type === 'number') { timeout = type; type = undefined; }
          return new Promise((res, rej) => {
            // Check pending queue first.
            const idx = pending.findIndex(m => !type || m.type === type);
            if (idx !== -1) { res(pending.splice(idx, 1)[0]); return; }
            const timer = setTimeout(() =>
              rej(new Error(`WS message timeout waiting for type: ${type || 'any'}`)), timeout);
            waiters.push({ type, resolve: res, timer });
          });
        },
        /** Drain all messages currently queued without waiting. */
        drain: () => { pending.length = 0; },
        close: () => new Promise(r => { ws.once('close', r); ws.close(); }),
      });
    });
  });
}

// ─── Setup ────────────────────────────────────────────────────────────────────

let addr;

beforeAll((done) => {
  server.listen(0, '127.0.0.1', () => {
    const port = server.address().port;
    addr = `ws://127.0.0.1:${port}`;
    done();
  });
});

afterAll((done) => {
  // Close all open WebSocket connections so the server can shut down cleanly.
  wss.clients.forEach(c => c.terminate());
  server.close(done);
});

// ─── REST API ─────────────────────────────────────────────────────────────────

describe('REST API', () => {
  test('GET /api/devices returns device list', async () => {
    const res = await request(app).get('/api/devices');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.devices)).toBe(true);
  });

  test('GET /api/playback returns playback state', async () => {
    const res = await request(app).get('/api/playback');
    expect(res.status).toBe(200);
    expect(res.body.playback).toBeDefined();
    expect(typeof res.body.playback.isPlaying).toBe('boolean');
  });

  test('GET /api/jams returns jam list', async () => {
    const res = await request(app).get('/api/jams');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.jams)).toBe(true);
  });

  test('GET /api/jams/:code 404 for unknown code', async () => {
    const res = await request(app).get('/api/jams/XXXXXX');
    expect(res.status).toBe(404);
  });
});

// ─── WebSocket: registration ──────────────────────────────────────────────────

describe('WebSocket registration', () => {
  test('registered message contains deviceId', async () => {
    const client = await wsConnect(addr);
    client.send({ type: 'register', deviceName: 'Test Browser', deviceType: 'browser' });
    const msg = await client.next('registered');
    expect(msg.type).toBe('registered');
    expect(typeof msg.deviceId).toBe('string');
    await client.close();
  });

  test('registered message contains initial playback state', async () => {
    const client = await wsConnect(addr);
    client.send({ type: 'register', deviceName: 'Phone', deviceType: 'mobile' });
    const msg = await client.next('registered');
    expect(msg.type).toBe('registered');
    expect(msg.playback).toBeDefined();
    await client.close();
  });

  test('devices broadcast arrives after registration', async () => {
    const client = await wsConnect(addr);
    client.send({ type: 'register', deviceName: 'Laptop', deviceType: 'desktop' });
    await client.next('registered');
    const devMsg = await client.next('devices');
    expect(devMsg.type).toBe('devices');
    expect(Array.isArray(devMsg.devices)).toBe(true);
    await client.close();
  });

  test('double registration returns error', async () => {
    const client = await wsConnect(addr);
    client.send({ type: 'register', deviceName: 'Dev', deviceType: 'browser' });
    await client.next('registered');
    client.send({ type: 'register', deviceName: 'Dev', deviceType: 'browser' });
    const err = await client.next('error');
    expect(err.type).toBe('error');
    await client.close();
  });
});

// ─── WebSocket: heartbeat ─────────────────────────────────────────────────────

describe('WebSocket heartbeat', () => {
  test('heartbeat_ack is returned', async () => {
    const client = await wsConnect(addr);
    client.send({ type: 'register', deviceName: 'Hb', deviceType: 'browser' });
    await client.next('registered');
    client.send({ type: 'heartbeat' });
    const ack = await client.next('heartbeat_ack');
    expect(ack.type).toBe('heartbeat_ack');
    await client.close();
  });
});

// ─── WebSocket: playback control ─────────────────────────────────────────────

describe('WebSocket playback control', () => {
  test('transfer_to sets active device and broadcasts playback_state', async () => {
    const c1 = await wsConnect(addr);
    const c2 = await wsConnect(addr);

    c1.send({ type: 'register', deviceName: 'C1', deviceType: 'browser' });
    const reg1 = await c1.next('registered');

    c2.send({ type: 'register', deviceName: 'C2', deviceType: 'mobile' });
    const reg2 = await c2.next('registered');

    // Transfer playback to c2.
    c1.send({ type: 'transfer_to', deviceId: reg2.deviceId });

    // c2 should receive 'become_active'
    const becomeActive = await c2.next('become_active');
    expect(becomeActive.type).toBe('become_active');

    // Both should receive playback_state
    const ps1 = await c1.next('playback_state');
    expect(ps1.type).toBe('playback_state');
    expect(ps1.state.activeDeviceId).toBe(reg2.deviceId);

    await c1.close();
    await c2.close();
  });

  test('control play/pause broadcasts playback_state', async () => {
    const client = await wsConnect(addr);
    client.send({ type: 'register', deviceName: 'Ctrl', deviceType: 'browser' });
    await client.next('registered');

    client.send({ type: 'control', action: 'play' });
    const ps = await client.next('playback_state');
    expect(ps.type).toBe('playback_state');
    expect(ps.state.isPlaying).toBe(true);

    client.send({ type: 'control', action: 'pause' });
    const ps2 = await client.next('playback_state');
    expect(ps2.state.isPlaying).toBe(false);

    await client.close();
  });

  test('control with invalid action returns error', async () => {
    const client = await wsConnect(addr);
    client.send({ type: 'register', deviceName: 'E', deviceType: 'browser' });
    await client.next('registered');

    client.send({ type: 'control', action: 'explode' });
    const err = await client.next('error');
    expect(err.type).toBe('error');
    await client.close();
  });

  test('unknown message type returns error', async () => {
    const client = await wsConnect(addr);
    client.send({ type: 'register', deviceName: 'U', deviceType: 'browser' });
    await client.next('registered');

    client.send({ type: 'unknown_msg' });
    const err = await client.next('error');
    expect(err.type).toBe('error');
    await client.close();
  });
});

// ─── WebSocket: jam sessions ──────────────────────────────────────────────────

describe('WebSocket jam sessions', () => {
  test('create_jam returns jam_created with a code', async () => {
    const client = await wsConnect(addr);
    client.send({ type: 'register', deviceName: 'Host', deviceType: 'browser' });
    await client.next('registered');

    client.send({ type: 'create_jam', jamName: 'Test Jam' });
    const msg = await client.next('jam_created');
    expect(msg.type).toBe('jam_created');
    expect(msg.jamCode).toMatch(/^[A-Z0-9]{6}$/);
    expect(msg.jam.name).toBe('Test Jam');

    await client.close();
  });

  test('join_jam allows another device to join', async () => {
    const host  = await wsConnect(addr);
    const guest = await wsConnect(addr);

    host.send({ type: 'register', deviceName: 'JamHost', deviceType: 'browser' });
    await host.next('registered');

    guest.send({ type: 'register', deviceName: 'JamGuest', deviceType: 'mobile' });
    await guest.next('registered');

    host.send({ type: 'create_jam', jamName: 'Party' });
    const created = await host.next('jam_created');
    const code = created.jamCode;

    guest.send({ type: 'join_jam', jamCode: code });
    const joined = await guest.next('jam_joined');
    expect(joined.type).toBe('jam_joined');
    expect(joined.jam.code).toBe(code);
    expect(joined.jam.deviceIds).toContain(joined.jam.hostDeviceId);

    await host.close();
    await guest.close();
  });

  test('join_jam with invalid code returns error', async () => {
    const client = await wsConnect(addr);
    client.send({ type: 'register', deviceName: 'X', deviceType: 'browser' });
    await client.next('registered');

    client.send({ type: 'join_jam', jamCode: 'XXXXXX' });
    const err = await client.next('error');
    expect(err.type).toBe('error');
    await client.close();
  });

  test('leave_jam returns jam_left', async () => {
    const client = await wsConnect(addr);
    client.send({ type: 'register', deviceName: 'LeaveTest', deviceType: 'browser' });
    await client.next('registered');

    client.send({ type: 'create_jam', jamName: 'Temp' });
    await client.next('jam_created');

    client.send({ type: 'leave_jam' });
    const msg = await client.next('jam_left');
    expect(msg.type).toBe('jam_left');
    await client.close();
  });

  test('jam_control play/pause broadcasts jam_state to participants', async () => {
    const host  = await wsConnect(addr);
    const guest = await wsConnect(addr);

    host.send({ type: 'register', deviceName: 'JH2', deviceType: 'browser' });
    await host.next('registered');

    guest.send({ type: 'register', deviceName: 'JG2', deviceType: 'mobile' });
    await guest.next('registered');

    host.send({ type: 'create_jam', jamName: 'SyncJam' });
    const created = await host.next('jam_created');
    const code = created.jamCode;

    guest.send({ type: 'join_jam', jamCode: code });
    await guest.next('jam_joined');
    // Both host and guest receive jam_state broadcast when guest joins.
    const initialJamState = await host.next('jam_state');
    expect(initialJamState.jam.isPlaying).toBe(false); // not yet playing
    const guestInitialJamState = await guest.next('jam_state');
    expect(guestInitialJamState.jam.isPlaying).toBe(false);

    // Host sends jam_control play
    host.send({ type: 'jam_control', action: 'play' });

    // Both should receive jam_state
    const jamState = await host.next('jam_state');
    expect(jamState.type).toBe('jam_state');
    expect(jamState.jam.isPlaying).toBe(true);

    const guestJamState = await guest.next('jam_state');
    expect(guestJamState.type).toBe('jam_state');
    expect(guestJamState.jam.isPlaying).toBe(true);

    await host.close();
    await guest.close();
  });

  test('non-host jam_control is rejected', async () => {
    const host  = await wsConnect(addr);
    const guest = await wsConnect(addr);

    host.send({ type: 'register', deviceName: 'NH_Host', deviceType: 'browser' });
    await host.next('registered');

    guest.send({ type: 'register', deviceName: 'NH_Guest', deviceType: 'mobile' });
    await guest.next('registered');

    host.send({ type: 'create_jam', jamName: 'HostOnly' });
    const created = await host.next('jam_created');
    const code = created.jamCode;

    guest.send({ type: 'join_jam', jamCode: code });
    await guest.next('jam_joined');
    await host.next('jam_state'); // broadcast on guest joining

    guest.send({ type: 'jam_control', action: 'play' });
    const err = await guest.next('error');
    expect(err.type).toBe('error');

    await host.close();
    await guest.close();
  });

  test('GET /api/jams/:code returns jam after creation via WS', async () => {
    const client = await wsConnect(addr);
    client.send({ type: 'register', deviceName: 'ApiTest', deviceType: 'browser' });
    await client.next('registered');

    client.send({ type: 'create_jam', jamName: 'APIJam' });
    const created = await client.next('jam_created');
    const code = created.jamCode;

    const res = await request(app).get(`/api/jams/${code}`);
    expect(res.status).toBe(200);
    expect(res.body.jam.code).toBe(code);

    await client.close();
  });
});
