/* global YT */
'use strict';

// ─── State ─────────────────────────────────────────────────────────────────
const state = {
  deviceId:   null,
  deviceName: null,
  ws:         null,
  room: { videoId: null, isPlaying: false, currentTime: 0, track: null },
  jam:  null,   // { code, name, hostId, deviceIds, videoId, isPlaying, currentTime, track }
  devices: [],
  queue: [], queueIndex: -1,
  volume: 90,
  seekDragging: false,
  playerOpen: false,
};

// ─── YouTube Player ─────────────────────────────────────────────────────────
let yt = null, ytReady = false, progressTimer = null, suppress = false, lastVideoId = null;

window.onYouTubeIframeAPIReady = () => {
  yt = new YT.Player('yt-player', {
    height: '1', width: '1',
    playerVars: { autoplay: 0, controls: 0, disablekb: 1, rel: 0, playsinline: 1, iv_load_policy: 3 },
    events: { onReady: () => { ytReady = true; yt.setVolume(state.volume); }, onStateChange: onYTState },
  });
};

function onYTState(e) {
  if (suppress) return;
  const s = e.data;
  if (s === YT.PlayerState.PLAYING) {
    state.room.isPlaying = true;
    startTick(); updatePlayUI();
    setTimeout(reportMeta, 1400);
  } else if (s === YT.PlayerState.PAUSED) {
    state.room.isPlaying = false; stopTick(); updatePlayUI();
  } else if (s === YT.PlayerState.ENDED) {
    state.room.isPlaying = false; stopTick(); updatePlayUI();
    handleNext();
  }
}

function reportMeta() {
  if (!yt || !ytReady) return;
  const d = yt.getVideoData();
  if (!d?.video_id) return;
  const track = {
    title: d.title || 'Unknown', artist: d.author || 'YouTube',
    thumbnail: `https://i.ytimg.com/vi/${d.video_id}/hqdefault.jpg`,
    duration: Math.floor(yt.getDuration() || 0), videoId: d.video_id,
  };
  state.room.track = track;
  updateTrackUI();
  send({ type: 'update_track', track });
}

// ─── Room sync ────────────────────────────────────────────────────────────────
function applyRoom(room, doSeek = true) {
  state.room = { ...state.room, ...room };
  if (!yt || !ytReady) return;

  const needLoad = room.videoId && room.videoId !== lastVideoId;
  if (needLoad) {
    lastVideoId = room.videoId;
    const start = doSeek && room.currentTime > 2 ? Math.floor(room.currentTime) : 0;
    suppress = true;
    yt.loadVideoById({ videoId: room.videoId, startSeconds: start });
    suppress = false;
    setTimeout(() => { if (!yt || !ytReady) return; room.isPlaying ? yt.playVideo() : yt.pauseVideo(); }, 900);
  } else if (room.videoId) {
    const ps = yt.getPlayerState();
    if (doSeek && typeof room.currentTime === 'number') {
      const diff = Math.abs((yt.getCurrentTime() || 0) - room.currentTime);
      if (diff > 3) { suppress = true; yt.seekTo(room.currentTime, true); suppress = false; }
    }
    if (room.isPlaying && ps !== YT.PlayerState.PLAYING) yt.playVideo();
    else if (!room.isPlaying && ps === YT.PlayerState.PLAYING) yt.pauseVideo();
  }

  updateTrackUI(); updatePlayUI();
  room.isPlaying ? startTick() : stopTick();
}

// ─── Queue ─────────────────────────────────────────────────────────────────
function playItem(item, idx) {
  state.queueIndex = idx;
  const track = { title: item.title, artist: item.author || item.artist || '', thumbnail: item.thumbnail, duration: item.duration || 0, videoId: item.videoId };
  state.room.track = track; state.room.videoId = item.videoId; state.room.currentTime = 0;
  lastVideoId = item.videoId;
  updateTrackUI(); renderQueue();
  send({ type: 'load_video', videoId: item.videoId, track });
  if (yt && ytReady) yt.loadVideoById(item.videoId);
  showMiniPlayer();
}

function addAndPlay(item) {
  if (!state.queue.find(q => q.videoId === item.videoId)) state.queue.push(item);
  const idx = state.queue.findIndex(q => q.videoId === item.videoId);
  playItem(state.queue[idx], idx);
  toast(`▶ ${item.title}`, 'success');
}

function addToQ(item) {
  if (state.queue.find(q => q.videoId === item.videoId)) { toast('Já na fila', ''); return; }
  state.queue.push(item);
  renderQueue();
  toast(`+ ${item.title}`, 'success');
  if (!state.room.videoId) playItem(state.queue[state.queue.length - 1], state.queue.length - 1);
}

function removeFromQ(idx) {
  state.queue.splice(idx, 1);
  if (!state.queue.length) state.queueIndex = -1;
  else if (idx < state.queueIndex) state.queueIndex--;
  renderQueue();
}

function handleNext() {
  if (!state.queue.length) return;
  const n = state.queueIndex < 0 ? 0 : state.queueIndex + 1;
  if (n < state.queue.length) playItem(state.queue[n], n);
  else { state.queueIndex = -1; renderQueue(); }
  send({ type: 'queue_next' });
}

function handlePrev() {
  if (!state.queue.length) return;
  const p = Math.max(0, state.queueIndex - 1);
  playItem(state.queue[p], p);
  send({ type: 'queue_prev' });
}

function handlePlayPause() {
  if (!state.room.videoId) return;
  const action = state.room.isPlaying ? 'pause' : 'play';
  send({ type: 'control', action });
  if (yt && ytReady) action === 'play' ? yt.playVideo() : yt.pauseVideo();
}

// ─── Progress tick ────────────────────────────────────────────────────────────
function startTick() {
  stopTick();
  progressTimer = setInterval(() => {
    if (!yt || !ytReady) return;
    const t = yt.getCurrentTime() || 0;
    state.room.currentTime = t;
    if (!state.seekDragging) updateSeek(t);
  }, 400);
}
function stopTick() { clearInterval(progressTimer); progressTimer = null; }

function updateSeek(t) {
  const dur = getDur();
  const pct = dur > 0 ? (t / dur) * 100 : 0;
  const fmt = fmtTime;
  $('player-current').textContent = fmt(t);
  $('player-duration').textContent = fmt(dur);
  $('player-seek-bar').value = t;
  $('player-seek-bar').max = dur;
  $('player-seek-fill').style.width = `${pct}%`;
  $('mini-progress-fill').style.width = `${pct}%`;
}

function getDur() {
  if (yt && ytReady) { const d = yt.getDuration(); if (d > 0) return Math.floor(d); }
  return state.room.track?.duration || 0;
}

// ─── WebSocket ────────────────────────────────────────────────────────────────
let hbTimer = null, reconTimer = null;

function connect(name, type) {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${proto}//${location.host}`);
  state.ws = ws;
  ws.onopen = () => {
    clearTimeout(reconTimer);
    ws.send(JSON.stringify({ type: 'register', deviceName: name, deviceType: type }));
    hbTimer = setInterval(() => ws.readyState === 1 && ws.send(JSON.stringify({ type: 'heartbeat' })), 20_000);
  };
  ws.onmessage = ({ data }) => { try { handleMsg(JSON.parse(data)); } catch {} };
  ws.onclose = () => {
    clearInterval(hbTimer); stopTick();
    toast('Desconectado — reconectando…', 'error');
    reconTimer = setTimeout(() => connect(state.deviceName, state.deviceType), 3000);
  };
  ws.onerror = () => ws.close();
}

function send(p) { if (state.ws?.readyState === 1) state.ws.send(JSON.stringify(p)); }

function handleMsg(m) {
  switch (m.type) {
    case 'registered':
      state.deviceId = m.deviceId;
      if (m.room?.videoId) { applyRoom(m.room, true); showMiniPlayer(); }
      showApp();
      renderThisDevice();
      loadTrending();
      break;
    case 'devices':
      state.devices = m.devices;
      renderDevices();
      renderHomeListeners();
      renderPlayerListeners();
      break;
    case 'room_state':
      applyRoom(m.room, true);
      if (m.room.videoId) showMiniPlayer();
      break;
    case 'track_updated':
      state.room.track = m.track; updateTrackUI(); break;
    case 'control':
      if (m.action === 'volume' && yt && ytReady) { yt.setVolume(m.value); $('player-volume').value = m.value; } break;
    case 'queue_next': handleNext(); break;
    case 'queue_prev': handlePrev(); break;
    case 'jam_created':
    case 'jam_joined':
      state.jam = m.jam;
      renderJam();
      applyRoom({ videoId: m.jam.videoId, isPlaying: m.jam.isPlaying, currentTime: m.jam.currentTime, track: m.jam.track }, true);
      toast(`Jam "${m.jam.name}" — você está dentro!`, 'success');
      break;
    case 'jam_state':
      state.jam = m.jam;
      renderJam();
      applyRoom({ videoId: m.jam.videoId, isPlaying: m.jam.isPlaying, currentTime: m.jam.currentTime, track: m.jam.track }, true);
      break;
    case 'jam_left':
      state.jam = null; renderJam();
      applyRoom(state.room, false);
      toast('Saiu da jam', '');
      break;
    case 'error':
      toast(m.message, 'error'); break;
  }
}

// ─── Search ───────────────────────────────────────────────────────────────────
let sugTimer = null;
let recentSearches = JSON.parse(localStorage.getItem('yt_recent') || '[]');

function saveRecent(q) {
  recentSearches = [q, ...recentSearches.filter(r => r !== q)].slice(0, 10);
  localStorage.setItem('yt_recent', JSON.stringify(recentSearches));
  renderRecent();
}

function setupSearch() {
  const inp = $('search-input');
  const clr = $('search-clear');
  const sug = $('search-suggestions');
  const rec = $('search-recent');
  const res = $('search-results');

  inp.addEventListener('focus', () => { renderRecent(); if (!inp.value) rec.classList.remove('hidden'); });
  inp.addEventListener('input', () => {
    const q = inp.value.trim();
    clr.classList.toggle('hidden', !q);
    if (!q) { sug.classList.add('hidden'); res.classList.add('hidden'); rec.classList.remove('hidden'); return; }
    rec.classList.add('hidden');
    clearTimeout(sugTimer);
    sugTimer = setTimeout(() => fetchSuggestions(q), 220);
  });
  inp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { const q = inp.value.trim(); if (q) doSearch(q); }
    if (e.key === 'Escape') { inp.value = ''; clr.classList.add('hidden'); sug.classList.add('hidden'); res.classList.add('hidden'); rec.classList.remove('hidden'); }
  });
  clr.addEventListener('click', () => { inp.value = ''; clr.classList.add('hidden'); sug.classList.add('hidden'); res.classList.add('hidden'); rec.classList.remove('hidden'); inp.focus(); });
}

async function fetchSuggestions(q) {
  try {
    const r = await fetch(`/api/suggest?q=${encodeURIComponent(q)}`);
    const { suggestions } = await r.json();
    renderSuggestions(q, suggestions || []);
  } catch {}
}

function renderSuggestions(q, sugs) {
  const el = $('search-suggestions');
  if (!sugs.length) { el.classList.add('hidden'); return; }
  el.innerHTML = sugs.map(s => `
    <div class="suggestion-item" onclick="doSearch(${JSON.stringify(s)})">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
      <span>${esc(s)}</span>
    </div>`).join('');
  el.classList.remove('hidden');
}

async function doSearch(q) {
  $('search-input').value = q;
  $('search-clear').classList.remove('hidden');
  $('search-suggestions').classList.add('hidden');
  $('search-recent').classList.add('hidden');
  saveRecent(q);

  const vid = extractVideoId(q);
  if (vid) { addToQ({ videoId: vid, title: 'YouTube Video', author: '', thumbnail: `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`, duration: 0 }); return; }

  const res = $('search-results');
  res.classList.remove('hidden');
  res.innerHTML = '<div style="color:var(--txt3);padding:1.2rem;text-align:center">Buscando…</div>';

  try {
    const r = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
    const { results, error } = await r.json();
    if (error) { res.innerHTML = `<div style="color:var(--red);padding:1rem">${esc(error)}</div>`; return; }
    res.innerHTML = (results || []).map((v, i) => `
      <div class="result-item" data-i="${i}">
        <img src="${esc(v.thumbnail)}" class="result-thumb" loading="lazy" alt="" />
        <div class="result-info">
          <div class="result-title">${esc(v.title)}</div>
          <div class="result-meta">${esc(v.author)} · ${fmtTime(v.duration)}</div>
        </div>
        <button class="result-add" data-i="${i}">+</button>
      </div>`).join('');

    // Wire clicks — stored in closure
    const vids = results || [];
    res.querySelectorAll('.result-item').forEach(el => {
      el.addEventListener('click', e => { if (e.target.closest('.result-add')) return; addAndPlay(vids[+el.dataset.i]); });
    });
    res.querySelectorAll('.result-add').forEach(btn => {
      btn.addEventListener('click', e => { e.stopPropagation(); addToQ(vids[+btn.dataset.i]); });
    });
  } catch { res.innerHTML = '<div style="color:var(--red);padding:1rem">Falha na busca.</div>'; }
}

function renderRecent() {
  const el = $('recent-list');
  if (!recentSearches.length) { el.innerHTML = '<div style="color:var(--txt3);font-size:.8rem">Nenhuma busca recente</div>'; return; }
  el.innerHTML = recentSearches.map(q => `
    <div class="recent-item" onclick="doSearch(${JSON.stringify(q)})">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--txt3)" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
      <span class="recent-q">${esc(q)}</span>
      <button class="recent-remove" onclick="event.stopPropagation();removeRecent(${JSON.stringify(q)})">✕</button>
    </div>`).join('');
}

function removeRecent(q) { recentSearches = recentSearches.filter(r => r !== q); localStorage.setItem('yt_recent', JSON.stringify(recentSearches)); renderRecent(); }

function extractVideoId(input) {
  try { const u = new URL(input); if (u.hostname.includes('youtu')) return u.searchParams.get('v') || u.pathname.slice(1); } catch {}
  if (/^[A-Za-z0-9_-]{11}$/.test(input)) return input;
  return null;
}

// ─── Trending ─────────────────────────────────────────────────────────────────
async function loadTrending() {
  const el = $('trending-list');
  const ld = $('trending-loading');
  try {
    const r = await fetch('/api/trending');
    const { results } = await r.json();
    if (!results?.length) { ld.textContent = 'Em alta indisponível.'; return; }
    ld.classList.add('hidden'); el.classList.remove('hidden');
    el.innerHTML = results.map((v, i) => `
      <div class="trend-item">
        <div class="trend-rank">${i + 1}</div>
        <img src="${esc(v.thumbnail)}" class="trend-thumb" loading="lazy" alt="" />
        <div class="trend-info">
          <div class="trend-title">${esc(v.title)}</div>
          <div class="trend-author">${esc(v.author)}</div>
        </div>
        <button class="trend-add" title="Adicionar à fila">+</button>
      </div>`).join('');
    el.querySelectorAll('.trend-item').forEach((row, i) => {
      row.addEventListener('click', e => { if (e.target.closest('.trend-add')) return; addAndPlay(results[i]); });
      row.querySelector('.trend-add').addEventListener('click', e => { e.stopPropagation(); addToQ(results[i]); });
    });
  } catch { ld.textContent = 'Em alta indisponível.'; }
}

// ─── Rendering ────────────────────────────────────────────────────────────────
function showApp() {
  $('screen-connect').classList.remove('active');
  $('screen-connect').classList.add('hidden');
  $('app').classList.remove('hidden');
}

function showMiniPlayer() { $('mini-player').classList.remove('hidden'); }

function renderThisDevice() {
  $('home-greeting').textContent = `Olá, ${state.deviceName} 👋`;
  $('home-avatar').textContent = (state.deviceName || '?')[0].toUpperCase();
}

function updateTrackUI() {
  const t = state.room.track;
  const tid = t?.title || (state.room.videoId ? 'Carregando…' : 'Nada tocando');
  const art = t?.artist || t?.author || '—';
  const thumb = t?.thumbnail || '';

  // Player sheet
  $('player-title').textContent  = tid;
  $('player-artist').textContent = art;

  // Mini player
  $('mini-title').textContent  = tid;
  $('mini-artist').textContent = art;
  if (thumb) $('mini-thumb').src = thumb;

  // Home now-playing card
  $('home-now-title').textContent  = tid;
  $('home-now-artist').textContent = art;
  if (thumb) $('home-now-thumb').src = thumb;
  if (tid !== 'Nada tocando' && state.room.videoId) {
    $('home-now-playing-card').classList.remove('hidden');
  }

  // Album art
  const art2 = $('player-art');
  const ph   = $('player-art-placeholder');
  if (thumb) {
    art2.src = thumb;
    art2.onload = () => { art2.classList.add('loaded'); ph.classList.add('hidden'); updatePlayerBg(thumb); };
    art2.onerror = () => { art2.classList.remove('loaded'); ph.classList.remove('hidden'); };
  } else {
    art2.classList.remove('loaded'); ph.classList.remove('hidden');
  }
}

function updatePlayerBg(url) {
  const bg = $('player-bg');
  if (url) { bg.style.backgroundImage = `url(${url})`; }
  else bg.style.backgroundImage = '';
}

function updatePlayUI() {
  const p = state.room.isPlaying;
  // Player sheet
  $('p-icon-play').classList.toggle('hidden', p);
  $('p-icon-pause').classList.toggle('hidden', !p);
  $('p-play').classList.toggle('playing', p);
  // Mini player
  $('mini-icon-play').classList.toggle('hidden', p);
  $('mini-icon-pause').classList.toggle('hidden', !p);
  // Home card button
  $('home-now-play').textContent = p ? '⏸' : '▶';
}

function renderDevices() {
  const list = $('devices-list');
  $('device-count-badge').textContent = state.devices.length;
  list.innerHTML = state.devices.map(d => {
    const isMe = d.id === state.deviceId;
    const color = avatarColor(d.id);
    return `
      <div class="device-card">
        <div class="device-av" style="background:${color}">${(d.name||'?')[0].toUpperCase()}</div>
        <div class="device-info">
          <div class="device-name">${esc(d.name)}${isMe ? ' <span class="device-me-badge">Você</span>' : ''}</div>
          <div class="device-meta">${deviceEmoji(d.type)} ${d.type}</div>
          ${state.room.videoId ? `<div class="device-playing">🎵 Sincronizado</div>` : ''}
        </div>
      </div>`;
  }).join('');
}

function renderHomeListeners() {
  const row = $('home-listeners-row');
  $('home-listener-count').textContent = state.devices.length;
  row.innerHTML = state.devices.map(d => {
    const color = avatarColor(d.id);
    const isMe  = d.id === state.deviceId;
    return `<div class="listener-chip">
      <div class="listener-chip-av" style="background:${color}">${(d.name||'?')[0]}</div>
      <div class="listener-chip-name">${esc(d.name)}${isMe ? ' (você)' : ''}</div>
    </div>`;
  }).join('');
}

function renderPlayerListeners() {
  const others = state.devices.filter(d => d.id !== state.deviceId);
  $('player-listeners-txt').textContent = others.length ? `${others.length} ouvindo com você` : 'Só você';
  $('player-listeners-avs').innerHTML = others.slice(0, 5).map(d => {
    return `<div class="pl-av" style="background:${avatarColor(d.id)}">${(d.name||'?')[0]}</div>`;
  }).join('');
}

function renderQueue() {
  const list  = $('queue-list');
  const badge = $('queue-count-badge');
  if (!state.queue.length) {
    list.innerHTML = '<li class="queue-empty">Pesquise músicas para adicionar à fila</li>';
    badge.style.display = 'none';
    return;
  }
  badge.style.display = '';
  badge.textContent = state.queue.length;
  list.innerHTML = state.queue.map((item, i) => {
    const active = i === state.queueIndex;
    return `<li class="queue-item${active ? ' active' : ''}" data-i="${i}">
      ${active ? '<div class="queue-eq"><span></span><span></span><span></span></div>' : ''}
      <img src="${esc(item.thumbnail)}" class="queue-thumb" loading="lazy" alt="" />
      <div class="queue-info">
        <div class="queue-title">${esc(item.title)}</div>
        <div class="queue-artist">${esc(item.author||item.artist||'')} · ${fmtTime(item.duration)}</div>
      </div>
      <div class="queue-actions">
        <button class="q-btn rm" data-i="${i}" title="Remover">✕</button>
      </div>
    </li>`;
  }).join('');
  list.querySelectorAll('.queue-item').forEach(row => {
    row.addEventListener('click', e => { if (e.target.closest('.q-btn')) return; playItem(state.queue[+row.dataset.i], +row.dataset.i); });
  });
  list.querySelectorAll('.q-btn.rm').forEach(btn => {
    btn.addEventListener('click', e => { e.stopPropagation(); removeFromQ(+btn.dataset.i); });
  });
}

// ─── Jams ────────────────────────────────────────────────────────────────────
function renderJam() {
  const idle   = $('jam-idle');
  const active = $('jam-active');
  const j = state.jam;
  if (!j) { idle.classList.remove('hidden'); active.classList.add('hidden'); return; }
  idle.classList.add('hidden'); active.classList.remove('hidden');
  $('jam-active-name').textContent = j.name;
  $('jam-active-code').textContent = j.code;
  const isHost = j.hostId === state.deviceId;
  $('jam-host-badge').classList.toggle('hidden', !isHost);
  $('jam-members-list').innerHTML = (j.deviceIds || []).map(id => {
    const d = state.devices.find(x => x.id === id);
    const nm = d?.name || id.slice(0, 6);
    return `<li class="jam-member">
      <div class="jam-member-av" style="background:${avatarColor(id)}">${nm[0]}</div>
      <div class="jam-member-name">${esc(nm)}</div>
    </li>`;
  }).join('');
}

function openCreateJamModal() {
  $('modal-backdrop').classList.remove('hidden');
  $('modal-create-jam').classList.remove('hidden');
}

function closeModal(id) {
  $(id)?.classList.add('hidden');
  $('modal-backdrop').classList.add('hidden');
}

function closeAllModals() {
  document.querySelectorAll('.modal').forEach(m => m.classList.add('hidden'));
  $('modal-backdrop').classList.add('hidden');
}

// ─── Page routing ─────────────────────────────────────────────────────────────
let currentPage = 'home';

function goPage(name) {
  if (name === currentPage) return;
  document.querySelectorAll('.page').forEach(p => p.classList.add('hidden'));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  const page = document.querySelector(`[data-page="${name}"]`);
  if (page) page.classList.remove('hidden');
  const btn = document.querySelector(`.nav-btn[data-page="${name}"]`);
  if (btn) btn.classList.add('active');
  currentPage = name;
  if (name === 'search') setTimeout(() => $('search-input').focus(), 100);
}

// ─── Player sheet ─────────────────────────────────────────────────────────────
function openPlayer() {
  if (!state.room.videoId) return;
  const sheet = $('player-sheet');
  sheet.classList.remove('hidden');
  requestAnimationFrame(() => sheet.classList.add('open'));
  state.playerOpen = true;
}

function closePlayer() {
  const sheet = $('player-sheet');
  sheet.classList.remove('open');
  setTimeout(() => sheet.classList.add('hidden'), 380);
  state.playerOpen = false;
}

// ─── Seek wiring ──────────────────────────────────────────────────────────────
function setupSeek() {
  const bar   = $('player-seek-bar');
  const track = $('player-seek-track');

  track.addEventListener('click', (e) => {
    const rect = track.getBoundingClientRect();
    const pct  = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const val  = pct * getDur();
    $('player-seek-fill').style.width = `${pct * 100}%`;
    send({ type: 'control', action: 'seek', value: val });
    if (yt && ytReady) yt.seekTo(val, true);
  });

  bar.addEventListener('mousedown', () => state.seekDragging = true);
  bar.addEventListener('touchstart', () => state.seekDragging = true, { passive: true });
  bar.addEventListener('input', () => {
    const v = +bar.value, d = getDur();
    $('player-seek-fill').style.width = `${d > 0 ? (v / d) * 100 : 0}%`;
    $('player-current').textContent = fmtTime(v);
  });
  bar.addEventListener('change', () => {
    state.seekDragging = false;
    const v = +bar.value;
    send({ type: 'control', action: 'seek', value: v });
    if (yt && ytReady) yt.seekTo(v, true);
  });

  $('player-volume').addEventListener('input', (e) => {
    const v = +e.target.value;
    state.volume = v;
    if (yt && ytReady) yt.setVolume(v);
    send({ type: 'control', action: 'volume', value: v });
  });
}

// ─── Utils ─────────────────────────────────────────────────────────────────
function $(id) { return document.getElementById(id); }
function fmtTime(s) { const t = Math.floor(s || 0); return `${Math.floor(t/60)}:${String(t%60).padStart(2,'0')}`; }
function esc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function deviceEmoji(t) { return {mobile:'📱',browser:'💻',desktop:'🖥️',tv:'📺',other:'🔊'}[t]||'🔊'; }
function avatarColor(id) {
  const cs = ['#e74c3c','#e67e22','#2ecc71','#3498db','#9b59b6','#1abc9c','#f39c12','#d35400'];
  let h = 0; for (const c of (id||'')) h=(h*31+c.charCodeAt(0))&0xffffffff;
  return cs[Math.abs(h)%cs.length];
}
function toast(msg, v='') {
  const c = $('toast-container');
  const t = document.createElement('div');
  t.className = `toast${v?' '+v:''}`;
  t.textContent = msg;
  c.appendChild(t);
  setTimeout(() => t.remove(), 3600);
}

// ─── Init ──────────────────────────────────────────────────────────────────
setupSearch();
setupSeek();
renderRecent();

// Connect form
$('btn-connect').addEventListener('click', doConnect);
$('inp-name').addEventListener('keydown', e => { if (e.key === 'Enter') doConnect(); });
setTimeout(() => $('inp-name').focus(), 100);

function doConnect() {
  const name = $('inp-name').value.trim() || 'Anônimo';
  const type = $('inp-type').value;
  state.deviceName = name; state.deviceType = type;
  connect(name, type);
}

// Play/pause buttons
$('p-play').addEventListener('click', handlePlayPause);
$('p-prev').addEventListener('click', handlePrev);
$('p-next').addEventListener('click', handleNext);

// Jam buttons
$('jam-create-card').addEventListener('click', openCreateJamModal);
$('btn-create-jam-confirm').addEventListener('click', () => {
  const name = $('jam-name-inp').value.trim() || 'Jam Session';
  const pass = $('jam-pass-inp').value.trim();
  send({ type: 'create_jam', jamName: name, password: pass || null });
  closeModal('modal-create-jam');
});
$('btn-join-jam').addEventListener('click', () => {
  const code = $('jam-code-input').value.trim().toUpperCase();
  const pass = $('jam-password-join').value.trim();
  if (!code) { toast('Insira o código da jam', 'error'); return; }
  send({ type: 'join_jam', code, password: pass });
});
$('btn-leave-jam').addEventListener('click', () => { send({ type: 'leave_jam' }); });
$('btn-copy-code').addEventListener('click', () => {
  if (state.jam?.code) { navigator.clipboard?.writeText(state.jam.code).then(() => toast('Código copiado!', 'success')); }
});

// Player sheet swipe to close (touch)
let touchY0 = 0;
$('player-sheet').addEventListener('touchstart', e => { touchY0 = e.touches[0].clientY; }, { passive: true });
$('player-sheet').addEventListener('touchend', e => {
  const dy = e.changedTouches[0].clientY - touchY0;
  if (dy > 80) closePlayer();
}, { passive: true });

// Home now-playing card play button
$('home-now-play').addEventListener('click', e => { e.stopPropagation(); handlePlayPause(); });
