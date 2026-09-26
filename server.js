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
const MEDIA = path.join(ROOT, 'media');
const USERS_FILE = path.join(DATA, 'users.json');

const MAIN_USERNAME = 'mvxtra';

/* ==================================================
   FOLDERS
================================================== */

fs.mkdirSync(DATA, { recursive: true });
fs.mkdirSync(MEDIA, { recursive: true });
fs.mkdirSync(PUBLIC, { recursive: true });

if (!fs.existsSync(USERS_FILE)) {
    fs.writeFileSync(USERS_FILE, '[]', 'utf8');
}

/* ==================================================
   EXPRESS
================================================== */

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

app.use('/hls', express.static(MEDIA));
app.use(express.static(PUBLIC));

/* ==================================================
   USERS
================================================== */

function loadUsers() {
    try {
        const data = fs.readFileSync(USERS_FILE, 'utf8');
        const users = JSON.parse(data);

        return Array.isArray(users) ? users : [];
    } catch (error) {
        console.log('[USERS LOAD ERROR]', error.message);
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
        console.log('[USERS SAVE ERROR]', error.message);
    }
}

function normalizeUsername(username) {
    return String(username || '')
        .trim()
        .toLowerCase();
}

function isMainUser(username) {
    return normalizeUsername(username) ===
        normalizeUsername(MAIN_USERNAME);
}

/* ==================================================
   REGISTER
================================================== */

app.post('/api/register', (req, res) => {

    const username =
        String(req.body?.username || '').trim();

    const password =
        String(req.body?.password || '');

    if (!username || !password) {
        return res.status(400).json({
            ok: false,
            error: 'Введите логин и пароль'
        });
    }

    if (username.length < 3 || username.length > 32) {
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

    const exists = users.find(user =>
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

    const user = {
        username,
        password,
        owner,
        role: owner ? 'owner' : 'user',
        createdAt: Date.now()
    };

    users.push(user);
    saveUsers(users);

    console.log(
        `[REGISTER] ${username}${owner ? ' [OWNER]' : ''}`
    );

    return res.json({
        ok: true,
        username: user.username,
        owner,
        role: user.role
    });
});

/* ==================================================
   LOGIN
================================================== */

app.post('/api/login', (req, res) => {

    const username =
        String(req.body?.username || '').trim();

    const password =
        String(req.body?.password || '');

    if (!username || !password) {
        return res.status(400).json({
            ok: false,
            error: 'Введите логин и пароль'
        });
    }

    const users = loadUsers();

    const user = users.find(item =>
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

    const owner = isMainUser(user.username);

    if (owner) {
        user.owner = true;
        user.role = 'owner';
    }

    saveUsers(users);

    console.log(
        `[LOGIN] ${user.username}${owner ? ' [OWNER]' : ''}`
    );

    return res.json({
        ok: true,
        username: user.username,
        owner,
        role: owner ? 'owner' : 'user'
    });
});

/* ==================================================
   STATUS
================================================== */

app.get('/api/status', (req, res) => {

    return res.json({
        ok: true,
        server: 'EWS SESSIONS',
        mainUser: MAIN_USERNAME,
        online: getOnlineUsers().length
    });
});

/* ==================================================
   ONLINE USERS
================================================== */

const onlineUsers = new Map();

/* ==================================================
   PLAYERS
================================================== */

const players = new Map();

/* ==================================================
   CLUB SCREEN
================================================== */

let screenHostId = null;

let clubScreenState = {
    active: false,
    src: '',
    name: '',
    owner: ''
};

/* ==================================================
   ONLINE HELPERS
================================================== */

function getOnlineUsers() {
    return Array.from(onlineUsers.values());
}

function broadcastOnline() {
    io.emit(
        'online-users',
        getOnlineUsers()
    );
}

/* ==================================================
   PLAYER HELPERS
================================================== */

function getPlayersFor(socketId) {

    return Array.from(players.values())
        .filter(player => player.id !== socketId);
}

function broadcastPlayers() {

    io.emit(
        'players-state',
        Array.from(players.values())
    );
}

/* ==================================================
   MAIN USER ONLINE
================================================== */

function getMainUserOnline() {

    for (const user of onlineUsers.values()) {

        if (isMainUser(user.username)) {
            return user;
        }
    }

    return null;
}

/* ==================================================
   SCREEN HOST
================================================== */

function updateScreenHost() {

    const owner = getMainUserOnline();

    if (!owner) {
        screenHostId = null;
        return null;
    }

    screenHostId = owner.id;

    return owner;
}

function broadcastScreenHost() {

    const owner = updateScreenHost();

    if (!owner) {

        io.emit('screen-host', {
            id: null,
            username: MAIN_USERNAME,
            online: false,
            owner: true
        });

        return;
    }

    io.emit('screen-host', {
        id: owner.id,
        username: owner.username,
        online: true,
        owner: true
    });
}

/* ==================================================
   CLUB SCREEN
================================================== */

function broadcastScreen() {

    io.emit(
        'club-screen-state',
        clubScreenState
    );
}

/* ==================================================
   TRANSLATION
================================================== */

const translationCache = new Map();
const translationPending = new Map();

function getTranslationCacheKey(
    text,
    targetLanguage
) {

    return (
        String(targetLanguage || 'en')
            .trim()
            .toLowerCase()
        +
        '::'
        +
        String(text || '').trim()
    );
}

async function translateText(
    text,
    targetLanguage
) {

    const original =
        String(text || '');

    const target =
        String(targetLanguage || 'en')
            .trim()
            .toLowerCase();

    if (!original) {
        return original;
    }

    /*
    Английский оставляем как есть.
    */

    if (
        !target ||
        target === 'en'
    ) {
        return original;
    }

    const key =
        getTranslationCacheKey(
            original,
            target
        );

    /*
    Кэш
    */

    if (translationCache.has(key)) {
        return translationCache.get(key);
    }

    /*
    Если такой перевод уже выполняется,
    используем тот же Promise.
    */

    if (translationPending.has(key)) {
        return translationPending.get(key);
    }

    const promise = (async () => {

        try {

            const url =
                'https://translate.googleapis.com/translate_a/single' +
                '?client=gtx' +
                '&sl=auto' +
                '&tl=' +
                encodeURIComponent(target) +
                '&dt=t' +
                '&q=' +
                encodeURIComponent(original);

            const response =
                await fetch(url);

            if (!response.ok) {
                return original;
            }

            const result =
                await response.json();

            if (
                Array.isArray(result) &&
                Array.isArray(result[0])
            ) {

                const translated =
                    result[0]
                        .map(part => part?.[0] || '')
                        .join('');

                if (translated) {

                    translationCache.set(
                        key,
                        translated
                    );

                    /*
                    Ограничиваем кэш.
                    */

                    if (
                        translationCache.size > 5000
                    ) {

                        const firstKey =
                            translationCache
                                .keys()
                                .next()
                                .value;

                        if (firstKey) {
                            translationCache.delete(
                                firstKey
                            );
                        }
                    }

                    return translated;
                }
            }

        } catch (error) {

            console.log(
                '[TRANSLATION ERROR]',
                error.message
            );
        }

        return original;

    })();

    translationPending.set(
        key,
        promise
    );

    try {
        return await promise;
    } finally {
        translationPending.delete(key);
    }
}

/* ==================================================
   SOCKET.IO
================================================== */

io.on('connection', socket => {

    console.log(
        `[SOCKET CONNECT] ${socket.id}`
    );

    socket.emit(
        'server-ready',
        {
            ok: true
        }
    );

    /* ==================================================
       JOIN
    ================================================== */

    socket.on('join', data => {

        const username =
            String(
                data?.username || 'Guest'
            ).trim();

        const language =
            String(
                data?.language || 'en'
            )
            .trim()
            .toLowerCase();

        if (!username) {
            return;
        }

        const owner =
            isMainUser(username);

        socket.username =
            username;

        socket.language =
            language;

        socket.isOwner =
            owner;

        /* ==============================================
           ONLINE
        ============================================== */

        onlineUsers.set(
            socket.id,
            {
                id: socket.id,
                username,
                language,
                owner
            }
        );

        /* ==============================================
           PLAYER
        ============================================== */

        const player = {

            id: socket.id,

            username,

            x: 0,

            y: 0,

            z: 13,

            ry: 0,

            /*
            Для совместимости с клиентом,
            который использует yaw.
            */

            yaw: 0,

            jumping: false,

            moving: false,

            owner,

            timestamp: Date.now()
        };

        players.set(
            socket.id,
            player
        );

        /* ==============================================
           OWNER
        ============================================== */

        if (owner) {

            screenHostId =
                socket.id;

            console.log(
                `[MAIN USER ONLINE] ${username}`
            );
        }

        /* ==============================================
           ONLINE
        ============================================== */

        broadcastOnline();

        /* ==============================================
           JOIN RESPONSE
        ============================================== */

        socket.emit(
            'joined',
            {
                ok: true,
                username,
                owner,
                role: owner
                    ? 'owner'
                    : 'user'
            }
        );

        /* ==============================================
           EXISTING PLAYERS
        ============================================== */

        socket.emit(
            'players-state',
            getPlayersFor(socket.id)
        );

        /*
        Также отправляем совместимый вариант.
        */

        for (
            const otherPlayer
            of getPlayersFor(socket.id)
        ) {

            socket.emit(
                'player-state',
                otherPlayer
            );
        }

        /* ==============================================
           SCREEN
        ============================================== */

        socket.emit(
            'club-screen-state',
            clubScreenState
        );

        /* ==============================================
           SCREEN HOST
        ============================================== */

        const screenOwner =
            getMainUserOnline();

        socket.emit(
            'screen-host',
            screenOwner
                ? {
                    id: screenOwner.id,
                    username: screenOwner.username,
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

        /* ==============================================
           TELL EVERYONE ABOUT NEW PLAYER
        ============================================== */

        socket.broadcast.emit(
            'player-joined',
            player
        );

        /*
        Дополнительный player-state
        для совместимости.
        */

        socket.broadcast.emit(
            'player-state',
            player
        );

        socket.broadcast.emit(
            'system-message',
            {
                text:
                    `${username} entered EWS SESSIONS`,
                ts: Date.now()
            }
        );

        broadcastScreenHost();

        console.log(
            `[JOIN] ${username}` +
            `${owner ? ' [OWNER]' : ''}`
        );
    });

    /* ==================================================
       REQUEST ONLINE
    ================================================== */

    socket.on(
        'request-online',
        () => {

            socket.emit(
                'online-users',
                getOnlineUsers()
            );
        }
    );

    /* ==================================================
       REQUEST PLAYERS
    ================================================== */

    socket.on(
        'request-players',
        () => {

            socket.emit(
                'players-state',
                getPlayersFor(socket.id)
            );

            for (
                const player
                of getPlayersFor(socket.id)
            ) {

                socket.emit(
                    'player-state',
                    player
                );
            }
        }
    );

    /* ==================================================
       PLAYER MOVE
    ================================================== */

    socket.on(
        'player-move',
        data => {

            if (!socket.username) {
                return;
            }

            const player =
                players.get(socket.id);

            if (!player) {
                return;
            }

            const x =
                Number(data?.x);

            const y =
                Number(data?.y);

            const z =
                Number(data?.z);

            const ry =
                Number(
                    data?.ry ??
                    data?.yaw
                );

            if (
                !Number.isFinite(x) ||
                !Number.isFinite(y) ||
                !Number.isFinite(z)
            ) {
                return;
            }

            player.x =
                Math.max(
                    -17,
                    Math.min(17, x)
                );

            player.y =
                Math.max(
                    0,
                    Math.min(5, y)
                );

            player.z =
                Math.max(
                    -17,
                    Math.min(17, z)
                );

            if (Number.isFinite(ry)) {

                player.ry = ry;
                player.yaw = ry;
            }

            player.jumping =
                !!data?.jumping;

            player.moving =
                !!data?.moving;

            player.timestamp =
                Date.now();

            player.username =
                socket.username;

            player.owner =
                !!socket.isOwner;

            players.set(
                socket.id,
                player
            );

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

    /* ==================================================
       PLAYER STATE
    ================================================== */

    socket.on(
        'player-state',
        data => {

            if (!socket.username) {
                return;
            }

            const player =
                players.get(socket.id);

            if (!player) {
                return;
            }

            const x =
                Number(data?.x);

            const z =
                Number(data?.z);

            if (
                !Number.isFinite(x) ||
                !Number.isFinite(z)
            ) {
                return;
            }

            const y =
                Number.isFinite(
                    Number(data?.y)
                )
                    ? Number(data.y)
                    : player.y;

            let rotation =
                player.ry;

            if (
                Number.isFinite(
                    Number(data?.yaw)
                )
            ) {

                rotation =
                    Number(data.yaw);

            } else if (
                Number.isFinite(
                    Number(data?.ry)
                )
            ) {

                rotation =
                    Number(data.ry);
            }

            player.x =
                Math.max(
                    -17,
                    Math.min(17, x)
                );

            player.y =
                Math.max(
                    0,
                    Math.min(5, y)
                );

            player.z =
                Math.max(
                    -17,
                    Math.min(17, z)
                );

            player.ry =
                rotation;

            player.yaw =
                rotation;

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

    /* ==================================================
       CLUB SCREEN
       ONLY mvxtra
    ================================================== */

    socket.on(
        'club-screen-state',
        data => {

            const owner =
                isMainUser(socket.username);

            if (!owner) {

                console.log(
                    `[SCREEN DENIED] ` +
                    `${socket.username || socket.id}`
                );

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

            if (!data) {
                return;
            }

            /* ==========================================
               SCREEN OFF
            ========================================== */

            if (data.active === false) {

                clubScreenState = {

                    active: false,

                    src: '',

                    name: '',

                    owner: socket.username
                };

                broadcastScreen();

                console.log(
                    '[SCREEN] OFF'
                );

                return;
            }

            /* ==========================================
               URL
            ========================================== */

            const src =
                String(
                    data.src || ''
                ).trim();

            if (!src) {
                return;
            }

            if (
                !/^https?:\/\//i.test(src)
            ) {

                console.log(
                    '[SCREEN] Invalid URL'
                );

                return;
            }

            const name =
                String(
                    data.name || ''
                ).trim();

            clubScreenState = {

                active: true,

                src,

                name,

                owner: socket.username
            };

            broadcastScreen();

            console.log(
                `[SCREEN] ${name || src}`
            );
        }
    );

    /* ==================================================
       REQUEST SCREEN
    ================================================== */

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
    );

    /* ==================================================
       CHAT
    ================================================== */

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

            if (!text) {
                return;
            }

            if (text.length > 500) {
                return;
            }

            const original =
                text;

            const timestamp =
                Date.now();

            /*
            Берём языки именно с onlineUsers,
            а не из data клиента.
            */

            const languageGroups =
                new Map();

            for (
                const user
                of onlineUsers.values()
            ) {

                const language =
                    String(
                        user.language || 'en'
                    )
                    .trim()
                    .toLowerCase();

                if (
                    !languageGroups.has(language)
                ) {

                    languageGroups.set(
                        language,
                        []
                    );
                }

                languageGroups
                    .get(language)
                    .push(user);
            }

            /*
            Переводим каждый язык только один раз.
            Параллельно.
            */

            const translatedByLanguage =
                new Map();

            await Promise.all(
                Array.from(
                    languageGroups.keys()
                ).map(
                    async language => {

                        const translated =
                            await translateText(
                                original,
                                language
                            );

                        translatedByLanguage.set(
                            language,
                            translated
                        );
                    }
                )
            );

            /*
            Каждый пользователь получает
            сообщение на своём языке.
            */

            for (
                const [
                    language,
                    users
                ]
                of languageGroups
            ) {

                const translated =
                    translatedByLanguage.get(
                        language
                    ) || original;

                for (
                    const user
                    of users
                ) {

                    io.to(user.id).emit(
                        'chat-message',
                        {
                            user:
                                socket.username,

                            username:
                                socket.username,

                            text:
                                translated,

                            original,

                            language,

                            ts:
                                timestamp
                        }
                    );
                }
            }
        }
    );

    /* ==================================================
       LANGUAGE CHANGE
    ================================================== */

    socket.on(
        'language-change',
        language => {

            const user =
                onlineUsers.get(socket.id);

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

            console.log(
                `[LANGUAGE] ` +
                `${user.username}: ` +
                `${newLanguage}`
            );
        }
    );

    /* ==================================================
       DISCONNECT
    ================================================== */

    socket.on(
        'disconnect',
        reason => {

            const user =
                onlineUsers.get(socket.id);

            if (user) {

                console.log(
                    `[OFFLINE] ` +
                    `${user.username} | ${reason}`
                );

                onlineUsers.delete(
                    socket.id
                );
            }

            players.delete(
                socket.id
            );

            /*
            Удаляем игрока у всех.
            */

            socket.broadcast.emit(
                'player-left',
                socket.id
            );

            socket.broadcast.emit(
                'player-removed',
                socket.id
            );

            /*
            ==========================================
            MAIN USER LEFT
            ==========================================
            */

            if (
                socket.id === screenHostId ||
                (
                    user &&
                    isMainUser(user.username)
                )
            ) {

                console.log(
                    '[MAIN USER OFFLINE]'
                );

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

            /*
            ==========================================
            SYSTEM MESSAGE
            ==========================================
            */

            if (user) {

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

            broadcastOnline();

            broadcastPlayers();

            broadcastScreenHost();
        }
    );
});

/* ==================================================
   ROOT
================================================== */

app.get(
    '/',
    (req, res) => {

        res.sendFile(
            path.join(
                PUBLIC,
                'index.html'
            )
        );
    }
);

/* ==================================================
   RTMP / HLS
================================================== */

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

        ffmpeg:
            process.env.FFMPEG_PATH ||
            'ffmpeg',

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

/* ==================================================
   START NODE MEDIA SERVER
================================================== */

try {

    const nms =
        new NodeMediaServer(
            mediaServerConfig
        );

    nms.run();

    console.log(
        'RTMP SERVER READY'
    );

    console.log(
        'RTMP: rtmp://localhost:1935/live'
    );

    console.log(
        'KEY: ews'
    );

    console.log(
        'HLS: http://localhost:3000/hls/ews/index.m3u8'
    );

} catch (error) {

    console.log(
        '[RTMP ERROR]',
        error.message
    );
}

/* ==================================================
   START WEB SERVER
================================================== */

server.listen(
    PORT,
    '0.0.0.0',
    () => {

        console.log(
            '=============================='
        );

        console.log(
            'EWS SESSIONS SERVER READY'
        );

        console.log(
            `PORT: ${PORT}`
        );

        console.log(
            `http://localhost:${PORT}`
        );

        console.log(
            'HLS: /hls/ews/index.m3u8'
        );

        console.log(
            'SOCKET.IO: READY'
        );

        console.log(
            'PLAYERS: READY'
        );

        console.log(
            'MULTIPLAYER SYNC: READY'
        );

        console.log(
            'CLUB SCREEN: READY'
        );

        console.log(
            `MAIN USER: ${MAIN_USERNAME}`
        );

        console.log(
            'MAIN USER CONTROL: READY'
        );

        console.log(
            'CHAT TRANSLATION: READY'
        );

        console.log(
            '=============================='
        );
    }
);