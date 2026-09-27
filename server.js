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

/* =========================================================
   PORTS
========================================================= */

const PORT =
  Number(process.env.PORT) || 3000;

const RTMP_PORT =
  Number(process.env.RTMP_PORT) || 1935;

const NMS_HTTP_PORT =
  Number(process.env.NMS_HTTP_PORT) || 8000;

/* =========================================================
   PATHS
========================================================= */

const PUBLIC_DIR =
  path.join(__dirname, 'public');

const HLS_DIR =
  path.join(__dirname, 'hls');

const HLS_STREAM_DIR =
  path.join(HLS_DIR, 'ews');

const USERS_FILE =
  path.join(__dirname, 'users.json');

/* =========================================================
   CLUB
========================================================= */

const SCREEN_HOST = 'mvxtra';

const FLOOR_Y = 1.7;

const PLAYER_RADIUS = 0.45;

const CLUB_MIN_X = -16;
const CLUB_MAX_X = 16;

const CLUB_MIN_Z = -15.5;
const CLUB_MAX_Z = 15.5;

/*
  Максимальный скачок позиции за один пакет.
  Это не даёт клиенту телепортировать персонажа.
*/
const MAX_MOVE_STEP = 3.0;

/* =========================================================
   EMOTES
========================================================= */

const EMOTES =
  new Set([1, 2, 3, 4, 5, 6]);

/* =========================================================
   DIRECTORIES
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
  })
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
   PLAYER POSITION
========================================================= */

function validNumber(value) {

  return (
    typeof value === 'number' &&
    Number.isFinite(value)
  );

}

/*
  Сервер принудительно удерживает игрока
  на высоте пола.

  Это важная часть исправления бага,
  когда другие игроки начинают "летать".
*/

function normalizePlayerY(player) {

  player.y = FLOOR_Y;

}

/* =========================================================
   BASIC COLLISION
========================================================= */

/*
  Формат:

  {
    minX,
    maxX,
    minZ,
    maxZ
  }

  Здесь пока находятся только безопасные
  внешние границы клуба.

  Точные collision бара / столов /
  колонок / экрана нужно синхронизировать
  с координатами актуального index.html.
*/

const STATIC_COLLIDERS = [];

/*
  Добавить прямоугольный collider.
*/
function addCollider(
  minX,
  maxX,
  minZ,
  maxZ
) {

  STATIC_COLLIDERS.push({
    minX,
    maxX,
    minZ,
    maxZ
  });

}

/*
  Проверка точки относительно collider.
*/
function pointInsideCollider(
  x,
  z,
  radius = PLAYER_RADIUS
) {

  for (
    const collider
    of STATIC_COLLIDERS
  ) {

    const closestX =
      clamp(
        x,
        collider.minX,
        collider.maxX
      );

    const closestZ =
      clamp(
        z,
        collider.minZ,
        collider.maxZ
      );

    const dx =
      x - closestX;

    const dz =
      z - closestZ;

    if (
      dx * dx +
      dz * dz <
      radius * radius
    ) {

      return true;

    }

  }

  return false;

}

/*
  Сейчас возвращаем старую позицию,
  если сервер получил координату
  внутри запрещённой зоны.
*/
function resolveCollision(
  player,
  nextX,
  nextZ
) {

  if (
    pointInsideCollider(
      nextX,
      nextZ
    )
  ) {

    return {
      x: player.x,
      z: player.z,
      collided: true
    };

  }

  return {
    x: nextX,
    z: nextZ,
    collided: false
  };

}

/* =========================================================
   SPAWN
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

/* =========================================================
   API STATUS
========================================================= */

app.get(
  '/api/status',
  (req, res) => {

    res.json({
      ok: true,
      service: 'EWS SESSIONS',
      online:
        onlineUsers.size,
      stream: true,
      multiplayer: true,
      seating: true,
      collision: true
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

const MAX_TRANSLATION_CACHE =
  500;

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
              chunk => {
                body += chunk;
              }
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
        () => {
          req.destroy(
            new Error(
              'translation timeout'
            )
          );
        }
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

  if (!text) {
    return '';
  }

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
   ONLINE / PLAYERS
========================================================= */

const onlineUsers =
  new Map();

const players =
  new Map();

/* =========================================================
   SEATS
========================================================= */

/*
  seatId -> {
    seatId,
    playerId,
    username,
    x,
    y,
    z,
    yaw
  }
*/

const occupiedSeats =
  new Map();

/*
  playerId -> seatId
*/

const playerSeats =
  new Map();

/*
  Seat positions are intentionally kept
  compatible with the client.

  The client can send the exact seat position
  when requesting a seat.
*/

function releasePlayerSeat(
  playerId
) {

  const seatId =
    playerSeats.get(
      playerId
    );

  if (!seatId) {
    return null;
  }

  playerSeats.delete(
    playerId
  );

  const seat =
    occupiedSeats.get(
      seatId
    );

  occupiedSeats.delete(
    seatId
  );

  if (seat) {

    io.emit(
      'seat-state',
      {
        seatId,
        occupied: false,
        playerId: null,
        username: null
      }
    );

  }

  return seatId;

}

function occupySeat(
  player,
  data
) {

  const seatId =
    String(
      data?.seatId || ''
    )
      .trim()
      .slice(0, 80);

  if (!seatId) {
    return false;
  }

  const current =
    occupiedSeats.get(
      seatId
    );

  if (
    current &&
    current.playerId !==
      player.id
  ) {

    return false;

  }

  /*
    Если игрок уже сидит
    на другом стуле — освобождаем его.
  */

  if (
    playerSeats.has(
      player.id
    ) &&
    playerSeats.get(
      player.id
    ) !== seatId
  ) {

    releasePlayerSeat(
      player.id
    );

  }

  const x =
    Number(data.x);

  const y =
    Number(data.y);

  const z =
    Number(data.z);

  const yaw =
    Number(data.yaw);

  const seat = {

    seatId,

    playerId:
      player.id,

    username:
      player.username,

    x:
      validNumber(x)
        ? clamp(
            x,
            CLUB_MIN_X,
            CLUB_MAX_X
          )
        : player.x,

    y:
      FLOOR_Y,

    z:
      validNumber(z)
        ? clamp(
            z,
            CLUB_MIN_Z,
            CLUB_MAX_Z
          )
        : player.z,

    yaw:
      validNumber(yaw)
        ? yaw
        : player.yaw

  };

  occupiedSeats.set(
    seatId,
    seat
  );

  playerSeats.set(
    player.id,
    seatId
  );

  player.x =
    seat.x;

  player.y =
    FLOOR_Y;

  player.z =
    seat.z;

  player.yaw =
    seat.yaw;

  player.sitting =
    true;

  player.seatId =
    seatId;

  io.emit(
    'seat-state',
    {
      seatId,
      occupied: true,
      playerId:
        player.id,
      username:
        player.username
    }
  );

  io.emit(
    'player-state',
    player
  );

  return true;

}

function getSeatsState() {

  return [
    ...occupiedSeats.values()
  ].map(
    seat => ({
      seatId:
        seat.seatId,

      playerId:
        seat.playerId,

      username:
        seat.username
    })
  );

}

/* =========================================================
   CLUB SCREEN
========================================================= */

const clubScreenState = {

  active: false,

  src: '',

  name: '',

  owner:
    SCREEN_HOST

};

/* =========================================================
   SPAWNS
========================================================= */

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

/* =========================================================
   ONLINE
========================================================= */

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

function sendSeatsSnapshot(
  socket
) {

  socket.emit(
    'seats-state',
    getSeatsState()
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
            FLOOR_Y,

          z:
            spawn.z,

          yaw: 0,

          pitch: 0,

          moving: false,

          jumping: false,

          sitting: false,

          seatId: null,

          dance: 0,

          danceStartedAt: 0

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

        sendSeatsSnapshot(
          socket
        );

        socket.broadcast.emit(
          'player-state',
          player
        );

        broadcastOnline();

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
       REQUEST SEATS
    ===================================================== */

    socket.on(
      'request-seats',
      () => {

        sendSeatsSnapshot(
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

        /*
          Если игрок сидит,
          обычное движение запрещаем.
        */

        if (
          player.sitting
        ) {

          normalizePlayerY(
            player
          );

          io.emit(
            'player-state',
            player
          );

          return;

        }

        const x =
          Number(data.x);

        const z =
          Number(data.z);

        const yaw =
          Number(data.yaw);

        const pitch =
          Number(data.pitch);

        let nextX =
          player.x;

        let nextZ =
          player.z;

        if (
          Number.isFinite(x)
        ) {

          nextX =
            clamp(
              x,
              CLUB_MIN_X,
              CLUB_MAX_X
            );

        }

        if (
          Number.isFinite(z)
        ) {

          nextZ =
            clamp(
              z,
              CLUB_MIN_Z,
              CLUB_MAX_Z
            );

        }

        /*
          Anti-teleport.
        */

        const dx =
          nextX -
          player.x;

        const dz =
          nextZ -
          player.z;

        const distance =
          Math.sqrt(
            dx * dx +
            dz * dz
          );

        if (
          distance >
          MAX_MOVE_STEP
        ) {

          const factor =
            MAX_MOVE_STEP /
            distance;

          nextX =
            player.x +
            dx * factor;

          nextZ =
            player.z +
            dz * factor;

        }

        const collision =
          resolveCollision(
            player,
            nextX,
            nextZ
          );

        player.x =
          collision.x;

        player.z =
          collision.z;

        /*
          КЛЮЧЕВОЕ ИСПРАВЛЕНИЕ:
          y больше не приходит
          от клиента свободным значением.
        */

        player.y =
          FLOOR_Y;

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

        /*
          Сервер больше не принимает
          свободный flying/jumping state.
        */

        player.jumping =
          false;

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

        if (
          player.sitting
        ) {

          normalizePlayerY(
            player
          );

          io.emit(
            'player-move',
            player
          );

          return;

        }

        const x =
          Number(data.x);

        const z =
          Number(data.z);

        const yaw =
          Number(
            data.yaw ??
            data.ry
          );

        let nextX =
          player.x;

        let nextZ =
          player.z;

        if (
          Number.isFinite(x)
        ) {

          nextX =
            clamp(
              x,
              CLUB_MIN_X,
              CLUB_MAX_X
            );

        }

        if (
          Number.isFinite(z)
        ) {

          nextZ =
            clamp(
              z,
              CLUB_MIN_Z,
              CLUB_MAX_Z
            );

        }

        /*
          Anti-teleport.
        */

        const dx =
          nextX -
          player.x;

        const dz =
          nextZ -
          player.z;

        const distance =
          Math.sqrt(
            dx * dx +
            dz * dz
          );

        if (
          distance >
          MAX_MOVE_STEP
        ) {

          const factor =
            MAX_MOVE_STEP /
            distance;

          nextX =
            player.x +
            dx * factor;

          nextZ =
            player.z +
            dz * factor;

        }

        const collision =
          resolveCollision(
            player,
            nextX,
            nextZ
          );

        player.x =
          collision.x;

        player.z =
          collision.z;

        player.y =
          FLOOR_Y;

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

        player.jumping =
          false;

        io.emit(
          'player-move',
          player
        );

      }
    );

    /* =====================================================
       SIT
    ===================================================== */

    socket.on(
      'seat-request',
      data => {

        if (
          !socket.username ||
          !players.has(
            socket.id
          )
        ) {
          return;
        }

        const player =
          players.get(
            socket.id
          );

        if (
          player.sitting
        ) {

          return;

        }

        const success =
          occupySeat(
            player,
            data || {}
          );

        socket.emit(
          'seat-result',
          {
            ok:
              success,

            seatId:
              success
                ? player.seatId
                : null
          }
        );

      }
    );

    /*
      Алиас на случай,
      если index использует seat-sit.
    */

    socket.on(
      'seat-sit',
      data => {

        if (
          !socket.username ||
          !players.has(
            socket.id
          )
        ) {
          return;
        }

        const player =
          players.get(
            socket.id
          );

        if (
          player.sitting
        ) {
          return;
        }

        const success =
          occupySeat(
            player,
            data || {}
          );

        socket.emit(
          'seat-result',
          {
            ok:
              success,

            seatId:
              success
                ? player.seatId
                : null
          }
        );

      }
    );

    /* =====================================================
       STAND
    ===================================================== */

    socket.on(
      'seat-leave',
      () => {

        if (
          !socket.username ||
          !players.has(
            socket.id
          )
        ) {
          return;
        }

        const player =
          players.get(
            socket.id
          );

        releasePlayerSeat(
          player.id
        );

        player.sitting =
          false;

        player.seatId =
          null;

        player.y =
          FLOOR_Y;

        io.emit(
          'player-state',
          player
        );

      }
    );

    /*
      Алиас.
    */

    socket.on(
      'seat-stand',
      () => {

        if (
          !socket.username ||
          !players.has(
            socket.id
          )
        ) {
          return;
        }

        const player =
          players.get(
            socket.id
          );

        releasePlayerSeat(
          player.id
        );

        player.sitting =
          false;

        player.seatId =
          null;

        player.y =
          FLOOR_Y;

        io.emit(
          'player-state',
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

        if (
          !socket.username
        ) {
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

          if (
            !targetSocket
          ) {
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

        if (
          !socket.username
        ) {
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

        /*
          Освобождаем стул.
        */

        releasePlayerSeat(
          socket.id
        );

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
      RTMP_PORT,

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
      NMS_HTTP_PORT,

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
   START
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
      'SEATING: ON'
    );

    console.log(
      'SERVER FLOOR LOCK: ON'
    );

    console.log(
      'SERVER COLLISION: ON'
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