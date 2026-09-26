const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const { Server } = require('socket.io');
const NodeMediaServer = require('node-media-server');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: '*'
    }
});

const PORT = process.env.PORT || 3000;
const RTMP_PORT = Number(process.env.RTMP_PORT || 1935);
const HLS_PORT = Number(process.env.HLS_PORT || 8000);

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const HLS_DIR = path.join(ROOT, 'media', 'hls');

if (!fs.existsSync(PUBLIC_DIR)) {
    fs.mkdirSync(PUBLIC_DIR, { recursive: true });
}

if (!fs.existsSync(HLS_DIR)) {
    fs.mkdirSync(HLS_DIR, { recursive: true });
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(express.static(PUBLIC_DIR));

app.use(
    '/hls',
    express.static(HLS_DIR, {
        setHeaders: (res) => {
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        }
    })
);

/* =========================================================
   USERS
========================================================= */

const USERS_FILE = path.join(ROOT, 'users.json');

if (!fs.existsSync(USERS_FILE)) {
    fs.writeFileSync(
        USERS_FILE,
        JSON.stringify([], null, 2),
        'utf8'
    );
}

function loadUsers() {
    try {
        return JSON.parse(
            fs.readFileSync(USERS_FILE, 'utf8')
        );
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

/* =========================================================
   REGISTER
========================================================= */

app.post('/api/register', (req, res) => {

    const username = String(req.body?.username || '').trim();
    const password = String(req.body?.password || '');

    if (!username || !password) {
        return res.json({
            ok: false,
            message: 'Enter username and password'
        });
    }

    if (username.length < 2 || username.length > 24) {
        return res.json({
            ok: false,
            message: 'Username must be 2-24 characters'
        });
    }

    if (password.length < 3) {
        return res.json({
            ok: false,
            message: 'Password is too short'
        });
    }

    const users = loadUsers();

    const exists = users.find(
        user => user.username.toLowerCase() === username.toLowerCase()
    );

    if (exists) {
        return res.json({
            ok: false,
            message: 'Username already exists'
        });
    }

    users.push({
        username,
        password
    });

    saveUsers(users);

    return res.json({
        ok: true,
        username
    });
});

/* =========================================================
   LOGIN
========================================================= */

app.post('/api/login', (req, res) => {

    const username = String(req.body?.username || '').trim();
    const password = String(req.body?.password || '');

    const users = loadUsers();

    const user = users.find(
        item =>
            item.username.toLowerCase() === username.toLowerCase() &&
            item.password === password
    );

    if (!user) {
        return res.json({
            ok: false,
            message: 'Wrong username or password'
        });
    }

    return res.json({
        ok: true,
        username: user.username
    });
});

/* =========================================================
   TRANSLATION
========================================================= */

app.post('/api/translate', async (req, res) => {

    const text = String(req.body?.text || '').trim();
    const target = String(req.body?.target || 'en').trim();

    if (!text) {
        return res.json({
            ok: false,
            message: 'No text'
        });
    }

    try {

        const url =
            'https://translate.googleapis.com/translate_a/single' +
            '?client=gtx' +
            '&sl=auto' +
            '&tl=' + encodeURIComponent(target) +
            '&dt=t' +
            '&q=' + encodeURIComponent(text);

        const response = await fetch(url);

        if (!response.ok) {
            throw new Error('Translation failed');
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

        res.json({
            ok: true,
            translated
        });

    } catch (error) {

        console.log('[TRANSLATE]', error.message);

        res.json({
            ok: false,
            translated: text
        });
    }
});

/* =========================================================
   SOCKET.IO
========================================================= */

const onlineUsers = new Map();

/*
    players:
    socket.id -> {
        username,
        language,
        x,
        y,
        z,
        rotation
    }
*/

const players = new Map();

function getOnlineUsers() {

    return Array.from(onlineUsers.values()).map(user => ({
        username: user.username,
        language: user.language
    }));
}

function getPlayers() {

    return Array.from(players.entries()).map(
        ([id, player]) => ({
            id,
            username: player.username,
            x: player.x,
            y: player.y,
            z: player.z,
            rotation: player.rotation
        })
    );
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

io.on('connection', socket => {

    console.log(
        `[SOCKET] Connected: ${socket.id}`
    );

    /* =====================================================
       JOIN
    ===================================================== */

    socket.on('join', data => {

        const username =
            String(data?.username || 'Guest').trim();

        const language =
            String(data?.language || 'en').trim();

        if (!username) return;

        socket.username = username;
        socket.language = language;

        onlineUsers.set(socket.id, {
            username,
            language
        });

        /*
            Initial player position.
        */

        players.set(socket.id, {
            username,
            language,
            x: 0,
            y: 0,
            z: 13,
            rotation: 0
        });

        console.log(
            `[ONLINE] ${username} | ${socket.id}`
        );

        /*
            Give this player the players
            already inside the club.
        */

        socket.emit(
            'players-state',
            getPlayers().filter(
                player => player.id !== socket.id
            )
        );

        /*
            Tell everybody else that a new
            player entered.
        */

        socket.broadcast.emit(
            'player-joined',
            {
                id: socket.id,
                username
            }
        );

        broadcastOnlineUsers();

        socket.emit(
            'joined',
            {
                ok: true,
                username,
                id: socket.id
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
    });

    /* =====================================================
       REQUEST ONLINE
    ===================================================== */

    socket.on('request-online', () => {

        socket.emit(
            'online-users',
            getOnlineUsers()
        );

        socket.emit(
            'players-state',
            getPlayers().filter(
                player => player.id !== socket.id
            )
        );
    });

    /* =====================================================
       PLAYER MOVEMENT
    ===================================================== */

    socket.on('player-move', data => {

        if (!socket.username) return;

        const player = players.get(socket.id);

        if (!player) return;

        const x = Number(data?.x);
        const y = Number(data?.y);
        const z = Number(data?.z);
        const rotation = Number(data?.rotation);

        if (
            !Number.isFinite(x) ||
            !Number.isFinite(y) ||
            !Number.isFinite(z) ||
            !Number.isFinite(rotation)
        ) {
            return;
        }

        /*
            Safety limits.
        */

        player.x = Math.max(-17, Math.min(17, x));
        player.y = Math.max(0, Math.min(5, y));
        player.z = Math.max(-16, Math.min(16, z));
        player.rotation = rotation;

        players.set(socket.id, player);

        socket.broadcast.emit(
            'player-move',
            {
                id: socket.id,
                username: player.username,
                x: player.x,
                y: player.y,
                z: player.z,
                rotation: player.rotation
            }
        );
    });

    /* =====================================================
       CHAT
    ===================================================== */

    socket.on('chat-message', async data => {

        if (!socket.username) return;

        const text =
            String(data?.text || '').trim();

        if (!text || text.length > 500) {
            return;
        }

        const originalText = text;
        const timestamp = Date.now();

        const users =
            Array.from(onlineUsers.entries());

        for (const [socketId, user] of users) {

            let messageText = originalText;

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
                        encodeURIComponent(user.language) +
                        '&dt=t&q=' +
                        encodeURIComponent(originalText);

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
                                    .map(item => item[0])
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
                    user: socket.username,
                    username: socket.username,
                    text: messageText,
                    original: originalText,
                    ts: timestamp
                }
            );
        }
    });

    /* =====================================================
       LANGUAGE
    ===================================================== */

    socket.on('language-change', language => {

        const user =
            onlineUsers.get(socket.id);

        if (!user) return;

        user.language =
            String(language || 'en');

        onlineUsers.set(
            socket.id,
            user
        );

        const player =
            players.get(socket.id);

        if (player) {

            player.language =
                user.language;

            players.set(
                socket.id,
                player
            );
        }

        broadcastOnlineUsers();
    });

    /* =====================================================
       DISCONNECT
    ===================================================== */

    socket.on('disconnect', reason => {

        const user =
            onlineUsers.get(socket.id);

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
        }
    });
});

/* =========================================================
   STATUS
========================================================= */

app.get('/api/status', (req, res) => {

    res.json({
        ok: true,
        online: onlineUsers.size,
        stream:
            '/hls/ews/index.m3u8'
    });
});

/* =========================================================
   HOME
========================================================= */

app.get('*', (req, res) => {

    res.sendFile(
        path.join(
            PUBLIC_DIR,
            'index.html'
        )
    );
});

/* =========================================================
   RTMP / HLS
========================================================= */

const mediaServerConfig = {

    logType: 3,

    rtmp: {
        port: RTMP_PORT,
        chunk_size: 60000,
        gop_cache: true,
        ping: 30,
        ping_timeout: 60
    },

    http: {
        port: HLS_PORT,
        mediaroot: HLS_DIR,
        allow_origin: '*'
    },

    trans: {

        ffmpeg: process.platform === 'win32'
            ? path.join(ROOT, 'ffmpeg.exe')
            : 'ffmpeg',

        tasks: [

            {
                app: 'live',

                hls: true,

                hlsFlags:
                    '[hls_time=2:hls_list_size=5:hls_flags=delete_segments]',

                dash: false
            }
        ]
    }
};

let mediaServer = null;

try {

    mediaServer =
        new NodeMediaServer(
            mediaServerConfig
        );

    mediaServer.run();

    console.log(
        `[STREAM] RTMP port: ${RTMP_PORT}`
    );

    console.log(
        `[STREAM] HLS port: ${HLS_PORT}`
    );

} catch (error) {

    console.log(
        '[STREAM ERROR]',
        error.message
    );
}

/* =========================================================
   START
========================================================= */

server.listen(PORT, '0.0.0.0', () => {

    console.log('');
    console.log('================================');
    console.log('       EWS SESSIONS ONLINE');
    console.log('================================');
    console.log(
        `HTTP: http://localhost:${PORT}`
    );
    console.log(
        `RTMP: rtmp://localhost:${RTMP_PORT}/live`
    );
    console.log(
        `HLS:  http://localhost:${HLS_PORT}/live`
    );
    console.log('================================');
    console.log('');
});