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
const HLS_STREAM_DIR = path.join(HLS_DIR, 'ews');

/*
  ВАЖНО:
  Оставляем users.json ТАМ ЖЕ,
  где он был в твоём старом сервере.
*/
const USERS_FILE = path.join(
    __dirname,
    'users.json'
);

const SCREEN_HOST = 'mvxtra';

/* =========================================================
   DIRECTORIES
========================================================= */

if (!fs.existsSync(PUBLIC_DIR)) {
    fs.mkdirSync(PUBLIC_DIR, {
        recursive: true
    });
}

if (!fs.existsSync(HLS_DIR)) {
    fs.mkdirSync(HLS_DIR, {
        recursive: true
    });
}

if (!fs.existsSync(HLS_STREAM_DIR)) {
    fs.mkdirSync(HLS_STREAM_DIR, {
        recursive: true
    });
}

/*
  НЕ перезаписываем существующий users.json.
  Если его нет — создаём пустой.
*/
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
    express.static(
        HLS_DIR,
        {
            setHeaders: (
                res,
                filePath
            ) => {

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
   HELPERS
========================================================= */

function readUsers() {

    try {

        const raw =
            fs.readFileSync(
                USERS_FILE,
                'utf8'
            );

        const users =
            JSON.parse(raw);

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
        /^[a-zA-Z0-9_\-а-яА-ЯёЁ ]+$/
            .test(username)
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
   STATUS
========================================================= */

app.get(
    '/api/status',
    (req, res) => {

        res.json({
            ok: true,
            service: 'EWS SESSIONS',
            online:
                onlineUsers.size,
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
            !isValidUsername(
                username
            )
        ) {

            return res.status(400).json({
                ok: false,
                error:
                    'Некорректное имя пользователя.'
            });
        }

        if (
            password.length < 4
        ) {

            return res.status(400).json({
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
                    String(
                        user.username
                    )
                    .toLowerCase() ===
                    username.toLowerCase()
            );

        if (exists) {

            return res.status(409).json({
                ok: false,
                error:
                    'Такой пользователь уже существует.'
            });
        }

        users.push({
            username,
            password:
                hashPassword(
                    password
                ),
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

        const users =
            readUsers();

        const user =
            users.find(
                item =>
                    String(
                        item.username
                    )
                    .toLowerCase() ===
                    username.toLowerCase()
            );

        if (!user) {

            return res.status(401).json({
                ok: false,
                error:
                    'Пользователь не найден.'
            });
        }

        /*
          Используем ТОТ ЖЕ SHA-256,
          что и твой старый сервер.
        */

        const passwordHash =
            hashPassword(
                password
            );

        if (
            user.password !==
            passwordHash
        ) {

            return res.status(401).json({
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

async function translateText(
    text,
    targetLanguage
) {

    if (!text) {
        return '';
    }

    const target =
        String(
            targetLanguage || ''
        )
        .trim()
        .toLowerCase();

    if (
        !target ||
        target === 'auto'
    ) {
        return text;
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
            encodeURIComponent(text);

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
                .map(
                    part =>
                        Array.isArray(part)
                            ? part[0]
                            : ''
                )
                .join('');
        }

        return text;

    } catch (error) {

        console.error(
            'TRANSLATION ERROR:',
            error.message
        );

        return text;
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
   SOCKET STATE
========================================================= */

const onlineUsers =
    new Map();

const players =
    new Map();

const clubScreenState = {

    active: false,

    src: '',

    name: '',

    owner:
        SCREEN_HOST
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
        const point of SPAWN_POINTS
    ) {

        const occupied =
            Array.from(
                players.values()
            ).some(
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
                Math.random() * 14 - 7
            ),

        z:
            Math.round(
                Math.random() * 8 + 5
            )
    };
}

/* =========================================================
   ONLINE
========================================================= */

function getOnlineUsers() {

    return Array.from(
        onlineUsers.values()
    ).map(
        user => ({
            username:
                user.username,

            language:
                user.language
        })
    );
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
    ).map(
        player => ({

            id:
                player.id,

            username:
                player.username,

            x:
                player.x,

            y:
                player.y,

            z:
                player.z,

            yaw:
                player.yaw,

            pitch:
                player.pitch
        })
    );
}

function sendPlayersSnapshot(
    socket
) {

    if (!socket) {
        return;
    }

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
   SOCKET CONNECTION
========================================================= */

io.on(
    'connection',
    socket => {

        console.log(
            'SOCKET CONNECT:',
            socket.id
        );

        /* =================================================
           JOIN
        ================================================= */

        socket.on(
            'join',
            data => {

                data =
                    data || {};

                const username =
                    cleanUsername(
                        data.username
                    );

                const language =
                    String(
                        data.language ||
                        'en'
                    )
                    .trim()
                    .toLowerCase();

                if (!username) {
                    return;
                }

                socket.username =
                    username;

                socket.language =
                    language;

                onlineUsers.set(
                    socket.id,
                    {
                        id:
                            socket.id,

                        username:
                            username,

                        language:
                            language
                    }
                );

                const spawn =
                    getSpawnPoint();

                const player = {

                    id:
                        socket.id,

                    username:
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
                        0
                };

                players.set(
                    socket.id,
                    player
                );

                /*
                  ТОЛЬКО MVXTRA управляет экраном.
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

                /*
                  Своя позиция.
                */

                socket.emit(
                    'player-spawn',
                    player
                );

                /*
                  Уже существующие игроки.
                */

                sendPlayersSnapshot(
                    socket
                );

                /*
                  Новый игрок всем остальным.
                */

                socket.broadcast.emit(
                    'player-state',
                    player
                );

                /*
                  Онлайн.
                */

                broadcastOnline();

                /*
                  Состояние экрана.
                */

                socket.emit(
                    'club-screen-state',
                    clubScreenState
                );

                /*
                  Старый совместимый event.
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
            }
        );

        /* =================================================
           REQUEST ONLINE
        ================================================= */

        socket.on(
            'request-online',
            () => {

                socket.emit(
                    'online-users',
                    getOnlineUsers()
                );
            }
        );

        /* =================================================
           REQUEST PLAYERS
        ================================================= */

        socket.on(
            'request-players',
            () => {

                sendPlayersSnapshot(
                    socket
                );
            }
        );

        /* =================================================
           PLAYER STATE
        ================================================= */

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
                            1.7,
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

                socket.broadcast.emit(
                    'player-state',
                    player
                );
            }
        );

        /* =================================================
           OLD PLAYER MOVE
        ================================================= */

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
                            1.7,
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

        /* =================================================
           SCREEN REQUEST
        ================================================= */

        socket.on(
            'request-club-screen',
            () => {

                socket.emit(
                    'club-screen-state',
                    clubScreenState
                );
            }
        );

        /* =================================================
           SCREEN
           ONLY MVXTRA
        ================================================= */

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

                    clubScreenState.active =
                        true;

                    clubScreenState.src =
                        state.src
                            .trim()
                            .slice(
                                0,
                                2000
                            );

                    clubScreenState.name =
                        String(
                            state.name ||
                            'MEDIA'
                        )
                        .slice(
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

                console.log(
                    'CLUB SCREEN:',
                    clubScreenState
                );
            }
        );

        /* =================================================
           CHAT
        ================================================= */

        socket.on(
            'chat-message',
            async message => {

                if (!socket.username) {
                    return;
                }

                message =
                    message || {};

                const original =
                    String(
                        message.text ||
                        ''
                    )
                    .trim()
                    .slice(
                        0,
                        500
                    );

                if (!original) {
                    return;
                }

                const senderLanguage =
                    String(
                        socket.language ||
                        'en'
                    )
                    .toLowerCase();

                const recipients =
                    Array.from(
                        onlineUsers.entries()
                    );

                await Promise.all(
                    recipients.map(
                        async ([id, user]) => {

                            const targetLanguage =
                                String(
                                    user.language ||
                                    'en'
                                )
                                .toLowerCase();

                            let translated =
                                original;

                            if (
                                targetLanguage !==
                                senderLanguage
                            ) {

                                translated =
                                    await translateText(
                                        original,
                                        targetLanguage
                                    );
                            }

                            const targetSocket =
                                io.sockets.sockets.get(
                                    id
                                );

                            if (
                                !targetSocket
                            ) {
                                return;
                            }

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
                                        original
                                }
                            );
                        }
                    )
                );
            }
        );

        /* =================================================
           LANGUAGE
        ================================================= */

        socket.on(
            'language-change',
            language => {

                if (!socket.username) {
                    return;
                }

                const newLanguage =
                    String(
                        language ||
                        'en'
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

        /* =================================================
           DISCONNECT
        ================================================= */

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
   ROOT
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

        res.status(404).send(
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

        res.status(404).json({
            ok: false,
            error:
                'API endpoint not found.'
        });
    }
);

/* =========================================================
   ERROR HANDLER
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

        res.status(500).json({
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