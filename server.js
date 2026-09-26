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
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const DATA = path.join(ROOT, 'data');
const USERS_FILE = path.join(DATA, 'users.json');
const MEDIA = path.join(ROOT, 'media');

fs.mkdirSync(DATA, { recursive: true });
fs.mkdirSync(MEDIA, { recursive: true });

if (!fs.existsSync(USERS_FILE)) {
    fs.writeFileSync(USERS_FILE, '[]', 'utf8');
}

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

/* =========================
   STATIC
========================= */

app.use('/hls', express.static(path.join(MEDIA, 'live')));

app.use(express.static(PUBLIC));

/* =========================
   USERS
========================= */

function loadUsers() {
    try {
        return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
    } catch {
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
   REGISTER
========================= */

app.post('/api/register', (req, res) => {
    const username = String(req.body?.username || '').trim();
    const password = String(req.body?.password || '');

    if (username.length < 2) {
        return res.json({
            ok: false,
            message: 'Username должен быть минимум 2 символа'
        });
    }

    if (password.length < 4) {
        return res.json({
            ok: false,
            message: 'Пароль должен быть минимум 4 символа'
        });
    }

    const users = loadUsers();

    const exists = users.some(
        u => u.username.toLowerCase() === username.toLowerCase()
    );

    if (exists) {
        return res.json({
            ok: false,
            message: 'Пользователь уже существует'
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

/* =========================
   LOGIN
========================= */

app.post('/api/login', (req, res) => {
    const username = String(req.body?.username || '').trim();
    const password = String(req.body?.password || '');

    const users = loadUsers();

    const user = users.find(
        u =>
            u.username.toLowerCase() === username.toLowerCase() &&
            u.password === password
    );

    if (!user) {
        return res.json({
            ok: false,
            message: 'Неверный username или пароль'
        });
    }

    res.json({
        ok: true,
        username: user.username
    });
});

/* =========================
   STATUS
========================= */

app.get('/api/status', (req, res) => {
    res.json({
        ok: true,
        online: onlineUsers.size,
        stream: true
    });
});

/* =========================
   ONLINE
========================= */

const onlineUsers = new Map();
const players = new Map();

function getOnlineUsers() {
    return Array.from(onlineUsers.values());
}

function broadcastOnline() {
    io.emit('online-users', getOnlineUsers());
}

/* =========================
   SOCKET.IO
========================= */

io.on('connection', socket => {

    console.log('[SOCKET CONNECT]', socket.id);

    socket.emit('server-ready', {
        ok: true
    });

    socket.on('join', data => {

        const username = String(
            data?.username || 'Guest'
        ).trim();

        const language = String(
            data?.language || 'en'
        ).trim();

        if (!username) return;

        socket.username = username;
        socket.language = language;

        onlineUsers.set(socket.id, {
            id: socket.id,
            username,
            language
        });

        players.set(socket.id, {
            id: socket.id,
            username,
            x: 0,
            y: 1.2,
            z: 5,
            ry: 0,
            jumping: false
        });

        console.log(
            `[ONLINE] ${username} | ${socket.id}`
        );

        broadcastOnline();

        socket.emit('joined', {
            ok: true,
            username
        });

        socket.emit(
            'players-state',
            Array.from(players.values()).filter(
                p => p.id !== socket.id
            )
        );

        socket.broadcast.emit('player-joined', {
            id: socket.id,
            username,
            x: 0,
            y: 1.2,
            z: 5,
            ry: 0
        });

        socket.broadcast.emit('system-message', {
            text: `${username} entered EWS SESSIONS`,
            ts: Date.now()
        });
    });

    socket.on('request-online', () => {
        socket.emit(
            'online-users',
            getOnlineUsers()
        );
    });

    socket.on('request-players', () => {
        socket.emit(
            'players-state',
            Array.from(players.values()).filter(
                p => p.id !== socket.id
            )
        );
    });

    socket.on('player-move', data => {

        if (!socket.username) return;

        const player = players.get(socket.id);

        if (!player) return;

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

        player.x = Math.max(-17, Math.min(17, x));
        player.y = Math.max(0.8, Math.min(6, y));
        player.z = Math.max(-17, Math.min(17, z));

        if (Number.isFinite(ry)) {
            player.ry = ry;
        }

        player.jumping = !!data?.jumping;

        players.set(socket.id, player);

        socket.broadcast.emit('player-move', player);
    });

    socket.on('chat-message', data => {

        if (!socket.username) return;

        const text = String(
            data?.text || ''
        ).trim();

        if (!text) return;

        if (text.length > 500) return;

        const message = {
            user: socket.username,
            username: socket.username,
            text,
            original: text,
            ts: Date.now()
        };

        io.emit('chat-message', message);
    });

    socket.on('language-change', language => {

        if (!socket.username) return;

        const user = onlineUsers.get(socket.id);

        if (!user) return;

        user.language = String(
            language || 'en'
        );

        onlineUsers.set(
            socket.id,
            user
        );

        broadcastOnline();
    });

    socket.on('disconnect', reason => {

        const user = onlineUsers.get(socket.id);

        if (user) {

            console.log(
                `[OFFLINE] ${user.username} | ${reason}`
            );

            onlineUsers.delete(socket.id);
        }

        players.delete(socket.id);

        socket.broadcast.emit(
            'player-left',
            socket.id
        );

        if (user) {
            socket.broadcast.emit(
                'system-message',
                {
                    text: `${user.username} left EWS SESSIONS`,
                    ts: Date.now()
                }
            );
        }

        broadcastOnline();
    });
});

/* =========================
   ROOT
========================= */

app.get('/', (req, res) => {
    res.sendFile(
        path.join(PUBLIC, 'index.html')
    );
});

/* =========================
   404
========================= */

app.use((req, res) => {
    res.status(404).send('Not found');
});

/* =========================
   RTMP / HLS
========================= */

const mediaServerConfig = {
    rtmp: {
        port: 1935,
        chunk_size: 60000,
        gop_cache: true,
        ping: 30,
        ping_timeout: 60
    },

    http: {
        port: 8000,
        mediaroot: MEDIA,
        allow_origin: '*'
    },

    trans: {
        ffmpeg: process.env.FFMPEG_PATH || 'ffmpeg',

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
    const nms = new NodeMediaServer(
        mediaServerConfig
    );

    nms.run();

    console.log('RTMP SERVER READY');
    console.log('RTMP: rtmp://localhost:1935/live');
    console.log('KEY: ews');
} catch (error) {
    console.log(
        '[RTMP ERROR]',
        error.message
    );
}

/* =========================
   START
========================= */

server.listen(PORT, '0.0.0.0', () => {

    console.log('');
    console.log('==============================');
    console.log('EWS SESSIONS SERVER READY');
    console.log(
        `PORT: ${PORT}`
    );
    console.log(
        `http://localhost:${PORT}`
    );
    console.log(
        'HLS: /hls/live/ews/index.m3u8'
    );
    console.log('==============================');
    console.log('');
});