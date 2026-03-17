'use strict';

const { v4: uuidv4 } = require('uuid');

/**
 * Device types supported by the system.
 */
const DEVICE_TYPES = ['browser', 'mobile', 'desktop', 'tv', 'other'];

/**
 * How long (ms) without a heartbeat before a device is considered stale.
 */
const HEARTBEAT_TIMEOUT_MS = 30_000;

/**
 * SessionManager keeps track of connected devices, playback state,
 * and active jam sessions entirely in memory.
 *
 * The manager is intentionally framework-agnostic; the WebSocket layer
 * calls into it and handles the actual message sending.
 */
class SessionManager {
  constructor() {
    /** @type {Map<string, Device>} deviceId → Device */
    this._devices = new Map();

    /** @type {Map<string, JamSession>} jamCode → JamSession */
    this._jams = new Map();

    /** @type {PlaybackState} */
    this._playback = {
      activeDeviceId: null,
      isPlaying: false,
      volume: 100,
      currentTime: 0,
      track: null,
    };
  }

  // ─── Device registry ──────────────────────────────────────────────────────

  /**
   * Register a new device and return its generated id.
   * @param {string} name   Human-readable device name.
   * @param {string} type   One of DEVICE_TYPES.
   * @param {object} ws     WebSocket connection object (stored by reference).
   * @returns {string}      The new device id.
   */
  registerDevice(name, type, ws) {
    const deviceId = uuidv4();
    const device = {
      id: deviceId,
      name: name || 'Unknown Device',
      type: DEVICE_TYPES.includes(type) ? type : 'other',
      ws,
      lastSeen: Date.now(),
      jamCode: null,
    };
    this._devices.set(deviceId, device);
    return deviceId;
  }

  /**
   * Remove a device (e.g. on disconnect).  If the device was the active
   * player its slot is cleared.  If it was in a jam it is removed from there.
   * @param {string} deviceId
   */
  removeDevice(deviceId) {
    const device = this._devices.get(deviceId);
    if (!device) return;

    if (device.jamCode) {
      this._removeFromJam(deviceId, device.jamCode);
    }

    if (this._playback.activeDeviceId === deviceId) {
      this._playback.activeDeviceId = null;
      this._playback.isPlaying = false;
    }

    this._devices.delete(deviceId);
  }

  /**
   * Update the last-seen timestamp for heartbeat tracking.
   * @param {string} deviceId
   */
  heartbeat(deviceId) {
    const device = this._devices.get(deviceId);
    if (device) device.lastSeen = Date.now();
  }

  /**
   * Return all devices as plain objects (no ws reference).
   * @returns {DeviceInfo[]}
   */
  getDevices() {
    return Array.from(this._devices.values()).map(this._deviceInfo);
  }

  /**
   * Return a single device info object.
   * @param {string} deviceId
   * @returns {DeviceInfo|null}
   */
  getDevice(deviceId) {
    const d = this._devices.get(deviceId);
    return d ? this._deviceInfo(d) : null;
  }

  // ─── Playback control ─────────────────────────────────────────────────────

  /**
   * Transfer active playback to the given device.
   * @param {string} deviceId
   * @returns {boolean}  false if the device doesn't exist.
   */
  transferTo(deviceId) {
    if (!this._devices.has(deviceId)) return false;
    this._playback.activeDeviceId = deviceId;
    return true;
  }

  /**
   * Apply a playback control action (originated from any device).
   * @param {string} action  'play'|'pause'|'next'|'prev'|'seek'|'volume'
   * @param {*}      value   Numeric value for seek/volume.
   */
  applyControl(action, value) {
    switch (action) {
      case 'play':
        this._playback.isPlaying = true;
        break;
      case 'pause':
        this._playback.isPlaying = false;
        break;
      case 'seek':
        if (typeof value === 'number' && value >= 0) {
          this._playback.currentTime = value;
        }
        break;
      case 'volume':
        if (typeof value === 'number' && value >= 0 && value <= 100) {
          this._playback.volume = value;
        }
        break;
      case 'next':
      case 'prev':
        // Track navigation is handled by the active device; we just reset time.
        this._playback.currentTime = 0;
        break;
      default:
        break;
    }
  }

  /**
   * Update current track information (sent by the active device).
   * @param {TrackInfo} track
   */
  updateTrack(track) {
    this._playback.track = track || null;
  }

  /**
   * Get a snapshot of the current playback state.
   * @returns {PlaybackState}
   */
  getPlaybackState() {
    return { ...this._playback };
  }

  // ─── Jam sessions ─────────────────────────────────────────────────────────

  /**
   * Create a new jam session.
   * @param {string} hostDeviceId  The device that creates the jam.
   * @param {string} [jamName]     Optional display name.
   * @returns {{ jamCode: string, jam: JamSession }}
   */
  createJam(hostDeviceId, jamName) {
    const host = this._devices.get(hostDeviceId);
    if (!host) throw new Error('Device not found');

    // Leave any existing jam first.
    if (host.jamCode) {
      this._removeFromJam(hostDeviceId, host.jamCode);
    }

    const jamCode = this._generateJamCode();
    const jam = {
      code: jamCode,
      name: jamName || `${host.name}'s Jam`,
      hostDeviceId,
      deviceIds: new Set([hostDeviceId]),
      isPlaying: false,
      currentTime: 0,
      track: null,
      startedAt: Date.now(),
    };
    this._jams.set(jamCode, jam);
    host.jamCode = jamCode;
    return { jamCode, jam };
  }

  /**
   * Join an existing jam session.
   * @param {string} deviceId
   * @param {string} jamCode
   * @returns {JamSession}
   */
  joinJam(deviceId, jamCode) {
    const device = this._devices.get(deviceId);
    if (!device) throw new Error('Device not found');

    const jam = this._jams.get(jamCode);
    if (!jam) throw new Error('Jam session not found');

    // Leave any existing jam first.
    if (device.jamCode && device.jamCode !== jamCode) {
      this._removeFromJam(deviceId, device.jamCode);
    }

    jam.deviceIds.add(deviceId);
    device.jamCode = jamCode;
    return jam;
  }

  /**
   * Leave the current jam session.
   * @param {string} deviceId
   * @returns {string|null}  The jam code that was left, or null.
   */
  leaveJam(deviceId) {
    const device = this._devices.get(deviceId);
    if (!device || !device.jamCode) return null;
    const jamCode = device.jamCode;
    this._removeFromJam(deviceId, jamCode);
    return jamCode;
  }

  /**
   * Apply a jam control action from the host device.
   * @param {string} jamCode
   * @param {string} action
   * @param {*}      value
   */
  applyJamControl(jamCode, action, value) {
    const jam = this._jams.get(jamCode);
    if (!jam) return;
    switch (action) {
      case 'play':
        jam.isPlaying = true;
        break;
      case 'pause':
        jam.isPlaying = false;
        break;
      case 'seek':
        if (typeof value === 'number' && value >= 0) {
          jam.currentTime = value;
        }
        break;
      default:
        break;
    }
  }

  /**
   * Update the track for a jam session (host sets this).
   * @param {string}    jamCode
   * @param {TrackInfo} track
   */
  updateJamTrack(jamCode, track) {
    const jam = this._jams.get(jamCode);
    if (jam) jam.track = track || null;
  }

  /**
   * Return a plain-object snapshot of a jam session.
   * @param {string} jamCode
   * @returns {JamSessionInfo|null}
   */
  getJamState(jamCode) {
    const jam = this._jams.get(jamCode);
    if (!jam) return null;
    return this._jamInfo(jam);
  }

  /**
   * Return all jam sessions as plain objects.
   * @returns {JamSessionInfo[]}
   */
  getJams() {
    return Array.from(this._jams.values()).map(this._jamInfo.bind(this));
  }

  /**
   * Get the WebSocket connection for a device (used by the WS layer).
   * @param {string} deviceId
   * @returns {object|null}
   */
  getWs(deviceId) {
    const d = this._devices.get(deviceId);
    return d ? d.ws : null;
  }

  /**
   * Prune devices that haven't sent a heartbeat recently.
   * @returns {string[]}  Ids of removed devices.
   */
  pruneStale() {
    const now = Date.now();
    const removed = [];
    for (const [id, device] of this._devices) {
      if (now - device.lastSeen > HEARTBEAT_TIMEOUT_MS) {
        this.removeDevice(id);
        removed.push(id);
      }
    }
    return removed;
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  /** @private */
  _removeFromJam(deviceId, jamCode) {
    const jam = this._jams.get(jamCode);
    const device = this._devices.get(deviceId);
    if (device) device.jamCode = null;
    if (!jam) return;

    jam.deviceIds.delete(deviceId);

    if (jam.deviceIds.size === 0) {
      // Empty jam — clean it up.
      this._jams.delete(jamCode);
      return;
    }

    // If the host left, promote another participant.
    if (jam.hostDeviceId === deviceId) {
      jam.hostDeviceId = [...jam.deviceIds][0];
    }
  }

  /** @private */
  _deviceInfo(device) {
    return {
      id: device.id,
      name: device.name,
      type: device.type,
      jamCode: device.jamCode,
      lastSeen: device.lastSeen,
    };
  }

  /** @private */
  _jamInfo(jam) {
    return {
      code: jam.code,
      name: jam.name,
      hostDeviceId: jam.hostDeviceId,
      deviceIds: [...jam.deviceIds],
      devices: [...jam.deviceIds].map(id => this.getDevice(id)).filter(Boolean),
      isPlaying: jam.isPlaying,
      currentTime: jam.currentTime,
      track: jam.track,
      startedAt: jam.startedAt,
    };
  }

  /** @private */
  _generateJamCode() {
    // Exclude visually ambiguous characters (0/O, 1/I) to make codes easier to read and share.
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code;
    do {
      code = Array.from({ length: 6 }, () =>
        chars[Math.floor(Math.random() * chars.length)]
      ).join('');
    } while (this._jams.has(code));
    return code;
  }
}

module.exports = { SessionManager, DEVICE_TYPES, HEARTBEAT_TIMEOUT_MS };

/**
 * @typedef {object} Device
 * @property {string}  id
 * @property {string}  name
 * @property {string}  type
 * @property {object}  ws
 * @property {number}  lastSeen
 * @property {string|null} jamCode
 */

/**
 * @typedef {object} DeviceInfo
 * @property {string}      id
 * @property {string}      name
 * @property {string}      type
 * @property {string|null} jamCode
 * @property {number}      lastSeen
 */

/**
 * @typedef {object} PlaybackState
 * @property {string|null} activeDeviceId
 * @property {boolean}     isPlaying
 * @property {number}      volume
 * @property {number}      currentTime
 * @property {TrackInfo|null} track
 */

/**
 * @typedef {object} TrackInfo
 * @property {string} title
 * @property {string} artist
 * @property {string} [album]
 * @property {string} [thumbnail]
 * @property {number} [duration]
 */

/**
 * @typedef {object} JamSession
 * @property {string}      code
 * @property {string}      name
 * @property {string}      hostDeviceId
 * @property {Set<string>} deviceIds
 * @property {boolean}     isPlaying
 * @property {number}      currentTime
 * @property {TrackInfo|null} track
 * @property {number}      startedAt
 */

/**
 * @typedef {object} JamSessionInfo
 * @property {string}      code
 * @property {string}      name
 * @property {string}      hostDeviceId
 * @property {string[]}    deviceIds
 * @property {DeviceInfo[]} devices
 * @property {boolean}     isPlaying
 * @property {number}      currentTime
 * @property {TrackInfo|null} track
 * @property {number}      startedAt
 */
