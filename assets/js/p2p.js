'use strict';

/**
 * P2P Share — peer-to-peer chat & file transfer.
 *
 * Signaling (the initial handshake) goes through the PeerJS broker; after that
 * all chat and file data flows directly between the two browsers over an
 * encrypted WebRTC data channel. Nothing is stored on any server.
 *
 * Wire protocol (one reliable, ordered data channel, serialization "raw"):
 *   JSON text messages:
 *     { type: 'hello', name, version }
 *     { type: 'chat', id, text, ts }
 *     { type: 'typing' }
 *     { type: 'file-offer', fileId, name, size, mime }
 *     { type: 'file-accept' | 'file-reject' | 'file-cancel', fileId }
 *     { type: 'file-done', fileId, sha256 }        (sha256 hex or null)
 *     { type: 'file-received', fileId, verified }  (true | false | null)
 *     { type: 'busy' } / { type: 'bye' }
 *   Binary messages: [uint32 fileId (big endian)][chunk bytes]
 *
 * A self-hosted PeerJS server can be used by defining, before this script loads:
 *   window.P2P_CONFIG = { peerOptions: { host, port, path, secure } };
 */

const CONFIG = Object.assign({
  idPrefix: 'shubhub-p2p-',
  peerOptions: {},
  chunkSize: 64 * 1024,                // bytes per data-channel message (incl. 4-byte header)
  maxBuffered: 1024 * 1024,            // pause sending above this many queued bytes
  maxIncomingSize: 2 * 1024 ** 3,      // auto-decline offers larger than 2 GB
  hashLimit: 256 * 1024 ** 2,          // only SHA-256 verify files up to 256 MB (memory)
  reconnectAttempts: 6,
}, window.P2P_CONFIG || {});

const PROTOCOL_VERSION = 1;
const NAME_KEY = 'p2p_display_name_v1';
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 6;
const HEADER_BYTES = 4;
const PREVIEWABLE = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/bmp'];

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const state = {
  peer: null,
  conn: null,
  role: null,           // 'host' | 'guest'
  roomCode: null,
  remoteName: null,
  leaving: false,
  reconnectTries: 0,
  reconnectTimer: null,
  hostIdRetries: 0,
  outgoing: new Map(),  // fileId -> transfer
  incoming: new Map(),  // fileId -> transfer
  sendQueue: [],
  pumping: false,
  unread: 0,
  lastTypingSent: 0,
  typingTimer: null,
  activeTab: 'connect',
};

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------

const $ = (id) => document.getElementById(id);

const el = {
  sidebar: document.querySelector('[data-sidebar]'),
  sidebarBtn: document.querySelector('[data-sidebar-btn]'),
  tabs: document.querySelectorAll('[data-p2p-tab]'),
  pages: document.querySelectorAll('[data-p2p-page]'),
  badges: document.querySelectorAll('[data-status-badge]'),
  chatUnread: $('chat-unread'),
  filesPending: $('files-pending'),

  name: $('display-name'),
  lobby: $('p2p-lobby'),
  btnCreate: $('btn-create'),
  joinForm: $('join-form'),
  joinCode: $('join-code'),
  btnJoin: $('btn-join'),
  session: $('p2p-session'),
  roomCode: $('room-code'),
  shareActions: $('share-actions'),
  btnCopyCode: $('btn-copy-code'),
  btnCopyLink: $('btn-copy-link'),
  sessionRole: $('session-role'),
  sessionPeer: $('session-peer'),
  sessionRoute: $('session-route'),
  btnLeave: $('btn-leave'),
  qrBox: $('qr-box'),
  error: $('connect-error'),

  chatLog: $('chat-log'),
  chatEmpty: $('chat-empty'),
  typing: $('typing-indicator'),
  chatForm: $('chat-form'),
  chatInput: $('chat-input'),
  chatSend: $('chat-send'),

  dropZone: $('drop-zone'),
  dropSub: $('drop-sub'),
  fileInput: $('file-input'),
  transferList: $('transfer-list'),
  transfersEmpty: $('transfers-empty'),
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function randomCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH));
  return Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}

function randomUint32() {
  return crypto.getRandomValues(new Uint32Array(1))[0];
}

function normalizeCode(raw) {
  return String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, CODE_LENGTH);
}

function isValidCode(code) {
  return code.length === CODE_LENGTH && [...code].every((c) => CODE_ALPHABET.includes(c));
}

function cleanText(value, max) {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

function cleanFileName(value) {
  const name = cleanText(value, 255)
    .replace(/[\\/]/g, '_')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim();
  return name || 'file';
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '?';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function myName() {
  return el.name.value.trim().slice(0, 40) || 'Anonymous';
}

function peerName() {
  return state.remoteName || 'Peer';
}

function inviteLink() {
  const url = new URL(window.location.href);
  url.search = '';
  url.hash = `room=${state.roomCode}`;
  return url.toString();
}

function isConnected() {
  return Boolean(state.conn && state.conn.open);
}

async function sha256Hex(blob) {
  if (!crypto.subtle) return null;
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

async function copyText(text, button) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  const label = button.lastChild;
  const original = label.textContent;
  label.textContent = ' Copied!';
  setTimeout(() => { label.textContent = original; }, 1500);
}

function storageGet(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

function storageSet(key, value) {
  try { localStorage.setItem(key, value); } catch { /* private mode */ }
}

// ---------------------------------------------------------------------------
// UI: tabs, status, errors
// ---------------------------------------------------------------------------

function showTab(name) {
  state.activeTab = name;
  el.tabs.forEach((t) => t.classList.toggle('active', t.dataset.p2pTab === name));
  el.pages.forEach((p) => p.classList.toggle('active', p.dataset.p2pPage === name));
  if (name === 'chat') {
    state.unread = 0;
    updateBadges();
    el.chatLog.scrollTop = el.chatLog.scrollHeight;
    if (!el.chatInput.disabled) el.chatInput.focus();
  }
  window.scrollTo(0, 0);
}

function updateBadges() {
  el.chatUnread.textContent = state.unread;
  el.chatUnread.classList.toggle('hidden', state.unread === 0);

  const pending = [...state.incoming.values()].filter((t) => t.status === 'offered').length;
  el.filesPending.textContent = pending;
  el.filesPending.classList.toggle('hidden', pending === 0);
}

function setStatus(stateName, text) {
  el.badges.forEach((badge) => {
    badge.dataset.state = stateName;
    badge.querySelector('.status-text').textContent = text;
  });

  const connected = stateName === 'connected';
  el.chatInput.disabled = !connected;
  el.chatSend.disabled = !connected;
  el.fileInput.disabled = !connected;
  el.dropZone.classList.toggle('disabled', !connected);
  el.dropSub.textContent = connected
    ? `Files go straight to ${peerName()}. They must accept each one.`
    : 'Connect to a peer first';
}

function showError(message) {
  el.error.textContent = message;
  el.error.classList.toggle('hidden', !message);
}

function renderSession() {
  const inRoom = Boolean(state.peer);
  el.lobby.classList.toggle('hidden', inRoom);
  el.session.classList.toggle('hidden', !inRoom);
  el.name.disabled = false;

  if (!inRoom) return;

  el.roomCode.textContent = state.roomCode || '------';
  el.sessionRole.textContent = state.role === 'host' ? 'Host' : 'Guest';
  el.sessionPeer.textContent = isConnected() ? peerName() : 'Waiting…';
  el.shareActions.classList.toggle('hidden', state.role !== 'host');
  renderQr();
}

function renderQr() {
  el.qrBox.textContent = '';
  if (state.role !== 'host' || !state.roomCode || isConnected()) return;
  if (typeof window.QRCode !== 'function') return;
  try {
    new window.QRCode(el.qrBox, {
      text: inviteLink(),
      width: 160,
      height: 160,
      correctLevel: window.QRCode.CorrectLevel ? window.QRCode.CorrectLevel.M : undefined,
    });
  } catch {
    el.qrBox.textContent = '';
  }
}

// ---------------------------------------------------------------------------
// Connection lifecycle
// ---------------------------------------------------------------------------

function ensurePeerJs() {
  if (typeof window.Peer === 'function') return true;
  showError('Could not load the PeerJS library. Check your connection or disable content blockers, then reload.');
  setStatus('error', 'Library missing');
  return false;
}

function createRoom() {
  if (!ensurePeerJs()) return;
  showError('');
  const code = randomCode();
  state.role = 'host';
  state.roomCode = code;
  state.leaving = false;
  setStatus('connecting', 'Creating room…');
  startPeer(CONFIG.idPrefix + code);
}

function joinRoom(rawCode) {
  if (!ensurePeerJs()) return;
  const code = normalizeCode(rawCode);
  if (!isValidCode(code)) {
    showError(`Room codes are ${CODE_LENGTH} characters (letters and digits, no 0/O/1/I).`);
    return;
  }
  showError('');
  state.role = 'guest';
  state.roomCode = code;
  state.leaving = false;
  state.reconnectTries = 0;
  setStatus('connecting', 'Connecting…');
  startPeer(null);
}

function startPeer(id) {
  const peer = id ? new window.Peer(id, CONFIG.peerOptions) : new window.Peer(CONFIG.peerOptions);
  state.peer = peer;
  renderSession();

  peer.on('open', () => {
    if (peer !== state.peer) return;
    if (state.role === 'host') {
      state.hostIdRetries = 0;
      setStatus('waiting', 'Waiting for peer');
      systemMessage(`Room ${state.roomCode} created. Share the code to invite someone.`);
      renderSession();
    } else {
      connectToHost();
    }
  });

  peer.on('connection', (conn) => {
    if (peer !== state.peer || state.role !== 'host') {
      conn.close();
      return;
    }
    if (isConnected() && conn.peer !== state.conn.peer) {
      // Rooms are one-to-one; politely turn away a third peer. (The same guest
      // reconnecting after a network blip simply replaces its old connection.)
      conn.on('open', () => {
        conn.send(JSON.stringify({ type: 'busy' }));
        setTimeout(() => conn.close(), 500);
      });
      return;
    }
    attachConnection(conn);
  });

  peer.on('disconnected', () => {
    // Lost the broker. Existing data connections keep working; reconnect so we
    // can accept new ones.
    if (peer !== state.peer || state.leaving || peer.destroyed) return;
    setTimeout(() => {
      if (peer === state.peer && !peer.destroyed && peer.disconnected) {
        try { peer.reconnect(); } catch { /* ignored */ }
      }
    }, 1000);
  });

  peer.on('error', (err) => handlePeerError(peer, err));
}

function connectToHost() {
  if (!state.peer || state.peer.destroyed) return;
  const conn = state.peer.connect(CONFIG.idPrefix + state.roomCode, {
    reliable: true,
    serialization: 'raw',
  });
  if (!conn) {
    scheduleReconnect();
    return;
  }
  attachConnection(conn);
}

function attachConnection(conn) {
  if (state.conn && state.conn !== conn) {
    try { state.conn.close(); } catch { /* ignored */ }
    failActiveTransfers('Connection was reset');
  }
  state.conn = conn;

  conn.on('open', () => {
    if (conn !== state.conn) return;
    clearTimeout(state.reconnectTimer);
    state.reconnectTries = 0;
    send({ type: 'hello', name: myName(), version: PROTOCOL_VERSION });
    setStatus('connected', 'Connected');
    renderSession();
    detectRoute(conn);
  });

  conn.on('data', (data) => {
    if (conn !== state.conn) return;
    onData(data);
  });

  conn.on('close', () => {
    if (conn !== state.conn) return;
    onConnectionLost();
  });

  conn.on('error', (err) => {
    console.warn('[p2p] connection error', err);
  });
}

function onConnectionLost() {
  const wasConnected = state.remoteName !== null;
  state.conn = null;
  failActiveTransfers('Connection lost');

  if (state.leaving || !state.peer) return;

  if (wasConnected) systemMessage(`${peerName()} disconnected.`);
  state.remoteName = null;
  el.sessionRoute.textContent = '—';

  if (state.role === 'host') {
    setStatus('waiting', 'Waiting for peer');
    renderSession();
  } else {
    scheduleReconnect();
  }
}

function scheduleReconnect() {
  if (state.leaving || state.role !== 'guest' || !state.peer) return;
  if (state.reconnectTries >= CONFIG.reconnectAttempts) {
    setStatus('error', 'Disconnected');
    showError('Lost the connection to the room and could not reconnect. The host may have left.');
    renderSession();
    return;
  }
  state.reconnectTries++;
  const delay = Math.min(1000 * 2 ** (state.reconnectTries - 1), 10000);
  setStatus('reconnecting', `Reconnecting (${state.reconnectTries}/${CONFIG.reconnectAttempts})…`);
  clearTimeout(state.reconnectTimer);
  state.reconnectTimer = setTimeout(() => {
    const peer = state.peer;
    if (!peer || state.leaving) return;
    if (peer.disconnected && !peer.destroyed) {
      try { peer.reconnect(); } catch { /* ignored */ }
      peer.once('open', connectToHost);
    } else {
      connectToHost();
    }
  }, delay);
}

function handlePeerError(peer, err) {
  if (peer !== state.peer) return;
  const type = err && err.type;
  console.warn('[p2p] peer error', type, err);

  if (type === 'unavailable-id' && state.role === 'host' && state.hostIdRetries < 3) {
    // Room code collision: pick another one.
    state.hostIdRetries++;
    teardownPeer();
    createRoom();
    return;
  }

  if (type === 'peer-unavailable') {
    if (state.role === 'guest' && state.reconnectTries > 0) {
      scheduleReconnect();
      return;
    }
    leaveRoom({ silent: true });
    showError(`Room ${state.roomCode || ''} was not found. Check the code, and make sure the host keeps their page open.`);
    return;
  }

  if (type === 'network' || type === 'socket-error' || type === 'socket-closed' || type === 'server-error') {
    if (isConnected()) return; // the direct link is still fine
    if (state.role === 'guest' && state.reconnectTries > 0) {
      scheduleReconnect();
      return;
    }
    leaveRoom({ silent: true });
    showError('Could not reach the PeerJS signaling server. Check your internet connection and try again.');
    return;
  }

  if (type === 'browser-incompatible') {
    leaveRoom({ silent: true });
    showError('This browser does not support WebRTC data channels. Try a recent Chrome, Firefox, Edge or Safari.');
    return;
  }

  if (!isConnected()) {
    leaveRoom({ silent: true });
    showError(`Connection failed (${type || 'unknown error'}). Please try again.`);
  }
}

function teardownPeer() {
  clearTimeout(state.reconnectTimer);
  if (state.conn) {
    try { state.conn.close(); } catch { /* ignored */ }
  }
  if (state.peer) {
    try { state.peer.destroy(); } catch { /* ignored */ }
  }
  state.conn = null;
  state.peer = null;
}

function leaveRoom({ silent = false } = {}) {
  state.leaving = true;
  if (isConnected()) {
    try { state.conn.send(JSON.stringify({ type: 'bye' })); } catch { /* ignored */ }
  }
  failActiveTransfers('Left the room');
  teardownPeer();
  if (!silent) systemMessage('You left the room.');
  state.role = null;
  state.roomCode = null;
  state.remoteName = null;
  state.sendQueue = [];
  el.sessionRoute.textContent = '—';
  setStatus('idle', 'Not connected');
  renderSession();
  if (window.location.hash) history.replaceState(null, '', window.location.pathname + window.location.search);
}

async function detectRoute(conn) {
  el.sessionRoute.textContent = 'Checking…';
  // Give ICE a moment to settle on the selected pair.
  await new Promise((r) => setTimeout(r, 1000));
  try {
    const pc = conn.peerConnection;
    if (!pc || conn !== state.conn) return;
    const stats = await pc.getStats();
    let pair = null;
    stats.forEach((report) => {
      if (report.type === 'transport' && report.selectedCandidatePairId) {
        pair = stats.get(report.selectedCandidatePairId);
      }
    });
    if (!pair) {
      stats.forEach((report) => {
        if (!pair && report.type === 'candidate-pair' && (report.selected || (report.nominated && report.state === 'succeeded'))) {
          pair = report;
        }
      });
    }
    const local = pair && stats.get(pair.localCandidateId);
    const remote = pair && stats.get(pair.remoteCandidateId);
    if (!local || !remote) {
      el.sessionRoute.textContent = 'Direct (P2P)';
      return;
    }
    const relayed = local.candidateType === 'relay' || remote.candidateType === 'relay';
    el.sessionRoute.textContent = relayed ? 'Relayed via TURN (still encrypted)' : 'Direct (P2P)';
  } catch {
    el.sessionRoute.textContent = 'Direct (P2P)';
  }
}

// ---------------------------------------------------------------------------
// Messaging
// ---------------------------------------------------------------------------

function send(message) {
  if (!isConnected()) return false;
  try {
    state.conn.send(JSON.stringify(message));
    return true;
  } catch (err) {
    console.warn('[p2p] send failed', err);
    return false;
  }
}

function onData(data) {
  if (typeof data === 'string') {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    if (msg && typeof msg === 'object') handleControl(msg);
    return;
  }
  if (data instanceof ArrayBuffer) {
    handleChunk(data);
  } else if (ArrayBuffer.isView(data)) {
    handleChunk(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
  }
}

function handleControl(msg) {
  switch (msg.type) {
    case 'hello': {
      const name = cleanText(msg.name, 40).trim() || 'Peer';
      const first = state.remoteName === null;
      const previous = state.remoteName;
      state.remoteName = name;
      if (first) {
        systemMessage(`Connected to ${name}.`);
      } else if (previous !== name) {
        systemMessage(`${previous} is now ${name}.`);
      }
      setStatus('connected', `Connected to ${name}`);
      renderSession();
      break;
    }
    case 'chat': {
      const text = cleanText(msg.text, 5000);
      if (!text.trim()) return;
      const ts = Number.isFinite(msg.ts) ? Math.min(msg.ts, Date.now()) : Date.now();
      hideTyping();
      chatMessage(text, false, ts);
      if (state.activeTab !== 'chat' || document.hidden) {
        state.unread++;
        updateBadges();
      }
      break;
    }
    case 'typing':
      showTyping();
      break;
    case 'file-offer':
      onFileOffer(msg);
      break;
    case 'file-accept':
      onFileAccepted(msg.fileId);
      break;
    case 'file-reject':
      onFileRejected(msg.fileId);
      break;
    case 'file-cancel':
      onRemoteCancel(msg.fileId);
      break;
    case 'file-done':
      onFileDone(msg);
      break;
    case 'file-received':
      onFileReceived(msg);
      break;
    case 'busy':
      leaveRoom({ silent: true });
      showError('That room already has two people in it.');
      break;
    case 'bye':
      // The peer left on purpose; don't keep retrying as a guest.
      if (state.role === 'guest') {
        systemMessage(`${peerName()} closed the room.`);
        leaveRoom({ silent: true });
        showError('The host closed the room.');
      }
      break;
    default:
      break;
  }
}

// ---------------------------------------------------------------------------
// Chat UI
// ---------------------------------------------------------------------------

function appendToLog(node) {
  el.chatEmpty.classList.add('hidden');
  const nearBottom = el.chatLog.scrollHeight - el.chatLog.scrollTop - el.chatLog.clientHeight < 80;
  el.chatLog.appendChild(node);
  if (nearBottom) el.chatLog.scrollTop = el.chatLog.scrollHeight;
}

function chatMessage(text, mine, ts) {
  const wrap = document.createElement('div');
  wrap.className = `chat-msg ${mine ? 'mine' : 'theirs'}`;

  const bubble = document.createElement('div');
  bubble.className = 'chat-bubble';
  bubble.textContent = text;

  const meta = document.createElement('span');
  meta.className = 'chat-meta';
  meta.textContent = `${mine ? 'You' : peerName()} · ${formatTime(ts)}`;

  wrap.append(bubble, meta);
  appendToLog(wrap);
}

function systemMessage(text) {
  const p = document.createElement('p');
  p.className = 'chat-system';
  p.textContent = text;
  appendToLog(p);
}

function sendChat() {
  const text = el.chatInput.value.replace(/\s+$/, '');
  if (!text.trim() || !isConnected()) return;
  const ts = Date.now();
  if (send({ type: 'chat', id: randomUint32(), text, ts })) {
    chatMessage(text, true, ts);
    el.chatInput.value = '';
    autoSizeInput();
    state.lastTypingSent = 0;
  }
}

function autoSizeInput() {
  el.chatInput.style.height = 'auto';
  el.chatInput.style.height = `${Math.min(el.chatInput.scrollHeight + 2, 140)}px`;
}

function showTyping() {
  el.typing.textContent = `${peerName()} is typing…`;
  clearTimeout(state.typingTimer);
  state.typingTimer = setTimeout(hideTyping, 3000);
}

function hideTyping() {
  clearTimeout(state.typingTimer);
  el.typing.innerHTML = '&nbsp;';
}

// ---------------------------------------------------------------------------
// File transfer — sending
// ---------------------------------------------------------------------------

function offerFiles(fileList) {
  if (!isConnected()) return;
  for (const file of fileList) {
    let fileId;
    do { fileId = randomUint32(); } while (state.outgoing.has(fileId));

    const transfer = {
      fileId,
      direction: 'out',
      file,
      name: file.name,
      size: file.size,
      mime: file.type || 'application/octet-stream',
      status: 'waiting',
      bytes: 0,
      startedAt: 0,
      cancelled: false,
      node: null,
    };
    state.outgoing.set(fileId, transfer);
    renderTransfer(transfer);
    send({ type: 'file-offer', fileId, name: transfer.name, size: transfer.size, mime: transfer.mime });
  }
}

function onFileAccepted(fileId) {
  const t = state.outgoing.get(fileId);
  if (!t || t.status !== 'waiting') return;
  t.status = 'queued';
  renderTransfer(t);
  state.sendQueue.push(t);
  pumpQueue();
}

function onFileRejected(fileId) {
  const t = state.outgoing.get(fileId);
  if (!t || t.status !== 'waiting') return;
  t.status = 'rejected';
  renderTransfer(t);
}

async function pumpQueue() {
  if (state.pumping) return;
  state.pumping = true;
  try {
    while (state.sendQueue.length) {
      const t = state.sendQueue.shift();
      if (t.cancelled || t.status !== 'queued') continue;
      await sendFile(t);
    }
  } finally {
    state.pumping = false;
  }
}

function waitForDrain(conn) {
  const dc = conn.dataChannel;
  return new Promise((resolve) => {
    const low = CONFIG.maxBuffered / 2;
    let timer = null;
    const done = () => {
      dc.removeEventListener('bufferedamountlow', check);
      clearInterval(timer);
      resolve();
    };
    const check = () => {
      if (dc.readyState !== 'open' || (dc.bufferedAmount <= low && !conn.bufferSize)) done();
    };
    dc.bufferedAmountLowThreshold = low;
    dc.addEventListener('bufferedamountlow', check);
    timer = setInterval(check, 50);
  });
}

async function sendFile(t) {
  const conn = state.conn;
  if (!conn || !conn.open) {
    t.status = 'failed';
    renderTransfer(t, 'Not connected');
    return;
  }

  t.status = 'sending';
  t.startedAt = performance.now();
  renderTransfer(t);

  const hashPromise = t.size <= CONFIG.hashLimit ? sha256Hex(t.file).catch(() => null) : Promise.resolve(null);
  const payloadSize = CONFIG.chunkSize - HEADER_BYTES;
  const readBlock = payloadSize * 16; // read ~1 MB from disk at a time
  let lastPaint = 0;

  try {
    let offset = 0;
    while (offset < t.size) {
      const block = await t.file.slice(offset, offset + readBlock).arrayBuffer();
      for (let pos = 0; pos < block.byteLength; pos += payloadSize) {
        if (t.cancelled) return;
        if (conn !== state.conn || !conn.open) throw new Error('Connection lost');

        const dc = conn.dataChannel;
        if (dc.bufferedAmount > CONFIG.maxBuffered || conn.bufferSize > 0) {
          await waitForDrain(conn);
          if (t.cancelled) return;
          if (conn !== state.conn || !conn.open) throw new Error('Connection lost');
        }

        const piece = new Uint8Array(block, pos, Math.min(payloadSize, block.byteLength - pos));
        const message = new Uint8Array(HEADER_BYTES + piece.byteLength);
        new DataView(message.buffer).setUint32(0, t.fileId);
        message.set(piece, HEADER_BYTES);
        conn.send(message.buffer);

        t.bytes += piece.byteLength;
        const now = performance.now();
        if (now - lastPaint > 150) {
          lastPaint = now;
          renderTransfer(t);
        }
      }
      offset += block.byteLength;
    }

    t.status = 'finishing';
    renderTransfer(t, 'Waiting for the receiver to confirm…');
    const sha256 = await hashPromise;
    if (t.cancelled) return;
    send({ type: 'file-done', fileId: t.fileId, sha256 });
  } catch (err) {
    if (t.cancelled) return;
    t.status = 'failed';
    renderTransfer(t, err.message || 'Transfer failed');
  }
}

function onFileReceived(msg) {
  const t = state.outgoing.get(msg.fileId);
  if (!t || t.status !== 'finishing') return;
  if (msg.verified === false) {
    t.status = 'failed';
    renderTransfer(t, 'Receiver reported a checksum mismatch');
    return;
  }
  t.status = 'done';
  renderTransfer(t, msg.verified ? 'Delivered and verified (SHA-256)' : 'Delivered');
}

// ---------------------------------------------------------------------------
// File transfer — receiving
// ---------------------------------------------------------------------------

function onFileOffer(msg) {
  const fileId = Number(msg.fileId);
  const size = Number(msg.size);
  if (!Number.isInteger(fileId) || fileId < 0 || fileId > 0xffffffff) return;
  if (!Number.isFinite(size) || size < 0 || state.incoming.has(fileId)) return;

  const transfer = {
    fileId,
    direction: 'in',
    name: cleanFileName(msg.name),
    size,
    mime: cleanText(msg.mime, 100).toLowerCase(),
    status: 'offered',
    bytes: 0,
    chunks: [],
    startedAt: 0,
    url: null,
    node: null,
  };
  state.incoming.set(fileId, transfer);

  if (size > CONFIG.maxIncomingSize) {
    transfer.status = 'rejected';
    renderTransfer(transfer, `Declined automatically: larger than ${formatBytes(CONFIG.maxIncomingSize)}`);
    send({ type: 'file-reject', fileId });
    return;
  }

  renderTransfer(transfer);
  systemMessage(`${peerName()} wants to send you “${transfer.name}” (${formatBytes(size)}). See the Files tab.`);
  updateBadges();
}

function acceptIncoming(t) {
  if (t.status !== 'offered' || !isConnected()) return;
  t.status = 'receiving';
  t.startedAt = performance.now();
  renderTransfer(t);
  updateBadges();
  send({ type: 'file-accept', fileId: t.fileId });
}

function rejectIncoming(t) {
  if (t.status !== 'offered') return;
  t.status = 'rejected';
  renderTransfer(t, 'You declined this file');
  updateBadges();
  send({ type: 'file-reject', fileId: t.fileId });
}

function handleChunk(buffer) {
  if (buffer.byteLength < HEADER_BYTES) return;
  const fileId = new DataView(buffer).getUint32(0);
  const t = state.incoming.get(fileId);
  if (!t || t.status !== 'receiving') return;

  const chunk = buffer.slice(HEADER_BYTES);
  t.bytes += chunk.byteLength;
  if (t.bytes > t.size) {
    t.status = 'failed';
    t.chunks = [];
    renderTransfer(t, 'Received more data than announced');
    send({ type: 'file-cancel', fileId });
    return;
  }
  t.chunks.push(chunk);

  const now = performance.now();
  if (!t.lastPaint || now - t.lastPaint > 150) {
    t.lastPaint = now;
    renderTransfer(t);
  }
}

async function onFileDone(msg) {
  const t = state.incoming.get(msg.fileId);
  if (!t || t.status !== 'receiving') return;

  if (t.bytes !== t.size) {
    t.status = 'failed';
    t.chunks = [];
    renderTransfer(t, `Incomplete: got ${formatBytes(t.bytes)} of ${formatBytes(t.size)}`);
    send({ type: 'file-received', fileId: t.fileId, verified: false });
    return;
  }

  const previewable = PREVIEWABLE.includes(t.mime);
  // Anything that isn't a safe image is stored as an opaque download.
  const blob = new Blob(t.chunks, { type: previewable ? t.mime : 'application/octet-stream' });
  t.chunks = [];
  t.status = 'verifying';
  renderTransfer(t, 'Verifying…');

  let verified = null;
  const expected = typeof msg.sha256 === 'string' ? msg.sha256.toLowerCase() : null;
  if (expected && t.size <= CONFIG.hashLimit) {
    try {
      const actual = await sha256Hex(blob);
      verified = actual === null ? null : actual === expected;
    } catch {
      verified = null;
    }
  }

  if (verified === false) {
    t.status = 'failed';
    renderTransfer(t, 'Checksum mismatch: the file was corrupted in transit');
    send({ type: 'file-received', fileId: t.fileId, verified: false });
    return;
  }

  t.url = URL.createObjectURL(blob);
  t.previewable = previewable;
  t.status = 'done';
  renderTransfer(t, verified ? 'Received and verified (SHA-256)' : 'Received');
  send({ type: 'file-received', fileId: t.fileId, verified });
}

// ---------------------------------------------------------------------------
// File transfer — cancel / failure
// ---------------------------------------------------------------------------

function cancelTransfer(t) {
  const active = ['waiting', 'queued', 'sending', 'finishing', 'offered', 'receiving'];
  if (!active.includes(t.status)) return;
  t.cancelled = true;
  t.status = 'cancelled';
  if (t.chunks) t.chunks = [];
  renderTransfer(t, 'Cancelled by you');
  updateBadges();
  send({ type: 'file-cancel', fileId: t.fileId });
}

function onRemoteCancel(fileId) {
  const active = ['waiting', 'queued', 'sending', 'finishing', 'offered', 'receiving', 'verifying'];
  for (const map of [state.outgoing, state.incoming]) {
    const t = map.get(fileId);
    if (t && active.includes(t.status)) {
      t.cancelled = true;
      t.status = 'cancelled';
      if (t.chunks) t.chunks = [];
      renderTransfer(t, `Cancelled by ${peerName()}`);
    }
  }
  updateBadges();
}

function failActiveTransfers(reason) {
  const active = ['waiting', 'queued', 'sending', 'finishing', 'offered', 'receiving'];
  for (const map of [state.outgoing, state.incoming]) {
    for (const t of map.values()) {
      if (active.includes(t.status)) {
        t.cancelled = true;
        t.status = 'failed';
        if (t.chunks) t.chunks = [];
        renderTransfer(t, reason);
      }
    }
  }
  state.sendQueue = [];
  updateBadges();
}

// ---------------------------------------------------------------------------
// Transfer cards
// ---------------------------------------------------------------------------

function button(label, icon, onClick, extraClass = '') {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `btn-action ${extraClass}`.trim();
  const i = document.createElement('ion-icon');
  i.setAttribute('name', icon);
  b.append(i, document.createTextNode(` ${label}`));
  b.addEventListener('click', onClick);
  return b;
}

function statusText(t) {
  const pct = t.size ? Math.floor((t.bytes / t.size) * 100) : 100;
  const elapsed = (performance.now() - t.startedAt) / 1000;
  const speed = elapsed > 0.2 ? `${formatBytes(t.bytes / elapsed)}/s` : '';
  switch (t.status) {
    case 'waiting': return `Waiting for ${peerName()} to accept…`;
    case 'queued': return 'Accepted, queued to send';
    case 'sending': return `Sending ${pct}% · ${formatBytes(t.bytes)} ${speed && `· ${speed}`}`;
    case 'receiving': return `Receiving ${pct}% · ${formatBytes(t.bytes)} ${speed && `· ${speed}`}`;
    case 'offered': return `${peerName()} wants to send you this file`;
    case 'rejected': return t.direction === 'out' ? `${peerName()} declined` : 'Declined';
    default: return '';
  }
}

function renderTransfer(t, note) {
  if (!t.node) {
    t.node = document.createElement('div');
    t.node.className = 'transfer-item';
    t.node.innerHTML = `
      <div class="transfer-head">
        <ion-icon class="transfer-dir"></ion-icon>
        <span class="transfer-name"></span>
        <span class="transfer-size"></span>
      </div>
      <div class="transfer-progress"><div class="transfer-progress-fill"></div></div>
      <div class="transfer-foot">
        <span class="transfer-status"></span>
        <div class="transfer-actions"></div>
      </div>`;
    t.node.querySelector('.transfer-dir').setAttribute('name', t.direction === 'out' ? 'arrow-up-circle-outline' : 'arrow-down-circle-outline');
    t.node.querySelector('.transfer-name').textContent = t.name;
    t.node.querySelector('.transfer-name').title = t.name;
    t.node.querySelector('.transfer-size').textContent = formatBytes(t.size);
    el.transfersEmpty.classList.add('hidden');
    el.transferList.prepend(t.node);
  }

  if (note !== undefined) t.note = note;
  const terminal = ['done', 'failed', 'cancelled', 'rejected'];
  const shownNote = terminal.includes(t.status) || t.status === 'finishing' || t.status === 'verifying' ? t.note : null;

  t.node.dataset.status = t.status;
  const pct = t.size ? (t.bytes / t.size) * 100 : 100;
  t.node.querySelector('.transfer-progress-fill').style.width = `${t.status === 'done' ? 100 : pct}%`;
  t.node.querySelector('.transfer-status').textContent = shownNote || statusText(t) || t.note || '';

  const actions = t.node.querySelector('.transfer-actions');
  const key = `${t.status}`;
  if (actions.dataset.key === key) return; // avoid rebuilding buttons on every progress tick
  actions.dataset.key = key;
  actions.textContent = '';

  if (t.status === 'offered') {
    actions.append(
      button('Accept', 'checkmark-outline', () => acceptIncoming(t), 'primary'),
      button('Decline', 'close-outline', () => rejectIncoming(t), 'danger'),
    );
  } else if (['waiting', 'queued', 'sending', 'receiving'].includes(t.status)) {
    actions.append(button('Cancel', 'close-outline', () => cancelTransfer(t), 'danger'));
  } else if (t.status === 'done' && t.direction === 'in' && t.url) {
    const a = document.createElement('a');
    a.className = 'btn-action primary';
    a.href = t.url;
    a.download = t.name;
    const i = document.createElement('ion-icon');
    i.setAttribute('name', 'download-outline');
    a.append(i, document.createTextNode(' Save'));
    actions.append(a);

    if (t.previewable && !t.node.querySelector('.transfer-preview')) {
      const img = document.createElement('img');
      img.className = 'transfer-preview';
      img.alt = t.name;
      img.src = t.url;
      t.node.appendChild(img);
    }
  }
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

function init() {
  if (el.sidebarBtn) {
    el.sidebarBtn.addEventListener('click', () => el.sidebar.classList.toggle('active'));
  }

  el.tabs.forEach((tab) => tab.addEventListener('click', () => showTab(tab.dataset.p2pTab)));

  // Display name
  el.name.value = storageGet(NAME_KEY) || '';
  el.name.addEventListener('change', () => {
    storageSet(NAME_KEY, el.name.value.trim());
    if (isConnected()) send({ type: 'hello', name: myName(), version: PROTOCOL_VERSION });
  });

  // Lobby
  el.btnCreate.addEventListener('click', createRoom);
  el.joinCode.addEventListener('input', () => {
    const pos = el.joinCode.selectionStart;
    el.joinCode.value = normalizeCode(el.joinCode.value);
    el.joinCode.setSelectionRange(pos, pos);
  });
  el.joinForm.addEventListener('submit', (e) => {
    e.preventDefault();
    joinRoom(el.joinCode.value);
  });

  // Session
  el.btnCopyCode.addEventListener('click', () => copyText(state.roomCode, el.btnCopyCode));
  el.btnCopyLink.addEventListener('click', () => copyText(inviteLink(), el.btnCopyLink));
  el.btnLeave.addEventListener('click', () => leaveRoom());

  // Chat
  el.chatForm.addEventListener('submit', (e) => {
    e.preventDefault();
    sendChat();
  });
  el.chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      sendChat();
    }
  });
  el.chatInput.addEventListener('input', () => {
    autoSizeInput();
    const now = Date.now();
    if (el.chatInput.value && now - state.lastTypingSent > 2000) {
      state.lastTypingSent = now;
      send({ type: 'typing' });
    }
  });

  // Files
  el.fileInput.addEventListener('change', () => {
    offerFiles(el.fileInput.files);
    el.fileInput.value = '';
  });
  el.dropZone.addEventListener('click', (e) => {
    if (!isConnected()) e.preventDefault();
  });
  ['dragenter', 'dragover'].forEach((type) => el.dropZone.addEventListener(type, (e) => {
    e.preventDefault();
    if (isConnected()) el.dropZone.classList.add('dragover');
  }));
  ['dragleave', 'dragend', 'drop'].forEach((type) => el.dropZone.addEventListener(type, () => {
    el.dropZone.classList.remove('dragover');
  }));
  el.dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    if (isConnected() && e.dataTransfer && e.dataTransfer.files.length) offerFiles(e.dataTransfer.files);
  });
  // Don't let a missed drop navigate away from the page.
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && state.activeTab === 'chat') {
      state.unread = 0;
      updateBadges();
    }
  });

  window.addEventListener('beforeunload', (e) => {
    const busy = [...state.outgoing.values(), ...state.incoming.values()]
      .some((t) => ['sending', 'receiving', 'finishing'].includes(t.status));
    if (isConnected()) {
      try { state.conn.send(JSON.stringify({ type: 'bye' })); } catch { /* ignored */ }
    }
    if (busy) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  setStatus('idle', 'Not connected');
  renderSession();

  if (!window.isSecureContext) {
    showError('This page must be opened over HTTPS for peer-to-peer connections to work.');
  }

  // Invite links: p2p.html#room=AB12CD
  const match = window.location.hash.match(/room=([A-Za-z0-9]+)/);
  if (match) {
    const code = normalizeCode(match[1]);
    el.joinCode.value = code;
    if (isValidCode(code)) joinRoom(code);
  }
}

init();
