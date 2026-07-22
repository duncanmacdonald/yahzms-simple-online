'use strict';

const path = require('path');
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// ---------- Category definitions ----------
const UPPER = ['ones', 'twos', 'threes', 'fours', 'fives', 'sixes'];
const LOWER = ['threeKind', 'fourKind', 'fullHouse', 'smStraight', 'lgStraight', 'yahtzee', 'chance'];
const ALL_CATS = [...UPPER, ...LOWER];

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
  const upperIdx = UPPER.indexOf(catId);
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

// Joker rules: rolled a Yahtzee but the Yahtzee box is already filled.
function jokerState(player, d) {
  if (!isYahtzeeRoll(d) || player.scores.yahtzee === undefined) {
    return { joker: false, allowed: null, bonus: false };
  }
  const bonus = player.scores.yahtzee === 50;
  const matchingUpper = UPPER[d[0] - 1];
  if (player.scores[matchingUpper] === undefined) {
    return { joker: true, allowed: [matchingUpper], bonus };
  }
  const openLower = LOWER.filter(id => id !== 'yahtzee' && player.scores[id] === undefined);
  if (openLower.length > 0) {
    return { joker: true, allowed: openLower, bonus };
  }
  const openUpper = UPPER.filter(id => player.scores[id] === undefined);
  return { joker: true, allowed: openUpper, bonus };
}

const cardComplete = p => ALL_CATS.every(id => p.scores[id] !== undefined);

// ---------- Game state ----------
// One shared table per server instance.
let game = newGame();
let emptyResetTimer = null;

function newGame() {
  return {
    phase: 'lobby',            // lobby | playing | over
    players: [],               // { token, name, ws, connected, scores, yahtzeeBonus, lobbyTimer }
    current: 0,
    turnsTaken: 0,
    dice: [1, 1, 1, 1, 1],
    held: [false, false, false, false, false],
    rollsUsed: 0,
    lastScore: null,           // { name, catId, zero } — the most recent score
  };
}

function resetTurn() {
  game.dice = [1, 1, 1, 1, 1];
  game.held = [false, false, false, false, false];
  game.rollsUsed = 0;
}

function publicState() {
  return {
    phase: game.phase,
    players: game.players.map(p => ({
      name: p.name,
      connected: p.connected,
      scores: p.scores,
      yahtzeeBonus: p.yahtzeeBonus,
    })),
    current: game.current,
    turnsTaken: game.turnsTaken,
    dice: game.dice,
    held: game.held,
    rollsUsed: game.rollsUsed,
    lastScore: game.lastScore,
  };
}

function indexOfToken(token) {
  return game.players.findIndex(p => p.token === token);
}

function broadcast(event, extra) {
  const state = publicState();
  for (const client of wss.clients) {
    if (client.readyState !== 1) continue;
    client.send(JSON.stringify({
      type: 'state',
      state,
      you: client.token ? indexOfToken(client.token) : -1,
      event: event || null,
      ...(extra || {}),
    }));
  }
}

function sendError(ws, message) {
  if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'error', message }));
}

function normalizeInitials(value) {
  return String(value || '').replace(/[^a-zA-Z]/g, '').slice(0, 3).toUpperCase();
}

// ---------- Message handlers ----------
function handleHello(ws, msg) {
  const token = String(msg.token || '');
  if (!token) return sendError(ws, 'Missing token');
  ws.token = token;
  const i = indexOfToken(token);
  if (i !== -1) {
    // Reclaim seat (refresh / reconnect)
    const p = game.players[i];
    p.connected = true;
    p.ws = ws;
    if (p.lobbyTimer) { clearTimeout(p.lobbyTimer); p.lobbyTimer = null; }
    cancelEmptyReset();
  }
  broadcast();
}

function handleJoin(ws, msg) {
  const token = String(msg.token || '');
  if (!token) return sendError(ws, 'Missing token');
  ws.token = token;
  if (indexOfToken(token) !== -1) return broadcast();
  if (game.phase !== 'lobby') return sendError(ws, 'A game is in progress — you can watch until it ends.');
  if (game.players.length >= 4) return sendError(ws, 'Table is full (4 players).');
  const name = normalizeInitials(msg.name);
  if (!name) return sendError(ws, 'Enter 1–3 initials to join.');
  if (game.players.some(p => p.name === name)) return sendError(ws, `"${name}" is taken — pick different initials.`);
  game.players.push({
    token, name, ws,
    connected: true,
    scores: {},
    yahtzeeBonus: 0,
    lobbyTimer: null,
  });
  cancelEmptyReset();
  broadcast();
}

function handleStart(ws) {
  const i = ws.token ? indexOfToken(ws.token) : -1;
  if (game.phase !== 'lobby') return;
  if (i !== 0) return sendError(ws, 'Only the host can start the game.');
  if (game.players.length < 2) return sendError(ws, 'Need at least 2 players.');
  game.phase = 'playing';
  game.current = 0;
  game.turnsTaken = 0;
  game.lastScore = null;
  resetTurn();
  broadcast('start');
}

function handleRoll(ws) {
  const i = ws.token ? indexOfToken(ws.token) : -1;
  if (game.phase !== 'playing' || i !== game.current) return;
  if (game.rollsUsed >= 3) return;
  game.rollsUsed++;
  for (let d = 0; d < 5; d++) {
    if (!game.held[d]) game.dice[d] = 1 + Math.floor(Math.random() * 6);
  }
  broadcast('roll');
}

function handleHold(ws, msg) {
  const i = ws.token ? indexOfToken(ws.token) : -1;
  if (game.phase !== 'playing' || i !== game.current) return;
  if (game.rollsUsed === 0 || game.rollsUsed >= 3) return;
  const d = Number(msg.i);
  if (!Number.isInteger(d) || d < 0 || d > 4) return;
  game.held[d] = !game.held[d];
  broadcast();
}

function handleScore(ws, msg) {
  const i = ws.token ? indexOfToken(ws.token) : -1;
  if (game.phase !== 'playing' || i !== game.current) return;
  if (game.rollsUsed === 0) return;
  const catId = String(msg.catId || '');
  if (!ALL_CATS.includes(catId)) return;
  const p = game.players[i];
  if (p.scores[catId] !== undefined) return;
  const js = jokerState(p, game.dice);
  if (js.allowed !== null && !js.allowed.includes(catId)) return;
  const pts = calcScore(catId, game.dice, js.joker);
  p.scores[catId] = pts;
  if (js.bonus) p.yahtzeeBonus += 100;
  game.lastScore = { name: p.name, catId, zero: pts === 0 };
  // Celebrate when a real Yahtzee is banked: 50 in the Yahtzee box, or a bonus Yahtzee.
  const celebrated = isYahtzeeRoll(game.dice) &&
    ((catId === 'yahtzee' && p.scores.yahtzee === 50) || js.bonus);
  endTurn(celebrated ? p.name : null);
}

function endTurn(celebrate) {
  game.turnsTaken++;
  const extra = celebrate ? { celebrate } : null;
  if (game.players.every(cardComplete)) {
    game.phase = 'over';
    broadcast('over', extra);
    return;
  }
  game.current = (game.current + 1) % game.players.length;
  resetTurn();
  broadcast('turn', extra);
}

function handleAgain(ws) {
  if (game.phase !== 'over') return;
  if (!ws.token || indexOfToken(ws.token) === -1) return;
  // Keep connected players seated, clear scores, back to the lobby.
  game.players = game.players.filter(p => p.connected);
  game.players.forEach(p => { p.scores = {}; p.yahtzeeBonus = 0; });
  game.phase = 'lobby';
  game.current = 0;
  game.turnsTaken = 0;
  game.lastScore = null;
  resetTurn();
  broadcast();
}

// Host can remove a disconnected player so a game can't get stuck.
function handleBoot(ws, msg) {
  const i = ws.token ? indexOfToken(ws.token) : -1;
  if (i !== 0) return sendError(ws, 'Only the host can remove players.');
  const target = Number(msg.index);
  if (!Number.isInteger(target) || target <= 0 || target >= game.players.length) return;
  if (game.players[target].connected) return sendError(ws, 'You can only remove disconnected players.');
  removePlayer(target);
  broadcast();
}

function removePlayer(index) {
  const p = game.players[index];
  if (p.lobbyTimer) clearTimeout(p.lobbyTimer);
  game.players.splice(index, 1);
  if (game.players.length === 0) {
    game = newGame();
    return;
  }
  if (game.phase === 'playing') {
    if (index < game.current) {
      game.current--;
    } else if (index === game.current) {
      game.current = game.current % game.players.length;
      resetTurn();
    }
    if (game.players.length < 2 || game.players.every(cardComplete)) {
      game.phase = game.players.every(cardComplete) ? 'over' : 'lobby';
      if (game.phase === 'lobby') {
        game.players.forEach(pl => { pl.scores = {}; pl.yahtzeeBonus = 0; });
        game.current = 0;
        game.turnsTaken = 0;
        resetTurn();
      }
    }
  }
}

// ---------- Disconnect handling ----------
function handleClose(ws) {
  if (!ws.token) return;
  const i = indexOfToken(ws.token);
  if (i === -1) return;
  const p = game.players[i];
  if (p.ws !== ws) return; // superseded by a newer connection
  // If another open tab holds the same seat, hand the seat to it.
  for (const other of wss.clients) {
    if (other !== ws && other.token === p.token && other.readyState === 1) {
      p.ws = other;
      return;
    }
  }
  p.connected = false;
  p.ws = null;
  if (game.phase === 'lobby') {
    // Short grace period for refreshes, then free the seat.
    p.lobbyTimer = setTimeout(() => {
      const j = indexOfToken(p.token);
      if (j !== -1 && !game.players[j].connected) {
        game.players.splice(j, 1);
        if (game.players.length === 0) game = newGame();
        broadcast();
      }
    }, 15000);
  }
  // If everyone has left mid-game, reset the table after 10 minutes.
  if (game.players.every(pl => !pl.connected)) {
    cancelEmptyReset();
    emptyResetTimer = setTimeout(() => {
      if (game.players.every(pl => !pl.connected)) {
        game = newGame();
        broadcast();
      }
    }, 10 * 60 * 1000);
  }
  broadcast();
}

function cancelEmptyReset() {
  if (emptyResetTimer) { clearTimeout(emptyResetTimer); emptyResetTimer = null; }
}

// ---------- Emoji reactions ----------
// Anyone connected (players and spectators) can fire these; the server
// rebroadcasts to everyone so all screens rain the same emoji. A light
// per-connection throttle caps flooding.
const EMOTES = new Set(['🎉', '🙈']);

function handleEmote(ws, msg) {
  const emoji = String(msg.emoji || '');
  if (!EMOTES.has(emoji)) return;
  const now = Date.now();
  if (ws.lastEmote && now - ws.lastEmote < 50) return;
  ws.lastEmote = now;
  const payload = JSON.stringify({ type: 'emote', emoji });
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(payload);
  }
}

// ---------- Wire it up ----------
wss.on('connection', ws => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    switch (msg.type) {
      case 'hello': return handleHello(ws, msg);
      case 'join':  return handleJoin(ws, msg);
      case 'start': return handleStart(ws);
      case 'roll':  return handleRoll(ws);
      case 'hold':  return handleHold(ws, msg);
      case 'score': return handleScore(ws, msg);
      case 'again': return handleAgain(ws);
      case 'boot':  return handleBoot(ws, msg);
      case 'emote': return handleEmote(ws, msg);
    }
  });
  ws.on('close', () => handleClose(ws));
  ws.on('error', () => {});
});

// Keepalive: drop dead sockets so seats free up.
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);

server.listen(PORT, () => {
  console.log(`Yahzms online listening on port ${PORT}`);
});
