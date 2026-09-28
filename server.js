const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const https = require('https');
const { Server } = require('socket.io');

const app = express();
app.set('trust proxy', 1);

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  },
  transports: ['websocket', 'polling'],
  pingInterval: 10000,
  pingTimeout: 25000
});

const PORT = Number(process.env.PORT || 3000);

const PUBLIC_DIR = path.join(__dirname, 'public');
const USERS_FILE = path.join(__dirname, 'users.json');

const SCREEN_HOST = 'mvxtra';
const CLUB_ROOM = 'ews-club';

const WORLD = {
  groundY: 0,
  minX: -16,
  maxX: 16,
  minZ: -15.5,
  maxZ: 15.5,
  maxJumpY: 4.5
};

const EMOTES = new Set([1, 2, 3, 4, 5, 6]);

const SPAWN_POINTS = [
  { x: 0, z: 13 },
  { x: 3, z: 10 },
  { x: -3, z: 10 },
  { x: 6, z: 7 },
  { x: -6, z: 7 },
  { x: 8, z: 3 },
  { x: -8, z: 3 }
];

fs.mkdirSync(PUBLIC_DIR, { recursive: true });

if (!fs.existsSync(USERS_FILE)) {
  fs.writeFileSync(USERS_FILE, JSON.stringify([], null, 2), 'utf8');
}

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(PUBLIC_DIR));

/* =========================================================
   USERS / AUTH
========================================================= */

function readUsers() {
  try {
    const users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
    return Array.isArray(users) ? users : [];
  } catch (error) {
    console.error('USERS READ ERROR:', error.message);
    return [];
  }
}

function saveUsers(users) {
  fs.writeFileSync(
    USERS_FILE,
    JSON.stringify(users, null, 2),
    'utf8'
  );
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

    return (
      expected.length === actual.length &&
      crypto.timingSafeEqual(expected, actual)
    );
  }

  const legacy = crypto
    .createHash('sha256')
    .update(String(password))
    .digest('hex');

  return legacy === value;
}

function cleanUsername(value) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, 24);
}

function isValidUsername(username) {
  return (
    username.length >= 2 &&
    username.length <= 24 &&
    /^[a-zA-Z0-9_\-а-яА-ЯёЁ ]+$/.test(username)
  );
}

function isScreenHost(username) {
  return (
    String(username || '').trim().toLowerCase() === SCREEN_HOST
  );
}

/* =========================================================
   AUTH RATE LIMIT
========================================================= */

const authAttempts = new Map();
const AUTH_WINDOW_MS = 10 * 60 * 1000;
const AUTH_MAX_ATTEMPTS = 20;

function authRateLimited(req) {
  const key = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const item = authAttempts.get(key);

  if (!item || now - item.startedAt > AUTH_WINDOW_MS) {
    authAttempts.set(key, {
      startedAt: now,
      count: 1
    });
    return false;
  }

  item.count += 1;
  return item.count > AUTH_MAX_ATTEMPTS;
}

setInterval(() => {
  const now = Date.now();

  for (const [key, item] of authAttempts) {
    if (now - item.startedAt > AUTH_WINDOW_MS) {
      authAttempts.delete(key);
    }
  }
}, AUTH_WINDOW_MS).unref();

/* =========================================================
   API
========================================================= */

app.get('/api/status', (req, res) => {
  res.json({
    ok: true,
    service: 'EWS SESSIONS',
    online: players.size,
    stream: true
  });
});

app.post('/api/register', (req, res) => {
  if (authRateLimited(req)) {
    return res.status(429).json({
      ok: false,
      error: 'Слишком много попыток. Попробуйте позже.'
    });
  }

  const username = cleanUsername(req.body.username);
  const password = String(req.body.password || '');

  if (!isValidUsername(username)) {
    return res.status(400).json({
      ok: false,
      error: 'Некорректное имя пользователя.'
    });
  }

  if (password.length < 4) {
    return res.status(400).json({
      ok: false,
      error: 'Пароль должен быть минимум 4 символа.'
    });
  }

  const users = readUsers();

  if (users.some(
    user =>
      String(user.username).toLowerCase() === username.toLowerCase()
  )) {
    return res.status(409).json({
      ok: false,
      error: 'Такой пользователь уже существует.'
    });
  }

  users.push({
    username,
    password: hashPassword(password),
    createdAt: Date.now()
  });

  saveUsers(users);

  res.json({
    ok: true,
    username
  });
});

app.post('/api/login', (req, res) => {
  if (authRateLimited(req)) {
    return res.status(429).json({
      ok: false,
      error: 'Слишком много попыток. Попробуйте позже.'
    });
  }

  const username = cleanUsername(req.body.username);
  const password = String(req.body.password || '');
  const users = readUsers();

  const user = users.find(
    item =>
      String(item.username).toLowerCase() === username.toLowerCase()
  );

  if (!user) {
    return res.status(401).json({
      ok: false,
      error: 'Пользователь не найден.'
    });
  }

  if (!verifyPassword(password, user.password)) {
    return res.status(401).json({
      ok: false,
      error: 'Неверный пароль.'
    });
  }

  // Upgrade legacy SHA-256 passwords on successful login.
  if (!String(user.password || '').startsWith('scrypt:')) {
    user.password = hashPassword(password);
    saveUsers(users);
  }

  res.json({
    ok: true,
    username: user.username
  });
});

/* =========================================================
   TRANSLATION
========================================================= */

const SUPPORTED_LANGUAGES = new Set([
  'ru', 'en', 'es', 'de', 'fr', 'zh', 'ja', 'ko',
  'ar', 'hi', 'pt', 'it', 'tr', 'uk', 'nl', 'pl'
]);

const translationCache = new Map();
const MAX_TRANSLATION_CACHE = 500;

function normalizeLanguage(value) {
  const lang = String(value || 'en')
    .trim()
    .toLowerCase();

  return SUPPORTED_LANGUAGES.has(lang)
    ? lang
    : 'en';
}

function httpsGetText(url, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const request = https.get(
      url,
      {
        headers: {
          'User-Agent': 'EWS-SESSIONS/2.0'
        }
      },
      response => {
        let body = '';

        response.setEncoding('utf8');

        response.on('data', chunk => {
          body += chunk;
        });

        response.on('end', () => {
          if (
            response.statusCode >= 200 &&
            response.statusCode < 300
          ) {
            resolve(body);
          } else {
            reject(new Error('HTTP ' + response.statusCode));
          }
        });
      }
    );

    request.setTimeout(timeout, () => {
      request.destroy(new Error('translation timeout'));
    });

    request.on('error', reject);
  });
}

async function translateText(text, targetLanguage) {
  if (!text) return '';

  const target = normalizeLanguage(targetLanguage);
  const source = String(text);
  const key = target + '\n' + source;

  if (translationCache.has(key)) {
    return translationCache.get(key);
  }

  try {
    const url =
      'https://translate.googleapis.com/translate_a/single' +
      '?client=gtx' +
      '&sl=auto' +
      '&tl=' + encodeURIComponent(target) +
      '&dt=t' +
      '&q=' + encodeURIComponent(source);

    const raw = await httpsGetText(url);
    const data = JSON.parse(raw);

    const translated =
      Array.isArray(data) &&
      Array.isArray(data[0])
        ? data[0]
            .map(part => Array.isArray(part) ? part[0] : '')
            .join('')
        : source;

    if (translationCache.size >= MAX_TRANSLATION_CACHE) {
      const firstKey = translationCache.keys().next().value;

      if (firstKey) {
        translationCache.delete(firstKey);
      }
    }

    translationCache.set(key, translated || source);

    return translated || source;
  } catch (error) {
    console.error('TRANSLATION ERROR:', error.message);
    return source;
  }
}

app.post('/api/translate', async (req, res) => {
  const text = String(req.body.text || '');
  const target = String(req.body.target || 'en');

  if (!text) {
    return res.json({
      ok: true,
      text: ''
    });
  }

  res.json({
    ok: true,
    text: await translateText(text, target)
  });
});

/* =========================================================
   MULTIPLAYER WORLD
   ONE SOURCE OF TRUTH
========================================================= */

const players = new Map();

const clubScreen = {
  active: false,
  src: '',
  url: '',
  name: '',
  owner: SCREEN_HOST,
  version: 0
};

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function publicPlayer(player) {
  return {
    id: player.id,
    username: player.username,
    language: player.language,
    avatar: player.avatar,
    x: player.x,
    y: player.y,
    z: player.z,
    yaw: player.yaw,
    pitch: player.pitch,
    moving: player.moving,
    jumping: player.jumping,
    dance: player.dance,
    danceStartedAt: player.danceStartedAt
  };
}

function publicScreen() {
  return {
    active: clubScreen.active,
    src: clubScreen.src,
    url: clubScreen.url,
    name: clubScreen.name,
    owner: SCREEN_HOST,
    version: clubScreen.version
  };
}

function worldSnapshot() {
  return {
    players: [...players.values()].map(publicPlayer),
    screen: publicScreen()
  };
}

function onlineSnapshot() {
  return [...players.values()].map(player => ({
    username: player.username,
    language: player.language
  }));
}

function emitOnline() {
  io.to(CLUB_ROOM).emit(
    'online:state',
    onlineSnapshot()
  );
}

function emitWorld(socket) {
  socket.emit(
    'world:state',
    worldSnapshot()
  );
}

function getSpawnPoint() {
  const free = SPAWN_POINTS.filter(point => {
    return ![...players.values()].some(player => {
      const dx = player.x - point.x;
      const dz = player.z - point.z;
      return Math.hypot(dx, dz) < 1.6;
    });
  });

  if (free.length) {
    return free[
      Math.floor(Math.random() * free.length)
    ];
  }

  return {
    x: Number((Math.random() * 14 - 7).toFixed(2)),
    z: Number((Math.random() * 8 + 5).toFixed(2))
  };
}

/* =========================================================
   SOCKET.IO
========================================================= */

io.on('connection', socket => {
  console.log('SOCKET CONNECT:', socket.id);

  socket.on('join', data => {
    data = data || {};

    const username = cleanUsername(data.username);

    if (!isValidUsername(username)) {
      return;
    }

    // The same browser can reconnect with a fresh socket.
    // Remove any state already attached to this socket first.
    players.delete(socket.id);

    const language = normalizeLanguage(data.language);
    const spawn = getSpawnPoint();

    socket.join(CLUB_ROOM);

    socket.data.joined = true;
    socket.data.username = username;

    const player = {
      id: socket.id,
      username,
      language,
      avatar: 'robot-v1',

      x: spawn.x,
      y: WORLD.groundY,
      z: spawn.z,

      yaw: 0,
      pitch: 0,

      moving: false,
      jumping: false,

      dance: 0,
      danceStartedAt: 0,

      lastUpdateAt: Date.now()
    };

    players.set(socket.id, player);

    socket.emit('screen-host', {
      host: isScreenHost(username),
      username: SCREEN_HOST
    });

    // New client gets one complete snapshot.
    emitWorld(socket);
    emitOnlineForSocket(socket);

    // Everyone already inside gets exactly one join event.
    socket.to(CLUB_ROOM).emit(
      'player:joined',
      publicPlayer(player)
    );

    emitOnline();

    console.log(
      'JOIN:',
      username,
      '|',
      language,
      '|',
      socket.id
    );
  });

  function emitOnlineForSocket(target) {
    target.emit(
      'online:state',
      onlineSnapshot()
    );
  }

  socket.on('request-world', () => {
    if (!socket.data.joined) return;
    emitWorld(socket);
    emitOnlineForSocket(socket);
  });

  socket.on('request-online', () => {
    if (!socket.data.joined) return;
    emitOnlineForSocket(socket);
  });

  /* =======================================================
     MOVEMENT
  ======================================================= */

  socket.on('player-state', data => {
    if (!socket.data.joined) return;

    const player = players.get(socket.id);

    if (!player || !data) return;

    const now = Date.now();
    const elapsed = Math.max(
      0.016,
      Math.min(
        0.25,
        (now - (player.lastUpdateAt || now)) / 1000
      )
    );

    const x = Number(data.x);
    const y = Number(data.y);
    const z = Number(data.z);
    const yaw = Number(data.yaw);
    const pitch = Number(data.pitch);

    const nextX = Number.isFinite(x)
      ? clamp(x, WORLD.minX, WORLD.maxX)
      : player.x;

    const nextZ = Number.isFinite(z)
      ? clamp(z, WORLD.minZ, WORLD.maxZ)
      : player.z;

    const distance = Math.hypot(
      nextX - player.x,
      nextZ - player.z
    );

    // 8 units/sec + generous packet-loss margin.
    const maxDistance = Math.max(
      1.0,
      8 * elapsed + 0.55
    );

    if (distance <= maxDistance) {
      player.x = nextX;
      player.z = nextZ;
    }

    const jumping = Boolean(data.jumping);

    if (
      jumping &&
      Number.isFinite(y)
    ) {
      player.y = clamp(
        y,
        WORLD.groundY,
        WORLD.maxJumpY
      );

      player.jumping = true;
    } else {
      player.y = WORLD.groundY;
      player.jumping = false;
    }

    if (Number.isFinite(yaw)) {
      player.yaw = yaw;
    }

    if (Number.isFinite(pitch)) {
      player.pitch = clamp(
        pitch,
        -Math.PI / 2,
        Math.PI / 2
      );
    }

    player.moving = Boolean(data.moving);

    if (Number.isFinite(Number(data.dance))) {
      const dance = Number(data.dance);

      player.dance = EMOTES.has(dance)
        ? dance
        : 0;
    }

    if (Number.isFinite(Number(data.danceStartedAt))) {
      player.danceStartedAt = Number(
        data.danceStartedAt
      );
    }

    player.lastUpdateAt = now;

    // Sender already knows its local position.
    // Only other players receive the update.
    socket.to(CLUB_ROOM).emit(
      'player:state',
      publicPlayer(player)
    );
  });

  /* =======================================================
     DANCE
  ======================================================= */

  socket.on('player-emote', data => {
    if (!socket.data.joined) return;

    const player = players.get(socket.id);
    if (!player) return;

    const dance = Number(data?.dance);

    if (!EMOTES.has(dance)) return;

    player.dance = dance;
    player.danceStartedAt = Date.now();

    io.to(CLUB_ROOM).emit(
      'player:state',
      publicPlayer(player)
    );
  });

  /* =======================================================
     LANGUAGE
  ======================================================= */

  socket.on('language-change', language => {
    if (!socket.data.joined) return;

    const player = players.get(socket.id);
    if (!player) return;

    player.language = normalizeLanguage(language);
    emitOnline();
  });

  /* =======================================================
     SCREEN
     ONLY MVXTRA CAN CONTROL IT
  ======================================================= */

  socket.on('screen:set', state => {
    if (!socket.data.joined) return;

    if (!isScreenHost(socket.data.username)) {
      console.log(
        'SCREEN DENIED:',
        socket.data.username
      );
      return;
    }

    state = state || {};

    const active =
      state.active === true &&
      String(state.src || '').trim().length > 0;

    if (active) {
      clubScreen.active = true;
      clubScreen.src = String(state.src).trim().slice(0, 2000);
      clubScreen.url = String(state.url || '').trim().slice(0, 2000);
      clubScreen.name = String(
        state.name || 'MEDIA'
      ).slice(0, 100);
    } else {
      clubScreen.active = false;
      clubScreen.src = '';
      clubScreen.url = '';
      clubScreen.name = '';
    }

    clubScreen.owner = SCREEN_HOST;
    clubScreen.version += 1;

    io.to(CLUB_ROOM).emit(
      'screen:state',
      publicScreen()
    );

    console.log(
      'SCREEN:',
      clubScreen.active ? 'ON' : 'OFF',
      '|',
      clubScreen.name,
      '|',
      clubScreen.version
    );
  });

  /* =======================================================
     CHAT
  ======================================================= */

  socket.on('chat-message', async message => {
    if (!socket.data.joined) return;

    const original = String(
      message?.text || ''
    )
      .trim()
      .slice(0, 500);

    if (!original) return;

    const recipients = [...players.values()];

    const languages = [
      ...new Set(
        recipients.map(player =>
          normalizeLanguage(player.language)
        )
      )
    ];

    const translations = new Map();

    await Promise.all(
      languages.map(async language => {
        translations.set(
          language,
          await translateText(
            original,
            language
          )
        );
      })
    );

    const ts = Date.now();

    for (const player of recipients) {
      const targetSocket =
        io.sockets.sockets.get(player.id);

      if (!targetSocket) continue;

      const targetLanguage =
        normalizeLanguage(player.language);

      targetSocket.emit(
        'chat-message',
        {
          user: socket.data.username,
          username: socket.data.username,
          text:
            translations.get(targetLanguage) ||
            original,
          original,
          targetLanguage,
          translated: true,
          ts
        }
      );
    }
  });

  /* =======================================================
     DISCONNECT
  ======================================================= */

  socket.on('disconnect', reason => {
    const player = players.get(socket.id);

    players.delete(socket.id);

    if (socket.data.joined) {
      socket.to(CLUB_ROOM).emit(
        'player:left',
        socket.id
      );

      // Presence is derived from the same players map.
      socket.to(CLUB_ROOM).emit(
        'online:state',
        onlineSnapshot()
      );
    }

    console.log(
      'DISCONNECT:',
      player?.username || socket.id,
      '|',
      reason
    );
  });
});

/* =========================================================
   MAIN PAGE
========================================================= */

app.get('/', (req, res) => {
  const index = path.join(
    PUBLIC_DIR,
    'index.html'
  );

  if (fs.existsSync(index)) {
    return res.sendFile(index);
  }

  res
    .status(404)
    .send(
      'EWS SESSIONS: index.html not found in public folder.'
    );
});

app.use('/api', (req, res) => {
  res.status(404).json({
    ok: false,
    error: 'API endpoint not found.'
  });
});

app.use((err, req, res, next) => {
  console.error('EXPRESS ERROR:', err);

  if (res.headersSent) {
    return next(err);
  }

  res.status(500).json({
    ok: false,
    error: 'Internal server error.'
  });
});

/* =========================================================
   START
========================================================= */

server.listen(
  PORT,
  '0.0.0.0',
  () => {
    console.log('========================================');
    console.log('        EWS SESSIONS SERVER READY');
    console.log('========================================');
    console.log('WEB:  http://localhost:' + PORT);
    console.log(
      'RTMP: rtmp://localhost:' +
      RTMP_PORT +
      '/live'
    );
    console.log(
      'HLS:  http://localhost:' +
      PORT +
      '/hls/'
    );
    console.log('SCREEN OWNER: mvxtra');
    console.log('MULTIPLAYER: ON');
    console.log('ONLINE USERS: ON');
    console.log('AVATARS: ROBOT-V1');
    console.log('DANCES: ON');
    console.log('CLUB SCREEN: SHARED');
    console.log('========================================');
  }
);

/* =========================================================
   SHUTDOWN
========================================================= */

function shutdown() {
  console.log(
    'EWS SESSIONS shutting down...'
  );

  server.close(() => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
