const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
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
const RTMP_PORT = 1935;
const HLS_PORT = 8000;

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const MEDIA_ROOT = path.join(ROOT, 'media');
const HLS_DIR = path.join(MEDIA_ROOT, 'live', 'ews');
const USERS_FILE = path.join(ROOT, 'users.json');
const FFMPEG_PATH = path.join(ROOT, 'ffmpeg.exe');

fs.mkdirSync(PUBLIC_DIR, { recursive: true });
fs.mkdirSync(HLS_DIR, { recursive: true });

if (!fs.existsSync(USERS_FILE)) {
    fs.writeFileSync(
        USERS_FILE,
        JSON.stringify([], null, 2),
        'utf8'
    );
}

/* =====================================================
   NODE MEDIA SERVER
===================================================== */

const nms = new NodeMediaServer({
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
        mediaroot: MEDIA_ROOT,
        allow_origin: '*'
    }
});

nms.run();

/* =====================================================
   EXPRESS
===================================================== */

app.use(express.json());

app.use(express.static(PUBLIC_DIR));

app.use(
    '/hls',
    express.static(MEDIA_ROOT)
);

app.get('/', (req, res) => {
    res.sendFile(
        path.join(PUBLIC_DIR, 'index.html')
    );
});

/* =====================================================
   STATUS
===================================================== */

app.get('/api/status', (req, res) => {
    res.json({
        ok: true,
        name: 'EWS SESSIONS',
        server: 'online',
        time: new Date().toISOString()
    });
});

/* =====================================================
   USERS
===================================================== */

function loadUsers() {
    try {
        return JSON.parse(
            fs.readFileSync(
                USERS_FILE,
                'utf8'
            )
        );
    } catch (error) {
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

/* =====================================================
   REGISTER
===================================================== */

app.post('/api/register', (req, res) => {

    const username = String(
        req.body.username || ''
    ).trim();

    const password = String(
        req.body.password || ''
    );

    if (!username || !password) {
        return res.status(400).json({
            ok: false,
            message: 'Username and password required'
        });
    }

    if (username.length < 3) {
        return res.status(400).json({
            ok: false,
            message: 'Username must be at least 3 characters'
        });
    }

    const users = loadUsers();

    const exists = users.some(
        user =>
            user.username.toLowerCase() ===
            username.toLowerCase()
    );

    if (exists) {
        return res.status(400).json({
            ok: false,
            message: 'User already exists'
        });
    }

    users.push({
        username,
        password
    });

    saveUsers(users);

    res.json({
        ok: true,
        message: 'Registration successful'
    });
});

/* =====================================================
   LOGIN
===================================================== */

app.post('/api/login', (req, res) => {

    const username = String(
        req.body.username || ''
    ).trim();

    const password = String(
        req.body.password || ''
    );

    const users = loadUsers();

    const user = users.find(
        u =>
            u.username.toLowerCase() ===
            username.toLowerCase() &&
            u.password === password
    );

    if (!user) {
        return res.status(401).json({
            ok: false,
            message: 'Invalid username or password'
        });
    }

    res.json({
        ok: true,
        username: user.username
    });
});

/* =====================================================
   TRANSLATION
===================================================== */

async function translateText(text, target) {

    if (!text || !target || target === 'en') {
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

        const data =
            await response.json();

        if (
            Array.isArray(data) &&
            Array.isArray(data[0])
        ) {

            return data[0]
                .map(item => item[0])
                .join('');
        }

    } catch (error) {

        console.log(
            '[TRANSLATE ERROR]',
            error.message
        );
    }

    return text;
}

app.get('/api/translate', async (req, res) => {

    const text = String(
        req.query.text || ''
    );

    const target = String(
        req.query.target || 'en'
    );

    const translated =
        await translateText(
            text,
            target
        );

    res.json({
        translated
    });
});

/* =====================================================
   ONLINE USERS
===================================================== */

const onlineUsers = new Map();

/* =====================================================
   MULTIPLAYER PLAYERS
===================================================== */

const players = new Map();

/* =====================================================
   CLUB SCREEN
===================================================== */

let clubScreenState = {
    active: false,
    src: '',
    name: ''
};

let screenHostId = null;

/* =====================================================
   HELPERS
===================================================== */

function getOnlineUsers() {

    return Array.from(
        onlineUsers.entries()
    ).map(([id, user]) => ({
        id,
        username: user.username,
        language: user.language,
        owner: user.owner
    }));
}

function getPlayers() {

    return Array.from(
        players.entries()
    ).map(([id, player]) => ({
        id,
        username: player.username,
        x: player.x,
        z: player.z,
        yaw: player.yaw,
        pitch: player.pitch
    }));
}

function broadcastOnline() {

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

/* =====================================================
   SOCKET.IO
===================================================== */

io.on('connection', socket => {

    console.log(
        '[SOCKET CONNECT]',
        socket.id
    );

    /* =================================================
       JOIN
    ================================================= */

    socket.on('join', data => {

        const username =
            String(
                data?.username ||
                'Guest'
            ).trim();

        const language =
            String(
                data?.language ||
                'en'
            );

        const owner =
            username.toLowerCase() ===
            'mvxtra';

        onlineUsers.set(
            socket.id,
            {
                username,
                language,
                owner
            }
        );

        players.set(
            socket.id,
            {
                username,
                x: 0,
                z: 13,
                yaw: 0,
                pitch: 0
            }
        );

        socket.username =
            username;

        socket.language =
            language;

        socket.owner =
            owner;

        if (!screenHostId) {
            screenHostId = socket.id;
        }

        console.log(
            `[JOIN] ${username}`
        );

        socket.emit(
            'screen-host',
            {
                host:
                    screenHostId === socket.id
            }
        );

        socket.emit(
            'club-screen-state',
            clubScreenState
        );

        socket.emit(
            'players-state',
            getPlayers()
        );

        broadcastOnline();
        broadcastPlayers();

        socket.broadcast.emit(
            'player-joined',
            {
                id: socket.id,
                username,
                x: 0,
                z: 13,
                yaw: 0,
                pitch: 0
            }
        );

        socket.broadcast.emit(
            'system-message',
            {
                text:
                    `${username} entered EWS SESSIONS`
            }
        );
    });

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

            socket.emit(
                'players-state',
                getPlayers()
            );
        }
    );

    /* =================================================
       PLAYER STATE
    ================================================= */

    socket.on(
        'player-state',
        data => {

            if (!players.has(socket.id)) {
                return;
            }

            const player =
                players.get(socket.id);

            player.x =
                Math.max(
                    -16,
                    Math.min(
                        16,
                        Number(data?.x) || 0
                    )
                );

            player.z =
                Math.max(
                    -15.5,
                    Math.min(
                        15.5,
                        Number(data?.z) || 0
                    )
                );

            player.yaw =
                Number(data?.yaw) || 0;

            player.pitch =
                Number(data?.pitch) || 0;

            players.set(
                socket.id,
                player
            );

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

    /* =================================================
       PLAYER MOVE
    ================================================= */

    socket.on(
        'player-move',
        data => {

            if (!players.has(socket.id)) {
                return;
            }

            const player =
                players.get(socket.id);

            if (data?.x !== undefined) {
                player.x =
                    Math.max(
                        -16,
                        Math.min(
                            16,
                            Number(data.x) || 0
                        )
                    );
            }

            if (data?.z !== undefined) {
                player.z =
                    Math.max(
                        -15.5,
                        Math.min(
                            15.5,
                            Number(data.z) || 0
                        )
                    );
            }

            if (data?.yaw !== undefined) {
                player.yaw =
                    Number(data.yaw) || 0;
            }

            if (data?.pitch !== undefined) {
                player.pitch =
                    Number(data.pitch) || 0;
            }

            players.set(
                socket.id,
                player
            );

            socket.broadcast.emit(
                'player-move',
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

    /* =================================================
       CLUB SCREEN
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

    socket.on(
        'club-screen-state',
        data => {

            if (!socket.username) {
                return;
            }

            /*
             * Только mvxtra может управлять экраном.
             */

            if (
                socket.username.toLowerCase() !==
                'mvxtra'
            ) {
                return;
            }

            if (!data || !data.active) {

                clubScreenState = {
                    active: false,
                    src: '',
                    name: ''
                };

            } else {

                clubScreenState = {
                    active: true,
                    src: String(
                        data.src || ''
                    ),
                    name: String(
                        data.name || 'MEDIA'
                    )
                };
            }

            io.emit(
                'club-screen-state',
                clubScreenState
            );
        }
    );

    /* =================================================
       CHAT
    ================================================= */

    socket.on(
        'chat-message',
        async data => {

            const username =
                socket.username ||
                String(
                    data?.user ||
                    'Guest'
                );

            const text =
                String(
                    data?.text ||
                    ''
                ).trim();

            if (!text) {
                return;
            }

            const recipients =
                Array.from(
                    onlineUsers.entries()
                );

            for (
                const [
                    socketId,
                    user
                ] of recipients
            ) {

                const translated =
                    await translateText(
                        text,
                        user.language
                    );

                io.to(socketId).emit(
                    'chat-message',
                    {
                        username,
                        text: translated,
                        original: text
                    }
                );
            }
        }
    );

    /* =================================================
       LANGUAGE CHANGE
    ================================================= */

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

            broadcastOnline();
        }
    );

    /* =================================================
       DISCONNECT
    ================================================= */

    socket.on(
        'disconnect',
        () => {

            const user =
                onlineUsers.get(
                    socket.id
                );

            if (user) {

                console.log(
                    `[OFFLINE] ${user.username}`
                );

                socket.broadcast.emit(
                    'system-message',
                    {
                        text:
                            `${user.username} left EWS SESSIONS`
                    }
                );
            }

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

            socket.broadcast.emit(
                'player-removed',
                socket.id
            );

            /*
             * Если главный пользователь вышел,
             * выбираем нового владельца экрана.
             */

            if (
                screenHostId ===
                socket.id
            ) {

                screenHostId = null;

                const first =
                    onlineUsers.keys().next();

                if (!first.done) {
                    screenHostId =
                        first.value;
                }

                if (screenHostId) {

                    io.to(
                        screenHostId
                    ).emit(
                        'screen-host',
                        {
                            host: true
                        }
                    );
                }
            }

            broadcastOnline();
            broadcastPlayers();
        }
    );
});

/* =====================================================
   FFMPEG / HLS
===================================================== */

let ffmpegProcess = null;
let ffmpegRestartTimer = null;

function cleanHLS() {

    try {

        const files =
            fs.readdirSync(
                HLS_DIR
            );

        for (
            const file of files
        ) {

            try {

                fs.unlinkSync(
                    path.join(
                        HLS_DIR,
                        file
                    )
                );

            } catch (e) {}
        }

    } catch (e) {}
}

function startFFmpeg() {

    if (
        ffmpegProcess &&
        !ffmpegProcess.killed
    ) {
        return;
    }

    if (
        !fs.existsSync(
            FFMPEG_PATH
        )
    ) {

        console.log(
            '[FFMPEG] ffmpeg.exe not found'
        );

        console.log(
            FFMPEG_PATH
        );

        return;
    }

    cleanHLS();

    console.log(
        '[FFMPEG] Starting...'
    );

    const args = [

        '-hide_banner',

        '-i',
        'rtmp://127.0.0.1:1935/live/ews',

        '-map',
        '0:v:0',

        '-c:v',
        'libx264',

        '-preset',
        'veryfast',

        '-tune',
        'zerolatency',

        '-pix_fmt',
        'yuv420p',

        '-r',
        '30',

        '-g',
        '60',

        '-keyint_min',
        '60',

        '-sc_threshold',
        '0',

        '-b:v',
        '2500k',

        '-maxrate',
        '2500k',

        '-bufsize',
        '5000k',

        '-map',
        '0:a:0?',

        '-c:a',
        'aac',

        '-b:a',
        '128k',

        '-ar',
        '48000',

        '-ac',
        '2',

        '-f',
        'hls',

        '-hls_time',
        '2',

        '-hls_list_size',
        '6',

        '-hls_flags',
        'delete_segments+append_list',

        '-hls_segment_filename',
        path.join(
            HLS_DIR,
            'segment_%03d.ts'
        ),

        path.join(
            HLS_DIR,
            'index.m3u8'
        )
    ];

    ffmpegProcess =
        spawn(
            FFMPEG_PATH,
            args,
            {
                cwd: ROOT,
                windowsHide: true
            }
        );

    ffmpegProcess.stdout.on(
        'data',
        data => {

            console.log(
                '[FFMPEG]',
                data.toString().trim()
            );
        }
    );

    ffmpegProcess.stderr.on(
        'data',
        data => {

            console.log(
                '[FFMPEG]',
                data.toString().trim()
            );
        }
    );

    ffmpegProcess.on(
        'error',
        error => {

            console.log(
                '[FFMPEG ERROR]',
                error.message
            );
        }
    );

    ffmpegProcess.on(
        'close',
        code => {

            console.log(
                `[FFMPEG] exited with code ${code}`
            );

            ffmpegProcess = null;

            if (ffmpegRestartTimer) {
                clearTimeout(
                    ffmpegRestartTimer
                );
            }

            ffmpegRestartTimer =
                setTimeout(
                    startFFmpeg,
                    3000
                );
        }
    );
}

/* =====================================================
   START SERVER
===================================================== */

server.listen(
    PORT,
    () => {

        console.log('');
        console.log(
            '=========================================='
        );
        console.log(
            '          EWS SESSIONS SERVER'
        );
        console.log(
            '=========================================='
        );
        console.log(
            `SERVER READY`
        );
        console.log(
            `http://localhost:${PORT}`
        );
        console.log(
            `RTMP: rtmp://localhost:${RTMP_PORT}/live`
        );
        console.log(
            `KEY: ews`
        );
        console.log(
            `HLS: http://localhost:${PORT}/hls/ews/index.m3u8`
        );
        console.log(
            '=========================================='
        );
        console.log('');

        setTimeout(
            startFFmpeg,
            2500
        );
    }
);

/* =====================================================
   SHUTDOWN
===================================================== */

function shutdown() {

    console.log(
        '\n[EWS] Shutting down...'
    );

    if (ffmpegRestartTimer) {
        clearTimeout(
            ffmpegRestartTimer
        );
    }

    if (ffmpegProcess) {

        try {
            ffmpegProcess.kill();
        } catch (e) {}
    }

    try {
        nms.stop();
    } catch (e) {}

    server.close(
        () => {

            console.log(
                '[EWS] Server stopped.'
            );

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