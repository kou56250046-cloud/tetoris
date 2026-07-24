// オンライン1対1対戦（ルームコード共有）。Firebase Realtime Databaseの
// Broadcast的な使い方（/rooms/{code} 配下のみ読み書き）で状態を同期する。
// ルームコードは知っていれば誰でも入れる程度の緩い秘匿性であり、
// 認証やセキュリティ機能ではない（友達との対戦専用）。
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import {
  getDatabase, ref, set, remove, onValue, onDisconnect, get
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-database.js';

// Realtime Databaseのセキュリティルールは /rooms 配下のみ read/write:true にすること。
const firebaseConfig = {
  apiKey: 'AIzaSyCOya1dpS8fKIodIz9leYs0Mh_nJDdsf4I',
  authDomain: 'tetoris-96fce.firebaseapp.com',
  databaseURL: 'https://tetoris-96fce-default-rtdb.asia-southeast1.firebasedatabase.app',
  projectId: 'tetoris-96fce',
  storageBucket: 'tetoris-96fce.firebasestorage.app',
  messagingSenderId: '293714781914',
  appId: '1:293714781914:web:b75929cd37d2c03ebce7e3',
};

const ROOM_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'; // 0/O, 1/I/L 等を除外
const GARBAGE_TABLE = { 1: 0, 2: 1, 3: 2, 4: 4 };
const COUNTDOWN_SECONDS = 3;
const BOARD_WRITE_MIN_INTERVAL_MS = 120;
const OPPONENT_COLORS = {
  I: '#5B8CFF', O: '#FFC93E', T: '#C86CFF', S: '#3EE087',
  Z: '#FF5C7A', J: '#4C6BFF', L: '#FF9A3E', GARBAGE: '#5A5866',
};

if (!window.TetrisEngine) {
  console.error('[netplay] TetrisEngine bridge not found. index.htmlの読み込み順を確認してください。');
}

const app = initializeApp(firebaseConfig);
const db = getDatabase(app);

const clientId = crypto.randomUUID();

// ---- DOM参照 ----
const onlineFab = document.getElementById('onlineFab');
const onlineModal = document.getElementById('onlineModal');
const onlineCloseBtn = document.getElementById('onlineCloseBtn');
const viewMenu = document.getElementById('onlineViewMenu');
const viewWaiting = document.getElementById('onlineViewWaiting');
const viewCountdown = document.getElementById('onlineViewCountdown');
const createRoomBtn = document.getElementById('createRoomBtn');
const joinRoomBtn = document.getElementById('joinRoomBtn');
const joinCodeInput = document.getElementById('joinCodeInput');
const onlineError = document.getElementById('onlineError');
const roomCodeDisplay = document.getElementById('roomCodeDisplay');
const copyLinkBtn = document.getElementById('copyLinkBtn');
const waitingStatus = document.getElementById('waitingStatus');
const countdownNumber = document.getElementById('countdownNumber');
const opponentPanel = document.getElementById('opponentPanel');
const opponentBoardCanvas = document.getElementById('opponentBoard');
const opponentBoardCtx = opponentBoardCanvas.getContext('2d');
const opponentLinesEl = document.getElementById('opponentLines');
const garbageBar = document.getElementById('garbageBar');
const garbageFill = document.getElementById('garbageFill');
const matchResultModal = document.getElementById('matchResultModal');
const matchResultTitle = document.getElementById('matchResultTitle');
const matchResultText = document.getElementById('matchResultText');
const rematchBtn = document.getElementById('rematchBtn');
const leaveRoomBtn = document.getElementById('leaveRoomBtn');

// ---- 状態 ----
let roomCode = null;
let isHost = false;
let opponentId = null;
let matchInitSeenSeed = null;
let countdownTimer = null;
let matchActive = false;
let garbageApplied = 0;
let opponentGarbageSent = 0;
let myMove = { board: null, garbageSent: 0, gameOver: false, lines: 0 };
let lastBoardWriteAt = 0;
let listeners = []; // {ref, unsub}
let rematchRequestedByMe = false;

function roomRef(...segments) {
  return ref(db, ['rooms', roomCode, ...segments].join('/'));
}

function genRoomCode() {
  let code = '';
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  for (const b of bytes) code += ROOM_CODE_ALPHABET[b % ROOM_CODE_ALPHABET.length];
  return code;
}

function showView(view) {
  viewMenu.hidden = view !== 'menu';
  viewWaiting.hidden = view !== 'waiting';
  viewCountdown.hidden = view !== 'countdown';
}

function openModal() {
  onlineModal.classList.add('show');
}
function closeModal() {
  onlineModal.classList.remove('show');
}

function trackListener(dbRef, callback) {
  const unsub = onValue(dbRef, callback);
  listeners.push(unsub);
}

function clearAllListeners() {
  listeners.forEach((unsub) => unsub());
  listeners = [];
}

// ---- ルーム作成/参加 ----
async function createRoomAsHost() {
  roomCode = genRoomCode();
  isHost = true;
  await enterRoom();
  roomCodeDisplay.textContent = roomCode;
  roomCodeDisplay.style.display = '';
  copyLinkBtn.style.display = '';
  waitingStatus.textContent = '対戦相手を待っています…';
  history.replaceState(null, '', `?room=${roomCode}`);
  showView('waiting');
}

async function joinRoomWithCode(code) {
  roomCode = code.trim().toUpperCase();
  if (!roomCode) return;
  isHost = false;
  await enterRoom();
  roomCodeDisplay.style.display = 'none';
  copyLinkBtn.style.display = 'none';
  waitingStatus.textContent = 'ホストの応答を待っています…';
  history.replaceState(null, '', `?room=${roomCode}`);
  showView('waiting');
}

async function enterRoom() {
  onlineError.textContent = '';
  const myPlayerRef = roomRef('players', clientId);
  await set(myPlayerRef, { joinedAt: Date.now() });
  onDisconnect(myPlayerRef).remove();

  trackListener(roomRef('players'), (snap) => {
    const players = snap.val() || {};
    const ids = Object.keys(players);
    if (ids.length > 2) {
      const sorted = ids.sort((a, b) => (players[a].joinedAt || 0) - (players[b].joinedAt || 0));
      const myRank = sorted.indexOf(clientId);
      if (myRank >= 2) {
        onlineError.textContent = 'このルームは満室です。';
        remove(myPlayerRef).catch(() => {});
        clearAllListeners();
        return;
      }
    }
    if (ids.length === 2 && !opponentId) {
      opponentId = ids.find((id) => id !== clientId);
      if (opponentId) {
        attachOpponentListener();
        if (isHost) startMatchInit();
      }
    }
    if (matchActive && ids.length < 2) {
      onOpponentLeft();
    }
  });

  trackListener(roomRef('matchInit'), (snap) => {
    const data = snap.val();
    if (!data || data.seed === matchInitSeenSeed) return;
    matchInitSeenSeed = data.seed;
    beginCountdown(data.seed);
  });
}

function startMatchInit() {
  set(roomRef('matchInit'), { seed: Math.floor(Math.random() * 4294967295), initiatedAt: Date.now() });
}

function attachOpponentListener() {
  trackListener(roomRef('moves', opponentId), (snap) => {
    const data = snap.val();
    if (!data) return;
    if (data.board) drawOpponentBoard(data.board);
    if (typeof data.lines === 'number') opponentLinesEl.textContent = data.lines;
    if (typeof data.garbageSent === 'number') {
      opponentGarbageSent = data.garbageSent;
      updateGarbageBar(opponentGarbageSent - garbageApplied);
    }
    if (data.gameOver && matchActive) {
      finishMatch(true);
    }
  });
}

function onOpponentLeft() {
  if (!matchActive) return;
  finishMatch(true, '相手が切断しました');
}

// ---- カウントダウン・対戦開始 ----
function beginCountdown(seed) {
  matchResultModal.classList.remove('show');
  closeModal();
  showView('countdown');
  openModal();
  let remaining = COUNTDOWN_SECONDS;
  countdownNumber.textContent = String(remaining);
  clearInterval(countdownTimer);
  countdownTimer = setInterval(() => {
    remaining -= 1;
    if (remaining <= 0) {
      clearInterval(countdownTimer);
      closeModal();
      beginMatch(seed);
    } else {
      countdownNumber.textContent = String(remaining);
    }
  }, 1000);
}

function beginMatch(seed) {
  matchActive = true;
  garbageApplied = 0;
  rematchRequestedByMe = false;
  myMove = { board: null, garbageSent: 0, gameOver: false, lines: 0 };
  set(roomRef('moves', clientId), myMove);
  opponentPanel.classList.add('show');
  garbageBar.classList.add('show');
  updateGarbageBar(0);
  window.TetrisEngine.hooks.onLineClear = handleLineClear;
  window.TetrisEngine.hooks.beforeSpawn = handleBeforeSpawn;
  window.TetrisEngine.hooks.onBoardChange = handleBoardChange;
  window.TetrisEngine.hooks.onGameOver = handleGameOver;
  window.TetrisEngine.startOnlineMatch(seed);
}

// ---- Engine → Netplay フック ----
function handleLineClear(count, combo) {
  myMove.lines += count;
  const amount = (GARBAGE_TABLE[count] || 0) + (combo >= 2 ? 1 : 0);
  if (amount > 0) myMove.garbageSent += amount;
  set(roomRef('moves', clientId), myMove);
}

function handleBeforeSpawn() {
  const pending = opponentGarbageSent - garbageApplied;
  if (pending > 0) {
    garbageApplied = opponentGarbageSent;
    updateGarbageBar(0);
  }
  return pending;
}

function handleBoardChange(board) {
  const now = Date.now();
  if (now - lastBoardWriteAt < BOARD_WRITE_MIN_INTERVAL_MS) return;
  lastBoardWriteAt = now;
  // Firebase RTDBはnullを「削除」として扱い配列の穴になってしまうため、
  // 空セルは0に置き換えてからシリアライズする（受信側は falsy 判定なのでそのまま使える）。
  myMove.board = board.map((row) => row.map((c) => c || 0));
  set(roomRef('moves', clientId), myMove);
}

function handleGameOver(score, lines) {
  if (!matchActive) return;
  myMove.gameOver = true;
  myMove.lines = lines;
  set(roomRef('moves', clientId), myMove);
  finishMatch(false);
}

// ---- 描画 ----
function drawOpponentBoard(board) {
  const cell = opponentBoardCanvas.width / 10;
  opponentBoardCtx.clearRect(0, 0, opponentBoardCanvas.width, opponentBoardCanvas.height);
  opponentBoardCtx.fillStyle = '#0A0A13';
  opponentBoardCtx.fillRect(0, 0, opponentBoardCanvas.width, opponentBoardCanvas.height);
  for (let y = 0; y < board.length; y++) {
    for (let x = 0; x < board[y].length; x++) {
      const v = board[y][x];
      if (!v) continue;
      opponentBoardCtx.fillStyle = OPPONENT_COLORS[v] || '#888';
      opponentBoardCtx.fillRect(x * cell, y * cell, cell - 1, cell - 1);
    }
  }
}

function updateGarbageBar(pending) {
  const pct = Math.max(0, Math.min(1, pending / 10)) * 100;
  garbageFill.style.height = pct + '%';
}

// ---- 勝敗・終了 ----
function finishMatch(won, customText) {
  if (!matchActive) return;
  matchActive = false;
  rematchRequestedByMe = false;
  rematchBtn.disabled = false;
  rematchBtn.textContent = 'もう一度対戦';
  window.TetrisEngine.stop();
  matchResultTitle.textContent = won ? 'WIN!' : 'LOSE...';
  matchResultText.textContent = customText || (won ? '相手がトップアウトしました' : 'あなたがトップアウトしました');
  matchResultModal.classList.add('show');
}

async function requestRematch() {
  if (rematchRequestedByMe) return;
  rematchRequestedByMe = true;
  rematchBtn.disabled = true;
  rematchBtn.textContent = '相手を待っています…';
  await set(roomRef('rematch', clientId), true);
  if (isHost) checkRematchReady();
}

function checkRematchReady() {
  get(roomRef('rematch')).then((snap) => {
    const data = snap.val() || {};
    if (data[clientId] && opponentId && data[opponentId]) {
      remove(roomRef('rematch'));
      startMatchInit();
    }
  });
}

trackRematchListener();
function trackRematchListener() {
  // opponentIdが確定してから有効化する（enterRoom内のplayersリスナーで opponentId 設定後も継続監視）
  setInterval(() => {
    if (isHost && opponentId && matchResultModal.classList.contains('show')) {
      checkRematchReady();
    }
  }, 1000);
}

async function leaveRoom() {
  matchActive = false;
  clearAllListeners();
  if (roomCode) {
    await remove(roomRef('players', clientId)).catch(() => {});
    await remove(roomRef('moves', clientId)).catch(() => {});
    await remove(roomRef('rematch', clientId)).catch(() => {});
  }
  roomCode = null;
  isHost = false;
  opponentId = null;
  matchInitSeenSeed = null;
  opponentPanel.classList.remove('show');
  garbageBar.classList.remove('show');
  matchResultModal.classList.remove('show');
  closeModal();
  showView('menu');
  history.replaceState(null, '', location.pathname);
  window.TetrisEngine.backToMenu();
}

// ---- UIイベント ----
onlineFab.addEventListener('click', () => {
  showView('menu');
  onlineError.textContent = '';
  openModal();
});
onlineCloseBtn.addEventListener('click', closeModal);
onlineModal.addEventListener('click', (e) => {
  if (e.target === onlineModal) closeModal();
});

createRoomBtn.addEventListener('click', () => {
  createRoomAsHost().catch((err) => { onlineError.textContent = '作成に失敗しました: ' + err.message; });
});
joinRoomBtn.addEventListener('click', () => {
  const code = joinCodeInput.value;
  if (!code) { onlineError.textContent = 'コードを入力してください。'; return; }
  joinRoomWithCode(code).catch((err) => { onlineError.textContent = '参加に失敗しました: ' + err.message; });
});
copyLinkBtn.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(location.href);
    copyLinkBtn.textContent = 'コピーしました';
    setTimeout(() => { copyLinkBtn.textContent = 'リンクをコピー'; }, 1500);
  } catch (e) { /* clipboard未対応環境では無視 */ }
});

rematchBtn.addEventListener('click', () => {
  requestRematch();
});
leaveRoomBtn.addEventListener('click', () => {
  leaveRoom();
});

// ---- URLのroomパラメータから自動参加 ----
const urlRoom = new URLSearchParams(location.search).get('room');
if (urlRoom) {
  joinCodeInput.value = urlRoom;
  showView('menu');
  openModal();
  joinRoomWithCode(urlRoom).catch((err) => { onlineError.textContent = '参加に失敗しました: ' + err.message; });
}
