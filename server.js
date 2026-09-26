const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const NodeMediaServer = require('node-media-server');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const mediaRoot = path.join(__dirname, 'media');
if (!fs.existsSync(mediaRoot)) fs.mkdirSync(mediaRoot, { recursive: true });

const ffmpegPath = path.join(__dirname, 'ffmpeg.exe');

const nmsConfig = {
  rtmp: {
    port: 1935,
    chunk_size: 60000,
    gop_cache: true,
    ping: 30,
    ping_timeout: 60
  },
  http: {
    port: 8000,
    mediaroot: mediaRoot,
    allow_origin: '*'
  }
};

const nms = new NodeMediaServer(nmsConfig);
nms.run();

let ffmpegProcess = null;

function startFFmpeg() {
  const hlsDir = path.join(mediaRoot, 'live', 'ews');
  fs.mkdirSync(hlsDir, { recursive: true });

  const outPath = path.join(hlsDir, 'index.m3u8');

  const args = [
    '-reconnect', '1',
    '-reconnect_at_eof', '1',
    '-reconnect_streamed', '1',
    '-reconnect_delay_max', '3',
    '-i', 'rtmp://localhost:1935/live/ews',
    '-c:v', 'copy',
    '-c:a', 'aac',
    '-ab', '128k',
    '-f', 'hls',
    '-hls_time', '2',
    '-hls_list_size', '3',
    '-hls_flags', 'delete_segments',
    outPath
  ];

  if (!fs.existsSync(ffmpegPath)) {
    console.log('[FFMPEG] ffmpeg.exe not found. HLS conversion disabled.');
    return;
  }

  console.log('[FFMPEG] Starting...');

  ffmpegProcess = spawn(ffmpegPath, args, { windowsHide: true });

  ffmpegProcess.stderr.on('data', data => {
    const lines = data.toString().split('\n');
    for (const line of lines) {
      const t = line.trim();
      if (t) console.log('[FFMPEG]', t);
    }
  });

  ffmpegProcess.on('close', code => {
    console.log('[FFMPEG] Exited code', code, '- retry in 3s');
    ffmpegProcess = null;
    setTimeout(startFFmpeg, 3000);
  });

  ffmpegProcess.on('error', err => {
    console.error('[FFMPEG] ERROR:', err.message);
    ffmpegProcess = null;
  });
}

startFFmpeg();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use('/hls', express.static(path.join(mediaRoot, 'live'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.m3u8')) {
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.setHeader('Cache-Control', 'no-cache');
    } else if (filePath.endsWith('.ts')) {
      res.setHeader('Content-Type', 'video/mp2t');
      res.setHeader('Cache-Control', 'no-cache');
    }
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
}));

// ================================
// USERS
// ================================

const USERS_FILE = path.join(__dirname, 'users.json');
if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, '{}');

function loadUsers() {
  try {
    return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

app.post('/api/register', (req, res) => {
  const { username, password } = req.body || {};

  if (!username || !password) {
    return res.json({ error: 'Введите логин и пароль' });
  }

  if (password.length < 6) {
    return res.json({ error: 'Пароль минимум 6 символов' });
  }

  const users = loadUsers();

  if (users[username]) {
    return res.json({ error: 'Логин занят' });
  }

  users[username] = { password };
  saveUsers(users);

  res.json({ ok: true, username });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};

  if (!username || !password) {
    return res.json({ error: 'Введите логин и пароль' });
  }

  const users = loadUsers();

  if (!users[username]) {
    return res.json({ error: 'Логин не найден' });
  }

  if (users[username].password !== password) {
    return res.json({ error: 'Неверный пароль' });
  }

  res.json({ ok: true, username });
});

// ================================
// TRANSLATION
// ================================

const translationCache = new Map();

async function translateText(text, targetLang) {
  if (!text || !targetLang) return text;

  const key = targetLang + '|' + text;
  if (translationCache.has(key)) return translationCache.get(key);

  try {
    const url =
      'https://translate.googleapis.com/translate_a/single' +
      '?client=gtx' +
      '&sl=auto' +
      '&tl=' + encodeURIComponent(targetLang) +
      '&dt=t' +
      '&q=' + encodeURIComponent(text);

    const response = await fetch(url);

    if (!response.ok) {
      console.log('[TRANSLATE] HTTP', response.status);
      return text;
    }

    const data = await response.json();

    let result = '';

    if (Array.isArray(data) && Array.isArray(data[0])) {
      for (const part of data[0]) {
        if (part && part[0]) result += part[0];
      }
    }

    result = result || text;

    translationCache.set(key, result);

    if (translationCache.size > 1000) {
      const first = translationCache.keys().next().value;
      translationCache.delete(first);
    }

    return result;
  } catch (err) {
    console.log('[TRANSLATE] ERROR:', err.message);
    return text;
  }
}

// ================================
// ONLINE / CHAT
// ================================

const online = new Map();

io.on('connection', socket => {
  console.log('[CONNECTED]', socket.id);

  socket.on('join', data => {
    let username = 'Guest';
    let lang = 'ru';

    if (typeof data === 'string') {
      username = data;
    } else if (data && typeof data === 'object') {
      username = data.username || 'Guest';
      lang = data.lang || 'ru';
    }

    online.set(socket.id, { username, lang });

    console.log('[JOIN]', username, '| language:', lang);

    io.emit('online', [...online.values()].map(u => u.username));

    socket.broadcast.emit('msg', {
      user: 'SYSTEM',
      text: username + ' зашёл в клуб',
      ts: Date.now(),
      system: true
    });
  });

  socket.on('language', lang => {
    const user = online.get(socket.id);
    if (!user) return;

    user.lang = String(lang || 'ru');
    online.set(socket.id, user);

    console.log('[LANG]', user.username, '=>', user.lang);
  });

  socket.on('msg', async data => {
    if (!data || !data.text) return;

    const text = String(data.text).trim();
    if (!text) return;

    const sender = online.get(socket.id);
    const username = sender?.username || data.user || 'Guest';

    console.log('[CHAT]', username, ':', text);

    const users = [...online.entries()];

    // Translate once per unique target language, then broadcast individually.
    const translatedByLang = new Map();

    for (const [, user] of users) {
      const targetLang = user.lang || 'ru';

      if (!translatedByLang.has(targetLang)) {
        translatedByLang.set(
          targetLang,
          await translateText(text, targetLang)
        );
      }
    }

    for (const [socketId, user] of users) {
      const targetLang = user.lang || 'ru';
      const translatedText = translatedByLang.get(targetLang) || text;

      io.to(socketId).emit('msg', {
        user: username,
        text: translatedText,
        original: text,
        targetLang,
        translated: translatedText !== text,
        ts: Date.now()
      });
    }
  });

  socket.on('disconnect', () => {
    const user = online.get(socket.id);

    if (!user) return;

    console.log('[DISCONNECTED]', user.username);

    online.delete(socket.id);

    io.emit('online', [...online.values()].map(u => u.username));

    socket.broadcast.emit('msg', {
      user: 'SYSTEM',
      text: user.username + ' вышел',
      ts: Date.now(),
      system: true
    });
  });
});

server.listen(3000, () => {
  console.log('==============================');
  console.log('       EWS SESSIONS');
  console.log('==============================');
  console.log('SERVER READY');
  console.log('http://localhost:3000');
  console.log('RTMP: rtmp://localhost:1935/live');
  console.log('KEY:  ews');
  console.log('HLS:  http://localhost:3000/hls/ews/index.m3u8');
});
