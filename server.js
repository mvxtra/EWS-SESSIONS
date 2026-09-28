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

const SUPPORTED_LANGUAGES = new Set([
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

/* =========================================================
   DIRECTORIES
========================================================= */

if (!fs.existsSync(HLS_DIR)) {
    fs.mkdirSync(HLS_DIR, { recursive: true });
}

if (!fs.existsSync(HLS_STREAM_DIR)) {
    fs.mkdirSync(HLS_STREAM_DIR, { recursive: true });
}

/* =========================================================
   EXPRESS
========================================================= */

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

app.use(express.static(PUBLIC_DIR));

app.get('/', (req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

/* =========================================================
   USERS
========================================================= */

function loadUsers() {
    try {
        if (!fs.existsSync(USERS_FILE)) {
            return {};
        }

        const raw = fs.readFileSync(USERS_FILE, 'utf8');

        if (!raw.trim()) {
            return {};
        }

        return JSON.parse(raw);
    } catch (err) {
        console.error('Users load error:', err);
        return {};
    }
}

function saveUsers(users) {
    try {
        fs.writeFileSync(
            USERS_FILE,
            JSON.stringify(users, null, 2),
            'utf8'
        );
    } catch (err) {
        console.error('Users save error:', err);
    }
}

function hashPassword(password) {
    return crypto
        .createHash('sha256')
        .update(String(password))
        .digest('hex');
}

function cleanUsername(username) {
    return String(username || '')
        .trim()
        .replace(/[<>]/g, '')
        .slice(0, 24);
}

function normalizeLanguage(language) {
    const lang = String(language || 'en')
        .trim()
        .toLowerCase()
        .split('-')[0];

    return SUPPORTED_LANGUAGES.has(lang) ? lang : 'en';
}

/* =========================================================
   AUTH
========================================================= */

app.post('/api/register', (req, res) => {
    const username = cleanUsername(req.body?.username);
    const password = String(req.body?.password || '');

    if (username.length < 2) {
        return res.json({
            ok: false,
            error: 'Username is too short'
        });
    }

    if (password.length < 4) {
        return res.json({
            ok: false,
            error: 'Password is too short'
        });
    }

    const users = loadUsers();

    const key = username.toLowerCase();

    if (users[key]) {
        return res.json({
            ok: false,
            error: 'User already exists'
        });
    }

    users[key] = {
        username,
        password: hashPassword(password),
        createdAt: Date.now()
    };

    saveUsers(users);

    res.json({
        ok: true,
        username
    });
});

app.post('/api/login', (req, res) => {
    const username = cleanUsername(req.body?.username);
    const password = String(req.body?.password || '');

    const users = loadUsers();
    const key = username.toLowerCase();

    const user = users[key];

    if (!user) {
        return res.json({
            ok: false,
            error: 'Invalid username or password'
        });
    }

    if (user.password !== hashPassword(password)) {
        return res.json({
            ok: false,
            error: 'Invalid username or password'
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

const translationCache = new Map();

function googleTranslate(text, target) {
    return new Promise((resolve) => {
        const source = 'auto';

        const url =
            'https://translate.googleapis.com/translate_a/single' +
            '?client=gtx' +
            '&sl=' + encodeURIComponent(source) +
            '&tl=' + encodeURIComponent(target) +
            '&dt=t' +
            '&q=' + encodeURIComponent(text);

        https.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0'
            }
        }, response => {
            let data = '';

            response.on('data', chunk => {
                data += chunk;
            });

            response.on('end', () => {
                try {
                    const json = JSON.parse(data);

                    let result = '';

                    if (Array.isArray(json?.[0])) {
                        for (const part of json[0]) {
                            if (Array.isArray(part) && part[0]) {
                                result += part[0];
                            }
                        }
                    }

                    resolve(result || text);
                } catch (err) {
                    console.error('Translation parse error:', err);
                    resolve(text);
                }
            });
        }).on('error', err => {
            console.error('Translation request error:', err);
            resolve(text);
        });
    });
}

async function translateText(text, target) {
    text = String(text || '').trim();
    target = normalizeLanguage(target);

    if (!text) {
        return '';
    }

    const cacheKey = `${target}:${text}`;

    if (translationCache.has(cacheKey)) {
        return translationCache.get(cacheKey);
    }

    const translated = await googleTranslate(text, target);

    translationCache.set(cacheKey, translated);

    if (translationCache.size > 2000) {
        const firstKey = translationCache.keys().next().value;

        if (firstKey) {
            translationCache.delete(firstKey);
        }
    }

    return translated;
}

app.post('/api/translate', async (req, res) => {
    try {
        const text = String(req.body?.text || '');
        const target = normalizeLanguage(req.body?.target || 'en');

        if (!text) {
            return res.json({
                ok: true,
                text: ''
            });
        }

        const translated = await translateText(text, target);

        res.json({
            ok: true,
            text: translated
        });
    } catch (err) {
        console.error('Translate API error:', err);

        res.status(500).json({
            ok: false,
            error: 'Translation failed'
        });
    }
});

/* =========================================================
   ONLINE USERS
========================================================= */

const onlineUsers = new Map();

function getOnlineUsers() {
    return [...onlineUsers.values()].map(user => ({
        id: user.id,
        username: user.username,
        language: user.language
    }));
}

function broadcastOnline() {
    io.emit('online-users', getOnlineUsers());
}

/* =========================================================
   MULTIPLAYER
========================================================= */

const players = new Map();

function getSpawnPoint() {
    const spawns = [
        { x: 0, z: 14 },
        { x: 3, z: 14 },
        { x: -3, z: 14 },
        { x: 6, z: 12 },
        { x: -6, z: 12 },
        { x: 8, z: 9 },
        { x: -8, z: 9 }
    ];

    return spawns[Math.floor(Math.random() * spawns.length)];
}

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function sanitizePlayerState(data) {
    const x = Number(data?.x);
    const y = Number(data?.y);
    const z = Number(data?.z);
    const yaw = Number(data?.yaw);
    const pitch = Number(data?.pitch);

    return {
        x: Number.isFinite(x) ? clamp(x, -34, 34) : 0,
        y: Number.isFinite(y) ? clamp(y, 0, 8) : 0,
        z: Number.isFinite(z) ? clamp(z, -28, 28) : 0,
        yaw: Number.isFinite(yaw) ? yaw : 0,
        pitch: Number.isFinite(pitch) ? clamp(pitch, -1.4, 1.4) : 0,
        moving: !!data?.moving,
        jumping: !!data?.jumping,
        dance: EMOTES.has(Number(data?.dance))
            ? Number(data.dance)
            : 0,
        danceStartedAt: Number.isFinite(Number(data?.danceStartedAt))
            ? Number(data.danceStartedAt)
            : 0,

        /* NEW CLUB STATE */

        sitting: !!data?.sitting,

        seatId:
            data?.seatId === null ||
            data?.seatId === undefined
                ? null
                : String(data.seatId).slice(0, 64)
    };
}

function sendPlayersSnapshot(socket) {
    socket.emit(
        'players-state',
        [...players.values()]
    );
}

/* =========================================================
   CLUB SCREEN
========================================================= */

let clubScreenState = {
    url: '',
    src: '',
    name: '',
    active: false,
    owner: '',
    updatedAt: Date.now()
};

/* =========================================================
   SOCKET.IO
========================================================= */

io.on('connection', socket => {
    console.log('Socket connected:', socket.id);

    socket.on('join', data => {
        data = data || {};

        const username = cleanUsername(data.username);

        if (!username) {
            return;
        }

        const language = normalizeLanguage(data.language);

        socket.username = username;
        socket.language = language;

        onlineUsers.set(socket.id, {
            id: socket.id,
            username,
            language
        });

        const spawn = getSpawnPoint();

        const player = {
            id: socket.id,
            username,

            x: spawn.x,
            y: 1.7,
            z: spawn.z,

            yaw: 0,
            pitch: 0,

            moving: false,
            jumping: false,

            dance: 0,
            danceStartedAt: 0,

            /* CLUB STATE */

            sitting: false,
            seatId: null
        };

        players.set(socket.id, player);

        socket.emit('screen-host', {
            host: username.toLowerCase() === SCREEN_HOST.toLowerCase(),
            username: SCREEN_HOST
        });

        socket.emit('player-spawn', player);

        sendPlayersSnapshot(socket);

        socket.broadcast.emit('player-joined', player);
        socket.broadcast.emit('player-state', player);

        broadcastOnline();

        socket.emit(
            'club-screen-state',
            clubScreenState
        );

        socket.emit(
            'online-users',
            getOnlineUsers()
        );

        console.log(
            `Player joined: ${username} (${socket.id})`
        );

        socket.emit('joined');
    });

    /* =====================================================
       LANGUAGE
    ===================================================== */

    socket.on('language-change', language => {
        language = normalizeLanguage(language);

        socket.language = language;

        const user = onlineUsers.get(socket.id);

        if (user) {
            user.language = language;
        }

        broadcastOnline();
    });

    /* =====================================================
       PLAYER STATE
    ===================================================== */

    socket.on('player-state', data => {
        if (!socket.username) {
            return;
        }

        const current = players.get(socket.id);

        if (!current) {
            return;
        }

        const state = sanitizePlayerState(data);

        current.x = state.x;
        current.y = state.y;
        current.z = state.z;

        current.yaw = state.yaw;
        current.pitch = state.pitch;

        current.moving = state.moving;
        current.jumping = state.jumping;

        current.dance = state.dance;
        current.danceStartedAt = state.danceStartedAt;

        current.sitting = state.sitting;
        current.seatId = state.seatId;

        socket.broadcast.emit(
            'player-state',
            current
        );
    });

    /* =====================================================
       SIT / STAND
    ===================================================== */

    socket.on('sit', data => {
        if (!socket.username) {
            return;
        }

        const player = players.get(socket.id);

        if (!player) {
            return;
        }

        const seatId =
            data?.seatId === undefined ||
            data?.seatId === null
                ? null
                : String(data.seatId).slice(0, 64);

        if (!seatId) {
            return;
        }

        /* Check whether another player already occupies it */

        const occupied = [...players.values()].some(
            p =>
                p.id !== socket.id &&
                p.sitting &&
                p.seatId === seatId
        );

        if (occupied) {
            socket.emit('seat-occupied', {
                seatId
            });

            return;
        }

        player.sitting = true;
        player.seatId = seatId;
        player.moving = false;
        player.jumping = false;
        player.dance = 0;

        io.emit('player-state', player);
    });

    socket.on('stand', () => {
        if (!socket.username) {
            return;
        }

        const player = players.get(socket.id);

        if (!player) {
            return;
        }

        player.sitting = false;
        player.seatId = null;

        io.emit('player-state', player);
    });

    /* =====================================================
       DANCE
    ===================================================== */

    socket.on('dance', dance => {
        if (!socket.username) {
            return;
        }

        const player = players.get(socket.id);

        if (!player) {
            return;
        }

        dance = Number(dance);

        if (!EMOTES.has(dance)) {
            dance = 0;
        }

        player.dance = dance;
        player.danceStartedAt = Date.now();

        io.emit('player-state', player);
    });

    /* =====================================================
       CHAT
    ===================================================== */

    socket.on('chat-message', async message => {
        if (!socket.username) {
            return;
        }

        const original = String(
            message?.text || ''
        )
            .trim()
            .slice(0, 500);

        if (!original) {
            return;
        }

        const recipients = [
            ...onlineUsers.entries()
        ];

        const targetLanguages = [
            ...new Set(
                recipients.map(
                    ([, user]) =>
                        normalizeLanguage(user.language)
                )
            )
        ];

        const translations = new Map();

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

        const ts = Date.now();

        for (const [id, user] of recipients) {
            const targetSocket =
                io.sockets.sockets.get(id);

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
                    user: socket.username,
                    username: socket.username,

                    text:
                        translations.get(
                            targetLanguage
                        ) || original,

                    original,

                    targetLanguage,

                    translated:
                        targetLanguage !==
                        normalizeLanguage(
                            socket.language
                        ),

                    ts
                }
            );
        }
    });

    /* =====================================================
       CLUB SCREEN
    ===================================================== */

    socket.on('club-screen-state', data => {
        if (!socket.username) {
            return;
        }

        if (
            socket.username.toLowerCase() !==
            SCREEN_HOST.toLowerCase()
        ) {
            return;
        }

        clubScreenState = {
            url: String(
                data?.url || ''
            ).slice(0, 1000),

            src: String(
                data?.src || ''
            ).slice(0, 1000),

            name: String(
                data?.name || ''
            ).slice(0, 50),

            active: !!data?.active,

            owner: String(
                data?.owner || ''
            ).slice(0, 50),

            updatedAt: Date.now()
        };

        io.emit(
            'club-screen-state',
            clubScreenState
        );
    });

    /* =====================================================
       REQUEST HANDLERS
    ===================================================== */

    socket.on('request-players', () => {
        if (!socket.username) return;
        sendPlayersSnapshot(socket);
    });

    socket.on('request-club-screen', () => {
        socket.emit('club-screen-state', clubScreenState);
    });

    /* =====================================================
       DISCONNECT
    ===================================================== */

    socket.on('disconnect', reason => {
        console.log(
            `Socket disconnected: ${socket.id}`,
            reason
        );

        onlineUsers.delete(socket.id);
        players.delete(socket.id);

        socket.broadcast.emit(
            'player-left',
            socket.id
        );

        broadcastOnline();
    });
});

/* =========================================================
   NODE MEDIA SERVER
========================================================= */

const nmsConfig = {
    logType: 3,

    rtmp: {
        port: RTMP_PORT,
        chunk_size: 60000,
        gop_cache: true,
        ping: 30,
        ping_timeout: 60
    },

    http: {
        port: NMS_HTTP_PORT,
        mediaroot: HLS_DIR,
        allow_origin: '*'
    },

    trans: {
        ffmpeg: '/usr/bin/ffmpeg',

        tasks: [
            {
                app: 'live',

                hls: true,

                hlsFlags:
                    '[hls_time=2:hls_list_size=6:hls_flags=delete_segments]',

                hlsKeepSegments: 6,

                dash: false
            }
        ]
    }
};

let nms;

try {
    nms = new NodeMediaServer(nmsConfig);

    nms.run();

    console.log(
        `NodeMediaServer RTMP: ${RTMP_PORT}`
    );

    console.log(
        `NodeMediaServer HTTP: ${NMS_HTTP_PORT}`
    );
} catch (err) {
    console.error(
        'NodeMediaServer start error:',
        err
    );
}

/* =========================================================
   MEDIA EVENTS
========================================================= */

if (nms) {
    nms.on('prePublish', (id, StreamPath, args) => {
        console.log(
            '[RTMP] prePublish:',
            id,
            StreamPath
        );
    });

    nms.on('postPublish', (id, StreamPath, args) => {
        console.log(
            '[RTMP] postPublish:',
            id,
            StreamPath
        );
    });

    nms.on('donePublish', (id, StreamPath, args) => {
        console.log(
            '[RTMP] donePublish:',
            id,
            StreamPath
        );
    });
}

/* =========================================================
   START SERVER
========================================================= */

server.listen(PORT, '0.0.0.0', () => {
    console.log('');
    console.log('======================================');
    console.log('        EWS SESSIONS SERVER');
    console.log('======================================');
    console.log(`HTTP: http://localhost:${PORT}`);
    console.log(`RTMP: ${RTMP_PORT}`);
    console.log(`NMS HTTP: ${NMS_HTTP_PORT}`);
    console.log('======================================');
    console.log('');
});