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

fs.mkdirSync(DATA, { recursive: true });
fs.mkdirSync(MEDIA, { recursive: true });

if (!fs.existsSync(USERS_FILE)) {
    fs.writeFileSync(USERS_FILE, '[]', 'utf8');
}

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

app.use('/hls', express.static(MEDIA));
app.use(express.static(PUBLIC));


// ======================================================
// USERS
// ======================================================

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
    return (
        normalizeUsername(username) ===
        normalizeUsername(MAIN_USERNAME)
    );
}


// ======================================================
// REGISTER
// ======================================================

app.post('/api/register', (req, res) => {

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
        `[REGISTER] ${username}${owner ? ' [MAIN USER]' : ''}`
    );

    res.json({
        ok: true,
        username: user.username,
        owner,
        role: user.role
    });
});


// ======================================================
// LOGIN
// ======================================================

app.post('/api/login', (req, res) => {

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
        `[LOGIN] ${user.username}${owner ? ' [MAIN USER]' : ''}`
    );

    res.json({
        ok: true,
        username: user.username,
        owner,
        role: owner ? 'owner' : 'user'
    });
});


// ======================================================
// ONLINE USERS / PLAYERS
// ======================================================

const onlineUsers = new Map();
const players = new Map();


// ======================================================
// CLUB SCREEN
// ======================================================

let screenHostId = null;

let clubScreenState = {
    active: false,
    src: '',
    name: '',
    owner: ''
};


// ======================================================
// ONLINE HELPERS
// ======================================================

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


function getPlayersFor(socketId) {
    return Array.from(
        players.values()
    ).filter(
        player => player.id !== socketId
    );
}


function broadcastPlayers() {
    io.emit(
        'players-state',
        Array.from(players.values())
    );
}


function getMainUserOnline() {

    for (const user of onlineUsers.values()) {

        if (isMainUser(user.username)) {
            return user;
        }
    }

    return null;
}


function updateScreenHost() {

    const owner = getMainUserOnline();

    screenHostId = owner
        ? owner.id
        : null;

    return owner;
}


function broadcastScreenHost() {

    const owner = updateScreenHost();

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


// ======================================================
// TRANSLATION
// ======================================================

const translationCache = new Map();
const translationPending = new Map();

const MAX_TRANSLATION_CACHE = 5000;


function translationKey(
    text,
    source,
    target
) {

    return (
        `${String(source || 'auto').toLowerCase()}::` +
        `${String(target || 'en').toLowerCase()}::` +
        `${String(text || '')}`
    );
}


function trimTranslationCache() {

    while (
        translationCache.size >
        MAX_TRANSLATION_CACHE
    ) {

        translationCache.delete(
            translationCache.keys().next().value
        );
    }
}


async function translateText(
    text,
    targetLanguage,
    sourceLanguage
) {

    const target = String(
        targetLanguage || 'en'
    )
        .trim()
        .toLowerCase();

    const source = String(
        sourceLanguage || 'auto'
    )
        .trim()
        .toLowerCase();

    if (!text) {
        return text;
    }

    if (
        !target ||
        (
            source !== 'auto' &&
            source === target
        )
    ) {
        return text;
    }

    const key = translationKey(
        text,
        source,
        target
    );

    if (translationCache.has(key)) {
        return translationCache.get(key);
    }

    if (translationPending.has(key)) {
        return translationPending.get(key);
    }

    const promise = (async () => {

        try {

            const sl =
                source &&
                source !== 'auto'
                    ? source
                    : 'auto';

            const url =
                'https://translate.googleapis.com/translate_a/single' +
                `?client=gtx` +
                `&sl=${encodeURIComponent(sl)}` +
                `&tl=${encodeURIComponent(target)}` +
                `&dt=t` +
                `&q=${encodeURIComponent(text)}`;

            const response = await fetch(
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

            const result =
                await response.json();

            if (
                Array.isArray(result) &&
                Array.isArray(result[0])
            ) {

                const translated =
                    result[0]
                        .map(part =>
                            Array.isArray(part)
                                ? part[0]
                                : ''
                        )
                        .join('');

                if (translated) {

                    translationCache.set(
                        key,
                        translated
                    );

                    trimTranslationCache();

                    return translated;
                }
            }

        } catch (error) {

            console.log(
                '[TRANSLATION ERROR]',
                error.message
            );
        }

        return text;

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


// ======================================================
// STATUS
// ======================================================

app.get(
    '/api/status',
    (req, res) => {

        res.json({
            ok: true,
            server: 'EWS SESSIONS',
            mainUser: MAIN_USERNAME,
            online: getOnlineUsers().length
        });
    }
);


// ======================================================
// SOCKET.IO
// ======================================================

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


        // ==================================================
        // JOIN
        // ==================================================

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


                onlineUsers.set(
                    socket.id,
                    {
                        id: socket.id,
                        username,
                        language,
                        owner
                    }
                );


                const player = {

                    id: socket.id,

                    username,

                    x: 0,
                    y: 0,
                    z: 13,

                    ry: 0,
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


                if (owner) {

                    screenHostId =
                        socket.id;

                    console.log(
                        `[MAIN USER ONLINE] ${username}`
                    );
                }


                broadcastOnline();


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


                socket.emit(
                    'players-state',
                    getPlayersFor(
                        socket.id
                    )
                );


                socket.emit(
                    'club-screen-state',
                    clubScreenState
                );


                const screenOwner =
                    getMainUserOnline();


                socket.emit(
                    'screen-host',
                    screenOwner
                        ? {
                            id: screenOwner.id,
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


                socket.broadcast.emit(
                    'player-joined',
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
                    `${owner ? ' [MAIN USER / OWNER]' : ''}`
                );
            }
        );


        // ==================================================
        // REQUEST ONLINE
        // ==================================================

        socket.on(
            'request-online',
            () => {

                socket.emit(
                    'online-users',
                    getOnlineUsers()
                );
            }
        );


        // ==================================================
        // REQUEST PLAYERS
        // ==================================================

        socket.on(
            'request-players',
            () => {

                socket.emit(
                    'players-state',
                    getPlayersFor(
                        socket.id
                    )
                );
            }
        );


        // ==================================================
        // PLAYER UPDATE
        // ==================================================

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


            const yValue =
                Number(data?.y);

            const yawValue =
                Number(
                    data?.yaw ??
                    data?.ry
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
                Number.isFinite(yValue)
                    ? Math.max(
                        0,
                        Math.min(
                            5,
                            yValue
                        )
                    )
                    : player.y;


            player.z =
                Math.max(
                    -17,
                    Math.min(
                        17,
                        z
                    )
                );


            if (
                Number.isFinite(
                    yawValue
                )
            ) {

                player.yaw =
                    yawValue;

                player.ry =
                    yawValue;
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


        // ==================================================
        // PLAYER MOVE
        // ==================================================

        socket.on(
            'player-move',
            data => {

                const player =
                    updatePlayer(data);

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


        // ==================================================
        // PLAYER STATE
        // ==================================================

        socket.on(
            'player-state',
            data => {

                const player =
                    updatePlayer(data);

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


        // ==================================================
        // CLUB SCREEN
        // ==================================================

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


                if (!data) {
                    return;
                }


                if (
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


                broadcastScreen();
            }
        );


        // ==================================================
        // REQUEST SCREEN
        // ==================================================

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


        // ==================================================
        // CHAT
        // ==================================================

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

                const timestamp =
                    Date.now();


                const sourceLanguage =
                    String(
                        data?.lang ||
                        socket.language ||
                        'auto'
                    )
                        .trim()
                        .toLowerCase();


                // Group users by language
                // so each translation is made once.

                const groups =
                    new Map();


                for (
                    const user
                    of onlineUsers.values()
                ) {

                    const lang =
                        String(
                            user.language ||
                            'en'
                        )
                            .trim()
                            .toLowerCase();


                    if (!groups.has(lang)) {

                        groups.set(
                            lang,
                            []
                        );
                    }


                    groups
                        .get(lang)
                        .push(user);
                }


                await Promise.all(

                    Array.from(
                        groups.entries()
                    ).map(
                        async (
                            [language, users]
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

                                        original,

                                        sourceLanguage,

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


        // ==================================================
        // LANGUAGE CHANGE
        // ==================================================

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


        // ==================================================
        // DISCONNECT
        // ==================================================

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
                }


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


                if (user) {

                    socket.broadcast.emit(
                        'system-message',
                        {
                            text:
                                `${user.username} left EWS SESSIONS`,
                            ts: Date.now()
                        }
                    );
                }


                broadcastOnline();

                broadcastPlayers();

                broadcastScreenHost();
            }
        );
    }
);


// ======================================================
// ROOT
// ======================================================

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


// ======================================================
// RTMP / HLS
// ======================================================
// Оставляем серверную часть,
// чтобы существующий звук/стриминг не ломался.
// Клиент при этом может использовать экран,
// YouTube или Twitch.

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


// ======================================================
// START SERVER
// ======================================================

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
            'SOCKET.IO: READY'
        );

        console.log(
            'PLAYERS: READY'
        );

        console.log(
            'ONLINE USERS: READY'
        );

        console.log(
            'CHAT: READY'
        );

        console.log(
            'CHAT TRANSLATION: READY'
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
            '=============================='
        );
    }
);