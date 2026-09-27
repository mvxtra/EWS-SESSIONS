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

const EMOTES = new Set([
  1,
  2,
  3,
  4,
  5,
  6
]);

/* =========================================================
   DIRECTORIES / FILES
========================================================= */

for (const dir of [
  PUBLIC_DIR,
  HLS_DIR,
  HLS_STREAM_DIR
]) {
  fs.mkdirSync(dir, {
    recursive: true
  });
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

app.use(
  express.json({
    limit: '2mb'
  })
);

app.use(
  express.urlencoded({
    extended: true
  })
);

app.use(
  express.static(PUBLIC_DIR)
);

/* =========================================================
   HLS
========================================================= */

app.use(
  '/hls',
  express.static(
    HLS_DIR,
    {
      setHeaders: (res, filePath) => {

        res.setHeader(
          'Access-Control-Allow-Origin',
          '*'
        );

        res.setHeader(
          'Cache-Control',
          'no-cache, no-store, must-revalidate'
        );

        if (
          filePath.endsWith('.m3u8')
        ) {
          res.setHeader(
            'Content-Type',
            'application/vnd.apple.mpegurl'
          );
        }

        if (
          filePath.endsWith('.ts')
        ) {
          res.setHeader(
            'Content-Type',
            'video/mp2t'
          );
        }

      }
    }
  )
);

/* =========================================================
   USERS
========================================================= */

function readUsers() {

  try {

    const users =
      JSON.parse(
        fs.readFileSync(
          USERS_FILE,
          'utf8'
        )
      );

    return Array.isArray(users)
      ? users
      : [];

  } catch (error) {

    console.error(
      'USERS READ ERROR:',
      error.message
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
    .update(
      String(password)
    )
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

function clamp(
  value,
  min,
  max
) {

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

    if (
      password.length < 4
    ) {

      return res
        .status(400)
        .json({
          ok: false,
          error:
            'Пароль должен быть минимум 4 символа.'
        });

    }

    const users =
      readUsers();

    const exists =
      users.some(
        user =>
          String(user.username)
            .toLowerCase() ===
          username.toLowerCase()
      );

    if (exists) {

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
        item =>
          String(item.username)
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

/* =========================================================
   TRANSLATION
========================================================= */

const translationCache =
  new Map();

const TRANSLATION_CACHE_LIMIT =
  500;

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
    'uk'
  ]);

function normalizeLanguage(
  language
) {

  const value =
    String(
      language || 'en'
    )
      .trim()
      .toLowerCase();

  if (
    SUPPORTED_LANGUAGES.has(value)
  ) {
    return value;
  }

  return 'en';

}

async function translateText(
  text,
  targetLanguage
) {

  const original =
    String(text || '');

  if (!original) {
    return '';
  }

  const target =
    normalizeLanguage(
      targetLanguage
    );

  const key =
    target +
    '\n' +
    original;

  if (
    translationCache.has(key)
  ) {

    return translationCache.get(key);

  }

  try {

    console.log(
      `[TRANSLATE] target=${target} text="${original}"`
    );

    const url =
      'https://translate.googleapis.com/translate_a/single' +
      '?client=gtx' +
      '&sl=auto' +
      '&tl=' +
      encodeURIComponent(target) +
      '&dt=t' +
      '&q=' +
      encodeURIComponent(original);

    const response =
      await fetch(url);

    if (!response.ok) {

      console.error(
        '[TRANSLATE HTTP ERROR]',
        response.status
      );

      return original;

    }

    const data =
      await response.json();

    let result =
      original;

    if (
      Array.isArray(data) &&
      Array.isArray(data[0])
    ) {

      result =
        data[0]
          .map(
            part =>
              Array.isArray(part)
                ? part[0]
                : ''
          )
          .join('');

    }

    if (!result) {
      result = original;
    }

    if (
      translationCache.size >=
      TRANSLATION_CACHE_LIMIT
    ) {

      const first =
        translationCache
          .keys()
          .next()
          .value;

      if (first) {
        translationCache.delete(first);
      }

    }

    translationCache.set(
      key,
      result
    );

    console.log(
      `[TRANSLATE OK] ${target}: "${original}" -> "${result}"`
    );

    return result;

  } catch (error) {

    console.error(
      '[TRANSLATION ERROR]',
      error.message
    );

    return original;

  }

}

/* =========================================================
   TRANSLATE API
========================================================= */

app.post(
  '/api/translate',
  async (req, res) => {

    const text =
      String(
        req.body.text || ''
      );

    const target =
      normalizeLanguage(
        req.body.target
      );

    if (!text) {

      return res.json({
        ok: true,
        text: ''
      });

    }

    const translated =
      await translateText(
        text,
        target
      );

    res.json({
      ok: true,
      text: translated
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

const clubScreenState = {

  active: false,

  src: '',

  name: '',

  owner: SCREEN_HOST

};

/* =========================================================
   SPAWN POINTS
========================================================= */

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

  for (
    const point
    of SPAWN_POINTS
  ) {

    const occupied =
      [
        ...players.values()
      ].some(
        player =>
          Math.abs(
            player.x -
            point.x
          ) < 1.5 &&
          Math.abs(
            player.z -
            point.z
          ) < 1.5
      );

    if (!occupied) {

      return {
        x: point.x,
        z: point.z
      };

    }

  }

  return {

    x:
      Math.round(
        Math.random() *
        14 -
        7
      ),

    z:
      Math.round(
        Math.random() *
        8 +
        5
      )

  };

}

/* =========================================================
   ONLINE USERS
========================================================= */

function getOnlineUsers() {

  return [
    ...onlineUsers.values()
  ].map(
    user => ({
      username:
        user.username,

      language:
        user.language
    })
  );

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

/* =========================================================
   PLAYERS
========================================================= */

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

        /* ================================================
           ALREADY JOINED
        ================================================ */

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

        /* ================================================
           NEW USER
        ================================================ */

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

          yaw:
            0,

          pitch:
            0,

          moving:
            false,

          jumping:
            false,

          dance:
            0,

          danceStartedAt:
            0

        };

        players.set(
          socket.id,
          player
        );

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

        socket.emit(
          'club-screen-state',
          clubScreenState
        );

        console.log(
          'JOIN:',
          username,
          '| language:',
          language
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
       PLAYERS
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
       CLUB SCREEN REQUEST
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

    /* =====================================================
       PLAYER STATE
    ===================================================== */

    socket.on(
      'player-state',
      data => {

        const player =
          players.get(
            socket.id
          );

        if (!player) {
          return;
        }

        data =
          data || {};

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
              8
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

        if (
          typeof data.moving ===
          'boolean'
        ) {

          player.moving =
            data.moving;

        }

        if (
          typeof data.jumping ===
          'boolean'
        ) {

          player.jumping =
            data.jumping;

        }

        if (
          Number.isFinite(
            Number(data.dance)
          )
        ) {

          const dance =
            Number(
              data.dance
            );

          player.dance =
            EMOTES.has(dance)
              ? dance
              : 0;

        }

        if (
          Number.isFinite(
            Number(
              data.danceStartedAt
            )
          )
        ) {

          player.danceStartedAt =
            Number(
              data.danceStartedAt
            ) || 0;

        }

        socket.broadcast.emit(
          'player-state',
          player
        );

      }
    );

    /* =====================================================
       OLD PLAYER MOVE COMPATIBILITY
    ===================================================== */

    socket.on(
      'player-move',
      data => {

        const player =
          players.get(
            socket.id
          );

        if (!player) {
          return;
        }

        data =
          data || {};

        if (
          Number.isFinite(
            Number(data.x)
          )
        ) {

          player.x =
            clamp(
              Number(data.x),
              -16,
              16
            );

        }

        if (
          Number.isFinite(
            Number(data.y)
          )
        ) {

          player.y =
            clamp(
              Number(data.y),
              0,
              8
            );

        }

        if (
          Number.isFinite(
            Number(data.z)
          )
        ) {

          player.z =
            clamp(
              Number(data.z),
              -15.5,
              15.5
            );

        }

        if (
          Number.isFinite(
            Number(data.yaw)
          )
        ) {

          player.yaw =
            Number(data.yaw);

        }

        if (
          Number.isFinite(
            Number(data.pitch)
          )
        ) {

          player.pitch =
            Number(data.pitch);

        }

        socket.broadcast.emit(
          'player-state',
          player
        );

      }
    );

    /* =====================================================
       DANCES / EMOTES
    ===================================================== */

    socket.on(
      'player-emote',
      data => {

        const player =
          players.get(
            socket.id
          );

        if (!player) {
          return;
        }

        const id =
          Number(
            data?.dance ??
            data?.emote ??
            0
          );

        player.dance =
          EMOTES.has(id)
            ? id
            : 0;

        player.danceStartedAt =
          player.dance
            ? Date.now()
            : 0;

        io.emit(
          'player-state',
          player
        );

      }
    );

    /* =====================================================
       CLUB SCREEN
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

          if (
            !/^https:\/\//i.test(
              src
            )
          ) {

            console.log(
              'SCREEN INVALID URL:',
              src
            );

            return;

          }

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

        } else {

          clubScreenState.active =
            false;

          clubScreenState.src =
            '';

          clubScreenState.name =
            '';

        }

        clubScreenState.owner =
          SCREEN_HOST;

        io.emit(
          'club-screen-state',
          clubScreenState
        );

      }
    );

    /* =====================================================
       CHAT + PERSONAL TRANSLATION
       
       IMPORTANT:
       Every message is translated separately for EVERY
       recipient, including the sender.

       Example:
       RU user writes "hello"
       RU sees "Привет"
       EN sees "Hello"
       DE sees "Hallo"
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

        const recipients =
          [
            ...onlineUsers.entries()
          ];

        console.log(
          `[CHAT] ${socket.username}: "${original}" | recipients=${recipients.length}`
        );

        await Promise.all(
          recipients.map(
            async ([id, user]) => {

              const targetLanguage =
                normalizeLanguage(
                  user.language
                );

              /*
               * DO NOT skip translation when
               * targetLanguage === senderLanguage.
               *
               * Google Translate uses sl=auto,
               * so it detects the language the user
               * actually typed.
               */

              const translated =
                await translateText(
                  original,
                  targetLanguage
                );

              const targetSocket =
                io.sockets.sockets.get(
                  id
                );

              if (!targetSocket) {
                return;
              }

              targetSocket.emit(
                'chat-message',
                {

                  user:
                    socket.username,

                  username:
                    socket.username,

                  text:
                    translated,

                  original:
                    original,

                  sourceLanguage:
                    'auto',

                  targetLanguage:
                    targetLanguage,

                  ts:
                    Date.now()

                }
              );

            }
          )
        );

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
       DISCONNECT
    ===================================================== */

    socket.on(
      'disconnect',
      reason => {

        const username =
          socket.username ||
          'unknown';

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

        console.log(
          'DISCONNECT:',
          username,
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
      'CHAT AUTO-DETECT: ON'
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

  } catch (error) {

    console.error(error);

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