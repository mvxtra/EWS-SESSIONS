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

// ============================================================
// PATHS
// ============================================================

const PUBLIC_DIR = path.join(__dirname, 'public');
const USERS_FILE = path.join(__dirname, 'users.json');

if (!fs.existsSync(USERS_FILE)) {
    fs.writeFileSync(USERS_FILE, JSON.stringify([], null, 2), 'utf8');
}

// ============================================================
// USERS
// ============================================================

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

// ============================================================
// EXPRESS
// ============================================================

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(PUBLIC_DIR));

// ============================================================
// REGISTRATION
// ============================================================

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

    saveUsers(users);

    res.json({
        ok: true,
        username
    });
});

// ============================================================
// LOGIN
// ============================================================

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

// ============================================================
// GLOBAL CLUB STATE
// ============================================================

const SCREEN_HOST = 'mvxtra';

let clubScreenState = {
    active: false,
    src: '',
    name: '',
    owner: SCREEN_HOST
};

// username -> socket id
const onlineUsers = new Map();

// socket.id -> player state
const players = new Map();

// socket.id -> language
const userLanguages = new Map();

// socket.id -> current emote
const playerEmotes = new Map();

// ============================================================
// HELPERS
// ============================================================

function sanitizeNumber(value, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

function broadcastOnlineUsers() {
    const users = [];

    for (const [id, username] of onlineUsers.entries()) {
        users.push({
            id,
            username
        });
    }

    io.emit('online-users', users);
}

function broadcastPlayers() {
    io.emit(
        'players-state',
        Array.from(players.values())
    );
}

// ============================================================
// SOCKET.IO
// ============================================================

io.on('connection', socket => {
    console.log('Socket connected:', socket.id);

    // --------------------------------------------------------
    // JOIN
    // --------------------------------------------------------

    socket.on('join', data => {
        const username = String(
            data?.username || 'PLAYER'
        ).trim();

        const language = String(
            data?.lang || 'ru'
        ).trim();

        socket.username = username;
        socket.language = language;

        onlineUsers.set(socket.id, username);
        userLanguages.set(socket.id, language);

        players.set(socket.id, {
            id: socket.id,
            username,

            x: 0,
            y: 0,
            z: 0,

            yaw: 0,
            pitch: 0,

            moving: false,
            jumping: false,

            emote: null
        });

        socket.emit('club-screen-state', clubScreenState);

        socket.emit(
            'players-state',
            Array.from(players.values())
                .filter(player => player.id !== socket.id)
        );

        broadcastOnlineUsers();
        broadcastPlayers();

        console.log(
            `${username} joined the club (${socket.id})`
        );
    });

    // --------------------------------------------------------
    // PLAYER SPAWN
    // --------------------------------------------------------

    socket.on('player-spawn', data => {
        const player = players.get(socket.id);

        if (!player) return;

        player.x = sanitizeNumber(data?.x, player.x);
        player.y = sanitizeNumber(data?.y, player.y);
        player.z = sanitizeNumber(data?.z, player.z);

        player.yaw = sanitizeNumber(data?.yaw, player.yaw);
        player.pitch = sanitizeNumber(data?.pitch, player.pitch);

        player.moving = !!data?.moving;
        player.jumping = !!data?.jumping;

        broadcastPlayers();
    });

    // --------------------------------------------------------
    // PLAYER STATE
    // --------------------------------------------------------

    socket.on('player-state', data => {
        const player = players.get(socket.id);

        if (!player) return;

        player.x = sanitizeNumber(data?.x, player.x);
        player.y = sanitizeNumber(data?.y, player.y);
        player.z = sanitizeNumber(data?.z, player.z);

        player.yaw = sanitizeNumber(data?.yaw, player.yaw);
        player.pitch = sanitizeNumber(data?.pitch, player.pitch);

        player.moving = !!data?.moving;
        player.jumping = !!data?.jumping;

        if (typeof data?.emote === 'string') {
            player.emote = data.emote;
        }

        socket.broadcast.emit('player-state', player);
    });

    // --------------------------------------------------------
    // PLAYER MOVE
    // --------------------------------------------------------

    socket.on('player-move', data => {
        const player = players.get(socket.id);

        if (!player) return;

        player.x = sanitizeNumber(data?.x, player.x);
        player.y = sanitizeNumber(data?.y, player.y);
        player.z = sanitizeNumber(data?.z, player.z);

        player.yaw = sanitizeNumber(data?.yaw, player.yaw);
        player.pitch = sanitizeNumber(data?.pitch, player.pitch);

        player.moving = !!data?.moving;
        player.jumping = !!data?.jumping;

        socket.broadcast.emit('player-move', player);
    });

    // ========================================================
    // EMOTES / DANCES
    // ========================================================

    socket.on('player-emote', data => {
        const player = players.get(socket.id);

        if (!player) return;

        let emote = data?.emote;

        if (emote === null || emote === undefined) {
            emote = null;
        } else {
            emote = String(emote).trim();

            const allowedEmotes = [
                'dance1',
                'dance2',
                'shuffle',
                'robot',
                'wave',
                'bounce'
            ];

            if (!allowedEmotes.includes(emote)) {
                return;
            }
        }

        player.emote = emote;

        playerEmotes.set(socket.id, emote);

        socket.broadcast.emit('player-emote', {
            id: socket.id,
            username: player.username,
            emote
        });

        console.log(
            `${player.username}: emote ${emote || 'STOP'}`
        );
    });

    // --------------------------------------------------------
    // STOP EMOTE
    // --------------------------------------------------------

    socket.on('stop-emote', () => {
        const player = players.get(socket.id);

        if (!player) return;

        player.emote = null;
        playerEmotes.delete(socket.id);

        socket.broadcast.emit('player-emote', {
            id: socket.id,
            username: player.username,
            emote: null
        });
    });

    // ========================================================
    // LANGUAGE
    // ========================================================

    socket.on('language-change', language => {
        const lang = String(language || 'ru');

        socket.language = lang;
        userLanguages.set(socket.id, lang);

        socket.emit('language-updated', lang);
    });

    // ========================================================
    // CHAT
    // ========================================================

    socket.on('chat-message', data => {
        const username =
            String(
                data?.user ||
                socket.username ||
                'PLAYER'
            ).trim();

        const text =
            String(data?.text || '')
                .trim()
                .slice(0, 500);

        const sourceLang =
            String(
                data?.lang ||
                socket.language ||
                'ru'
            ).trim();

        if (!text) return;

        const message = {
            id: Date.now() + '-' + socket.id,
            user: username,
            text,
            lang: sourceLang,
            timestamp: Date.now()
        };

        /*
         * ВАЖНО:
         * Сервер НЕ меняет язык пользователя.
         * Каждый клиент получает оригинальный текст
         * и самостоятельно переводит его на выбранный язык.
         *
         * Это позволяет каждому пользователю иметь
         * свой язык независимо от остальных.
         */

        io.emit('chat-message', message);
    });

    // ========================================================
    // SCREEN HOST
    // ========================================================

    socket.on('screen-host', () => {
        if (
            String(socket.username || '').toLowerCase() !==
            SCREEN_HOST.toLowerCase()
        ) {
            socket.emit('screen-host-result', {
                ok: false,
                error: 'Только mvxtra может управлять экраном.'
            });

            return;
        }

        socket.emit('screen-host-result', {
            ok: true
        });
    });

    // ========================================================
    // CLUB SCREEN
    // ========================================================

    socket.on('club-screen-state', state => {
        const username =
            String(socket.username || '').trim();

        if (
            username.toLowerCase() !==
            SCREEN_HOST.toLowerCase()
        ) {
            socket.emit('screen-host-result', {
                ok: false,
                error: 'Только mvxtra может управлять экраном.'
            });

            return;
        }

        if (!state || state.active === false) {
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
            String(state.src || '').trim();

        const name =
            String(state.name || 'MEDIA').trim();

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
    });

    // ========================================================
    // DISCONNECT
    // ========================================================

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

        broadcastOnlineUsers();
        broadcastPlayers();
    });
});

// ============================================================
// HTTP SERVER
// ============================================================

server.listen(PORT, '0.0.0.0', () => {
    console.log('');
    console.log('====================================');
    console.log('       EWS SESSIONS SERVER');
    console.log('====================================');
    console.log(`HTTP: http://localhost:${PORT}`);
    console.log(`PORT: ${PORT}`);
    console.log(`SCREEN HOST: ${SCREEN_HOST}`);
    console.log('Socket.IO: READY');
    console.log('EMOTES: READY');
    console.log('====================================');
    console.log('');
});

// ============================================================
// RTMP / HLS SERVER
// ============================================================

const mediaRoot = path.join(
    __dirname,
    'media'
);

if (!fs.existsSync(mediaRoot)) {
    fs.mkdirSync(mediaRoot, {
        recursive: true
    });
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
                hlsFlags: '[hls_time=2:hls_list_size=3:hls_flags=delete_segments]',
                dash: false
            }
        ]
    }
};

try {
    const nms = new NodeMediaServer(rtmpConfig);

    nms.run();

    console.log('RTMP / HLS server started.');
    console.log('RTMP: rtmp://YOUR_SERVER/live/STREAM_KEY');
    console.log('HLS: http://YOUR_SERVER:8000/live/STREAM_KEY/index.m3u8');

} catch (err) {
    console.error(
        'RTMP / HLS server error:',
        err
    );
}