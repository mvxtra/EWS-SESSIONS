const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { Server } = require('socket.io');
const { spawn } = require('child_process');
const NodeMediaServer = require('node-media-server');

// =====================================================
// EWS SESSIONS
// PROFESSIONAL SERVER
// =====================================================

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
    cors: {
        origin: '*',
        methods: ['GET', 'POST']
    }
});

// =====================================================
// CONFIG
// =====================================================

const PORT = 3000;
const RTMP_PORT = 1935;
const HLS_PORT = 8000;

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');

const MEDIA_ROOT = path.join(ROOT, 'media');
const HLS_DIR = path.join(MEDIA_ROOT, 'live', 'ews');

const USERS_FILE = path.join(ROOT, 'users.json');
const FFMPEG_PATH = path.join(ROOT, 'ffmpeg.exe');

const MAIN_USERNAME = 'mvxtra';

// =====================================================
// DIRECTORIES
// =====================================================

fs.mkdirSync(PUBLIC_DIR, { recursive: true });
fs.mkdirSync(MEDIA_ROOT, { recursive: true });
fs.mkdirSync(HLS_DIR, { recursive: true });

if (!fs.existsSync(USERS_FILE)) {
    fs.writeFileSync(
        USERS_FILE,
        '[]',
        'utf8'
    );
}

// =====================================================
// EXPRESS
// =====================================================

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

app.use(
    '/hls',
    express.static(MEDIA_ROOT, {
        setHeaders: (res) => {
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
            res.setHeader('Access-Control-Allow-Origin', '*');
        }
    })
);

app.use(express.static(PUBLIC_DIR));

app.get('/', (req, res) => {
    res.sendFile(
        path.join(PUBLIC_DIR, 'index.html')
    );
});

// =====================================================
// USERS
// =====================================================

function loadUsers() {
    try {
        const raw = fs.readFileSync(
            USERS_FILE,
            'utf8'
        );

        const users = JSON.parse(raw);

        return Array.isArray(users)
            ? users
            : [];
    } catch (error) {
        console.log(
            '[USERS LOAD ERROR]',
            error.message
        );

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
    } catch (error) {
        console.log(
            '[USERS SAVE ERROR]',
            error.message
        );
    }
}

function normalizeUsername(username) {
    return String(
        username || ''
    )
        .trim()
        .toLowerCase();
}

function isMainUser(username) {
    return (
        normalizeUsername(username) ===
        normalizeUsername(MAIN_USERNAME)
    );
}

// =====================================================
// REGISTER
// =====================================================

app.post(
    '/api/register',
    (req, res) => {

        const username = String(
            req.body?.username || ''
        ).trim();

        const password = String(
            req.body?.password || ''
        );

        if (!username || !password) {
            return res.status(400).json({
                ok: false,
                error: 'Введите логин и пароль'
            });
        }

        if (
            username.length < 3 ||
            username.length > 32
        ) {
            return res.status(400).json({
                ok: false,
                error: 'Логин должен быть от 3 до 32 символов'
            });
        }

        if (password.length < 3) {
            return res.status(400).json({
                ok: false,
                error: 'Пароль слишком короткий'
            });
        }

        const users = loadUsers();

        const exists = users.some(
            user =>
                normalizeUsername(user.username) ===
                normalizeUsername(username)
        );

        if (exists) {
            return res.status(409).json({
                ok: false,
                error: 'Пользователь уже существует'
            });
        }

        const owner = isMainUser(username);

        users.push({
            username,
            password,
            owner,
            role: owner ? 'owner' : 'user',
            createdAt: Date.now()
        });

        saveUsers(users);

        console.log(
            `[REGISTER] ${username}${owner ? ' [OWNER]' : ''}`
        );

        res.json({
            ok: true,
            username,
            owner,
            role: owner ? 'owner' : 'user'
        });
    }
);

// =====================================================
// LOGIN
// =====================================================

app.post(
    '/api/login',
    (req, res) => {

        const username = String(
            req.body?.username || ''
        ).trim();

        const password = String(
            req.body?.password || ''
        );

        if (!username || !password) {
            return res.status(400).json({
                ok: false,
                error: 'Введите логин и пароль'
            });
        }

        const users = loadUsers();

        const user = users.find(
            item =>
                normalizeUsername(item.username) ===
                normalizeUsername(username)
        );

        if (!user) {
            return res.status(401).json({
                ok: false,
                error: 'Пользователь не найден'
            });
        }

        if (String(user.password) !== password) {
            return res.status(401).json({
                ok: false,
                error: 'Неверный пароль'
            });
        }

        const owner = isMainUser(
            user.username
        );

        user.owner = owner;
        user.role = owner
            ? 'owner'
            : 'user';

        saveUsers(users);

        console.log(
            `[LOGIN] ${user.username}${owner ? ' [OWNER]' : ''}`
        );

        res.json({
            ok: true,
            username: user.username,
            owner,
            role: user.role
        });
    }
);

// =====================================================
// STATUS
// =====================================================

app.get(
    '/api/status',
    (req, res) => {

        res.json({
            ok: true,
            name: 'EWS SESSIONS',
            server: 'online',
            mainUser: MAIN_USERNAME,
            online: onlineUsers.size,
            rtmp:
                `rtmp://localhost:${RTMP_PORT}/live`,
            streamKey: 'ews',
            hls:
                `http://localhost:${PORT}/hls/ews/index.m3u8`,
            time: new Date().toISOString()
        });
    }
);

// =====================================================
// TRANSLATION CACHE
// =====================================================

const translationCache = new Map();

const MAX_TRANSLATION_CACHE = 5000;

function makeTranslationKey(
    text,
    source,
    target
) {
    return [
        source || 'auto',
        target || 'en',
        text
    ].join('::');
}

function trimTranslationCache() {

    while (
        translationCache.size >
        MAX_TRANSLATION_CACHE
    ) {

        const first =
            translationCache.keys().next().value;

        translationCache.delete(first);
    }
}

async function translateText(
    text,
    target,
    source = 'auto'
) {

    if (!text) {
        return '';
    }

    target = String(
        target || 'en'
    ).toLowerCase();

    source = String(
        source || 'auto'
    ).toLowerCase();

    if (
        source !== 'auto' &&
        source === target
    ) {
        return text;
    }

    const key =
        makeTranslationKey(
            text,
            source,
            target
        );

    if (
        translationCache.has(key)
    ) {
        return translationCache.get(key);
    }

    try {

        const url =
            'https://translate.googleapis.com/translate_a/single' +
            '?client=gtx' +
            '&sl=' +
            encodeURIComponent(source) +
            '&tl=' +
            encodeURIComponent(target) +
            '&dt=t' +
            '&q=' +
            encodeURIComponent(text);

        const response =
            await fetch(
                url,
                {
                    headers: {
                        'User-Agent':
                            'Mozilla/5.0'
                    }
                }
            );

        if (!response.ok) {
            return text;
        }

        const data =
            await response.json();

        let translated = '';

        if (
            Array.isArray(data) &&
            Array.isArray(data[0])
        ) {

            translated =
                data[0]
                    .map(
                        item =>
                            Array.isArray(item)
                                ? item[0]
                                : ''
                    )
                    .join('');
        }

        if (translated) {

            translationCache.set(
                key,
                translated
            );

            trimTranslationCache();

            return translated;
        }

    } catch (error) {

        console.log(
            '[TRANSLATION ERROR]',
            error.message
        );
    }

    return text;
}

// =====================================================
// ONLINE USERS
// =====================================================

const onlineUsers = new Map();

// =====================================================
// MULTIPLAYER PLAYERS
// =====================================================

const players = new Map();

// =====================================================
// CLUB SCREEN
// =====================================================

let clubScreenState = {
    active: false,
    src: '',
    name: '',
    owner: ''
};

let screenHostId = null;

// =====================================================
// HELPERS
// =====================================================

function getOnlineUsers() {

    return Array.from(
        onlineUsers.values()
    );
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
        Array.from(
            players.values()
        )
    );
}

function getMainUserOnline() {

    for (
        const user of
        onlineUsers.values()
    ) {

        if (
            isMainUser(
                user.username
            )
        ) {
            return user;
        }
    }

    return null;
}

function updateScreenHost() {

    const owner =
        getMainUserOnline();

    screenHostId =
        owner
            ? owner.id
            : null;

    return owner;
}

function broadcastScreenHost() {

    const owner =
        updateScreenHost();

    io.emit(
        'screen-host',
        owner
            ? {
                id: owner.id,
                username: owner.username,
                online: true,
                owner: true
            }
            : {
                id: null,
                username: MAIN_USERNAME,
                online: false,
                owner: true
            }
    );
}

function broadcastScreen() {

    io.emit(
        'club-screen-state',
        clubScreenState
    );
}

// =====================================================
// SOCKET.IO
// =====================================================

io.on(
    'connection',
    socket => {

        console.log(
            `[SOCKET CONNECT] ${socket.id}`
        );

        socket.emit(
            'server-ready',
            {
                ok: true
            }
        );

        // =================================================
        // JOIN
        // =================================================

        socket.on(
            'join',
            data => {

                const username =
                    String(
                        data?.username ||
                        'Guest'
                    ).trim();

                const language =
                    String(
                        data?.language ||
                        'en'
                    ).trim().toLowerCase();

                if (!username) {
                    return;
                }

                const owner =
                    isMainUser(
                        username
                    );

                socket.username =
                    username;

                socket.language =
                    language;

                socket.isOwner =
                    owner;

                onlineUsers.set(
                    socket.id,
                    {
                        id: socket.id,
                        username,
                        language,
                        owner
                    }
                );

                // =========================================
                // CREATE PLAYER
                // =========================================

                const player = {
                    id: socket.id,

                    username,

                    x: 0,
                    y: 0,
                    z: 13,

                    yaw: 0,
                    ry: 0,

                    pitch: 0,

                    jumping: false,
                    moving: false,

                    owner,

                    timestamp: Date.now()
                };

                players.set(
                    socket.id,
                    player
                );

                if (owner) {

                    screenHostId =
                        socket.id;

                    console.log(
                        `[OWNER ONLINE] ${username}`
                    );
                }

                // =========================================
                // SEND ONLINE
                // =========================================

                broadcastOnline();

                // =========================================
                // SEND JOINED
                // =========================================

                socket.emit(
                    'joined',
                    {
                        ok: true,
                        username,
                        owner,
                        role:
                            owner
                                ? 'owner'
                                : 'user'
                    }
                );

                // =========================================
                // SEND EXISTING PLAYERS
                // =========================================

                socket.emit(
                    'players-state',
                    Array.from(
                        players.values()
                    ).filter(
                        player =>
                            player.id !==
                            socket.id
                    )
                );

                // =========================================
                // SEND SCREEN
                // =========================================

                socket.emit(
                    'club-screen-state',
                    clubScreenState
                );

                // =========================================
                // SCREEN HOST
                // =========================================

                const screenOwner =
                    getMainUserOnline();

                socket.emit(
                    'screen-host',
                    screenOwner
                        ? {
                            id:
                                screenOwner.id,
                            username:
                                screenOwner.username,
                            online: true,
                            owner: true
                        }
                        : {
                            id: null,
                            username:
                                MAIN_USERNAME,
                            online: false,
                            owner: true
                        }
                );

                // =========================================
                // INFORM OTHER PLAYERS
                // =========================================

                socket.broadcast.emit(
                    'player-joined',
                    player
                );

                socket.broadcast.emit(
                    'system-message',
                    {
                        text:
                            `${username} entered EWS SESSIONS`,
                        ts:
                            Date.now()
                    }
                );

                broadcastScreenHost();

                console.log(
                    `[JOIN] ${username}${owner ? ' [OWNER]' : ''}`
                );
            }
        );

        // =================================================
        // REQUEST ONLINE
        // =================================================

        socket.on(
            'request-online',
            () => {

                socket.emit(
                    'online-users',
                    getOnlineUsers()
                );
            }
        );

        // =================================================
        // REQUEST PLAYERS
        // =================================================

        socket.on(
            'request-players',
            () => {

                socket.emit(
                    'players-state',
                    Array.from(
                        players.values()
                    ).filter(
                        player =>
                            player.id !==
                            socket.id
                    )
                );
            }
        );

        // =================================================
        // PLAYER UPDATE
        // =================================================

        function updatePlayer(data) {

            if (!socket.username) {
                return null;
            }

            const player =
                players.get(
                    socket.id
                );

            if (!player) {
                return null;
            }

            const x =
                Number(data?.x);

            const z =
                Number(data?.z);

            if (
                !Number.isFinite(x) ||
                !Number.isFinite(z)
            ) {
                return null;
            }

            const y =
                Number(data?.y);

            const yaw =
                Number(
                    data?.yaw ??
                    data?.ry ??
                    0
                );

            const pitch =
                Number(
                    data?.pitch ??
                    0
                );

            player.x =
                Math.max(
                    -17,
                    Math.min(
                        17,
                        x
                    )
                );

            player.y =
                Number.isFinite(y)
                    ? Math.max(
                        0,
                        Math.min(
                            5,
                            y
                        )
                    )
                    : 0;

            player.z =
                Math.max(
                    -17,
                    Math.min(
                        17,
                        z
                    )
                );

            if (
                Number.isFinite(yaw)
            ) {

                player.yaw =
                    yaw;

                player.ry =
                    yaw;
            }

            if (
                Number.isFinite(pitch)
            ) {
                player.pitch =
                    pitch;
            }

            player.jumping =
                !!data?.jumping;

            player.moving =
                !!data?.moving;

            player.username =
                socket.username;

            player.owner =
                !!socket.isOwner;

            player.timestamp =
                Date.now();

            players.set(
                socket.id,
                player
            );

            return player;
        }

        // =================================================
        // PLAYER STATE
        // =================================================

        socket.on(
            'player-state',
            data => {

                const player =
                    updatePlayer(
                        data
                    );

                if (!player) {
                    return;
                }

                socket.broadcast.emit(
                    'player-state',
                    player
                );

                socket.broadcast.emit(
                    'player-move',
                    player
                );
            }
        );

        // =================================================
        // PLAYER MOVE
        // =================================================

        socket.on(
            'player-move',
            data => {

                const player =
                    updatePlayer(
                        data
                    );

                if (!player) {
                    return;
                }

                socket.broadcast.emit(
                    'player-move',
                    player
                );

                socket.broadcast.emit(
                    'player-state',
                    player
                );
            }
        );

        // =================================================
        // CLUB SCREEN
        // =================================================

        socket.on(
            'club-screen-state',
            data => {

                if (
                    !isMainUser(
                        socket.username
                    )
                ) {

                    socket.emit(
                        'screen-error',
                        {
                            ok: false,
                            error:
                                'Only mvxtra can control the club screen'
                        }
                    );

                    return;
                }

                socket.isOwner = true;
                screenHostId =
                    socket.id;

                // CLEAR
                if (
                    !data ||
                    data.active === false
                ) {

                    clubScreenState = {
                        active: false,
                        src: '',
                        name: '',
                        owner:
                            socket.username
                    };

                    broadcastScreen();

                    return;
                }

                const src =
                    String(
                        data.src || ''
                    ).trim();

                if (
                    !src ||
                    !/^https?:\/\//i.test(src)
                ) {
                    return;
                }

                clubScreenState = {
                    active: true,
                    src,
                    name:
                        String(
                            data.name || ''
                        ).trim(),
                    owner:
                        socket.username
                };

                console.log(
                    `[SCREEN] ${socket.username} -> ${src}`
                );

                broadcastScreen();
            }
        );

        // =================================================
        // REQUEST SCREEN
        // =================================================

        socket.on(
            'request-club-screen',
            () => {

                socket.emit(
                    'club-screen-state',
                    clubScreenState
                );

                const owner =
                    getMainUserOnline();

                socket.emit(
                    'screen-host',
                    owner
                        ? {
                            id:
                                owner.id,
                            username:
                                owner.username,
                            online: true,
                            owner: true
                        }
                        : {
                            id: null,
                            username:
                                MAIN_USERNAME,
                            online: false,
                            owner: true
                        }
                );
            }
        );

        // =================================================
        // CHAT
        // =================================================

        socket.on(
            'chat-message',
            async data => {

                if (!socket.username) {
                    return;
                }

                const text =
                    String(
                        data?.text || ''
                    ).trim();

                if (
                    !text ||
                    text.length > 500
                ) {
                    return;
                }

                const original =
                    text;

                const sourceLanguage =
                    String(
                        data?.lang ||
                        socket.language ||
                        'auto'
                    ).trim().toLowerCase();

                const timestamp =
                    Date.now();

                const groups =
                    new Map();

                // =========================================
                // GROUP USERS BY LANGUAGE
                // =========================================

                for (
                    const user of
                    onlineUsers.values()
                ) {

                    const lang =
                        String(
                            user.language ||
                            'en'
                        ).trim().toLowerCase();

                    if (
                        !groups.has(lang)
                    ) {
                        groups.set(
                            lang,
                            []
                        );
                    }

                    groups
                        .get(lang)
                        .push(user);
                }

                // =========================================
                // TRANSLATE ONCE PER LANGUAGE
                // =========================================

                await Promise.all(
                    Array.from(
                        groups.entries()
                    ).map(
                        async (
                            [
                                language,
                                users
                            ]
                        ) => {

                            const translated =
                                await translateText(
                                    original,
                                    language,
                                    sourceLanguage
                                );

                            for (
                                const user
                                of users
                            ) {

                                io.to(
                                    user.id
                                ).emit(
                                    'chat-message',
                                    {
                                        user:
                                            socket.username,

                                        username:
                                            socket.username,

                                        text:
                                            translated,

                                        original:
                                            original,

                                        sourceLanguage:
                                            sourceLanguage,

                                        language:
                                            language,

                                        translated:
                                            translated !==
                                            original,

                                        ts:
                                            timestamp
                                    }
                                );
                            }
                        }
                    )
                );
            }
        );

        // =================================================
        // LANGUAGE CHANGE
        // =================================================

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

                const newLanguage =
                    String(
                        language || 'en'
                    )
                        .trim()
                        .toLowerCase();

                user.language =
                    newLanguage;

                socket.language =
                    newLanguage;

                onlineUsers.set(
                    socket.id,
                    user
                );

                broadcastOnline();
            }
        );

        // =================================================
        // DISCONNECT
        // =================================================

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

                    socket.broadcast.emit(
                        'system-message',
                        {
                            text:
                                `${user.username} left EWS SESSIONS`,
                            ts:
                                Date.now()
                        }
                    );
                }

                onlineUsers.delete(
                    socket.id
                );

                players.delete(
                    socket.id
                );

                // =========================================
                // REMOVE PLAYER FOR EVERYONE
                // =========================================

                socket.broadcast.emit(
                    'player-left',
                    socket.id
                );

                socket.broadcast.emit(
                    'player-removed',
                    socket.id
                );

                // =========================================
                // MAIN USER LEFT
                // =========================================

                if (
                    socket.id ===
                    screenHostId ||
                    (
                        user &&
                        isMainUser(
                            user.username
                        )
                    )
                ) {

                    screenHostId =
                        null;

                    clubScreenState = {
                        active: false,
                        src: '',
                        name: '',
                        owner: ''
                    };

                    broadcastScreen();
                }

                broadcastOnline();
                broadcastPlayers();
                broadcastScreenHost();

                console.log(
                    `[DISCONNECT] ${socket.id}`
                );
            }
        );
    }
);

// =====================================================
// NODE MEDIA SERVER
// =====================================================

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

        mediaroot:
            MEDIA_ROOT,

        allow_origin: '*'
    }
};

let nms = null;

try {

    nms =
        new NodeMediaServer(
            nmsConfig
        );

    nms.run();

    console.log('');
    console.log(
        '=========================================='
    );
    console.log(
        'EWS MEDIA SERVER READY'
    );
    console.log(
        `RTMP: rtmp://localhost:${RTMP_PORT}/live`
    );
    console.log(
        'KEY: ews'
    );
    console.log(
        `HLS MEDIA PORT: ${HLS_PORT}`
    );
    console.log(
        '=========================================='
    );
    console.log('');

} catch (error) {

    console.log(
        '[MEDIA SERVER ERROR]',
        error.message
    );
}

// =====================================================
// FFMPEG
// =====================================================

let ffmpegProcess = null;
let ffmpegRestartTimer = null;
let ffmpegStarting = false;

function cleanHLS() {

    try {

        const files =
            fs.readdirSync(
                HLS_DIR
            );

        for (
            const file of files
        ) {

            const fullPath =
                path.join(
                    HLS_DIR,
                    file
                );

            try {
                fs.unlinkSync(
                    fullPath
                );
            } catch {}
        }

    } catch (error) {

        console.log(
            '[HLS CLEAN ERROR]',
            error.message
        );
    }
}

// =====================================================
// START FFMPEG
// =====================================================

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

    if (
        !fs.existsSync(
            FFMPEG_PATH
        )
    ) {

        console.log('');
        console.log(
            '[FFMPEG] ffmpeg.exe NOT FOUND'
        );
        console.log(
            FFMPEG_PATH
        );
        console.log('');

        return;
    }

    ffmpegStarting = true;

    cleanHLS();

    console.log(
        '[FFMPEG] Starting...'
    );

    const args = [

        '-hide_banner',

        '-loglevel',
        'warning',

        // =============================================
        // INPUT
        // =============================================

        '-i',
        'rtmp://127.0.0.1:1935/live/ews',

        // =============================================
        // VIDEO
        // =============================================

        '-map',
        '0:v:0?',

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

        // =============================================
        // AUDIO
        // =============================================

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

        // =============================================
        // HLS
        // =============================================

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

    try {

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

    } catch (error) {

        ffmpegStarting = false;

        console.log(
            '[FFMPEG START ERROR]',
            error.message
        );

        return;
    }

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

            ffmpegProcess =
                null;

            if (ffmpegRestartTimer) {
                clearTimeout(
                    ffmpegRestartTimer
                );
            }

            // Don't hammer the machine.
            ffmpegRestartTimer =
                setTimeout(
                    () => {

                        startFFmpeg();

                    },
                    3000
                );
        }
    );
}

// =====================================================
// WEB SERVER
// =====================================================

server.listen(
    PORT,
    '0.0.0.0',
    () => {

        console.log('');
        console.log(
            '=========================================='
        );
        console.log(
            '          EWS SESSIONS'
        );
        console.log(
            '=========================================='
        );
        console.log(
            `WEB:  http://localhost:${PORT}`
        );
        console.log(
            `RTMP: rtmp://localhost:${RTMP_PORT}/live`
        );
        console.log(
            'KEY:  ews'
        );
        console.log(
            `HLS:  http://localhost:${PORT}/hls/ews/index.m3u8`
        );
        console.log(
            `MAIN USER: ${MAIN_USERNAME}`
        );
        console.log(
            'ONLINE: READY'
        );
        console.log(
            'MULTIPLAYER: READY'
        );
        console.log(
            'CHAT: READY'
        );
        console.log(
            'TRANSLATION: READY'
        );
        console.log(
            'CLUB SCREEN: READY'
        );
        console.log(
            'AUDIO: READY'
        );
        console.log(
            '=========================================='
        );
        console.log('');

        setTimeout(
            () => {
                startFFmpeg();
            },
            2500
        );
    }
);

// =====================================================
// GRACEFUL SHUTDOWN
// =====================================================

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
        } catch {}
    }

    if (nms) {

        try {
            nms.stop();
        } catch {}
    }

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