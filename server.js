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

const PORT = 3000;
const RTMP_PORT = 1935;
const HLS_PORT = 8000;

const mediaRoot = path.join(__dirname, 'media');
const hlsDir = path.join(mediaRoot, 'live', 'ews');
const ffmpegPath = path.join(__dirname, 'ffmpeg.exe');

fs.mkdirSync(hlsDir, { recursive: true });

/* =========================================================
   RTMP SERVER
========================================================= */

const nmsConfig = {
  rtmp: {
    port: RTMP_PORT,
    chunk_size: 60000,
    gop_cache: true,
    ping: 30,
    ping_timeout: 60
  },

  http: {
    port: HLS_PORT,
    mediaroot: mediaRoot,
    allow_origin: '*'
  }
};

const nms = new NodeMediaServer(nmsConfig);

nms.on('prePublish', (id, StreamPath) => {
  console.log('[RTMP] STREAM START:', StreamPath);
});

nms.on('donePublish', (id, StreamPath) => {
  console.log('[RTMP] STREAM STOP:', StreamPath);
});

nms.run();

/* =========================================================
   FFMPEG
========================================================= */

let ffmpegProcess = null;
let ffmpegStarting = false;

function cleanHLS() {
  try {
    const files = fs.readdirSync(hlsDir);

    for (const file of files) {
      if (file.endsWith('.m3u8') || file.endsWith('.ts')) {
        try {
          fs.unlinkSync(path.join(hlsDir, file));
        } catch {}
      }
    }
  } catch {}
}

function startFFmpeg() {
  if (ffmpegProcess || ffmpegStarting) {
    return;
  }

  if (!fs.existsSync(ffmpegPath)) {
    console.error('[FFMPEG] ERROR: ffmpeg.exe не найден!');
    console.error('[FFMPEG] Ожидается:', ffmpegPath);
    return;
  }

  ffmpegStarting = true;

  cleanHLS();

  const output = path.join(hlsDir, 'index.m3u8');

  const args = [
    '-hide_banner',
    '-loglevel', 'warning',
    '-fflags', '+genpts',

    '-i',
    'rtmp://127.0.0.1:1935/live/ews',

    '-map', '0:v:0?',
    '-map', '0:a:0?',

    '-c:v', 'copy',

    '-c:a', 'aac',
    '-b:a', '160k',
    '-ar', '48000',
    '-ac', '2',

    '-f', 'hls',

    '-hls_time', '2',
    '-hls_list_size', '6',

    '-hls_flags',
    'delete_segments+append_list',

    '-hls_segment_filename',
    path.join(hlsDir, 'segment_%03d.ts'),

    output
  ];

  console.log('[FFMPEG] Connecting to RTMP...');

  ffmpegProcess = spawn(
    ffmpegPath,
    args,
    {
      windowsHide: true
    }
  );

  ffmpegStarting = false;

  ffmpegProcess.stderr.on('data', data => {
    const text = data.toString().trim();

    if (text) {
      console.log('[FFMPEG]', text);
    }
  });

  ffmpegProcess.on('error', err => {
    console.error('[FFMPEG ERROR]', err.message);
    ffmpegProcess = null;
  });

  ffmpegProcess.on('close', code => {
    console.log('[FFMPEG] stopped:', code);

    ffmpegProcess = null;

    setTimeout(startFFmpeg, 3000);
  });
}

setTimeout(startFFmpeg, 1500);

/* =========================================================
   EXPRESS
========================================================= */

app.use(express.json());

app.use(
  express.static(
    path.join(__dirname, 'public')
  )
);

/* =========================================================
   HLS
========================================================= */

app.use(
  '/hls',
  express.static(
    path.join(mediaRoot, 'live'),
    {
      setHeaders: (res, filePath) => {

        if (filePath.endsWith('.m3u8')) {
          res.setHeader(
            'Content-Type',
            'application/vnd.apple.mpegurl'
          );

          res.setHeader(
            'Cache-Control',
            'no-cache, no-store, must-revalidate'
          );
        }

        if (filePath.endsWith('.ts')) {
          res.setHeader(
            'Content-Type',
            'video/mp2t'
          );

          res.setHeader(
            'Cache-Control',
            'no-cache'
          );
        }

        res.setHeader(
          'Access-Control-Allow-Origin',
          '*'
        );
      }
    }
  )
);

/* =========================================================
   USERS
========================================================= */

const USERS_FILE =
  path.join(__dirname, 'users.json');

if (!fs.existsSync(USERS_FILE)) {
  fs.writeFileSync(
    USERS_FILE,
    '{}'
  );
}

function loadUsers() {
  try {
    return JSON.parse(
      fs.readFileSync(
        USERS_FILE,
        'utf8'
      )
    );
  } catch {
    return {};
  }
}

function saveUsers(users) {
  fs.writeFileSync(
    USERS_FILE,
    JSON.stringify(
      users,
      null,
      2
    )
  );
}

app.post(
  '/api/register',
  (req, res) => {

    const {
      username,
      password
    } = req.body || {};

    if (!username || !password) {
      return res.json({
        error:
          'Введите логин и пароль'
      });
    }

    if (password.length < 6) {
      return res.json({
        error:
          'Пароль минимум 6 символов'
      });
    }

    const users = loadUsers();

    if (users[username]) {
      return res.json({
        error:
          'Логин занят'
      });
    }

    users[username] = {
      password
    };

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

    const {
      username,
      password
    } = req.body || {};

    if (!username || !password) {
      return res.json({
        error:
          'Введите логин и пароль'
      });
    }

    const users = loadUsers();

    if (!users[username]) {
      return res.json({
        error:
          'Логин не найден'
      });
    }

    if (
      users[username].password !==
      password
    ) {
      return res.json({
        error:
          'Неверный пароль'
      });
    }

    res.json({
      ok: true,
      username
    });
  }
);

/* =========================================================
   TRANSLATION
========================================================= */

const translationCache = new Map();

async function translateText(
  text,
  targetLang
) {

  if (!text || !targetLang) {
    return text;
  }

  const key =
    targetLang +
    '|' +
    text;

  if (translationCache.has(key)) {
    return translationCache.get(key);
  }

  try {

    const url =
      'https://translate.googleapis.com/translate_a/single' +
      '?client=gtx' +
      '&sl=auto' +
      '&tl=' +
      encodeURIComponent(targetLang) +
      '&dt=t' +
      '&q=' +
      encodeURIComponent(text);

    const response =
      await fetch(url);

    if (!response.ok) {
      return text;
    }

    const data =
      await response.json();

    let result = '';

    if (
      Array.isArray(data) &&
      Array.isArray(data[0])
    ) {

      for (
        const part of data[0]
      ) {

        if (
          part &&
          part[0]
        ) {
          result += part[0];
        }
      }
    }

    result =
      result ||
      text;

    translationCache.set(
      key,
      result
    );

    return result;

  } catch {
    return text;
  }
}

/* =========================================================
   ONLINE / CHAT
========================================================= */

const online = new Map();

io.on(
  'connection',
  socket => {

    console.log(
      '[CONNECTED]',
      socket.id
    );

    socket.on(
      'join',
      data => {

        let username = 'Guest';
        let lang = 'ru';

        if (
          typeof data ===
          'string'
        ) {
          username = data;
        }

        else if (
          data &&
          typeof data ===
          'object'
        ) {
          username =
            data.username ||
            'Guest';

          lang =
            data.lang ||
            'ru';
        }

        online.set(
          socket.id,
          {
            username,
            lang
          }
        );

        io.emit(
          'online',
          [
            ...online.values()
          ].map(
            u => u.username
          )
        );

        socket.broadcast.emit(
          'msg',
          {
            user: 'SYSTEM',
            text:
              username +
              ' зашёл в клуб',
            ts: Date.now(),
            system: true
          }
        );
      }
    );

    socket.on(
      'language',
      lang => {

        const user =
          online.get(
            socket.id
          );

        if (!user) return;

        user.lang =
          String(
            lang || 'ru'
          );
      }
    );

    socket.on(
      'msg',
      async data => {

        if (
          !data ||
          !data.text
        ) {
          return;
        }

        const text =
          String(
            data.text
          ).trim();

        if (!text) {
          return;
        }

        const sender =
          online.get(
            socket.id
          );

        const username =
          sender?.username ||
          data.user ||
          'Guest';

        const users =
          [
            ...online.entries()
          ];

        const translatedByLang =
          new Map();

        for (
          const [, user]
          of users
        ) {

          const targetLang =
            user.lang ||
            'ru';

          if (
            !translatedByLang.has(
              targetLang
            )
          ) {

            translatedByLang.set(
              targetLang,
              await translateText(
                text,
                targetLang
              )
            );
          }
        }

        for (
          const [socketId, user]
          of users
        ) {

          const targetLang =
            user.lang ||
            'ru';

          const translatedText =
            translatedByLang.get(
              targetLang
            ) ||
            text;

          io.to(
            socketId
          ).emit(
            'msg',
            {
              user: username,
              text:
                translatedText,
              original: text,
              targetLang,
              translated:
                translatedText !==
                text,
              ts: Date.now()
            }
          );
        }
      }
    );

    socket.on(
      'disconnect',
      () => {

        const user =
          online.get(
            socket.id
          );

        if (!user) return;

        online.delete(
          socket.id
        );

        io.emit(
          'online',
          [
            ...online.values()
          ].map(
            u => u.username
          )
        );

        socket.broadcast.emit(
          'msg',
          {
            user: 'SYSTEM',
            text:
              user.username +
              ' вышел',
            ts: Date.now(),
            system: true
          }
        );
      }
    );
  }
);

/* =========================================================
   SERVER
========================================================= */

server.listen(
  PORT,
  () => {

    console.log('');
    console.log(
      '=============================='
    );

    console.log(
      '       EWS SESSIONS'
    );

    console.log(
      '=============================='
    );

    console.log(
      'WEB:',
      `http://localhost:${PORT}`
    );

    console.log(
      'RTMP:',
      `rtmp://localhost:${RTMP_PORT}/live`
    );

    console.log(
      'STREAM KEY: ews'
    );

    console.log(
      'HLS:',
      `http://localhost:${PORT}/hls/ews/index.m3u8`
    );

    console.log(
      '=============================='
    );
  }
);