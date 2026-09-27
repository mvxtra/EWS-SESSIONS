const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Server } = require('socket.io');
const NodeMediaServer = require('node-media-server');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

const PORT = process.env.PORT || 3000;
const RTMP_PORT = process.env.RTMP_PORT || 1935;
const NMS_HTTP_PORT = process.env.NMS_HTTP_PORT || 8000;

const PUBLIC_DIR = path.join(__dirname, 'public');
const HLS_DIR = path.join(__dirname, 'hls');
const HLS_STREAM_DIR = path.join(HLS_DIR, 'ews');
const USERS_FILE = path.join(__dirname, 'users.json');

const SCREEN_HOST = 'mvxtra';

const EMOTES = new Set([1, 2, 3, 4, 5, 6]);

/* =========================================================
   DIRECTORIES
========================================================= */

for (const dir of [
  PUBLIC_DIR,
  HLS_DIR,
  HLS_STREAM_DIR
]) {
  fs.mkdirSync(dir, { recursive: true });
}

if (!fs.existsSync(USERS_FILE)) {
  fs.writeFileSync(
    USERS_FILE,
    JSON.stringify([], null, 2),
    'utf8'
  );
}

/* =========================================================
   EXPRESS
========================================================= */

app.use(express.json({
  limit: '2mb'
}));

app.use(express.urlencoded({
  extended: true
}));

app.use(express.static(PUBLIC_DIR));

app.use(
  '/hls',
  express.static(HLS_DIR, {
    setHeaders: (res, filePath) => {

      res.setHeader(
        'Access-Control-Allow-Origin',
        '*'
      );

      res.setHeader(
        'Cache-Control',
        'no-cache, no-store, must-revalidate'
      );

      if (filePath.endsWith('.m3u8')) {
        res.setHeader(
          'Content-Type',
          'application/vnd.apple.mpegurl'
        );
      }

      if (filePath.endsWith('.ts')) {
        res.setHeader(
          'Content-Type',
          'video/mp2t'
        );
      }
    }
  })
);

/* =========================================================
   USERS
========================================================= */

function readUsers() {

  try {

    const users = JSON.parse(
      fs.readFileSync(
        USERS_FILE,
        'utf8'
      )
    );

    return Array.isArray(users)
      ? users
      : [];

  } catch (e) {

    console.error(
      'USERS READ ERROR:',
      e.message
    );

    return [];
  }
}

function saveUsers(users) {

  fs.writeFileSync(
    USERS_FILE,
    JSON.stringify(
      users,
      null,
      2
    ),
    'utf8'
  );
}

function hashPassword(password) {

  return crypto
    .createHash('sha256')
    .update(String(password))
    .digest('hex');
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
    String(username || '')
      .trim()
      .toLowerCase() === SCREEN_HOST
  );
}

function clamp(value, min, max) {

  return Math.max(
    min,
    Math.min(max, value)
  );
}

/* =========================================================
   API
========================================================= */

app.get(
  '/api/status',
  (req, res) => {

    res.json({
      ok: true,
      service: 'EWS SESSIONS',
      online: onlineUsers.size,
      stream: true
    });

  }
);

app.post(
  '/api/register',
  (req, res) => {

    const username =
      cleanUsername(
        req.body.username
      );

    const password =
      String(
        req.body.password || ''
      );

    if (!isValidUsername(username)) {

      return res
        .status(400)
        .json({
          ok: false,
          error:
            'Некорректное имя пользователя.'
        });

    }

    if (password.length < 4) {

      return res
        .status(400)
        .json({
          ok: false,
          error:
            'Пароль должен быть минимум 4 символа.'
        });

    }

    const users = readUsers();

    if (
      users.some(
        u =>
          String(u.username)
            .toLowerCase() ===
          username.toLowerCase()
      )
    ) {

      return res
        .status(409)
        .json({
          ok: false,
          error:
            'Такой пользователь уже существует.'
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

  }
);

app.post(
  '/api/login',
  (req, res) => {

    const username =
      cleanUsername(
        req.body.username
      );

    const password =
      String(
        req.body.password || ''
      );

    const users = readUsers();

    const user =
      users.find(
        u =>
          String(u.username)
            .toLowerCase() ===
          username.toLowerCase()
      );

    if (!user) {

      return res
        .status(401)
        .json({
          ok: false,
          error:
            'Пользователь не найден.'
        });

    }

    if (
      user.password !==
      hashPassword(password)
    ) {

      return res
        .status(401)
        .json({
          ok: false,
          error:
            'Неверный пароль.'
        });

    }

    res.json({
      ok: true,
      username: user.username
    });

  }
);

app.get(
  '/',
  (req, res) => {

    const index =
      path.join(
        PUBLIC_DIR,
        'index.html'
      );

    if (
      fs.existsSync(index)
    ) {

      return res.sendFile(index);

    }

    res
      .status(404)
      .send(
        'EWS SESSIONS: index.html not found in public folder.'
      );

  }
);

app.use(
  '/api',
  (req, res) => {

    res
      .status(404)
      .json({
        ok: false,
        error:
          'API endpoint not found.'
      });

  }
);

app.use(
  (err, req, res, next) => {

    console.error(
      'EXPRESS ERROR:',
      err
    );

    if (res.headersSent) {
      return next(err);
    }

    res
      .status(500)
      .json({
        ok: false,
        error:
          'Internal server error.'
      });

  }
);

/* =========================================================
   ONLINE USERS
========================================================= */

const onlineUsers = new Map();

function getOnlineUsers() {

  return Array.from(
    onlineUsers.values()
  ).map(user => ({
    id: user.id,
    username: user.username,
    language: user.language
  }));

}

function broadcastOnline() {

  const list =
    getOnlineUsers();

  io.emit(
    'online-users',
    list
  );

}

/* =========================================================
   PLAYERS
========================================================= */

const players = new Map();

function getPlayers() {

  return Array.from(
    players.values()
  );

}

/* =========================================================
   CLUB SCREEN
========================================================= */

let clubScreenState = {
  active: false,
  src: '',
  name: '',
  owner: SCREEN_HOST
};

/* =========================================================
   TRANSLATION
========================================================= */

const translationCache = new Map();

const TRANSLATION_CACHE_LIMIT = 1000;

function normalizeLanguage(language) {

  const lang =
    String(language || '')
      .trim()
      .toLowerCase();

  const aliases = {
    russian: 'ru',
    english: 'en',
    german: 'de',
    deutsch: 'de',
    french: 'fr',
    español: 'es',
    spanish: 'es',
    italian: 'it',
    portuguese: 'pt',
    dutch: 'nl',
    polish: 'pl',
    ukrainian: 'uk',
    chinese: 'zh-CN',
    japanese: 'ja',
    korean: 'ko'
  };

  return aliases[lang] || lang || 'en';
}

async function translateWithGoogle(
  text,
  targetLanguage
) {

  const original =
    String(text || '').trim();

  const target =
    normalizeLanguage(
      targetLanguage
    );

  if (!original) {
    return '';
  }

  if (
    !target ||
    target === 'auto'
  ) {
    return original;
  }

  const key =
    target +
    '|' +
    original;

  if (
    translationCache.has(key)
  ) {

    console.log(
      `[TRANSLATE CACHE] ${target}: ${original}`
    );

    return translationCache.get(key);
  }

  const url =
    'https://translate.googleapis.com/translate_a/single' +
    '?client=gtx' +
    '&sl=auto' +
    '&tl=' +
    encodeURIComponent(target) +
    '&dt=t' +
    '&q=' +
    encodeURIComponent(original);

  let lastError = null;

  for (
    let attempt = 1;
    attempt <= 2;
    attempt++
  ) {

    try {

      console.log(
        `[TRANSLATE] attempt=${attempt} target=${target} text="${original}"`
      );

      const controller =
        new AbortController();

      const timeout =
        setTimeout(
          () => controller.abort(),
          10000
        );

      const response =
        await fetch(
          url,
          {
            method: 'GET',
            headers: {
              'User-Agent':
                'Mozilla/5.0 EWS-Sessions'
            },
            signal:
              controller.signal
          }
        );

      clearTimeout(timeout);

      if (!response.ok) {

        throw new Error(
          `HTTP ${response.status}`
        );

      }

      const data =
        await response.json();

      let translated = '';

      if (
        Array.isArray(data) &&
        Array.isArray(data[0])
      ) {

        translated =
          data[0]
            .map(
              item =>
                Array.isArray(item)
                  ? String(item[0] || '')
                  : ''
            )
            .join('');

      }

      translated =
        translated.trim();

      if (!translated) {

        throw new Error(
          'Empty translation returned'
        );

      }

      if (
        translationCache.size >=
        TRANSLATION_CACHE_LIMIT
      ) {

        const firstKey =
          translationCache
            .keys()
            .next()
            .value;

        if (firstKey) {

          translationCache.delete(
            firstKey
          );

        }

      }

      translationCache.set(
        key,
        translated
      );

      console.log(
        `[TRANSLATE OK] ${target}: "${original}" -> "${translated}"`
      );

      return translated;

    } catch (error) {

      lastError =
        error;

      console.error(
        `[TRANSLATE ERROR] attempt=${attempt}:`,
        error.message
      );

      if (
        attempt < 2
      ) {

        await new Promise(
          resolve =>
            setTimeout(
              resolve,
              500
            )
        );

      }

    }

  }

  console.error(
    '[TRANSLATE FAILED]',
    lastError?.message ||
      'unknown error'
  );

  /*
    If translation fails,
    preserve original message.
  */

  return original;
}

/* =========================================================
   SOCKET.IO
========================================================= */

io.on(
  'connection',
  socket => {

    console.log(
      'SOCKET CONNECTED:',
      socket.id
    );

    /* =====================================================
       JOIN
    ===================================================== */

    socket.on(
      'join',
      data => {

        const username =
          cleanUsername(
            data?.username
          );

        const language =
          normalizeLanguage(
            data?.language || 'en'
          );

        if (!username) {

          socket.emit(
            'join-error',
            'Имя пользователя отсутствует.'
          );

          return;
        }

        /*
          Prevent duplicate join.
        */

        if (socket.username) {

          socket.language =
            language;

          const existing =
            onlineUsers.get(
              socket.id
            );

          if (existing) {

            existing.language =
              language;

          }

          socket.emit(
            'language-updated',
            {
              language
            }
          );

          broadcastOnline();

          return;
        }

        socket.username =
          username;

        socket.language =
          language;

        onlineUsers.set(
          socket.id,
          {
            id: socket.id,
            username,
            language
          }
        );

        const x =
          Number(data?.x);

        const y =
          Number(data?.y);

        const z =
          Number(data?.z);

        const yaw =
          Number(data?.yaw);

        players.set(
          socket.id,
          {
            id: socket.id,
            username,

            x:
              Number.isFinite(x)
                ? x
                : 0,

            y:
              Number.isFinite(y)
                ? y
                : 1.7,

            z:
              Number.isFinite(z)
                ? z
                : 10,

            yaw:
              Number.isFinite(yaw)
                ? yaw
                : 0,

            pitch: 0,
            dance: 0
          }
        );

        socket.emit(
          'joined',
          {
            id: socket.id,
            username,
            language
          }
        );

        socket.emit(
          'club-screen-state',
          clubScreenState
        );

        socket.emit(
          'players-state',
          getPlayers().filter(
            player =>
              player.id !==
              socket.id
          )
        );

        socket.broadcast.emit(
          'player-joined',
          players.get(
            socket.id
          )
        );

        broadcastOnline();

        console.log(
          `[JOIN] ${username} language=${language}`
        );

      }
    );

    /* =====================================================
       ONLINE
    ===================================================== */

    socket.on(
      'request-online',
      () => {

        socket.emit(
          'online-users',
          getOnlineUsers()
        );

      }
    );

    /* =====================================================
       LANGUAGE
    ===================================================== */

    socket.on(
      'language-change',
      language => {

        if (!socket.username) {
          return;
        }

        const newLanguage =
          normalizeLanguage(
            language
          );

        socket.language =
          newLanguage;

        const user =
          onlineUsers.get(
            socket.id
          );

        if (user) {

          user.language =
            newLanguage;

        }

        console.log(
          `[LANGUAGE] ${socket.username} -> ${newLanguage}`
        );

        socket.emit(
          'language-updated',
          {
            language:
              newLanguage
          }
        );

        broadcastOnline();

      }
    );

    /* =====================================================
       PLAYERS
    ===================================================== */

    socket.on(
      'request-players',
      () => {

        socket.emit(
          'players-state',
          getPlayers().filter(
            player =>
              player.id !==
              socket.id
          )
        );

      }
    );

    socket.on(
      'player-state',
      data => {

        if (!socket.username) {
          return;
        }

        const player =
          players.get(
            socket.id
          );

        if (!player) {
          return;
        }

        if (
          Number.isFinite(
            Number(data?.x)
          )
        ) {

          player.x =
            clamp(
              Number(data.x),
              -30,
              30
            );

        }

        if (
          Number.isFinite(
            Number(data?.y)
          )
        ) {

          player.y =
            clamp(
              Number(data.y),
              0,
              20
            );

        }

        if (
          Number.isFinite(
            Number(data?.z)
          )
        ) {

          player.z =
            clamp(
              Number(data.z),
              -40,
              40
            );

        }

        if (
          Number.isFinite(
            Number(data?.yaw)
          )
        ) {

          player.yaw =
            Number(data.yaw);

        }

        if (
          Number.isFinite(
            Number(data?.pitch)
          )
        ) {

          player.pitch =
            Number(data.pitch);

        }

        if (
          EMOTES.has(
            Number(data?.dance)
          )
        ) {

          player.dance =
            Number(data.dance);

        }

        socket.broadcast.emit(
          'player-state',
          player
        );

      }
    );

    socket.on(
      'player-move',
      data => {

        if (!socket.username) {
          return;
        }

        const player =
          players.get(
            socket.id
          );

        if (!player) {
          return;
        }

        if (
          Number.isFinite(
            Number(data?.x)
          )
        ) {

          player.x =
            clamp(
              Number(data.x),
              -30,
              30
            );

        }

        if (
          Number.isFinite(
            Number(data?.y)
          )
        ) {

          player.y =
            clamp(
              Number(data.y),
              0,
              20
            );

        }

        if (
          Number.isFinite(
            Number(data?.z)
          )
        ) {

          player.z =
            clamp(
              Number(data.z),
              -40,
              40
            );

        }

        if (
          Number.isFinite(
            Number(data?.yaw)
          )
        ) {

          player.yaw =
            Number(data.yaw);

        }

        if (
          Number.isFinite(
            Number(data?.pitch)
          )
        ) {

          player.pitch =
            Number(data.pitch);

        }

        socket.broadcast.emit(
          'player-move',
          player
        );

      }
    );

    /* =====================================================
       DANCES
    ===================================================== */

    socket.on(
      'player-emote',
      value => {

        if (!socket.username) {
          return;
        }

        const dance =
          Number(value);

        if (
          !EMOTES.has(dance)
        ) {

          return;
        }

        const player =
          players.get(
            socket.id
          );

        if (!player) {
          return;
        }

        player.dance =
          dance;

        io.emit(
          'player-emote',
          {
            id:
              socket.id,

            username:
              socket.username,

            dance
          }
        );

      }
    );

    /* =====================================================
       SCREEN
    ===================================================== */

    socket.on(
      'request-club-screen',
      () => {

        socket.emit(
          'club-screen-state',
          clubScreenState
        );

      }
    );

    socket.on(
      'club-screen-state',
      state => {

        if (
          !isScreenHost(
            socket.username
          )
        ) {

          return;
        }

        if (
          !state ||
          state.active !== true ||
          typeof state.src !== 'string' ||
          !state.src.trim()
        ) {

          clubScreenState = {
            active: false,
            src: '',
            name: '',
            owner:
              SCREEN_HOST
          };

          io.emit(
            'club-screen-state',
            clubScreenState
          );

          return;
        }

        const src =
          state.src
            .trim()
            .slice(0, 2000);

        if (
          !/^https:\/\//i.test(src)
        ) {

          socket.emit(
            'club-screen-error',
            'Ссылка экрана должна начинаться с HTTPS.'
          );

          return;
        }

        clubScreenState = {
          active: true,
          src,

          name:
            String(
              state.name ||
              'MEDIA'
            ).slice(0, 100),

          owner:
            SCREEN_HOST
        };

        io.emit(
          'club-screen-state',
          clubScreenState
        );

      }
    );

    /* =====================================================
       CHAT + PERSONAL TRANSLATION
    ===================================================== */

    socket.on(
      'chat-message',
      async message => {

        if (!socket.username) {
          return;
        }

        const original =
          String(
            message?.text || ''
          )
            .trim()
            .slice(0, 500);

        if (!original) {
          return;
        }

        const senderLanguage =
          normalizeLanguage(
            socket.language || 'en'
          );

        console.log('');
        console.log(
          '================ CHAT ================'
        );
        console.log(
          `USER: ${socket.username}`
        );
        console.log(
          `LANG: ${senderLanguage}`
        );
        console.log(
          `TEXT: ${original}`
        );

        const recipients =
          Array.from(
            onlineUsers.entries()
          );

        /*
          Translate separately for every recipient.
        */

        await Promise.all(
          recipients.map(
            async ([id, user]) => {

              const targetSocket =
                io.sockets.sockets.get(
                  id
                );

              if (!targetSocket) {
                return;
              }

              const targetLanguage =
                normalizeLanguage(
                  user.language || 'en'
                );

              let translated =
                original;

              /*
                Same language:
                no translation needed.
              */

              if (
                targetLanguage !==
                senderLanguage
              ) {

                translated =
                  await translateWithGoogle(
                    original,
                    targetLanguage
                  );

              }

              console.log(
                `[CHAT SEND] ${socket.username} -> ${user.username} | ${senderLanguage} -> ${targetLanguage} | "${translated}"`
              );

              targetSocket.emit(
                'chat-message',
                {
                  user:
                    socket.username,

                  username:
                    socket.username,

                  text:
                    translated,

                  original,

                  sourceLanguage:
                    senderLanguage,

                  targetLanguage,

                  ts:
                    Date.now()
                }
              );

            }
          )
        );

        console.log(
          '========================================'
        );
        console.log('');

      }
    );

    /* =====================================================
       DISCONNECT
    ===================================================== */

    socket.on(
      'disconnect',
      reason => {

        console.log(
          'SOCKET DISCONNECTED:',
          socket.id,
          reason
        );

        onlineUsers.delete(
          socket.id
        );

        players.delete(
          socket.id
        );

        io.emit(
          'player-left',
          socket.id
        );

        io.emit(
          'player-removed',
          socket.id
        );

        broadcastOnline();

      }
    );

  }
);

/* =========================================================
   NODE MEDIA SERVER
========================================================= */

const nmsConfig = {

  rtmp: {

    port:
      Number(RTMP_PORT),

    chunk_size:
      60000,

    gop_cache:
      true,

    ping:
      30,

    ping_timeout:
      60

  },

  http: {

    port:
      Number(NMS_HTTP_PORT),

    mediaroot:
      HLS_DIR,

    allow_origin:
      '*'

  },

  trans: {

    ffmpeg:
      path.join(
        __dirname,
        'ffmpeg',
        'ffmpeg.exe'
      ),

    tasks: [

      {

        app:
          'live',

        hls:
          true,

        hlsFlags:
          '[hls_time=2:hls_list_size=6:hls_flags=delete_segments+append_list]',

        hlsKeep:
          false

      }

    ]

  }

};

let nms;

try {

  nms =
    new NodeMediaServer(
      nmsConfig
    );

  nms.run();

  console.log(
    'NODE MEDIA SERVER STARTED'
  );

} catch (e) {

  console.error(
    'NODE MEDIA SERVER ERROR:',
    e.message
  );

}

/* =========================================================
   SERVER START
========================================================= */

server.listen(
  PORT,
  '0.0.0.0',
  () => {

    console.log('');
    console.log(
      '========================================'
    );
    console.log(
      '        EWS SESSIONS SERVER READY'
    );
    console.log(
      '========================================'
    );

    console.log(
      `WEB:  http://localhost:${PORT}`
    );

    console.log(
      `RTMP: rtmp://localhost:${RTMP_PORT}/live`
    );

    console.log(
      `HLS:  http://localhost:${PORT}/hls/`
    );

    console.log(
      'SCREEN OWNER: mvxtra'
    );

    console.log(
      'CHAT TRANSLATION: PERSONAL'
    );

    console.log(
      'MULTIPLAYER: ON'
    );

    console.log(
      'ONLINE USERS: ON'
    );

    console.log(
      'DANCES / EMOTES: ON'
    );

    console.log(
      'USERS FILE: ./users.json'
    );

    console.log(
      '========================================'
    );

    console.log('');

  }
);

/* =========================================================
   SHUTDOWN
========================================================= */

function shutdown() {

  console.log(
    'EWS SESSIONS shutting down...'
  );

  try {

    if (nms) {
      nms.stop();
    }

  } catch (e) {

    console.error(e);

  }

  server.close(
    () => process.exit(0)
  );

}

process.on(
  'SIGINT',
  shutdown
);

process.on(
  'SIGTERM',
  shutdown
);