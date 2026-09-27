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

/* =========================================================
   CONFIG
========================================================= */

const PORT = process.env.PORT || 3000;
const RTMP_PORT = process.env.RTMP_PORT || 1935;
const NMS_HTTP_PORT = process.env.NMS_HTTP_PORT || 8000;

const PUBLIC_DIR = path.join(__dirname, 'public');
const HLS_DIR = path.join(__dirname, 'hls');
const USERS_FILE = path.join(__dirname, 'users.json');

const HLS_STREAM_DIR = path.join(HLS_DIR, 'ews');

/* =========================================================
   DIRECTORIES / USERS
========================================================= */

if (!fs.existsSync(PUBLIC_DIR)) {
    fs.mkdirSync(PUBLIC_DIR, { recursive: true });
}

if (!fs.existsSync(HLS_DIR)) {
    fs.mkdirSync(HLS_DIR, { recursive: true });
}

if (!fs.existsSync(HLS_STREAM_DIR)) {
    fs.mkdirSync(HLS_STREAM_DIR, { recursive: true });
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

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

app.use(express.static(PUBLIC_DIR));

app.use(
    '/hls',
    express.static(HLS_DIR, {
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
                    'no-cache, no-store, must-revalidate'
                );
            }

            res.setHeader(
                'Access-Control-Allow-Origin',
                '*'
            );
        }
    })
);

/* =========================================================
   HELPERS
========================================================= */

function readUsers() {
    try {
        const raw = fs.readFileSync(
            USERS_FILE,
            'utf8'
        );

        const users = JSON.parse(raw);

        return Array.isArray(users)
            ? users
            : [];
    } catch (err) {
        console.error(
            'USERS READ ERROR:',
            err
        );

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

/* =========================================================
   STATUS
========================================================= */

app.get('/api/status', (req, res) => {
    res.json({
        ok: true,
        service: 'EWS SESSIONS',
        online: onlineUsers.size,
        stream: true
    });
});

/* =========================================================
   REGISTER
========================================================= */

app.post('/api/register', (req, res) => {

    const username = cleanUsername(
        req.body.username
    );

    const password = String(
        req.body.password || ''
    );

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

    const exists = users.some(
        user =>
            String(user.username).toLowerCase() ===
            username.toLowerCase()
    );

    if (exists) {
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

/* =========================================================
   LOGIN
========================================================= */

app.post('/api/login', (req, res) => {

    const username = cleanUsername(
        req.body.username
    );

    const password = String(
        req.body.password || ''
    );

    const users = readUsers();

    const user = users.find(
        item =>
            String(item.username).toLowerCase() ===
            username.toLowerCase()
    );

    if (!user) {
        return res.status(401).json({
            ok: false,
            error: 'Пользователь не найден.'
        });
    }

    /*
      Поддерживаем обычный SHA-256,
      который использует этот server.js.
    */

    const passwordHash =
        hashPassword(password);

    if (user.password !== passwordHash) {
        return res.status(401).json({
            ok: false,
            error: 'Неверный пароль.'
        });
    }

    res.json({
        ok: true,
        username: user.username
    });
});

/* =========================================================
   TRANSLATION
========================================================= */

async function translateText(text, targetLanguage) {

    if (!text) {
        return '';
    }

    if (!targetLanguage) {
        return text;
    }

    const target =
        String(targetLanguage)
            .trim()
            .toLowerCase();

    if (
        !target ||
        target === 'auto'
    ) {
        return text;
    }

    /*
      Google Translate endpoint.
      Перевод выполняется сервером отдельно
      для каждого получателя.
    */

    try {

        const url =
            'https://translate.googleapis.com/translate_a/single' +
            '?client=gtx' +
            '&sl=auto' +
            '&tl=' + encodeURIComponent(target) +
            '&dt=t' +
            '&q=' + encodeURIComponent(text);

        const response =
            await fetch(url);

        if (!response.ok) {
            return text;
        }

        const data =
            await response.json();

        if (
            Array.isArray(data) &&
            Array.isArray(data[0])
        ) {

            return data[0]
                .map(part =>
                    Array.isArray(part)
                        ? part[0]
                        : ''
                )
                .join('');
        }

        return text;

    } catch (err) {

        console.error(
            'TRANSLATION ERROR:',
            err.message
        );

        return text;
    }
}

app.post('/api/translate', async (req, res) => {

    const text =
        String(req.body.text || '');

    const target =
        String(req.body.target || 'en');

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
});

/* =========================================================
   SOCKET.IO STATE
========================================================= */

const onlineUsers = new Map();
const players = new Map();

/*
  ВАЖНО:
  Экран клуба всегда принадлежит mvxtra.
  Никаких новых "хостов" при выходе пользователя.
*/

const clubScreenState = {
    active: false,
    src: '',
    name: '',
    owner: 'mvxtra'
};

/* =========================================================
   ONLINE USERS
========================================================= */

function getOnlineUsers() {

    return Array.from(
        onlineUsers.values()
    ).map(user => ({
        username: user.username,
        language: user.language
    }));
}

function broadcastOnline() {

    io.emit(
        'online-users',
        getOnlineUsers()
    );
}

/* =========================================================
   PLAYERS
========================================================= */

function getPlayers() {

    return Array.from(
        players.values()
    ).map(player => ({
        id: player.id,
        username: player.username,
        x: player.x,
        z: player.z,
        yaw: player.yaw,
        pitch: player.pitch
    }));
}

function broadcastPlayersSnapshot(socket) {

    if (!socket) return;

    socket.emit(
        'players-state',
        getPlayers()
    );
}

/* =========================================================
   JOIN
========================================================= */

io.on('connection', socket => {

    console.log(
        'SOCKET CONNECT:',
        socket.id
    );

    /* =====================================================
       JOIN
    ===================================================== */

    socket.on('join', data => {

        data = data || {};

        const username =
            cleanUsername(
                data.username
            );

        const language =
            String(
                data.language || 'en'
            ).toLowerCase();

        if (!username) {
            return;
        }

        /*
          Если пользователь уже был подключён
          этим socket — сначала очищаем.
        */

        onlineUsers.set(
            socket.id,
            {
                id: socket.id,
                username,
                language
            }
        );

        /*
          Начальная позиция игрока.
        */

        const player = {
            id: socket.id,
            username,
            x: 0,
            z: 13,
            yaw: 0,
            pitch: 0
        };

        players.set(
            socket.id,
            player
        );

        socket.username = username;
        socket.language = language;

        /*
          Говорим клиенту, что управление экраном
          доступно только mvxtra.
        */

        socket.emit(
            'screen-host',
            {
                host:
                    username.toLowerCase() ===
                    'mvxtra',
                username: 'mvxtra'
            }
        );

        /*
          Онлайн список.
        */

        broadcastOnline();

        /*
          Текущее состояние экрана.
        */

        socket.emit(
            'club-screen-state',
            clubScreenState
        );

        /*
          Уже находящиеся игроки.
        */

        broadcastPlayersSnapshot(socket);

        /*
          Новый игрок появляется у остальных.
        */

        socket.broadcast.emit(
            'player-state',
            player
        );

        /*
          Совместимость.
        */

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
    });

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
            broadcastPlayersSnapshot(socket);
        }
    );

    /* =====================================================
       PLAYER STATE
    ===================================================== */

    socket.on(
        'player-state',
        data => {

            if (!socket.username) {
                return;
            }

            const player =
                players.get(socket.id);

            if (!player) {
                return;
            }

            data = data || {};

            const x =
                Number(data.x);

            const z =
                Number(data.z);

            const yaw =
                Number(data.yaw);

            const pitch =
                Number(data.pitch);

            if (Number.isFinite(x)) {
                player.x =
                    Math.max(
                        -16,
                        Math.min(16, x)
                    );
            }

            if (Number.isFinite(z)) {
                player.z =
                    Math.max(
                        -15.5,
                        Math.min(15.5, z)
                    );
            }

            if (Number.isFinite(yaw)) {
                player.yaw = yaw;
            }

            if (Number.isFinite(pitch)) {
                player.pitch = pitch;
            }

            socket.broadcast.emit(
                'player-state',
                {
                    id: socket.id,
                    username: player.username,
                    x: player.x,
                    z: player.z,
                    yaw: player.yaw,
                    pitch: player.pitch
                }
            );
        }
    );

    /* =====================================================
       OLD PLAYER MOVE COMPATIBILITY
    ===================================================== */

    socket.on(
        'player-move',
        data => {

            if (!socket.username) {
                return;
            }

            const player =
                players.get(socket.id);

            if (!player) {
                return;
            }

            data = data || {};

            if (
                Number.isFinite(
                    Number(data.x)
                )
            ) {
                player.x =
                    Math.max(
                        -16,
                        Math.min(
                            16,
                            Number(data.x)
                        )
                    );
            }

            if (
                Number.isFinite(
                    Number(data.z)
                )
            ) {
                player.z =
                    Math.max(
                        -15.5,
                        Math.min(
                            15.5,
                            Number(data.z)
                        )
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
                {
                    id: socket.id,
                    username: player.username,
                    x: player.x,
                    z: player.z,
                    yaw: player.yaw,
                    pitch: player.pitch
                }
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
       CLUB SCREEN
       ONLY MVXTRA
    ===================================================== */

    socket.on(
        'club-screen-state',
        state => {

            if (!socket.username) {
                return;
            }

            if (
                socket.username
                    .toLowerCase() !==
                'mvxtra'
            ) {

                console.log(
                    'SCREEN DENIED:',
                    socket.username
                );

                return;
            }

            state = state || {};

            if (
                state.active === true &&
                typeof state.src === 'string' &&
                state.src.length > 0
            ) {

                clubScreenState.active = true;

                clubScreenState.src =
                    state.src.slice(0, 2000);

                clubScreenState.name =
                    String(
                        state.name || 'MEDIA'
                    ).slice(0, 100);

                clubScreenState.owner =
                    'mvxtra';

            } else {

                clubScreenState.active = false;
                clubScreenState.src = '';
                clubScreenState.name = '';
                clubScreenState.owner = 'mvxtra';
            }

            /*
              Всем игрокам одновременно.
            */

            io.emit(
                'club-screen-state',
                clubScreenState
            );

            console.log(
                'CLUB SCREEN:',
                clubScreenState
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

            message = message || {};

            const originalText =
                String(
                    message.text || ''
                )
                .trim()
                .slice(0, 500);

            if (!originalText) {
                return;
            }

            /*
              Язык отправителя.
              Не используется как глобальный язык.
            */

            const senderLanguage =
                String(
                    socket.language || 'en'
                ).toLowerCase();

            /*
              Переводим ОТДЕЛЬНО для каждого пользователя.
            */

            const recipients =
                Array.from(
                    onlineUsers.entries()
                );

            await Promise.all(
                recipients.map(
                    async ([socketId, user]) => {

                        let translated =
                            originalText;

                        const targetLanguage =
                            String(
                                user.language ||
                                'en'
                            ).toLowerCase();

                        /*
                          Если язык совпадает,
                          перевод не нужен.
                        */

                        if (
                            targetLanguage !==
                            senderLanguage
                        ) {

                            translated =
                                await translateText(
                                    originalText,
                                    targetLanguage
                                );
                        }

                        const targetSocket =
                            io.sockets.sockets.get(
                                socketId
                            );

                        if (!targetSocket) {
                            return;
                        }

                        /*
                          ВАЖНО:
                          Именно такие поля ждёт
                          твой оригинальный index.html:
                            message.user
                            message.text
                            message.ts
                        */

                        targetSocket.emit(
                            'chat-message',
                            {
                                user:
                                    socket.username,

                                text:
                                    translated,

                                ts:
                                    Date.now(),

                                original:
                                    originalText
                            }
                        );
                    }
                )
            );
        }
    );

    /* =====================================================
       LANGUAGE CHANGE
       Только язык ЭТОГО пользователя.
    ===================================================== */

    socket.on(
        'language-change',
        language => {

            if (!socket.username) {
                return;
            }

            const newLanguage =
                String(
                    language || 'en'
                )
                .trim()
                .toLowerCase();

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

            /*
              Другим пользователям ничего
              менять не надо.
            */

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

            /*
              Удаляем игрока у всех.
            */

            io.emit(
                'player-left',
                socket.id
            );

            /*
              Совместимость со старыми клиентами.
            */

            io.emit(
                'player-removed',
                socket.id
            );

            /*
              ВАЖНО:
              НИКАКОГО нового screen host.
              Управлять экраном всё равно может
              только mvxtra.
            */

            broadcastOnline();

            console.log(
                'DISCONNECT:',
                username,
                '|',
                reason
            );
        }
    );
});

/* =========================================================
   NODE MEDIA SERVER
========================================================= */

const nmsConfig = {

    rtmp: {
        port: Number(RTMP_PORT),

        chunk_size: 60000,

        gop_cache: true,

        ping: 30,

        ping_timeout: 60
    },

    http: {
        port: Number(NMS_HTTP_PORT),

        mediaroot: HLS_DIR,

        allow_origin: '*'
    },

    trans: {

        ffmpeg:
            process.env.FFMPEG_PATH ||
            'ffmpeg',

        tasks: [

            {
                app: 'live',

                hls: true,

                hlsFlags:
                    '[hls_time=2:hls_list_size=6:hls_flags=delete_segments+append_list]',

                hlsKeepSegments: 6,

                dash: false
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

} catch (err) {

    console.error(
        'NODE MEDIA SERVER ERROR:',
        err
    );
}

/* =========================================================
   CREATE PUBLIC FOLDER INDEX
========================================================= */

const publicIndex =
    path.join(
        PUBLIC_DIR,
        'index.html'
    );

if (!fs.existsSync(publicIndex)) {

    app.get('/', (req, res) => {

        res.status(404).send(
            'EWS SESSIONS: index.html not found in public folder.'
        );

    });

} else {

    app.get('/', (req, res) => {

        res.sendFile(
            publicIndex
        );

    });
}

/* =========================================================
   404 API
========================================================= */

app.use(
    '/api',
    (req, res) => {

        res.status(404).json({
            ok: false,
            error: 'API endpoint not found.'
        });

    }
);

/* =========================================================
   ERROR HANDLER
========================================================= */

app.use(
    (err, req, res, next) => {

        console.error(
            'EXPRESS ERROR:',
            err
        );

        if (res.headersSent) {
            return next(err);
        }

        res.status(500).json({
            ok: false,
            error: 'Internal server error.'
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

    } catch (err) {
        console.error(err);
    }

    server.close(
        () => {
            process.exit(0);
        }
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