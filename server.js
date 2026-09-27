const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const https = require('https');
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

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

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
      .toLowerCase() ===
    SCREEN_HOST
  );

}

function clamp(value, min, max) {

  return Math.max(
    min,
    Math.min(max, value)
  );

}

/* =========================================================
   API STATUS
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

/* =========================================================
   REGISTER
========================================================= */

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

    if (
      !isValidUsername(username)
    ) {

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
      password:
        hashPassword(password),
      createdAt:
        Date.now()
    });

    saveUsers(users);

    res.json({
      ok: true,
      username
    });

  }
);

/* =========================================================
   LOGIN
========================================================= */

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

    const user =
      readUsers().find(
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
      username:
        user.username
    });

  }
);

/* =========================================================
   TRANSLATION
========================================================= */

const SUPPORTED_LANGUAGES =
  new Set([
    'ru',
    'en',
    'es',
    'de',
    'fr',
    'zh',
    'ja',
    'ko',
    'ar',
    'hi',
    'pt',
    'it',
    'tr',
    'uk',
    'nl',
    'pl'
  ]);

const translationCache =
  new Map();

const MAX_TRANSLATION_CACHE = 500;

function normalizeLanguage(value) {

  const lang =
    String(
      value || 'en'
    )
      .trim()
      .toLowerCase();

  return SUPPORTED_LANGUAGES.has(
    lang
  )
    ? lang
    : 'en';

}

function httpsGetText(
  url,
  timeout = 8000
) {

  return new Promise(
    (resolve, reject) => {

      const req =
        https.get(
          url,
          {
            headers: {
              'User-Agent':
                'EWS-SESSIONS/1.0'
            }
          },
          res => {

            let body = '';

            res.setEncoding(
              'utf8'
            );

            res.on(
              'data',
              chunk =>
                body += chunk
            );

            res.on(
              'end',
              () => {

                if (
                  res.statusCode >= 200 &&
                  res.statusCode < 300
                ) {

                  resolve(body);

                } else {

                  reject(
                    new Error(
                      'HTTP ' +
                      res.statusCode
                    )
                  );

                }

              }
            );

          }
        );

      req.setTimeout(
        timeout,
        () =>
          req.destroy(
            new Error(
              'translation timeout'
            )
          )
      );

      req.on(
        'error',
        reject
      );

    }
  );

}

async function translateText(
  text,
  targetLanguage
) {

  if (!text) return '';

  const target =
    normalizeLanguage(
      targetLanguage
    );

  const source =
    String(text);

  const key =
    target +
    '\n' +
    source;

  if (
    translationCache.has(key)
  ) {

    return translationCache.get(
      key
    );

  }

  try {

    const url =
      'https://translate.googleapis.com/translate_a/single' +
      '?client=gtx' +
      '&sl=auto' +
      '&tl=' +
      encodeURIComponent(target) +
      '&dt=t' +
      '&q=' +
      encodeURIComponent(source);

    const raw =
      await httpsGetText(url);

    const data =
      JSON.parse(raw);

    const translated =
      Array.isArray(data) &&
      Array.isArray(data[0])
        ? data[0]
            .map(
              part =>
                Array.isArray(part)
                  ? part[0]
                  : ''
            )
            .join('')
        : source;

    if (
      translationCache.size >=
      MAX_TRANSLATION_CACHE
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
      translated || source
    );

    return (
      translated ||
      source
    );

  } catch (e) {

    console.error(
      'TRANSLATION ERROR:',
      e.message
    );

    return source;

  }

}

app.post(
  '/api/translate',
  async (req, res) => {

    const text =
      String(
        req.body.text || ''
      );

    const target =
      String(
        req.body.target || 'en'
      );

    if (!text) {

      return res.json({
        ok: true,
        text: ''
      });

    }

    res.json({
      ok: true,
      text:
        await translateText(
          text,
          target
        )
    });

  }
);

/* =========================================================
   ONLINE / PLAYERS / SCREEN
========================================================= */

const onlineUsers =
  new Map();

const players =
  new Map();

/*
  IMPORTANT:
  This state is shared between ALL connected users.
  mvxtra controls it.
  Every guest receives it.
*/
const clubScreenState = {

  active: false,

  src: '',

  name: '',

  owner:
    SCREEN_HOST

};

const SPAWN_POINTS = [

  {
    x: 0,
    z: 13
  },

  {
    x: 3,
    z: 10
  },

  {
    x: -3,
    z: 10
  },

  {
    x: 6,
    z: 7
  },

  {
    x: -6,
    z: 7
  },

  {
    x: 8,
    z: 3
  },

  {
    x: -8,
    z: 3
  }

];

function getSpawnPoint() {

  return (
    SPAWN_POINTS[
      Math.floor(
        Math.random() *
        SPAWN_POINTS.length
      )
    ] || {
      x: 0,
      z: 13
    }
  );

}

function getOnlineUsers() {

  return [
    ...onlineUsers.values()
  ].map(user => ({
    username:
      user.username,

    language:
      user.language
  }));

}

function broadcastOnline() {

  const list =
    getOnlineUsers();

  io.emit(
    'online-users',
    list
  );

  io.emit(
    'online',
    list
  );

}

function getPlayers() {

  return [
    ...players.values()
  ].map(
    player => ({
      ...player
    })
  );

}

function sendPlayersSnapshot(
  socket
) {

  socket.emit(
    'players-state',
    getPlayers().filter(
      player =>
        player.id !==
        socket.id
    )
  );

}

/* =========================================================
   SOCKET.IO
========================================================= */

io.on(
  'connection',
  socket => {

    console.log(
      'SOCKET CONNECT:',
      socket.id
    );

    /* =====================================================
       JOIN
    ===================================================== */

    socket.on(
      'join',
      data => {

        data =
          data || {};

        const username =
          cleanUsername(
            data.username
          );

        if (!username) {
          return;
        }

        const language =
          normalizeLanguage(
            data.language
          );

        socket.username =
          username;

        socket.language =
          language;

        onlineUsers.set(
          socket.id,
          {
            id:
              socket.id,

            username,

            language
          }
        );

        const spawn =
          getSpawnPoint();

        const player = {

          id:
            socket.id,

          username,

          x:
            spawn.x,

          y:
            1.7,

          z:
            spawn.z,

          yaw: 0,

          pitch: 0,

          moving: false,

          jumping: false,

          dance: 0,

          danceStartedAt: 0

        };

        players.set(
          socket.id,
          player
        );

        /*
          Tell this user whether they are mvxtra.
        */

        socket.emit(
          'screen-host',
          {
            host:
              isScreenHost(
                username
              ),

            username:
              SCREEN_HOST
          }
        );

        socket.emit(
          'player-spawn',
          player
        );

        sendPlayersSnapshot(
          socket
        );

        socket.broadcast.emit(
          'player-state',
          player
        );

        broadcastOnline();

        /*
          VERY IMPORTANT:
          Send the current screen immediately
          to the person who just joined.
        */

        socket.emit(
          'club-screen-state',
          {
            active:
              clubScreenState.active,

            src:
              clubScreenState.src,

            name:
              clubScreenState.name,

            owner:
              SCREEN_HOST
          }
        );

        socket.emit(
          'online',
          getOnlineUsers()
        );

        console.log(
          'JOIN:',
          username,
          '|',
          language
        );

      }
    );

    /* =====================================================
       REQUEST ONLINE
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
       REQUEST PLAYERS
    ===================================================== */

    socket.on(
      'request-players',
      () => {

        sendPlayersSnapshot(
          socket
        );

      }
    );

    /* =====================================================
       REQUEST SCREEN
    ===================================================== */

    socket.on(
      'request-club-screen',
      () => {

        socket.emit(
          'club-screen-state',
          {
            active:
              clubScreenState.active,

            src:
              clubScreenState.src,

            name:
              clubScreenState.name,

            owner:
              SCREEN_HOST
          }
        );

      }
    );

    /* =====================================================
       PLAYER STATE
    ===================================================== */

    socket.on(
      'player-state',
      data => {

        if (
          !socket.username ||
          !players.has(
            socket.id
          ) ||
          !data
        ) {
          return;
        }

        const player =
          players.get(
            socket.id
          );

        const x =
          Number(data.x);

        const y =
          Number(data.y);

        const z =
          Number(data.z);

        const yaw =
          Number(data.yaw);

        const pitch =
          Number(data.pitch);

        if (
          Number.isFinite(x)
        ) {
          player.x =
            clamp(
              x,
              -16,
              16
            );
        }

        if (
          Number.isFinite(y)
        ) {
          player.y =
            clamp(
              y,
              0,
              6
            );
        }

        if (
          Number.isFinite(z)
        ) {
          player.z =
            clamp(
              z,
              -15.5,
              15.5
            );
        }

        if (
          Number.isFinite(yaw)
        ) {
          player.yaw =
            yaw;
        }

        if (
          Number.isFinite(pitch)
        ) {
          player.pitch =
            pitch;
        }

        player.moving =
          Boolean(
            data.moving
          );

        player.jumping =
          Boolean(
            data.jumping
          );

        io.emit(
          'player-state',
          player
        );

      }
    );

    /* =====================================================
       PLAYER MOVE
    ===================================================== */

    socket.on(
      'player-move',
      data => {

        if (
          !socket.username ||
          !players.has(
            socket.id
          ) ||
          !data
        ) {
          return;
        }

        const player =
          players.get(
            socket.id
          );

        const x =
          Number(data.x);

        const y =
          Number(data.y);

        const z =
          Number(data.z);

        const yaw =
          Number(
            data.yaw ??
            data.ry
          );

        if (
          Number.isFinite(x)
        ) {
          player.x =
            clamp(
              x,
              -16,
              16
            );
        }

        if (
          Number.isFinite(y)
        ) {
          player.y =
            clamp(
              y,
              0,
              6
            );
        }

        if (
          Number.isFinite(z)
        ) {
          player.z =
            clamp(
              z,
              -15.5,
              15.5
            );
        }

        if (
          Number.isFinite(yaw)
        ) {
          player.yaw =
            yaw;
        }

        player.moving =
          Boolean(
            data.moving
          );

        io.emit(
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
      data => {

        if (
          !socket.username ||
          !players.has(
            socket.id
          )
        ) {
          return;
        }

        const dance =
          Number(
            data?.dance
          );

        if (
          !EMOTES.has(
            dance
          )
        ) {
          return;
        }

        const player =
          players.get(
            socket.id
          );

        player.dance =
          dance;

        player.danceStartedAt =
          Date.now();

        io.emit(
          'player-emote',
          {
            id:
              socket.id,

            username:
              socket.username,

            dance,

            danceStartedAt:
              player.danceStartedAt
          }
        );

      }
    );

    /* =====================================================
       CHAT
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

        /*
          Every person receives the message
          in THEIR selected language.

          Example:

          RU user:
          "Привет"

          EN user:
          "Hello"

          DE user:
          "Hallo"

          The original is never lost.
        */

        const recipients =
          [
            ...onlineUsers.entries()
          ];

        const targetLanguages =
          [
            ...new Set(
              recipients.map(
                ([, user]) =>
                  normalizeLanguage(
                    user.language
                  )
              )
            )
          ];

        const translations =
          new Map();

        await Promise.all(
          targetLanguages.map(
            async targetLanguage => {

              translations.set(
                targetLanguage,

                await translateText(
                  original,
                  targetLanguage
                )
              );

            }
          )
        );

        const ts =
          Date.now();

        for (
          const [id, user]
          of recipients
        ) {

          const targetSocket =
            io.sockets.sockets.get(
              id
            );

          if (!targetSocket) {
            continue;
          }

          const targetLanguage =
            normalizeLanguage(
              user.language
            );

          targetSocket.emit(
            'chat-message',
            {
              user:
                socket.username,

              username:
                socket.username,

              text:
                translations.get(
                  targetLanguage
                ) || original,

              original,

              targetLanguage,

              translated:
                true,

              ts
            }
          );

        }

      }
    );

    /* =====================================================
       LANGUAGE CHANGE
    ===================================================== */

    socket.on(
      'language-change',
      language => {

        if (!socket.username) {
          return;
        }

        const normalized =
          normalizeLanguage(
            language
          );

        socket.language =
          normalized;

        const user =
          onlineUsers.get(
            socket.id
          );

        if (user) {

          user.language =
            normalized;

        }

        broadcastOnline();

      }
    );

    /* =====================================================
       CLUB SCREEN
       ONLY MVXTRA CAN CONTROL IT
    ===================================================== */

    socket.on(
      'club-screen-state',
      state => {

        if (
          !isScreenHost(
            socket.username
          )
        ) {

          console.log(
            'SCREEN DENIED:',
            socket.username
          );

          return;
        }

        state =
          state || {};

        /*
          SCREEN ON
        */

        if (
          state.active === true &&
          typeof state.src ===
            'string' &&
          state.src.trim()
        ) {

          const src =
            state.src
              .trim()
              .slice(0, 2000);

          clubScreenState.active =
            true;

          clubScreenState.src =
            src;

          clubScreenState.name =
            String(
              state.name ||
              'MEDIA'
            ).slice(
              0,
              100
            );

        }

        /*
          SCREEN OFF
        */

        else {

          clubScreenState.active =
            false;

          clubScreenState.src =
            '';

          clubScreenState.name =
            '';

        }

        clubScreenState.owner =
          SCREEN_HOST;

        /*
          THIS IS THE IMPORTANT PART:
          send the same state to EVERYONE.
        */

        io.emit(
          'club-screen-state',
          {
            active:
              clubScreenState.active,

            src:
              clubScreenState.src,

            name:
              clubScreenState.name,

            owner:
              SCREEN_HOST
          }
        );

        console.log(
          'SCREEN STATE:',
          clubScreenState.active
            ? 'ON'
            : 'OFF',
          clubScreenState.name,
          '|',
          clubScreenState.src
        );

      }
    );

    /* =====================================================
       DISCONNECT
    ===================================================== */

    socket.on(
      'disconnect',
      reason => {

        const username =
          socket.username;

        onlineUsers.delete(
          socket.id
        );

        players.delete(
          socket.id
        );

        socket.broadcast.emit(
          'player-left',
          socket.id
        );

        broadcastOnline();

        console.log(
          'DISCONNECT:',
          username ||
            socket.id,
          '|',
          reason
        );

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
      Number(
        RTMP_PORT
      ),

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
      Number(
        NMS_HTTP_PORT
      ),

    mediaroot:
      HLS_DIR,

    allow_origin:
      '*'

  },

  trans: {

    ffmpeg:
      process.env.FFMPEG_PATH ||
      'ffmpeg',

    tasks: [

      {

        app:
          'live',

        hls:
          true,

        hlsFlags:
          '[hls_time=2:hls_list_size=6:hls_flags=delete_segments+append_list]',

        hlsKeepSegments:
          6,

        dash:
          false

      }

    ]

  }

};

let nms = null;

try {

  nms =
    new NodeMediaServer(
      nmsConfig
    );

  nms.run();

  console.log(
    'RTMP SERVER READY'
  );

  console.log(
    `RTMP: rtmp://localhost:${RTMP_PORT}/live`
  );

} catch (error) {

  console.error(
    'NODE MEDIA SERVER ERROR:',
    error
  );

}

/* =========================================================
   MAIN PAGE
========================================================= */

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

      return res.sendFile(
        index
      );

    }

    res
      .status(404)
      .send(
        'EWS SESSIONS: index.html not found in public folder.'
      );

  }
);

/* =========================================================
   API 404
========================================================= */

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

/* =========================================================
   EXPRESS ERROR
========================================================= */

app.use(
  (
    err,
    req,
    res,
    next
  ) => {

    console.error(
      'EXPRESS ERROR:',
      err
    );

    if (
      res.headersSent
    ) {

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
   START SERVER
========================================================= */

server.listen(
  PORT,
  '0.0.0.0',
  () => {

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
      'CLUB SCREEN: ON'
    );

    console.log(
      'USERS FILE: ./users.json'
    );

    console.log(
      '========================================'
    );

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
    () =>
      process.exit(0)
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