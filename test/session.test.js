'use strict';

const { SessionManager, HEARTBEAT_TIMEOUT_MS } = require('../server/session');

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Minimal fake WebSocket */
function fakeWs() {
  return {
    readyState: 1, // OPEN
    messages: [],
    send(msg) { this.messages.push(JSON.parse(msg)); },
  };
}

// ─── SessionManager unit tests ────────────────────────────────────────────────

describe('SessionManager', () => {

  describe('Device registration', () => {
    test('registers a device and returns a UUID', () => {
      const sm = new SessionManager();
      const ws = fakeWs();
      const id = sm.registerDevice('Laptop', 'desktop', ws);
      expect(typeof id).toBe('string');
      expect(id).toMatch(/^[0-9a-f-]{36}$/);
    });

    test('getDevice returns info without ws reference', () => {
      const sm = new SessionManager();
      const ws = fakeWs();
      const id = sm.registerDevice('Phone', 'mobile', ws);
      const info = sm.getDevice(id);
      expect(info).not.toBeNull();
      expect(info.id).toBe(id);
      expect(info.name).toBe('Phone');
      expect(info.type).toBe('mobile');
      expect(info.ws).toBeUndefined();
    });

    test('unknown device type defaults to "other"', () => {
      const sm = new SessionManager();
      const id = sm.registerDevice('Gadget', 'smartfridge', fakeWs());
      expect(sm.getDevice(id).type).toBe('other');
    });

    test('getDevices returns all registered devices', () => {
      const sm = new SessionManager();
      sm.registerDevice('A', 'browser', fakeWs());
      sm.registerDevice('B', 'mobile', fakeWs());
      expect(sm.getDevices()).toHaveLength(2);
    });

    test('removeDevice cleans up device', () => {
      const sm = new SessionManager();
      const id = sm.registerDevice('X', 'browser', fakeWs());
      sm.removeDevice(id);
      expect(sm.getDevice(id)).toBeNull();
      expect(sm.getDevices()).toHaveLength(0);
    });

    test('getWs returns the ws object for a registered device', () => {
      const sm = new SessionManager();
      const ws = fakeWs();
      const id = sm.registerDevice('Y', 'browser', ws);
      expect(sm.getWs(id)).toBe(ws);
    });
  });

  // ─── Playback ──────────────────────────────────────────────────────────────

  describe('Playback state', () => {
    test('initial playback state is idle', () => {
      const sm = new SessionManager();
      const state = sm.getPlaybackState();
      expect(state.activeDeviceId).toBeNull();
      expect(state.isPlaying).toBe(false);
      expect(state.volume).toBe(100);
      expect(state.track).toBeNull();
    });

    test('transferTo sets activeDeviceId', () => {
      const sm = new SessionManager();
      const id = sm.registerDevice('TV', 'tv', fakeWs());
      expect(sm.transferTo(id)).toBe(true);
      expect(sm.getPlaybackState().activeDeviceId).toBe(id);
    });

    test('transferTo returns false for unknown device', () => {
      const sm = new SessionManager();
      expect(sm.transferTo('bad-id')).toBe(false);
    });

    test('applyControl play sets isPlaying=true', () => {
      const sm = new SessionManager();
      sm.applyControl('play');
      expect(sm.getPlaybackState().isPlaying).toBe(true);
    });

    test('applyControl pause sets isPlaying=false', () => {
      const sm = new SessionManager();
      sm.applyControl('play');
      sm.applyControl('pause');
      expect(sm.getPlaybackState().isPlaying).toBe(false);
    });

    test('applyControl seek updates currentTime', () => {
      const sm = new SessionManager();
      sm.applyControl('seek', 42);
      expect(sm.getPlaybackState().currentTime).toBe(42);
    });

    test('applyControl seek ignores negative values', () => {
      const sm = new SessionManager();
      sm.applyControl('seek', -5);
      expect(sm.getPlaybackState().currentTime).toBe(0);
    });

    test('applyControl volume clamps to [0,100]', () => {
      const sm = new SessionManager();
      sm.applyControl('volume', 60);
      expect(sm.getPlaybackState().volume).toBe(60);
      sm.applyControl('volume', 150);
      expect(sm.getPlaybackState().volume).toBe(60); // unchanged
      sm.applyControl('volume', -10);
      expect(sm.getPlaybackState().volume).toBe(60); // unchanged
    });

    test('updateTrack sets track info', () => {
      const sm = new SessionManager();
      const track = { title: 'Song', artist: 'Artist' };
      sm.updateTrack(track);
      expect(sm.getPlaybackState().track).toEqual(track);
    });

    test('removeDevice clears activeDeviceId if it was the active device', () => {
      const sm = new SessionManager();
      const id = sm.registerDevice('A', 'browser', fakeWs());
      sm.transferTo(id);
      sm.removeDevice(id);
      expect(sm.getPlaybackState().activeDeviceId).toBeNull();
    });
  });

  // ─── Jam sessions ──────────────────────────────────────────────────────────

  describe('Jam sessions', () => {
    test('createJam returns a 6-character code and adds host', () => {
      const sm = new SessionManager();
      const hostId = sm.registerDevice('Host', 'browser', fakeWs());
      const { jamCode, jam } = sm.createJam(hostId, 'My Jam');
      expect(jamCode).toMatch(/^[A-Z0-9]{6}$/);
      expect(jam.hostDeviceId).toBe(hostId);
      expect(jam.deviceIds).toContain(hostId);
      expect(jam.name).toBe('My Jam');
    });

    test('createJam throws if device not found', () => {
      const sm = new SessionManager();
      expect(() => sm.createJam('ghost')).toThrow('Device not found');
    });

    test('joinJam adds participant to jam', () => {
      const sm = new SessionManager();
      const hostId   = sm.registerDevice('Host',  'browser', fakeWs());
      const guestId  = sm.registerDevice('Guest', 'mobile',  fakeWs());
      const { jamCode } = sm.createJam(hostId, 'Cool Jam');
      sm.joinJam(guestId, jamCode);
      const info = sm.getJamState(jamCode);
      expect(info.deviceIds).toContain(guestId);
      expect(info.devices).toHaveLength(2);
    });

    test('joinJam throws for unknown jam code', () => {
      const sm = new SessionManager();
      const id = sm.registerDevice('X', 'browser', fakeWs());
      expect(() => sm.joinJam(id, 'BADCOD')).toThrow('Jam session not found');
    });

    test('leaveJam removes participant', () => {
      const sm = new SessionManager();
      const hostId  = sm.registerDevice('Host',  'browser', fakeWs());
      const guestId = sm.registerDevice('Guest', 'mobile',  fakeWs());
      const { jamCode } = sm.createJam(hostId);
      sm.joinJam(guestId, jamCode);
      sm.leaveJam(guestId);
      const info = sm.getJamState(jamCode);
      expect(info.deviceIds).not.toContain(guestId);
    });

    test('jam is deleted when last member leaves', () => {
      const sm = new SessionManager();
      const id = sm.registerDevice('Solo', 'browser', fakeWs());
      const { jamCode } = sm.createJam(id);
      sm.leaveJam(id);
      expect(sm.getJamState(jamCode)).toBeNull();
    });

    test('host is reassigned when host leaves', () => {
      const sm = new SessionManager();
      const hostId  = sm.registerDevice('Host',  'browser', fakeWs());
      const guestId = sm.registerDevice('Guest', 'mobile',  fakeWs());
      const { jamCode } = sm.createJam(hostId);
      sm.joinJam(guestId, jamCode);
      sm.leaveJam(hostId);
      const info = sm.getJamState(jamCode);
      expect(info.hostDeviceId).toBe(guestId);
    });

    test('applyJamControl updates jam state', () => {
      const sm = new SessionManager();
      const id = sm.registerDevice('Host', 'browser', fakeWs());
      const { jamCode } = sm.createJam(id);
      sm.applyJamControl(jamCode, 'play');
      expect(sm.getJamState(jamCode).isPlaying).toBe(true);
      sm.applyJamControl(jamCode, 'seek', 30);
      expect(sm.getJamState(jamCode).currentTime).toBe(30);
      sm.applyJamControl(jamCode, 'pause');
      expect(sm.getJamState(jamCode).isPlaying).toBe(false);
    });

    test('updateJamTrack sets jam track', () => {
      const sm = new SessionManager();
      const id = sm.registerDevice('Host', 'browser', fakeWs());
      const { jamCode } = sm.createJam(id);
      const track = { title: 'Jam Song', artist: 'Band' };
      sm.updateJamTrack(jamCode, track);
      expect(sm.getJamState(jamCode).track).toEqual(track);
    });

    test('getJams returns all active jam sessions', () => {
      const sm = new SessionManager();
      const id1 = sm.registerDevice('H1', 'browser', fakeWs());
      const id2 = sm.registerDevice('H2', 'browser', fakeWs());
      sm.createJam(id1, 'Jam 1');
      sm.createJam(id2, 'Jam 2');
      expect(sm.getJams()).toHaveLength(2);
    });

    test('device jamCode is cleared after leaving', () => {
      const sm = new SessionManager();
      const id = sm.registerDevice('Host', 'browser', fakeWs());
      const { jamCode } = sm.createJam(id);
      expect(sm.getDevice(id).jamCode).toBe(jamCode);
      sm.leaveJam(id);
      // jam was deleted (solo), but device should have null jamCode
      // device is still registered
      expect(sm.getDevice(id).jamCode).toBeNull();
    });
  });

  // ─── Heartbeat / pruning ───────────────────────────────────────────────────

  describe('Heartbeat / pruning', () => {
    test('heartbeat updates lastSeen', () => {
      const sm = new SessionManager();
      const id = sm.registerDevice('D', 'browser', fakeWs());
      const before = sm.getDevice(id).lastSeen;
      // Advance time slightly.
      jest.useFakeTimers();
      jest.advanceTimersByTime(1000);
      sm.heartbeat(id);
      const after = sm.getDevice(id).lastSeen;
      expect(after).toBeGreaterThan(before);
      jest.useRealTimers();
    });

    test('pruneStale removes devices past timeout', () => {
      jest.useFakeTimers();
      const sm = new SessionManager();
      sm.registerDevice('Old', 'browser', fakeWs());
      jest.advanceTimersByTime(HEARTBEAT_TIMEOUT_MS + 1000);
      const removed = sm.pruneStale();
      expect(removed).toHaveLength(1);
      expect(sm.getDevices()).toHaveLength(0);
      jest.useRealTimers();
    });

    test('pruneStale does not remove fresh devices', () => {
      jest.useFakeTimers();
      const sm = new SessionManager();
      sm.registerDevice('Fresh', 'browser', fakeWs());
      jest.advanceTimersByTime(1000);
      const removed = sm.pruneStale();
      expect(removed).toHaveLength(0);
      expect(sm.getDevices()).toHaveLength(1);
      jest.useRealTimers();
    });
  });
});
