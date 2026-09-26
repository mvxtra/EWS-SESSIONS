const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const NodeMediaServer = require('node-media-server');

// ======================================================
// EWS SESSIONS SERVER
// ======================================================

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: true,
        methods: ['GET', 'POST']
    },

    transports: ['websocket', 'polling'],

    pingInterval: 25000,
    pingTimeout: 20000,

    connectionStateRecovery: {
        maxDisconnectionDuration: 120000,
        skipMiddlewares: true
    }
});

const PORT = 3000;
const RTMP_PORT = 1935;
const HLS_PORT = 8000;

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const MEDIA_ROOT = path.join(ROOT, 'media');
const HLS_DIR = path.join(MEDIA_ROOT, 'live', 'ews');

const USERS_FILE = path.join(ROOT, 'users.json');
const FFMPEG_PATH = path.join(ROOT, 'ffmpeg.exe');

// ======================================================
// CREATE DIRECTORIES
// ======================================================

if (!fs.existsSync(MEDIA_ROOT)) {
    fs.mkdirSync(MEDIA_ROOT, { recursive: true });
}

if (!fs.existsSync(HLS_DIR)) {
    fs.mkdirSync(HLS_DIR, { recursive: true });
}

if (!fs.existsSync(PUBLIC_DIR)) {
    fs.mkdirSync(PUBLIC_DIR, { recursive: true });
}

if (!fs.existsSync(USERS_FILE)) {
    fs.writeFileSync(
        USERS_FILE,
        JSON.stringify([], null, 2),
        'utf8'
    );
}

// ======================================================
// NODE MEDIA SERVER
// ======================================================

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
        port: HLS_PORT,
        mediaroot: MEDIA_ROOT,
        allow_origin: '*'
    }
};

const nms = new NodeMediaServer(nmsConfig);

nms.run();

// ======================================================
// EXPRESS
// ======================================================

app.use(express.json());

app.use(
    express.static(PUBLIC_DIR)
);

// HLS files
app.use(
    '/hls',
    express.static(MEDIA_ROOT)
);

// Explicit homepage
app.get('/', (req, res) => {
    res.sendFile(
        path.join(PUBLIC_DIR, 'index.html')
    );
});

// ======================================================
// BASIC API
// ======================================================

app.get('/api/status', (req, res) => {
    res.json({
        ok: true,
        name: 'EWS SESSIONS',
        server: 'online',
        rtmp: `rtmp://localhost:${RTMP_PORT}/live`,
        streamKey: 'ews',
        hls: `http://localhost:${PORT}/hls/ews/index.m3u8`,
        time: new Date().toISOString()
    });
});

// ======================================================
// USERS
// ======================================================

function loadUsers() {
    try {
        const data = fs.readFileSync(
            USERS_FILE,
            'utf8'
        );

        return JSON.parse(data);
    } catch (error) {
        console.log('[USERS] Could not read users.json');

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

// ======================================================
// REGISTER
// ======================================================

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

    console.log(
        `[REGISTER] ${username}`
    );

    res.json({
        ok: true,
        message: 'Registration successful'
    });
});

// ======================================================
// LOGIN
// ======================================================

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

    console.log(
        `[LOGIN] ${user.username}`
    );

    res.json({
        ok: true,
        username: user.username
    });
});

// ======================================================
// TRANSLATION
// ======================================================

app.get('/api/translate', async (req, res) => {

    const text = String(
        req.query.text || ''
    );

    const target = String(
        req.query.target || 'en'
    );

    if (!text) {
        return res.json({
            translated: ''
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

        const data = await response.json();

        let translated = '';

        if (
            Array.isArray(data) &&
            Array.isArray(data[0])
        ) {
            translated = data[0]
                .map(item => item[0])
                .join('');
        }

        res.json({
            translated
        });

    } catch (error) {

        console.log(
            '[TRANSLATE ERROR]',
            error.message
        );

        res.json({
            translated: text
        });
    }
});


// ======================================================
// FFMPEG
// ======================================================

// ======================================================
// SOCKET.IO
// ======================================================

const onlineUsers = new Map();

io.on('connection', socket => {

    console.log(`[SOCKET] Connected: ${socket.id}`);

    // --------------------------------------------------
    // JOIN
    // --------------------------------------------------

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

        onlineUsers.set(socket.id, {
            username,
            language
        });

        console.log(
            `[ONLINE] ${username} | ${socket.id}`
        );

        broadcastOnlineUsers();

        socket.emit('joined', {
            ok: true,
            username
        });

        socket.broadcast.emit('system-message', {
            text: `${username} entered EWS SESSIONS`,
            ts: Date.now()
        });

    });

    // --------------------------------------------------
    // REQUEST ONLINE
    // --------------------------------------------------

    socket.on('request-online', () => {

        socket.emit(
            'online-users',
            getOnlineUsers()
        );

    });

    // --------------------------------------------------
    // CHAT
    // --------------------------------------------------

    socket.on('chat-message', async data => {

        if (!socket.username) {
            return;
        }

        const text = String(
            data?.text || ''
        ).trim();

        if (!text) {
            return;
        }

        if (text.length > 500) {
            return;
        }

        const originalText = text;
        const timestamp = Date.now();

        const users = Array.from(
            onlineUsers.entries()
        );

        for (const [socketId, user] of users) {

            let messageText = originalText;

            /*
             * Перевод оставляем.
             * Если перевод не сработал —
             * отправляем оригинал.
             */

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
                        '&dt=t' +
                        '&q=' +
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
                                messageText = translated;
                            }
                        }
                    }

                } catch (error) {

                    console.log(
                        '[CHAT TRANSLATION]',
                        error.message
                    );

                    messageText = originalText;
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

    // --------------------------------------------------
    // LANGUAGE
    // --------------------------------------------------

    socket.on('language-change', language => {

        const user =
            onlineUsers.get(socket.id);

        if (!user) {
            return;
        }

        user.language =
            String(language || 'en');

        onlineUsers.set(
            socket.id,
            user
        );

        broadcastOnlineUsers();

        console.log(
            `[LANGUAGE] ${user.username}: ${user.language}`
        );

    });

    // --------------------------------------------------
    // DISCONNECT
    // --------------------------------------------------

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


// ======================================================
// ONLINE HELPERS
// ======================================================

function getOnlineUsers() {

    return Array.from(
        onlineUsers.values()
    );

}

function broadcastOnlineUsers() {

    const users =
        getOnlineUsers();

    console.log(
        `[ONLINE LIST] ${users.map(
            u => u.username
        ).join(', ')}`
    );

    io.emit(
        'online-users',
        users
    );

}
let ffmpegProcess = null;
let ffmpegRestartTimer = null;
let ffmpegStarting = false;

function cleanHLS() {

    try {

        const files =
            fs.readdirSync(HLS_DIR);

        for (const file of files) {

            const fullPath =
                path.join(
                    HLS_DIR,
                    file
                );

            try {
                fs.unlinkSync(fullPath);
            } catch (error) {
                // ignore
            }
        }

    } catch (error) {

        console.log(
            '[HLS] Cleanup error:',
            error.message
        );
    }
}

// ======================================================
// START FFMPEG
// ======================================================

function startFFmpeg() {

    if (ffmpegStarting) {
        return;
    }

    if (
        ffmpegProcess &&
        !ffmpegProcess.killed
    ) {
        return;
    }

    if (!fs.existsSync(FFMPEG_PATH)) {

        console.log(
            '[FFMPEG] ffmpeg.exe not found:'
        );

        console.log(
            FFMPEG_PATH
        );

        return;
    }

    ffmpegStarting = true;

    cleanHLS();

    console.log(
        '[FFMPEG] Starting...'
    );

    /*
        IMPORTANT:

        We DO NOT use:

        -reconnect
        -reconnect_streamed
        -reconnect_delay_max

        because the installed FFmpeg build
        does not support these options for RTMP.
    */

    const args = [

        '-hide_banner',

        // RTMP input
        '-i',
        'rtmp://127.0.0.1:1935/live/ews',

        // Video
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

        // Audio
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

        // HLS
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

    ffmpegStarting = false;

    ffmpegProcess.stdout.on(
        'data',
        data => {

            const text =
                data.toString().trim();

            if (text) {
                console.log(
                    `[FFMPEG] ${text}`
                );
            }
        }
    );

    ffmpegProcess.stderr.on(
        'data',
        data => {

            const text =
                data.toString().trim();

            if (text) {
                console.log(
                    `[FFMPEG] ${text}`
                );
            }
        }
    );

    ffmpegProcess.on(
        'error',
        error => {

            console.log(
                '[FFMPEG] Process error:',
                error.message
            );
        }
    );

    ffmpegProcess.on(
        'close',
        code => {

            console.log(
                `[FFMPEG] Exited code ${code}`
            );

            ffmpegProcess = null;

            if (ffmpegRestartTimer) {
                clearTimeout(
                    ffmpegRestartTimer
                );
            }

            ffmpegRestartTimer =
                setTimeout(() => {

                    console.log(
                        '[FFMPEG] Restarting...'
                    );

                    startFFmpeg();

                }, 3000);
        }
    );
}

// ======================================================
// START WEB SERVER
// ======================================================

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
            `KEY:  ews`
        );
        console.log(
            `HLS:  http://localhost:${PORT}/hls/ews/index.m3u8`
        );
        console.log(
            '=========================================='
        );
        console.log('');

        // Give NodeMediaServer a moment,
        // then start FFmpeg.
        setTimeout(() => {

            startFFmpeg();

        }, 2500);
    }
);

// ======================================================
// GRACEFUL SHUTDOWN
// ======================================================

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
        } catch (error) {
            // ignore
        }
    }

    try {
        nms.stop();
    } catch (error) {
        // ignore
    }

    server.close(() => {

        console.log(
            '[EWS] Server stopped.'
        );

        process.exit(0);
    });
}

process.on(
    'SIGINT',
    shutdown
);

process.on(
    'SIGTERM',
    shutdown
);