/* global WebSocket */
'use strict';

// ─── State ────────────────────────────────────────────────────────────────────

const state = {
  deviceId:    null,
  deviceName:  null,
  deviceType:  null,
  devices:     [],
  playback:    { activeDeviceId: null, isPlaying: false, volume: 100, currentTime: 0, track: null },
  jam:         null,   // JamSessionInfo or null
  ws:          null,
  seekDragging: false,
};

// ─── WebSocket connection ─────────────────────────────────────────────────────

let heartbeatTimer = null;
let progressTimer  = null;
let reconnectTimer = null;

function connect(name, type) {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${proto}//${location.host}`);
  state.ws = ws;

  ws.addEventListener('open', () => {
    clearTimeout(reconnectTimer);
    ws.send(JSON.stringify({ type: 'register', deviceName: name, deviceType: type }));
    // Send heartbeat every 20 s.
    heartbeatTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'heartbeat' }));
      }
    }, 20_000);
  });

  ws.addEventListener('message', ({ data }) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    handleMessage(msg);
  });

  ws.addEventListener('close', () => {
    clearInterval(heartbeatTimer);
    stopProgressTimer();
    showToast('Disconnected — reconnecting…', 'error');
    reconnectTimer = setTimeout(() => connect(state.deviceName, state.deviceType), 3000);
  });

  ws.addEventListener('error', () => {
    ws.close();
  });
}

function send(payload) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify(payload));
  }
}

// ─── Message handler ──────────────────────────────────────────────────────────

function handleMessage(msg) {
  switch (msg.type) {

    case 'registered':
      state.deviceId = msg.deviceId;
      state.playback = msg.playback;
      showApp();
      renderThisDevice();
      renderPlayback();
      break;

    case 'devices':
      state.devices = msg.devices;
      renderDeviceList();
      if (state.jam) renderJamDevices();
      break;

    case 'playback_state':
      state.playback = msg.state;
      renderPlayback();
      break;

    case 'become_active':
      state.playback = msg.playback;
      renderPlayback();
      showToast('This device is now the active player.', 'success');
      break;

    case 'control':
      // The server forwarded a control command to us (we are the active device).
      applyLocalControl(msg.action, msg.value);
      break;

    case 'jam_created':
      state.jam = msg.jam;
      renderJam();
      showToast(`Jam created! Share code: ${msg.jamCode}`, 'success');
      break;

    case 'jam_joined':
      state.jam = msg.jam;
      renderJam();
      showToast(`Joined jam "${msg.jam.name}"`, 'success');
      break;

    case 'jam_left':
      state.jam = null;
      renderJam();
      showToast('Left jam session.', '');
      break;

    case 'jam_state':
      state.jam = msg.jam;
      renderJamDevices();
      // If we're not the host, sync to jam state.
      if (state.jam && state.jam.hostDeviceId !== state.deviceId) {
        syncToJamState(state.jam);
      }
      break;

    case 'error':
      showToast(msg.message, 'error');
      break;

    default:
      break;
  }
}

// ─── Local playback simulation ────────────────────────────────────────────────

/**
 * Applies a control action to the local playback state representation.
 * In a real integration this would call the YouTube Music API/extension.
 */
function applyLocalControl(action, value) {
  switch (action) {
    case 'play':
      state.playback.isPlaying = true;
      startProgressTimer();
      break;
    case 'pause':
      state.playback.isPlaying = false;
      stopProgressTimer();
      break;
    case 'seek':
      if (typeof value === 'number') state.playback.currentTime = value;
      break;
    case 'volume':
      if (typeof value === 'number') {
        state.playback.volume = value;
        document.getElementById('volume-bar').value = value;
      }
      break;
    case 'next':
    case 'prev':
      state.playback.currentTime = 0;
      break;
    default:
      break;
  }
  renderPlayback();
}

function syncToJamState(jam) {
  state.playback.isPlaying  = jam.isPlaying;
  state.playback.currentTime = jam.currentTime;
  if (jam.track) state.playback.track = jam.track;
  renderPlayback();
  if (jam.isPlaying) startProgressTimer(); else stopProgressTimer();
}

// Simulate progress ticking (real app would get this from YT Music player).
function startProgressTimer() {
  stopProgressTimer();
  progressTimer = setInterval(() => {
    const { track, currentTime } = state.playback;
    const duration = track && track.duration ? track.duration : 0;
    if (duration > 0 && currentTime < duration) {
      state.playback.currentTime += 1;
      if (!state.seekDragging) updateSeekBar();
      updateTimeLabels();
    }
  }, 1000);
}

function stopProgressTimer() {
  clearInterval(progressTimer);
  progressTimer = null;
}

// ─── Rendering ────────────────────────────────────────────────────────────────

function showApp() {
  document.getElementById('overlay').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');
}

function renderThisDevice() {
  const el = document.getElementById('this-device');
  el.innerHTML = `
    <div class="this-device-name">${esc(state.deviceName)}</div>
    <div class="this-device-type">${esc(state.deviceType)}</div>
  `;
}

function renderDeviceList() {
  const list = document.getElementById('device-list');
  const others = state.devices.filter(d => d.id !== state.deviceId);
  if (others.length === 0) {
    list.innerHTML = `<li style="color:var(--text-faint);font-size:.85rem;padding:.3rem 0">No other devices connected</li>`;
    return;
  }
  list.innerHTML = others.map(d => {
    const isActive = d.id === state.playback.activeDeviceId;
    return `
      <li class="device-item${isActive ? ' active-device' : ''}" data-id="${esc(d.id)}">
        <span class="device-icon">${deviceIcon(d.type)}</span>
        <div class="device-info">
          <div class="device-name">${esc(d.name)}</div>
          <div class="device-type">${esc(d.type)}${isActive ? ' · playing' : ''}</div>
        </div>
        <button class="transfer-btn" data-id="${esc(d.id)}" title="Transfer playback here">
          ${isActive ? '▶ Active' : 'Play here'}
        </button>
      </li>`;
  }).join('');

  list.querySelectorAll('.transfer-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      send({ type: 'transfer_to', deviceId: btn.dataset.id });
    });
  });
}

function renderPlayback() {
  const { track, isPlaying, currentTime, activeDeviceId, volume } = state.playback;

  // Track info
  document.getElementById('track-title').textContent  = track ? track.title  : 'Nothing playing';
  document.getElementById('track-artist').textContent = track ? track.artist : '—';
  if (track && track.thumbnail) {
    document.getElementById('track-art').src = track.thumbnail;
  } else {
    document.getElementById('track-art').src = 'placeholder.svg';
  }

  // Active device label
  const devLabel = document.getElementById('active-device-label');
  if (activeDeviceId) {
    const dev = state.devices.find(d => d.id === activeDeviceId);
    const label = dev ? dev.name : (activeDeviceId === state.deviceId ? state.deviceName : 'Unknown');
    devLabel.textContent = `Playing on: ${label}`;
  } else {
    devLabel.textContent = '';
  }

  // Play/pause button
  document.getElementById('btn-play-pause').textContent  = isPlaying ? '⏸' : '▶';
  document.getElementById('jam-btn-play-pause').textContent = isPlaying ? '⏸' : '▶';

  // Seek bar & time
  if (!state.seekDragging) updateSeekBar();
  updateTimeLabels();

  // Volume
  document.getElementById('volume-bar').value = volume;

  // Progress timer
  if (isPlaying) startProgressTimer(); else stopProgressTimer();
}

function updateSeekBar() {
  const { track, currentTime } = state.playback;
  const duration = track && track.duration ? track.duration : 100;
  const bar = document.getElementById('seek-bar');
  bar.max   = duration;
  bar.value = currentTime;
}

function updateTimeLabels() {
  const { track, currentTime } = state.playback;
  const duration = track && track.duration ? track.duration : 0;
  document.getElementById('current-time').textContent = formatTime(currentTime);
  document.getElementById('duration').textContent     = formatTime(duration);
}

function renderJam() {
  const idle   = document.getElementById('jam-idle');
  const active = document.getElementById('jam-active');
  const badge  = document.getElementById('jam-badge');

  if (!state.jam) {
    idle.classList.remove('hidden');
    active.classList.add('hidden');
    badge.style.display = 'none';
    return;
  }

  idle.classList.add('hidden');
  active.classList.remove('hidden');
  badge.style.display = '';
  badge.textContent = state.jam.devices.length;

  document.getElementById('jam-name').textContent         = state.jam.name;
  document.getElementById('jam-code-display').textContent = state.jam.code;

  // Show host controls only if we are the host.
  const controls = document.getElementById('jam-controls');
  if (state.jam.hostDeviceId === state.deviceId) {
    controls.classList.remove('hidden');
  } else {
    controls.classList.add('hidden');
  }

  renderJamDevices();
}

function renderJamDevices() {
  if (!state.jam) return;
  const list = document.getElementById('jam-device-list');
  list.innerHTML = state.jam.devices.map(d => `
    <li class="jam-device-item">
      <span>${deviceIcon(d.type)}</span>
      <span>${esc(d.name)}</span>
      ${d.id === state.jam.hostDeviceId ? '<span class="host-badge">HOST</span>' : ''}
    </li>
  `).join('');
}

// ─── Controls wiring ──────────────────────────────────────────────────────────

document.getElementById('connect-btn').addEventListener('click', () => {
  const name = document.getElementById('device-name').value.trim() || 'My Device';
  const type = document.getElementById('device-type').value;
  state.deviceName = name;
  state.deviceType = type;
  connect(name, type);
});

document.getElementById('device-name').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.getElementById('connect-btn').click();
});

// Playback controls
document.getElementById('btn-play-pause').addEventListener('click', () => {
  const action = state.playback.isPlaying ? 'pause' : 'play';
  send({ type: 'control', action });
});
document.getElementById('btn-next').addEventListener('click', () => send({ type: 'control', action: 'next' }));
document.getElementById('btn-prev').addEventListener('click', () => send({ type: 'control', action: 'prev' }));

// Seek bar
const seekBar = document.getElementById('seek-bar');
seekBar.addEventListener('mousedown',  () => { state.seekDragging = true; });
seekBar.addEventListener('touchstart', () => { state.seekDragging = true; }, { passive: true });
seekBar.addEventListener('input', () => {
  document.getElementById('current-time').textContent = formatTime(Number(seekBar.value));
});
seekBar.addEventListener('change', () => {
  state.seekDragging = false;
  send({ type: 'control', action: 'seek', value: Number(seekBar.value) });
});

// Volume
document.getElementById('volume-bar').addEventListener('input', (e) => {
  send({ type: 'control', action: 'volume', value: Number(e.target.value) });
});

// Jam controls
document.getElementById('create-jam-btn').addEventListener('click', () => {
  send({ type: 'create_jam', jamName: `${state.deviceName}'s Jam` });
});

document.getElementById('join-jam-btn').addEventListener('click', () => {
  const code = document.getElementById('join-code').value.trim().toUpperCase();
  if (!code) { showToast('Enter a jam code first.', 'error'); return; }
  send({ type: 'join_jam', jamCode: code });
});

document.getElementById('join-code').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.getElementById('join-jam-btn').click();
});

document.getElementById('leave-jam-btn').addEventListener('click', () => {
  send({ type: 'leave_jam' });
});

document.getElementById('copy-code-btn').addEventListener('click', () => {
  const code = document.getElementById('jam-code-display').textContent;
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(code)
      .then(() => showToast('Jam code copied!', 'success'))
      .catch(() => showToast(`Code: ${code} (copy manually)`, ''));
  } else {
    // Fallback: select the code element text for manual copy.
    const el = document.getElementById('jam-code-display');
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    showToast(`Code selected: ${code} — press Ctrl+C to copy`, '');
  }
});

// Jam host controls
document.getElementById('jam-btn-play-pause').addEventListener('click', () => {
  const action = state.playback.isPlaying ? 'pause' : 'play';
  send({ type: 'jam_control', action });
});
document.getElementById('jam-btn-next').addEventListener('click', () => {
  // Jam doesn't have next/prev; forward to global control for host's device.
  send({ type: 'control', action: 'next' });
});
document.getElementById('jam-btn-prev').addEventListener('click', () => {
  send({ type: 'control', action: 'prev' });
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatTime(seconds) {
  const s = Math.floor(seconds || 0);
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

function deviceIcon(type) {
  const icons = { browser: '🌐', mobile: '📱', desktop: '💻', tv: '📺', other: '🔊' };
  return icons[type] || icons.other;
}

function esc(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function showToast(message, variant = '') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast${variant ? ` ${variant}` : ''}`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 4000);
}
