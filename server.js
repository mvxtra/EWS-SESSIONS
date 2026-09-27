const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
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

const PUBLIC_DIR = path.join(__dirname, 'public');
const USERS_FILE = path.join(__dirname, 'users.json');

if (!fs.existsSync(USERS_FILE)) {
    fs.writeFileSync(USERS_FILE, JSON.stringify([], null, 2), 'utf8');
}

/* =========================================================
   USERS
========================================================= */

function loadUsers() {
    try {
        const data = fs.readFileSync(USERS_FILE, 'utf8');
        const users = JSON.parse(data);
        return Array.isArray(users) ? users : [];
    } catch (err) {
        console.error('users.json error:', err);
        return [];
    }
}

function saveUsers(users) {
    try {
        fs.writeFileSync(
            USERS_FILE,
            JSON.stringify(users, null, 2),
            'utf8'
        );
        return true;
    } catch (err) {
        console.error('Cannot save users.json:', err);
        return false;
    }
}

/* =========================================================
   EXPRESS
========================================================= */

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(PUBLIC_DIR));

/* =========================================================
   REGISTER
========================================================= */

app.post('/api/register', (req, res) => {
    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '');

    if (!username || !password) {
        return res.status(400).json({
            ok: false,
            error: 'Введите логин и пароль.'
        });
    }

    if (username.length < 3 || username.length > 24) {
        return res.status(400).json({
            ok: false,
            error: 'Логин должен быть от 3 до 24 символов.'
        });
    }

    if (password.length < 4) {
        return res.status(400).json({
            ok: false,
            error: 'Пароль должен быть не короче 4 символов.'
        });
    }

    const users = loadUsers();

    const exists = users.some(
        user =>
            String(user.username || '').toLowerCase() ===
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
        password
    });

    if (!saveUsers(users)) {
        return res.status(500).json({
            ok: false,
            error: 'Не удалось сохранить пользователя.'
        });
    }

    res.json({
        ok: true,
        username
    });
});

/* =========================================================
   LOGIN
========================================================= */

app.post('/api/login', (req, res) => {
    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '');

    const users = loadUsers();

    const user = users.find(
        u =>
            String(u.username || '').toLowerCase() ===
                username.toLowerCase() &&
            String(u.password || '') === password
    );

    if (!user) {
        return res.status(401).json({
            ok: false,
            error: 'Неверный логин или пароль.'
        });
    }

    res.json({
        ok: true,
        username: user.username
    });
});

/* =========================================================
   CLUB STATE
========================================================= */

const SCREEN_HOST = 'mvxtra';

let clubScreenState = {
    active: false,
    src: '',
    name: '',
    owner: SCREEN_HOST
};

const onlineUsers = new Map();
const players = new Map();
const userLanguages = new Map();
const playerEmotes = new Map();

/* =========================================================
   HELPERS
========================================================= */

function sanitizeNumber(value, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

function getPlayers() {
    return Array.from(players.values());
}

function broadcastOnlineUsers() {
    io.emit(
        'online-users',
        Array.from(onlineUsers.entries()).map(([id, username]) => ({
            id,
            username
        }))
    );
}

function broadcastPlayers() {
    io.emit('players-state', getPlayers());
}

/* =========================================================
   SOCKET.IO
========================================================= */

io.on('connection', socket => {

    console.log('Socket connected:', socket.id);

    /* =====================================================
       JOIN
    ===================================================== */

    socket.on('join', data => {

        const username =
            String(data?.username || 'PLAYER').trim();

        const language =
            String(data?.language || data?.lang || 'ru').trim();

        socket.username = username;
        socket.language = language;

        onlineUsers.set(socket.id, username);
        userLanguages.set(socket.id, language);

        const player = {
            id: socket.id,
            username,

            x: 0,
            y: 0,
            z: 13,

            yaw: 0,
            pitch: 0,

            moving: false,
            jumping: false,

            dance: 0,
            danceStartedAt: 0
        };

        players.set(socket.id, player);

        socket.emit(
            'club-screen-state',
            clubScreenState
        );

        socket.emit(
            'players-state',
            getPlayers().filter(
                p => p.id !== socket.id
            )
        );

        socket.emit(
            'online-users',
            Array.from(onlineUsers.entries()).map(
                ([id, name]) => ({
                    id,
                    username: name
                })
            )
        );

        socket.broadcast.emit(
            'player-joined',
            player
        );

        broadcastOnlineUsers();

        console.log(
            `${username} joined the club (${socket.id})`
        );
    });

    /* =====================================================
       REQUEST PLAYERS
    ===================================================== */

    socket.on('request-players', () => {

        socket.emit(
            'players-state',
            getPlayers().filter(
                p => p.id !== socket.id
            )
        );

    });

    /* =====================================================
       REQUEST ONLINE
    ===================================================== */

    socket.on('request-online', () => {

        socket.emit(
            'online-users',
            Array.from(onlineUsers.entries()).map(
                ([id, username]) => ({
                    id,
                    username
                })
            )
        );

    });

    /* =====================================================
       PLAYER STATE
    ===================================================== */

    socket.on('player-state', data => {

        const player = players.get(socket.id);

        if (!player) return;

        player.x =
            sanitizeNumber(data?.x, player.x);

        player.y =
            sanitizeNumber(data?.y, player.y);

        player.z =
            sanitizeNumber(data?.z, player.z);

        player.yaw =
            sanitizeNumber(data?.yaw, player.yaw);

        player.pitch =
            sanitizeNumber(data?.pitch, player.pitch);

        player.moving =
            !!data?.moving;

        player.jumping =
            !!data?.jumping;

        if (data?.dance !== undefined) {
            player.dance =
                sanitizeNumber(data.dance, 0);
        }

        if (data?.danceStartedAt !== undefined) {
            player.danceStartedAt =
                sanitizeNumber(
                    data.danceStartedAt,
                    0
                );
        }

        socket.broadcast.emit(
            'player-state',
            player
        );
    });

    /* =====================================================
       PLAYER MOVE
    ===================================================== */

    socket.on('player-move', data => {

        const player = players.get(socket.id);

        if (!player) return;

        player.x =
            sanitizeNumber(data?.x, player.x);

        player.y =
            sanitizeNumber(data?.y, player.y);

        player.z =
            sanitizeNumber(data?.z, player.z);

        player.yaw =
            sanitizeNumber(data?.yaw, player.yaw);

        player.pitch =
            sanitizeNumber(data?.pitch, player.pitch);

        player.moving =
            !!data?.moving;

        player.jumping =
            !!data?.jumping;

        if (data?.dance !== undefined) {
            player.dance =
                sanitizeNumber(data.dance, 0);
        }

        if (data?.danceStartedAt !== undefined) {
            player.danceStartedAt =
                sanitizeNumber(
                    data.danceStartedAt,
                    0
                );
        }

        socket.broadcast.emit(
            'player-move',
            player
        );
    });

    /* =====================================================
       EMOTE
    ===================================================== */

    socket.on('player-emote', data => {

        const player = players.get(socket.id);

        if (!player) return;

        let emote = data?.emote;

        if (
            emote === null ||
            emote === undefined
        ) {
            emote = null;
        } else {

            emote = String(emote).trim();

            const allowed = [
                'dance1',
                'dance2',
                'shuffle',
                'robot',
                'wave',
                'bounce'
            ];

            if (!allowed.includes(emote)) {
                return;
            }
        }

        player.emote = emote;
        playerEmotes.set(socket.id, emote);

        socket.broadcast.emit(
            'player-emote',
            {
                id: socket.id,
                username: player.username,
                emote
            }
        );
    });

    /* =====================================================
       STOP EMOTE
    ===================================================== */

    socket.on('stop-emote', () => {

        const player = players.get(socket.id);

        if (!player) return;

        player.emote = null;
        player.dance = 0;
        player.danceStartedAt = 0;

        playerEmotes.delete(socket.id);

        socket.broadcast.emit(
            'player-emote',
            {
                id: socket.id,
                username: player.username,
                emote: null
            }
        );
    });

    /* =====================================================
       LANGUAGE
    ===================================================== */

    socket.on('language-change', language => {

        const lang =
            String(language || 'ru').trim();

        socket.language = lang;
        userLanguages.set(
            socket.id,
            lang
        );

        socket.emit(
            'language-updated',
            lang
        );
    });

    /* =====================================================
       CHAT
    ===================================================== */

    socket.on('chat-message', data => {

        const username =
            String(
                socket.username ||
                data?.user ||
                'PLAYER'
            ).trim();

        const text =
            String(
                data?.text || ''
            )
            .trim()
            .slice(0, 500);

        const sourceLang =
            String(
                socket.language ||
                data?.lang ||
                'ru'
            ).trim();

        if (!text) return;

        const message = {
            id:
                Date.now() +
                '-' +
                socket.id,

            user: username,

            text,

            lang: sourceLang,

            timestamp: Date.now()
        };

        /*
         * Отправляем оригинал ВСЕМ.
         *
         * Каждый браузер самостоятельно переводит
         * сообщение на выбранный именно этим пользователем
         * язык.
         */
        io.emit(
            'chat-message',
            message
        );
    });

    /* =====================================================
       SCREEN HOST
    ===================================================== */

    socket.on('screen-host', () => {

        if (
            String(socket.username || '').toLowerCase() !==
            SCREEN_HOST.toLowerCase()
        ) {

            socket.emit(
                'screen-host-result',
                {
                    ok: false,
                    error:
                        'Только mvxtra может управлять экраном.'
                }
            );

            return;
        }

        socket.emit(
            'screen-host-result',
            {
                ok: true
            }
        );
    });

    /* =====================================================
       CLUB SCREEN
    ===================================================== */

    socket.on(
        'club-screen-state',
        state => {

            const username =
                String(
                    socket.username || ''
                ).trim();

            if (
                username.toLowerCase() !==
                SCREEN_HOST.toLowerCase()
            ) {

                socket.emit(
                    'screen-host-result',
                    {
                        ok: false,
                        error:
                            'Только mvxtra может управлять экраном.'
                    }
                );

                return;
            }

            if (
                !state ||
                state.active === false
            ) {

                clubScreenState = {
                    active: false,
                    src: '',
                    name: '',
                    owner: SCREEN_HOST
                };

                io.emit(
                    'club-screen-state',
                    clubScreenState
                );

                return;
            }

            const src =
                String(
                    state.src || ''
                ).trim();

            const name =
                String(
                    state.name || 'MEDIA'
                ).trim();

            if (!src) return;

            clubScreenState = {
                active: true,
                src,
                name,
                owner: SCREEN_HOST
            };

            io.emit(
                'club-screen-state',
                clubScreenState
            );
        }
    );

    /* =====================================================
       DISCONNECT
    ===================================================== */

    socket.on('disconnect', reason => {

        const username =
            socket.username ||
            onlineUsers.get(socket.id) ||
            'PLAYER';

        console.log(
            `${username} disconnected: ${reason}`
        );

        onlineUsers.delete(socket.id);
        userLanguages.delete(socket.id);
        playerEmotes.delete(socket.id);
        players.delete(socket.id);

        socket.broadcast.emit(
            'player-left',
            socket.id
        );

        socket.broadcast.emit(
            'player-removed',
            socket.id
        );

        broadcastOnlineUsers();
        broadcastPlayers();
    });

});

/* =========================================================
   HTTP
========================================================= */

server.listen(
    PORT,
    '0.0.0.0',
    () => {

        console.log('');
        console.log('====================================');
        console.log('       EWS SESSIONS SERVER');
        console.log('====================================');
        console.log(`HTTP: http://localhost:${PORT}`);
        console.log(`PORT: ${PORT}`);
        console.log(`SCREEN HOST: ${SCREEN_HOST}`);
        console.log('Socket.IO: READY');
        console.log('EMOTES: READY');
        console.log('CHAT: READY');
        console.log('ONLINE: READY');
        console.log('====================================');
        console.log('');
    }
);

/* =========================================================
   RTMP / HLS
========================================================= */

const mediaRoot =
    path.join(
        __dirname,
        'media'
    );

if (!fs.existsSync(mediaRoot)) {
    fs.mkdirSync(
        mediaRoot,
        { recursive: true }
    );
}

const rtmpConfig = {

    logType: 3,

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
    },

    trans: {
        ffmpeg: './ffmpeg',

        tasks: [
            {
                app: 'live',
                hls: true,

                hlsFlags:
                    '[hls_time=2:hls_list_size=3:hls_flags=delete_segments]',

                dash: false
            }
        ]
    }
};

try {

    const nms =
        new NodeMediaServer(
            rtmpConfig
        );

    nms.run();

    console.log(
        'RTMP / HLS server started.'
    );

    console.log(
        'RTMP: rtmp://YOUR_SERVER/live/STREAM_KEY'
    );

    console.log(
        'HLS: http://YOUR_SERVER:8000/live/STREAM_KEY/index.m3u8'
    );

} catch (err) {

    console.error(
        'RTMP / HLS server error:',
        err
    );
}