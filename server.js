const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const https = require('https');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  transports: ['websocket', 'polling'],
  pingInterval: 10000,
  pingTimeout: 30000,
  maxHttpBufferSize: 1e6
});

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, 'public');
const USERS_FILE = path.join(__dirname, 'users.json');
const SCREEN_FILE = path.join(__dirname, 'screen-state.json');
const LAMP_FILE = path.join(__dirname, 'lamp-state.json');
const HOST_NAME = 'mvxtra';
const ROOM = 'ews-club';

const LANGS = new Set(['ru','en','es','de','fr','zh','ja','ko','ar','hi','pt','it','tr','uk','nl','pl']);
const players = new Map();
const ghosts = new Map();
let nextGhostId = 1;
let ghostTimer = null;
let defeatedGhosts = 0;
let defeatedBosses = 0;
let bossEncountered = false;

const world = {
  minX: -15, maxX: 15,
  minZ: -13, maxZ: 13,
  groundY: 0
};

const defaultScreen = {
  active: true,
  src: process.env.SCREEN_URL || '/hls/ews/index.m3u8',
  type: 'video',
  title: 'EWS SESSIONS',
  version: 1
};

function readScreen() {
  try {
    const data = JSON.parse(fs.readFileSync(SCREEN_FILE, 'utf8'));
    return {
      active: data.active !== false,
      src: String(data.src || defaultScreen.src),
      type: data.type === 'iframe' ? 'iframe' : 'video',
      title: String(data.title || defaultScreen.title),
      version: Number(data.version) || 1
    };
  } catch {
    return { ...defaultScreen };
  }
}

const screen = readScreen();
function readLampColor(){ try { const d=JSON.parse(fs.readFileSync(LAMP_FILE,'utf8')); return d.color==='red'?'red':'white'; } catch { return 'white'; } }
function writeLampColor(){ fs.writeFileSync(LAMP_FILE, JSON.stringify({color:lampColor},null,2),'utf8'); }
let lampColor=readLampColor();
fs.mkdirSync(PUBLIC_DIR, { recursive: true });
if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, '[]\n', 'utf8');

function readUsers() {
  try {
    const data = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function writeUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), 'utf8');
}

function writeScreen() {
  fs.writeFileSync(SCREEN_FILE, JSON.stringify(screen, null, 2), 'utf8');
}

function newSessionToken() {
  return crypto.randomBytes(32).toString('hex');
}

function safeUserResponse(user) {
  return { ok: true, username: user.username, token: user.token };
}

function cleanName(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, 24);
}

function validName(name) {
  return name.length >= 2 &&
    name.length <= 24 &&
    /^[a-zA-Z0-9_а-яА-ЯёЁ -]+$/.test(name);
}

function hashLegacy(password) {
  return crypto.createHash('sha256').update(String(password)).digest('hex');
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return 'scrypt:' + salt + ':' + hash;
}

function verifyPassword(password, stored) {
  const value = String(stored || '');
  if (value.startsWith('scrypt:')) {
    const parts = value.split(':');
    if (parts.length !== 3) return false;
    const expected = Buffer.from(parts[2], 'hex');
    const actual = crypto.scryptSync(String(password), parts[1], 64);
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  }
  return value === hashLegacy(password);
}

function ensureHost() {
  const users = readUsers();
  const found = users.some(u => String(u.username || '').toLowerCase() === HOST_NAME);
  const host = users.find(u => String(u.username || '').toLowerCase() === HOST_NAME);
  if (!host) {
    users.push({
      username: HOST_NAME,
      password: hashLegacy('123456'),
      token: newSessionToken(),
      createdAt: new Date().toISOString()
    });
    writeUsers(users);
  } else if (!host.token) {
    host.token = newSessionToken();
    writeUsers(users);
  }
}
ensureHost();

app.use(express.json({ limit: '64kb' }));
app.use(express.urlencoded({ extended: false }));
app.use(express.static(PUBLIC_DIR, { extensions: ['html'] }));

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'EWS SESSIONS', multiplayer: true, screen: true });
});

app.post('/api/register', (req, res) => {
  const username = cleanName(req.body?.username);
  const password = String(req.body?.password || '');

  if (!validName(username)) return res.status(400).json({ ok:false, error:'Имя: 2–24 символа, буквы/цифры/_/-.' });
  if (password.length < 4 || password.length > 128) return res.status(400).json({ ok:false, error:'Пароль должен быть 4–128 символов.' });

  const users = readUsers();
  if (users.some(u => String(u.username || '').toLowerCase() === username.toLowerCase())) {
    return res.status(409).json({ ok:false, error:'Это имя уже занято.' });
  }

  const user = { username, password: hashPassword(password), token: newSessionToken(), createdAt: new Date().toISOString() };
  users.push(user);
  writeUsers(users);
  res.json(safeUserResponse(user));
});

app.post('/api/login', (req, res) => {
  const username = cleanName(req.body?.username);
  const password = String(req.body?.password || '');
  const user = readUsers().find(u => String(u.username || '').toLowerCase() === username.toLowerCase());

  if (!user || !verifyPassword(password, user.password)) {
    return res.status(401).json({ ok:false, error:'Неверное имя или пароль.' });
  }

  if (!user.token) {
    user.token = newSessionToken();
    const users = readUsers();
    const idx = users.findIndex(u => String(u.username || '').toLowerCase() === String(user.username).toLowerCase());
    if (idx >= 0) { users[idx].token = user.token; writeUsers(users); }
  }

  res.json(safeUserResponse(user));
});

app.post('/api/session', (req, res) => {
  const token = String(req.body?.token || '').trim();
  if (!token) return res.status(401).json({ ok:false, error:'Сессия отсутствует.' });
  const user = readUsers().find(u => u.token && u.token === token);
  if (!user) return res.status(401).json({ ok:false, error:'Сессия истекла.' });
  res.json(safeUserResponse(user));
});

const translationCache = new Map();

function translateLanguage(value) {
  const lang = String(value || 'en').toLowerCase();
  return LANGS.has(lang) ? lang : 'en';
}

function getText(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'EWS-SESSIONS/3.0' } }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => body += chunk);
      response.on('end', () => {
        if (response.statusCode >= 200 && response.statusCode < 300) resolve(body);
        else reject(new Error('translation HTTP ' + response.statusCode));
      });
    });
    req.setTimeout(5000, () => req.destroy(new Error('translation timeout')));
    req.on('error', reject);
  });
}

async function translateText(text, target) {
  const source = String(text || '').trim().slice(0, 500);
  const lang = translateLanguage(target);
  if (!source) return '';
  if (lang === 'auto') return source;

  const key = lang + '\n' + source;
  if (translationCache.has(key)) return translationCache.get(key);

  try {
    const url =
      'https://translate.googleapis.com/translate_a/single?client=gtx' +
      '&sl=auto&tl=' + encodeURIComponent(lang) +
      '&dt=t&q=' + encodeURIComponent(source);

    const data = JSON.parse(await getText(url));
    const result = Array.isArray(data?.[0])
      ? data[0].map(x => Array.isArray(x) ? x[0] : '').join('')
      : source;

    const value = result || source;
    if (translationCache.size > 1000) translationCache.delete(translationCache.keys().next().value);
    translationCache.set(key, value);
    return value;
  } catch {
    return source;
  }
}

app.post('/api/translate', async (req, res) => {
  const text = String(req.body?.text || '').trim().slice(0, 500);
  const target = translateLanguage(req.body?.target);
  res.json({ ok:true, text: await translateText(text, target) });
});

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function normalizePlayer(p) {
  return {
    id: p.id,
    username: p.username,
    language: p.language,
    x: p.x,
    y: world.groundY,
    z: p.z,
    yaw: p.yaw,
    moving: p.moving,
    vy: p.vy || 0,
    grounded: p.grounded !== false,
    seated: !!p.seated
  };
}

function screenState() {
  return { ...screen };
}

function onlineState() {
  return [...players.values()].map(p => ({
    username: p.username,
    language: p.language
  }));
}

function broadcastOnline() {
  io.to(ROOM).emit('online:state', onlineState());
}

function spawnGhost() {
  if (ghosts.size >= 2) return;
  const id = 'ghost-' + nextGhostId++;
  const ghost = {
    id,
    hp: 10,
    x: (Math.random() * 16) - 8,
    y: 2.8 + Math.random() * 2.4,
    z: (Math.random() * 10) - 2,
    born: Date.now(),
    phase: Math.random() * Math.PI * 2,
    speed: 0.7 + Math.random() * 0.45,
    radius: 2.2 + Math.random() * 1.8,
    life: 0
  };
  ghosts.set(id, ghost);
  io.to(ROOM).emit('ghost:spawn', ghost);
}

function broadcastGhosts() {
  io.to(ROOM).emit('ghost:state', [...ghosts.values()]);
}

function ghostScoreState() {
  return { ghosts: defeatedGhosts, bosses: defeatedBosses };
}

function broadcastGhostScore() {
  io.to(ROOM).emit('ghost:score', ghostScoreState());
}

function startGhostEvents() {
  clearInterval(ghostTimer);
  const schedule = () => {
    const delay = 14000 + Math.floor(Math.random() * 18000);
    ghostTimer = setTimeout(() => {
      spawnGhost();
      schedule();
    }, delay);
  };
  schedule();
}
startGhostEvents();

function randomSpawn() {
  const points = [
    [0,10],[3,8],[-3,8],[6,5],[-6,5],
    [8,1],[-8,1],[4,-1],[-4,-1],[0,-4]
  ];
  const free = points.filter(([x,z]) =>
    ![...players.values()].some(p => Math.hypot(p.x-x, p.z-z) < 1.5)
  );
  const [x,z] = free[Math.floor(Math.random()*free.length)] || [0,8];
  return { x, z };
}

io.on('connection', socket => {
  socket.on('join', payload => {
    const username = cleanName(payload?.username);
    if (!validName(username)) return;

    const spawn = randomSpawn();
    const player = {
      id: socket.id,
      username,
      language: translateLanguage(payload?.language),
      x: spawn.x,
      y: 0,
      z: spawn.z,
      yaw: 0,
      moving: false,
      vy: 0,
      grounded: true,
      seated: false
    };

    players.set(socket.id, player);
    socket.join(ROOM);
    socket.data.joined = true;
    socket.data.username = username;

    socket.emit('club:ready', {
      username,
      host: username.toLowerCase() === HOST_NAME,
      screen: screenState(),
      lampColor
    });

    socket.emit('world:state', {
      players: [...players.values()].map(normalizePlayer),
      screen: screenState()
    });
    socket.emit('ghost:state', [...ghosts.values()]);
    socket.emit('ghost:score', ghostScoreState());

    socket.to(ROOM).emit('player:joined', normalizePlayer(player));
    broadcastOnline();
  });

  socket.on('world:request', () => {
    if (!socket.data.joined) return;
    socket.emit('world:state', {
      players: [...players.values()].map(normalizePlayer),
      screen: screenState()
    });
    socket.emit('online:state', onlineState());
    socket.emit('lamp-color:state', lampColor);
    socket.emit('ghost:state', [...ghosts.values()]);
    socket.emit('ghost:score', ghostScoreState());
  });

  socket.on('player:state', data => {
    const p = players.get(socket.id);
    if (!p || !socket.data.joined || !data) return;

    p.x = clamp(Number(data.x) || 0, world.minX, world.maxX);
    p.z = clamp(Number(data.z) || 0, world.minZ, world.maxZ);
    p.yaw = Number.isFinite(Number(data.yaw)) ? Number(data.yaw) : p.yaw;
    p.moving = !!data.moving;
    p.vy = Number.isFinite(Number(data.vy)) ? Number(data.vy) : 0;
    p.grounded = data.grounded !== false;
    p.seated = !!data.seated;

    socket.to(ROOM).emit('player:state', normalizePlayer(p));
  });

  socket.on('ghost:hit', ghostId => {
    const p = players.get(socket.id);
    if (!p || !socket.data.joined) return;
    const id = String(ghostId || '');
    const ghost = ghosts.get(id);
    if (!ghost) return;

    ghost.hp -= 1;
    if (ghost.hp <= 0) {
      ghosts.delete(id);
      if (!ghost.boss) {
        defeatedGhosts++;
        broadcastGhostScore();
        io.to(ROOM).emit('ghost:progress', { count: defeatedGhosts, target: 50 });
        io.to(ROOM).emit('ghost:dead', { id, by: p.username, count: defeatedGhosts });
        if (defeatedGhosts >= 50 && !bossEncountered) {
          bossEncountered = true;
          const boss = {
            id: 'ghost-boss-1', hp: 100, boss: true,
            x: (Math.random() * 10) - 5, y: 4.2, z: (Math.random() * 8) - 1,
            born: Date.now(), phase: Math.random() * Math.PI * 2,
            speed: 0.42, radius: 3.4, life: 0
          };
          ghosts.set(boss.id, boss);
          io.to(ROOM).emit('ghost:boss-spawn', boss);
        }
      } else {
        defeatedBosses++;
        io.to(ROOM).emit('ghost:dead', { id, by: p.username, boss: true });
        broadcastGhostScore();
      }
    } else {
      io.to(ROOM).emit('ghost:hit', { id, hp: ghost.hp, by: p.username });
    }
  });



  socket.on('blackout:start', () => {
    const p = players.get(socket.id);
    if (!p || p.username.toLowerCase() !== HOST_NAME) return;
    io.to(ROOM).emit('blackout:start');
  });

  socket.on('lamp-color:set', value => {
    const p=players.get(socket.id);
    if(!p || p.username.toLowerCase()!==HOST_NAME) return;
    const color=String(value||'').toLowerCase();
    if(color!=='red' && color!=='white') return;
    lampColor=color;
    writeLampColor();
    io.to(ROOM).emit('lamp-color:state',lampColor);
  });

  socket.on('language:set', value => {
    const p = players.get(socket.id);
    if (!p) return;
    p.language = translateLanguage(value);
    socket.emit('language:state', p.language);
    broadcastOnline();
  });

  socket.on('chat:send', async raw => {
    const p = players.get(socket.id);
    if (!p) return;

    const text = String(raw || '').trim().slice(0, 240);
    if (!text) return;

    const message = {
      id: crypto.randomBytes(8).toString('hex'),
      user: p.username,
      text,
      ts: Date.now()
    };

    // Each viewer translates locally through /api/translate, so one user's
    // language choice never changes another user's chat.
    io.to(ROOM).emit('chat:message', message);
  });

  socket.on('screen:set', payload => {
    const p = players.get(socket.id);
    if (!p || p.username.toLowerCase() !== HOST_NAME) return;

    const src = String(payload?.src || '').trim().slice(0, 2000);
    const type = payload?.type === 'iframe' ? 'iframe' : 'video';

    if (!src) {
      screen.active = false;
      screen.src = '';
      screen.type = 'video';
      screen.title = '';
    } else {
      screen.active = true;
      screen.src = src;
      screen.type = type;
      screen.title = String(payload?.title || 'EWS SESSIONS').trim().slice(0, 100);
    }

    screen.version++;
    writeScreen();
    io.to(ROOM).emit('screen:state', screenState());
  });

  socket.on('screen:request', () => {
    if (socket.data.joined) socket.emit('screen:state', screenState());
  });

  socket.on('disconnect', () => {
    if (!players.has(socket.id)) return;
    players.delete(socket.id);
    socket.to(ROOM).emit('player:left', socket.id);
    broadcastOnline();
  });
});

app.get('*', (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

setInterval(() => {
  const now = Date.now();
  for (const [id, ghost] of ghosts) {
    if (ghost.life > 0 && now - ghost.born >= ghost.life) {
      ghosts.delete(id);
      io.to(ROOM).emit('ghost:dead', { id, expired: true });
    }
  }
}, 2000);

server.listen(PORT, '0.0.0.0', () => {
  console.log('======================================');
  console.log(' EWS SESSIONS — CLEAN BUILD');
  console.log(' PORT:', PORT);
  console.log(' MULTIPLAYER: ON');
  console.log(' AUTH: ON');
  console.log(' TRANSLATION: ON');
  console.log(' SCREEN HOST:', HOST_NAME);
  console.log(' SCREEN SRC:', screen.src);
  console.log('======================================');
});