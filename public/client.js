'use strict';

// ---------- Category definitions (must match server) ----------
const UPPER = [
  { id: 'ones',   label: 'Ones',   sub: 'Sum of 1s' },
  { id: 'twos',   label: 'Twos',   sub: 'Sum of 2s' },
  { id: 'threes', label: 'Threes', sub: 'Sum of 3s' },
  { id: 'fours',  label: 'Fours',  sub: 'Sum of 4s' },
  { id: 'fives',  label: 'Fives',  sub: 'Sum of 5s' },
  { id: 'sixes',  label: 'Sixes',  sub: 'Sum of 6s' },
];
const LOWER = [
  { id: 'threeKind',  label: 'Three of a Kind', sub: 'Sum of all dice' },
  { id: 'fourKind',   label: 'Four of a Kind',  sub: 'Sum of all dice' },
  { id: 'fullHouse',  label: 'Full House',      sub: '25 points' },
  { id: 'smStraight', label: 'Small Straight',  sub: '30 points' },
  { id: 'lgStraight', label: 'Large Straight',  sub: '40 points' },
  { id: 'yahtzee',    label: 'Yahtzee',         sub: '50 points' },
  { id: 'chance',     label: 'Chance',          sub: 'Sum of all dice' },
];
const ALL_CATS = [...UPPER, ...LOWER];
const UPPER_BY_VALUE = ['ones', 'twos', 'threes', 'fours', 'fives', 'sixes'];

// ---------- Scoring helpers (display only — server is authoritative) ----------
const sum = a => a.reduce((x, y) => x + y, 0);

function counts(d) {
  const c = [0, 0, 0, 0, 0, 0, 0];
  d.forEach(v => c[v]++);
  return c;
}
const isYahtzeeRoll = d => d.every(v => v === d[0]);

function hasStraight(d, len) {
  const uniq = [...new Set(d)].sort((a, b) => a - b);
  let run = 1;
  for (let i = 1; i < uniq.length; i++) {
    run = (uniq[i] === uniq[i - 1] + 1) ? run + 1 : 1;
    if (run >= len) return true;
  }
  return run >= len;
}

function calcScore(catId, d, joker) {
  const c = counts(d);
  const upperIdx = UPPER_BY_VALUE.indexOf(catId);
  if (upperIdx !== -1) return c[upperIdx + 1] * (upperIdx + 1);
  switch (catId) {
    case 'threeKind':  return c.some(n => n >= 3) ? sum(d) : 0;
    case 'fourKind':   return c.some(n => n >= 4) ? sum(d) : 0;
    case 'fullHouse':  return (joker || (c.includes(3) && c.includes(2))) ? 25 : 0;
    case 'smStraight': return (joker || hasStraight(d, 4)) ? 30 : 0;
    case 'lgStraight': return (joker || hasStraight(d, 5)) ? 40 : 0;
    case 'yahtzee':    return isYahtzeeRoll(d) ? 50 : 0;
    case 'chance':     return sum(d);
  }
  return 0;
}

function jokerState(player, d) {
  if (!isYahtzeeRoll(d) || player.scores.yahtzee === undefined) {
    return { joker: false, allowed: null, bonus: false };
  }
  const bonus = player.scores.yahtzee === 50;
  const matchingUpper = UPPER_BY_VALUE[d[0] - 1];
  if (player.scores[matchingUpper] === undefined) {
    return { joker: true, allowed: [matchingUpper], bonus };
  }
  const openLower = LOWER.filter(c => c.id !== 'yahtzee' && player.scores[c.id] === undefined).map(c => c.id);
  if (openLower.length > 0) {
    return { joker: true, allowed: openLower, bonus };
  }
  const openUpper = UPPER.filter(c => player.scores[c.id] === undefined).map(c => c.id);
  return { joker: true, allowed: openUpper, bonus };
}

function upperSubtotal(p) { return sum(UPPER.map(c => p.scores[c.id] ?? 0)); }
function upperBonus(p) { return upperSubtotal(p) >= 63 ? 35 : 0; }
function lowerTotal(p) { return sum(LOWER.map(c => p.scores[c.id] ?? 0)) + p.yahtzeeBonus; }
function grandTotal(p) { return upperSubtotal(p) + upperBonus(p) + lowerTotal(p); }

// ---------- Connection ----------
const $ = id => document.getElementById(id);

let token = localStorage.getItem('yahzms-token');
if (!token) {
  token = (crypto.randomUUID && crypto.randomUUID()) || (Date.now() + '-' + Math.random().toString(36).slice(2));
  localStorage.setItem('yahzms-token', token);
}

let ws = null;
let S = null;        // latest server state
let me = -1;         // my player index, -1 = not seated
let animating = false;
let reconnectDelay = 1000;

function send(obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}`);
  ws.addEventListener('open', () => {
    reconnectDelay = 1000;
    setConn('ok');
    send({ type: 'hello', token });
  });
  ws.addEventListener('message', e => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    handleMessage(msg);
  });
  ws.addEventListener('close', () => {
    setConn('down');
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 1.5, 10000);
  });
}

function setConn(status) {
  const pill = $('conn-pill');
  if (status === 'ok') {
    pill.textContent = 'Connected';
    pill.className = 'conn-pill ok';
  } else {
    pill.textContent = 'Reconnecting…';
    pill.className = 'conn-pill down';
  }
}

function handleMessage(msg) {
  if (msg.type === 'error') {
    showJoinError(msg.message);
    return;
  }
  if (msg.type !== 'state') return;
  S = msg.state;
  me = msg.you;
  if (pendingCat && (S.phase !== 'playing' || me !== S.current)) closeConfirm();
  if (msg.event === 'roll') {
    animateRoll(() => renderAll());
  } else {
    renderAll();
  }
}

// ---------- Rendering ----------
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}

function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  $('screen-' + name).classList.add('active');
}

function renderAll() {
  if (!S) return;
  if (S.phase === 'lobby') {
    showScreen('lobby');
    renderLobby();
  } else if (S.phase === 'playing') {
    showScreen('game');
    renderGame();
  } else {
    showScreen('over');
    renderGameOver();
  }
}

// ---------- Lobby ----------
const nameInput = $('name-input');

function normalizeInitials(value) {
  return value.replace(/[^a-zA-Z]/g, '').slice(0, 3).toUpperCase();
}

function showJoinError(text) {
  $('join-error').textContent = text || '';
}

function renderLobby() {
  showJoinError('');
  const seated = me >= 0;
  $('join-row').style.display = seated || S.players.length >= 4 ? 'none' : 'flex';

  const list = $('player-list');
  list.innerHTML = '';
  S.players.forEach((p, i) => {
    const li = document.createElement('li');
    li.innerHTML =
      `<span class="seat">${i + 1}</span>` +
      `<span>${escapeHtml(p.name)}${i === me ? ' <span class="you-tag">YOU</span>' : ''}</span>` +
      (p.connected ? '' : '<span class="offline-tag">offline</span>') +
      (i === 0 ? '<span class="host-tag">HOST</span>' : '');
    list.appendChild(li);
  });

  const btnStart = $('btn-start');
  btnStart.style.display = me === 0 ? 'block' : 'none';
  btnStart.disabled = S.players.length < 2;

  const note = $('lobby-note');
  if (S.players.length === 0) {
    note.textContent = 'The first player to join becomes the host and starts the game.';
  } else if (me === 0) {
    note.textContent = S.players.length < 2
      ? 'You are the host. Waiting for at least one more player…'
      : "You're the host — start whenever everyone's in.";
  } else if (seated) {
    note.textContent = `Waiting for ${escapeHtml(S.players[0].name)} (host) to start the game…`;
  } else if (S.players.length >= 4) {
    note.textContent = 'Table is full (4 players).';
  } else {
    note.textContent = `${escapeHtml(S.players[0].name)} is hosting. Enter your initials to join.`;
  }
}

function joinGame() {
  const name = normalizeInitials(nameInput.value.trim());
  if (!name) return;
  localStorage.setItem('yahzms-name', name);
  send({ type: 'join', token, name });
}

nameInput.addEventListener('input', () => { nameInput.value = normalizeInitials(nameInput.value); });
$('btn-add').addEventListener('click', joinGame);
nameInput.addEventListener('keydown', e => { if (e.key === 'Enter') joinGame(); });
$('btn-start').addEventListener('click', () => send({ type: 'start' }));

// ---------- Game ----------
const diceRow = $('dice-row');

function myTurn() {
  return S.phase === 'playing' && me === S.current && !animating;
}

function renderGame() {
  renderBanner();
  renderDice();
  renderHoldHint();
  renderControls();
  renderScorecard();
}

function renderBanner() {
  const cur = S.players[S.current];
  const t = $('turn-text');
  if (me === S.current) {
    t.innerHTML = '<span class="who">Your turn!</span>';
  } else if (me === -1) {
    t.innerHTML = `<span class="who">${escapeHtml(cur.name)}</span>'s turn — you're spectating`;
  } else {
    t.innerHTML = `<span class="who">${escapeHtml(cur.name)}</span>'s turn` +
      (cur.connected ? '' : ' <span class="offline-tag">offline — waiting to reconnect</span>');
  }
  const round = Math.floor(S.turnsTaken / S.players.length) + 1;
  $('turn-round').textContent = `Round ${round} of 13`;
}

function renderDice() {
  diceRow.innerHTML = '';
  for (let i = 0; i < 5; i++) {
    const el = document.createElement('div');
    el.className = 'die';
    el.dataset.v = S.dice[i];
    if (S.held[i]) el.classList.add('held');
    if (!myTurn() || S.rollsUsed === 0 || S.rollsUsed >= 3) el.classList.add('disabled');
    for (let p = 0; p < 9; p++) {
      const pip = document.createElement('span');
      pip.className = 'pip';
      el.appendChild(pip);
    }
    el.addEventListener('click', () => {
      if (!myTurn() || S.rollsUsed === 0 || S.rollsUsed >= 3) return;
      send({ type: 'hold', i });
    });
    diceRow.appendChild(el);
  }
}

function renderHoldHint() {
  const el = $('hold-hint');
  if (!myTurn()) {
    el.textContent = me === -1 ? 'Watching the table' : `Waiting for ${escapeHtml(S.players[S.current].name)}…`;
    return;
  }
  if (S.rollsUsed === 0) el.textContent = 'Roll to begin your turn';
  else if (S.rollsUsed >= 3) el.textContent = 'No rolls left — pick a score';
  else el.textContent = S.held.some(h => h) ? 'Held dice are kept on the next roll' : 'Tap dice to hold them';
}

function renderControls() {
  const btn = $('btn-roll');
  btn.style.display = me === S.current ? 'block' : 'none';
  btn.disabled = !myTurn() || S.rollsUsed >= 3;
  btn.textContent = S.rollsUsed === 0 ? 'Roll Dice' : (S.rollsUsed >= 3 ? 'Pick a score →' : 'Roll Again');

  let dots = '';
  for (let i = 0; i < 3; i++) dots += `<span class="dot${i < S.rollsUsed ? ' used' : ''}"></span>`;
  $('rolls-left').innerHTML = `Rolls: ${dots}`;

  const jn = $('joker-note');
  const cur = S.players[S.current];
  if (S.rollsUsed > 0 && isYahtzeeRoll(S.dice)) {
    const js = jokerState(cur, S.dice);
    if (js.joker) {
      jn.textContent = js.bonus ? '🎉 Bonus Yahtzee! +100 points — joker rules apply' : 'Yahtzee again — joker rules apply';
    } else if (cur.scores.yahtzee === undefined) {
      jn.textContent = '🎲 YAHTZEE!';
    } else jn.textContent = '';
  } else jn.textContent = '';
}

$('btn-roll').addEventListener('click', () => {
  if (!myTurn() || S.rollsUsed >= 3) return;
  send({ type: 'roll' });
});

function animateRoll(done) {
  const els = [...diceRow.children];
  if (els.length !== 5) { done(); return; }
  animating = true;
  els.forEach((el, i) => { if (!S.held[i]) el.classList.add('rolling'); });
  let ticks = 0;
  const iv = setInterval(() => {
    ticks++;
    els.forEach((el, i) => {
      if (!S.held[i]) el.dataset.v = 1 + Math.floor(Math.random() * 6);
    });
    if (ticks >= 8) {
      clearInterval(iv);
      animating = false;
      done();
    }
  }, 70);
}

// ---------- Scorecard ----------
function scoreCell(p, pi, cat) {
  const td = document.createElement('td');
  const scored = p.scores[cat.id];
  if (scored !== undefined) {
    td.textContent = scored;
    td.className = 'scored';
    if (cat.id === 'yahtzee' && p.yahtzeeBonus > 0) {
      td.textContent = `${scored} +${p.yahtzeeBonus}`;
    }
    return td;
  }
  // Open cell: show potential for the current player once they've rolled
  if (pi === S.current && S.rollsUsed > 0 && !animating) {
    const js = jokerState(p, S.dice);
    const allowed = js.allowed === null || js.allowed.includes(cat.id);
    if (allowed) {
      const pts = calcScore(cat.id, S.dice, js.joker);
      td.textContent = pts;
      td.className = 'potential' + (pts === 0 ? ' zero' : '') + (pi === me ? '' : ' readonly');
      if (pi === me) {
        td.title = `Score ${pts} in ${cat.label}`;
        td.addEventListener('click', () => openConfirm(cat, pts));
      }
    } else {
      td.className = 'locked-out';
      td.textContent = '–';
      td.title = 'Not available under joker rules this turn';
    }
  }
  return td;
}

function renderScorecard() {
  const table = $('score-table');
  table.innerHTML = '';

  const thead = document.createElement('thead');
  const hr = document.createElement('tr');
  hr.innerHTML = '<th></th>' + S.players.map((p, i) =>
    `<th${i === S.current ? ' class="current"' : ''}>${escapeHtml(p.name)}${i === me ? '<small class="th-you">you</small>' : ''}${p.connected ? '' : '<small class="th-off">offline</small>'}</th>`).join('');
  thead.appendChild(hr);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');

  const sectionRow = label => {
    const tr = document.createElement('tr');
    tr.className = 'section-head';
    tr.innerHTML = `<td colspan="${S.players.length + 1}">${label}</td>`;
    return tr;
  };
  const catRow = cat => {
    const tr = document.createElement('tr');
    const name = document.createElement('td');
    name.className = 'cat-name';
    name.innerHTML = `${cat.label} <small>${cat.sub}</small>`;
    tr.appendChild(name);
    S.players.forEach((p, pi) => tr.appendChild(scoreCell(p, pi, cat)));
    return tr;
  };
  const totalRow = (label, fn, cls = 'totals') => {
    const tr = document.createElement('tr');
    tr.className = cls;
    tr.innerHTML = `<td>${label}</td>` + S.players.map(p => `<td>${fn(p)}</td>`).join('');
    return tr;
  };

  tbody.appendChild(sectionRow('Upper Section'));
  UPPER.forEach(c => tbody.appendChild(catRow(c)));
  tbody.appendChild(totalRow('Subtotal', upperSubtotal));
  tbody.appendChild(totalRow('Bonus (63+ → 35)', upperBonus));
  tbody.appendChild(sectionRow('Lower Section'));
  LOWER.forEach(c => tbody.appendChild(catRow(c)));
  tbody.appendChild(totalRow('Grand Total', grandTotal, 'grand'));

  table.appendChild(tbody);
}

// ---------- Score confirm modal ----------
let pendingCat = null;

function openConfirm(cat, pts) {
  pendingCat = cat.id;
  const scrub = pts === 0;
  $('confirm-card').classList.toggle('scrub', scrub);
  $('confirm-text').innerHTML = scrub
    ? `Nae score in <strong>${cat.label}</strong>. Take a <strong>zero</strong> like the scrub ye are?`
    : `Score <strong>${pts}</strong> point${pts === 1 ? '' : 's'} in <strong>${cat.label}</strong>?`;
  $('btn-confirm').textContent = scrub ? `Aye, scrub ${cat.label}` : 'Score it';
  $('confirm-overlay').classList.add('active');
}

function closeConfirm() {
  pendingCat = null;
  $('confirm-overlay').classList.remove('active');
}

$('btn-confirm').addEventListener('click', () => {
  if (pendingCat) send({ type: 'score', catId: pendingCat });
  closeConfirm();
});
$('btn-cancel').addEventListener('click', closeConfirm);
$('confirm-overlay').addEventListener('click', e => {
  if (e.target === $('confirm-overlay')) closeConfirm();
});

// ---------- Game over ----------
function renderGameOver() {
  const ranked = S.players
    .map((p, i) => ({ p, i }))
    .sort((a, b) => grandTotal(b.p) - grandTotal(a.p));
  $('winner-name').textContent = ranked[0].p.name;
  const ol = $('ranking');
  ol.innerHTML = '';
  const medals = ['🥇', '🥈', '🥉', '4th'];
  ranked.forEach(({ p }, i) => {
    const li = document.createElement('li');
    li.innerHTML = `<span>${medals[i]} ${escapeHtml(p.name)}${S.players[me] === p ? ' (you)' : ''}</span><span class="pts">${grandTotal(p)}</span>`;
    ol.appendChild(li);
  });
}

$('btn-again').addEventListener('click', () => send({ type: 'again' }));

// ---------- Boot ----------
const savedName = localStorage.getItem('yahzms-name');
if (savedName) nameInput.value = savedName;
connect();
