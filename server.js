const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const NodeMediaServer = require('node-media-server');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: true,
        methods: ['GET', 'POST']
    }
});

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');

const PORT = Number(process.env.PORT || 3000);
const RTMP_PORT = Number(process.env.RTMP_PORT || 1935);
const HLS_PORT = Number(process.env.HLS_PORT || 8000);

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

if (!fs.existsSync(USERS_FILE)) {
    fs.writeFileSync(USERS_FILE, '[]', 'utf8');
}

function readUsers() {
    try {
        return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
    } catch (e) {
        console.log('[USERS READ ERROR]', e.message);
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

/* =========================
   STATIC
========================= */

app.use(express.static(PUBLIC_DIR));

/* =========================
   AUTH
========================= */

app.post('/api/register', (req, res) => {
    try {
        const username = String(req.body.username || '').trim();
        const password = String(req.body.password || '');

        if (username.length < 2) {
            return res.json({
                ok: false,
                message: 'Username must contain at least 2 characters'
            });
        }

        if (password.length < 3) {
            return res.json({
                ok: false,
                message: 'Password must contain at least 3 characters'
            });
        }

        const users = readUsers();

        const exists = users.some(
            u => String(u.username).toLowerCase() === username.toLowerCase()
        );

        if (exists) {
            return res.json({
                ok: false,
                message: 'Username already exists'
            });
        }

        users.push({
            username,
            password,
            createdAt: Date.now()
        });

        saveUsers(users);

        console.log(`[REGISTER] ${username}`);

        return res.json({
            ok: true,
            username
        });

    } catch (error) {
        console.log('[REGISTER ERROR]', error);

        return res.status(500).json({
            ok: false,
            message: 'Registration error'
        });
    }
});

app.post('/api/login', (req, res) => {
    try {
        const username = String(req.body.username || '').trim();
        const password = String(req.body.password || '');

        const users = readUsers();

        const user = users.find(
            u =>
                String(u.username).toLowerCase() === username.toLowerCase() &&
                u.password === password
        );

        if (!user) {
            return res.json({
                ok: false,
                message: 'Wrong username or password'
            });
        }

        console.log(`[LOGIN] ${user.username}`);

        return res.json({
            ok: true,
            username: user.username
        });

    } catch (error) {
        console.log('[LOGIN ERROR]', error);

        return res.status(500).json({
            ok: false,
            message: 'Login error'
        });
    }
});

/* =========================
   TRANSLATION
========================= */

app.post('/api/translate', async (req, res) => {
    try {
        const text = String(req.body.text || '').trim();
        const target = String(req.body.target || 'en').trim();

        if (!text) {
            return res.json({
                ok: true,
                text: ''
            });
        }

        if (target === 'auto') {
            return res.json({
                ok: true,
                text
            });
        }

        const url =
            'https://translate.googleapis.com/translate_a/single' +
            '?client=gtx' +
            '&sl=auto' +
            '&tl=' + encodeURIComponent(target) +
            '&dt=t' +
            '&q=' + encodeURIComponent(text);

        const response = await fetch(url);

        if (!response.ok) {
            return res.json({
                ok: true,
                text
            });
        }

        const result = await response.json();

        let translated = text;

        if (
            Array.isArray(result) &&
            Array.isArray(result[0])
        ) {
            translated = result[0]
                .map(item => item[0])
                .join('');
        }

        return res.json({
            ok: true,
            text: translated
        });

    } catch (error) {
        console.log('[TRANSLATE ERROR]', error.message);

        return res.json({
            ok: true,
            text: String(req.body.text || '')
        });
    }
});

/* =========================
   STATUS
========================= */

app.get('/api/status', (req, res) => {
    return res.json({
        ok: true,
        online: onlineUsers.size,
        players: players.size,
        stream: {
            hls: '/hls/ews/index.m3u8'
        },
        serverTime: Date.now()
    });
});

/* =========================
   HLS
========================= */

const hlsDirectory = path.join(ROOT, 'media', 'hls');

if (!fs.existsSync(hlsDirectory)) {
    fs.mkdirSync(hlsDirectory, {
        recursive: true
    });
}

app.use(
    '/hls',
    express.static(hlsDirectory, {
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

/* =========================
   ONLINE USERS
========================= */

const onlineUsers = new Map();

/* =========================
   3D PLAYERS
========================= */

const players = new Map();

function getOnlineUsers() {
    return Array.from(onlineUsers.values());
}

function getPlayers() {
    return Array.from(players.values());
}

function broadcastOnlineUsers() {
    io.emit(
        'online-users',
        getOnlineUsers()
    );
}

function broadcastPlayers() {
    io.emit(
        'players-state',
        getPlayers()
    );
}

/* =========================
   SOCKET.IO
========================= */

io.on('connection', socket => {

    console.log(
        `[SOCKET CONNECT] ${socket.id}`
    );

    /* -------------------------
       JOIN
    ------------------------- */

    socket.on('join', data => {

        const username = String(
            data?.username || 'Guest'
        ).trim();

        const language = String(
            data?.language || 'en'
        ).trim();

        if (!username) {
            return;
        }

        socket.username = username;
        socket.language = language;

        onlineUsers.set(
            socket.id,
            {
                id: socket.id,
                username,
                language
            }
        );

        players.set(
            socket.id,
            {
                id: socket.id,
                username,
                x: 0,
                y: 0,
                z: 8,
                ry: 0,
                jumping: false
            }
        );

        console.log(
            `[ONLINE] ${username} | ${socket.id}`
        );

        socket.emit('joined', {
            ok: true,
            username
        });

        socket.emit(
            'players-state',
            getPlayers()
        );

        socket.broadcast.emit(
            'player-joined',
            {
                id: socket.id,
                username
            }
        );

        socket.broadcast.emit(
            'system-message',
            {
                text:
                    `${username} entered EWS SESSIONS`,
                ts: Date.now()
            }
        );

        broadcastOnlineUsers();
        broadcastPlayers();
    });

    /* -------------------------
       REQUEST ONLINE
    ------------------------- */

    socket.on(
        'request-online',
        () => {
            socket.emit(
                'online-users',
                getOnlineUsers()
            );

            socket.emit(
                'players-state',
                getPlayers()
            );
        }
    );

    /* -------------------------
       PLAYER MOVE
    ------------------------- */

    socket.on(
        'player-move',
        data => {

            const player =
                players.get(socket.id);

            if (!player) {
                return;
            }

            const x = Number(data?.x);
            const y = Number(data?.y);
            const z = Number(data?.z);
            const ry = Number(data?.ry);

            if (
                !Number.isFinite(x) ||
                !Number.isFinite(y) ||
                !Number.isFinite(z)
            ) {
                return;
            }

            player.x = x;
            player.y = y;
            player.z = z;

            if (Number.isFinite(ry)) {
                player.ry = ry;
            }

            player.jumping =
                Boolean(data?.jumping);

            players.set(
                socket.id,
                player
            );

            socket.broadcast.emit(
                'player-move',
                player
            );
        }
    );

    /* -------------------------
       CHAT
    ------------------------- */

    socket.on(
        'chat-message',
        async data => {

            if (!socket.username) {
                return;
            }

            const originalText =
                String(data?.text || '')
                    .trim();

            if (!originalText) {
                return;
            }

            if (originalText.length > 500) {
                return;
            }

            const timestamp = Date.now();

            const users =
                Array.from(
                    onlineUsers.entries()
                );

            for (const [
                socketId,
                user
            ] of users) {

                let messageText =
                    originalText;

                if (
                    user.language &&
                    user.language !== 'en'
                ) {
                    try {

                        const url =
                            'https://translate.googleapis.com/translate_a/single' +
                            '?client=gtx' +
                            '&sl=auto' +
                            '&tl=' +
                            encodeURIComponent(
                                user.language
                            ) +
                            '&dt=t&q=' +
                            encodeURIComponent(
                                originalText
                            );

                        const response =
                            await fetch(url);

                        if (response.ok) {

                            const result =
                                await response.json();

                            if (
                                Array.isArray(result) &&
                                Array.isArray(result[0])
                            ) {

                                const translated =
                                    result[0]
                                        .map(
                                            item => item[0]
                                        )
                                        .join('');

                                if (translated) {
                                    messageText =
                                        translated;
                                }
                            }
                        }

                    } catch (error) {

                        console.log(
                            '[CHAT TRANSLATION]',
                            error.message
                        );

                        messageText =
                            originalText;
                    }
                }

                io.to(socketId).emit(
                    'chat-message',
                    {
                        user:
                            socket.username,

                        username:
                            socket.username,

                        text:
                            messageText,

                        original:
                            originalText,

                        ts:
                            timestamp
                    }
                );
            }
        }
    );

    /* -------------------------
       LANGUAGE
    ------------------------- */

    socket.on(
        'language-change',
        language => {

            const user =
                onlineUsers.get(
                    socket.id
                );

            if (!user) {
                return;
            }

            user.language =
                String(
                    language || 'en'
                );

            onlineUsers.set(
                socket.id,
                user
            );

            broadcastOnlineUsers();

            console.log(
                `[LANGUAGE] ${user.username}: ${user.language}`
            );
        }
    );

    /* -------------------------
       DISCONNECT
    ------------------------- */

    socket.on(
        'disconnect',
        reason => {

            const user =
                onlineUsers.get(
                    socket.id
                );

            if (user) {

                console.log(
                    `[OFFLINE] ${user.username} | ${reason}`
                );

                onlineUsers.delete(
                    socket.id
                );

                players.delete(
                    socket.id
                );

                socket.broadcast.emit(
                    'player-left',
                    {
                        id: socket.id
                    }
                );

                socket.broadcast.emit(
                    'system-message',
                    {
                        text:
                            `${user.username} left EWS SESSIONS`,
                        ts: Date.now()
                    }
                );

                broadcastOnlineUsers();
                broadcastPlayers();
            }
        }
    );
});

/* =========================
   ROOT PAGE
========================= */

app.get('/', (req, res) => {

    const indexFile =
        path.join(
            PUBLIC_DIR,
            'index.html'
        );

    if (!fs.existsSync(indexFile)) {

        return res.status(500).send(
            'EWS SESSIONS: index.html not found'
        );
    }

    res.sendFile(indexFile);
});

/* =========================
   UNKNOWN ROUTES
========================= */

app.use((req, res) => {

    if (
        req.method === 'GET' &&
        req.accepts('html')
    ) {

        const indexFile =
            path.join(
                PUBLIC_DIR,
                'index.html'
            );

        if (fs.existsSync(indexFile)) {
            return res.sendFile(indexFile);
        }
    }

    res.status(404).json({
        ok: false,
        message: 'Not found'
    });
});

/* =========================
   ERROR HANDLER
========================= */

app.use(
    (err, req, res, next) => {

        console.error(
            '[EXPRESS ERROR]',
            err
        );

        if (res.headersSent) {
            return next(err);
        }

        res.status(500).json({
            ok: false,
            message: 'Server error'
        });
    }
);

/* =========================
   NODE MEDIA SERVER
========================= */

let nms = null;

try {

    const mediaServerConfig = {

        rtmp: {
            port: RTMP_PORT,
            chunk_size: 60000,
            gop_cache: true,
            ping: 30,
            ping_timeout: 60
        },

        http: {
            port: HLS_PORT,
            mediaroot: path.join(
                ROOT,
                'media'
            ),
            allow_origin: '*'
        },

        trans: {

            ffmpeg: process.env.FFMPEG_PATH || 'ffmpeg',

            tasks: [
                {
                    app: 'live',

                    hls: true,

                    hlsFlags:
                        '[hls_time=2:hls_list_size=6:hls_flags=delete_segments]',

                    dash: false
                }
            ]
        }
    };

    nms =
        new NodeMediaServer(
            mediaServerConfig
        );

    nms.run();

    console.log(
        `[NMS] RTMP started on ${RTMP_PORT}`
    );

    console.log(
        `[NMS] HLS started on ${HLS_PORT}`
    );

} catch (error) {

    console.log(
        '[NMS ERROR]',
        error.message
    );

    console.log(
        '[NMS] Website will continue running.'
    );
}

/* =========================
   SERVER START
========================= */

server.listen(
    PORT,
    '0.0.0.0',
    () => {

        console.log('');
        console.log(
            '================================'
        );
        console.log(
            '       EWS SESSIONS'
        );
        console.log(
            '       SERVER READY'
        );
        console.log(
            '================================'
        );
        console.log(
            `PORT: ${PORT}`
        );
        console.log(
            `PUBLIC: http://localhost:${PORT}`
        );
        console.log(
            `RTMP: ${RTMP_PORT}`
        );
        console.log(
            `HLS: ${HLS_PORT}`
        );
        console.log(
            '================================'
        );
        console.log('');
    }
);

/* =========================
   SHUTDOWN
========================= */

function shutdown() {

    console.log(
        '[SERVER] shutting down...'
    );

    try {
        if (nms) {
            nms.stop();
        }
    } catch (e) {}

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