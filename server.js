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

/*
=========================================================
EWS SESSIONS
SCREEN OWNER
=========================================================
*/

const SCREEN_OWNER_USERNAME = 'mvxtra';

fs.mkdirSync(DATA, { recursive: true });
fs.mkdirSync(MEDIA, { recursive: true });

if (!fs.existsSync(USERS_FILE)) {
    fs.writeFileSync(USERS_FILE, '[]', 'utf8');
}

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

/*
=========================================================
HLS
=========================================================
*/

app.use('/hls', express.static(MEDIA));

/*
=========================================================
PUBLIC
=========================================================
*/

app.use(express.static(PUBLIC));

/*
=========================================================
USERS
=========================================================
*/

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

/*
=========================================================
REGISTER
=========================================================
*/

app.post('/api/register', (req, res) => {

    const username = String(
        req.body?.username || ''
    ).trim();

    const password = String(
        req.body?.password || ''
    );

    if (username.length < 2) {
        return res.json({
            ok: false,
            message: 'Username минимум 2 символа'
        });
    }

    if (password.length < 4) {
        return res.json({
            ok: false,
            message: 'Пароль минимум 4 символа'
        });
    }

    const users = loadUsers();

    const exists = users.some(
        user =>
            String(user.username).toLowerCase() ===
            username.toLowerCase()
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

    return res.json({
        ok: true,
        username
    });
});

/*
=========================================================
LOGIN
=========================================================
*/

app.post('/api/login', (req, res) => {

    const username = String(
        req.body?.username || ''
    ).trim();

    const password = String(
        req.body?.password || ''
    );

    const users = loadUsers();

    const user = users.find(
        item =>
            String(item.username).toLowerCase() ===
                username.toLowerCase() &&
            item.password === password
    );

    if (!user) {
        return res.json({
            ok: false,
            message: 'Неверный username или пароль'
        });
    }

    return res.json({
        ok: true,
        username: user.username
    });
});

/*
=========================================================
STATUS
=========================================================
*/

app.get('/api/status', (req, res) => {

    res.json({
        ok: true,
        online: onlineUsers.size,
        stream: true,
        screenOwner: SCREEN_OWNER_USERNAME
    });

});

/*
=========================================================
ONLINE USERS
=========================================================
*/

const onlineUsers = new Map();

/*
socket.id -> {
    id,
    username,
    language
}
*/

/*
=========================================================
PLAYERS
=========================================================
*/

const players = new Map();

/*
socket.id -> {
    id,
    username,
    x,
    y,
    z,
    ry,
    jumping,
    moving,
    timestamp
}
*/

/*
=========================================================
CLUB SCREEN
=========================================================
*/

/*
ВАЖНО:

SCREEN принадлежит только mvxtra.

Никто другой не становится хозяином автоматически.
*/

let screenHostId = null;

let clubScreenState = {
    active: false,
    src: '',
    name: '',
    owner: ''
};

/*
=========================================================
ONLINE HELPERS
=========================================================
*/

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

/*
=========================================================
PLAYER HELPERS
=========================================================
*/

function getPlayersFor(socketId) {

    return Array.from(
        players.values()
    ).filter(
        player =>
            player.id !== socketId
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

/*
=========================================================
SCREEN HELPERS
=========================================================
*/

function broadcastScreen() {

    io.emit(
        'club-screen-state',
        clubScreenState
    );

}

function getScreenOwnerOnline() {

    for (
        const user of onlineUsers.values()
    ) {

        if (
            user.username.toLowerCase() ===
            SCREEN_OWNER_USERNAME.toLowerCase()
        ) {
            return user;
        }

    }

    return null;
}

function updateScreenHost() {

    const owner =
        getScreenOwnerOnline();

    if (!owner) {

        screenHostId = null;

        return null;
    }

    screenHostId = owner.id;

    return owner;
}

function broadcastScreenHost() {

    const owner =
        updateScreenHost();

    if (!owner) {

        io.emit(
            'screen-host',
            {
                id: null,
                username: SCREEN_OWNER_USERNAME,
                online: false
            }
        );

        return;
    }

    io.emit(
        'screen-host',
        {
            id: owner.id,
            username: owner.username,
            online: true
        }
    );

}

/*
=========================================================
TRANSLATION
=========================================================
*/

async function translateText(
    text,
    targetLanguage
) {

    if (
        !targetLanguage ||
        targetLanguage === 'en'
    ) {
        return text;
    }

    try {

        const url =
            'https://translate.googleapis.com/translate_a/single' +
            '?client=gtx' +
            '&sl=auto' +
            '&tl=' +
            encodeURIComponent(targetLanguage) +
            '&dt=t' +
            '&q=' +
            encodeURIComponent(text);

        const response =
            await fetch(url);

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
                    .map(part => part[0])
                    .join('');

            if (translated) {
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
}

/*
=========================================================
SOCKET.IO
=========================================================
*/

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

    /*
    =====================================================
    JOIN
    =====================================================
    */

    socket.on('join', data => {

        const username =
            String(
                data?.username || 'Guest'
            ).trim();

        const language =
            String(
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

        /*
        PLAYER
        */

        players.set(
            socket.id,
            {
                id: socket.id,
                username,

                x: 0,
                y: 0,
                z: 13,

                ry: 0,

                jumping: false,
                moving: false,

                timestamp: Date.now()
            }
        );

        /*
        SCREEN OWNER

        Только mvxtra.
        */

        if (
            username.toLowerCase() ===
            SCREEN_OWNER_USERNAME.toLowerCase()
        ) {

            screenHostId =
                socket.id;

            console.log(
                `[SCREEN OWNER ONLINE] ${username}`
            );

        }

        console.log(
            `[ONLINE] ${username} | ${socket.id}`
        );

        /*
        ONLINE
        */

        broadcastOnline();

        /*
        JOINED
        */

        socket.emit(
            'joined',
            {
                ok: true,
                username
            }
        );

        /*
        PLAYERS
        */

        socket.emit(
            'players-state',
            getPlayersFor(socket.id)
        );

        /*
        SCREEN
        */

        socket.emit(
            'club-screen-state',
            clubScreenState
        );

        /*
        SCREEN OWNER
        */

        const screenOwner =
            getScreenOwnerOnline();

        if (screenOwner) {

            socket.emit(
                'screen-host',
                {
                    id: screenOwner.id,
                    username: screenOwner.username,
                    online: true
                }
            );

        } else {

            socket.emit(
                'screen-host',
                {
                    id: null,
                    username: SCREEN_OWNER_USERNAME,
                    online: false
                }
            );

        }

        /*
        PLAYER JOINED
        */

        socket.broadcast.emit(
            'player-joined',
            {
                id: socket.id,
                username,

                x: 0,
                y: 0,
                z: 13,

                ry: 0,

                jumping: false,
                moving: false
            }
        );

        /*
        SYSTEM MESSAGE
        */

        socket.broadcast.emit(
            'system-message',
            {
                text:
                    `${username} entered EWS SESSIONS`,
                ts:
                    Date.now()
            }
        );

        /*
        Update screen owner for everyone.
        */

        broadcastScreenHost();

    });

    /*
    =====================================================
    REQUEST ONLINE
    =====================================================
    */

    socket.on(
        'request-online',
        () => {

            socket.emit(
                'online-users',
                getOnlineUsers()
            );

        }
    );

    /*
    =====================================================
    REQUEST PLAYERS
    =====================================================
    */

    socket.on(
        'request-players',
        () => {

            socket.emit(
                'players-state',
                getPlayersFor(socket.id)
            );

        }
    );

    /*
    =====================================================
    PLAYER MOVE
    =====================================================
    */

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
                Number(data?.ry);

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

            if (
                Number.isFinite(ry)
            ) {
                player.ry = ry;
            }

            player.jumping =
                !!data?.jumping;

            player.moving =
                !!data?.moving;

            player.timestamp =
                Date.now();

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

    /*
    =====================================================
    PLAYER STATE
    =====================================================
    */

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

            const ry =
                Number.isFinite(
                    Number(data?.yaw)
                )
                    ? Number(data.yaw)
                    : (
                        Number.isFinite(
                            Number(data?.ry)
                        )
                            ? Number(data.ry)
                            : player.ry
                    );

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

            player.ry = ry;

            player.jumping =
                !!data?.jumping;

            player.moving =
                !!data?.moving;

            player.username =
                socket.username;

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

    /*
    =====================================================
    SCREEN STATE
    =====================================================
    */

    socket.on(
        'club-screen-state',
        data => {

            /*
            ГЛАВНАЯ ЗАЩИТА.

            Только аккаунт mvxtra может
            управлять экраном.

            Не имеет значения socket.id,
            кто вошёл первым или кто сейчас
            находится в комнате.
            */

            const isOwner =
                String(
                    socket.username || ''
                ).trim().toLowerCase() ===
                SCREEN_OWNER_USERNAME.toLowerCase();

            if (!isOwner) {

                console.log(
                    `[SCREEN DENIED] ${socket.username || socket.id}`
                );

                return;
            }

            /*
            Убеждаемся, что этот socket
            действительно является текущим
            mvxtra.
            */

            screenHostId =
                socket.id;

            if (!data) {
                return;
            }

            /*
            CLEAR
            */

            if (
                data.active === false
            ) {

                clubScreenState = {
                    active: false,
                    src: '',
                    name: '',
                    owner: socket.username
                };

                console.log(
                    `[SCREEN CLEARED] ${socket.username}`
                );

                broadcastScreen();

                return;
            }

            const src =
                String(
                    data.src || ''
                ).trim();

            if (!src) {
                return;
            }

            /*
            Разрешаем только HTTP / HTTPS.
            */

            if (
                !/^https?:\/\//i.test(src)
            ) {
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

                owner:
                    socket.username
            };

            console.log(
                `[SCREEN] ${socket.username} -> ${src}`
            );

            broadcastScreen();

        }
    );

    /*
    =====================================================
    REQUEST SCREEN
    =====================================================
    */

    socket.on(
        'request-club-screen',
        () => {

            socket.emit(
                'club-screen-state',
                clubScreenState
            );

            const owner =
                getScreenOwnerOnline();

            if (owner) {

                socket.emit(
                    'screen-host',
                    {
                        id: owner.id,
                        username: owner.username,
                        online: true
                    }
                );

            } else {

                socket.emit(
                    'screen-host',
                    {
                        id: null,
                        username: SCREEN_OWNER_USERNAME,
                        online: false
                    }
                );

            }

        }
    );

    /*
    =====================================================
    CHAT
    =====================================================
    */

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

            const users =
                Array.from(
                    onlineUsers.entries()
                );

            for (
                const [
                    socketId,
                    user
                ] of users
            ) {

                const translated =
                    await translateText(
                        original,
                        user.language
                    );

                io.to(socketId).emit(
                    'chat-message',
                    {
                        user:
                            socket.username,

                        username:
                            socket.username,

                        text:
                            translated,

                        original,

                        ts:
                            timestamp
                    }
                );

            }

        }
    );

    /*
    =====================================================
    LANGUAGE
    =====================================================
    */

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
                ).trim();

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
                `[LANGUAGE] ${user.username}: ${newLanguage}`
            );

        }
    );

    /*
    =====================================================
    DISCONNECT
    =====================================================
    */

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

            /*
            PLAYER
            */

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
            SCREEN OWNER LEFT

            НИКАКОГО нового хозяина.

            Если mvxtra ушёл —
            экран выключается.
            */

            if (
                socket.id === screenHostId ||
                (
                    user &&
                    user.username.toLowerCase() ===
                    SCREEN_OWNER_USERNAME.toLowerCase()
                )
            ) {

                console.log(
                    `[SCREEN OWNER LEFT] ${user?.username || socket.id}`
                );

                screenHostId = null;

                clubScreenState = {
                    active: false,
                    src: '',
                    name: '',
                    owner: ''
                };

                broadcastScreen();

            }

            /*
            SYSTEM MESSAGE
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

            /*
            ONLINE
            */

            broadcastOnline();

            /*
            PLAYERS
            */

            broadcastPlayers();

            /*
            SCREEN OWNER STATUS
            */

            broadcastScreenHost();

        }
    );

});

/*
=========================================================
MAIN PAGE
=========================================================
*/

app.get('/', (req, res) => {

    res.sendFile(
        path.join(
            PUBLIC,
            'index.html'
        )
    );

});

/*
=========================================================
RTMP / HLS
=========================================================
*/

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

/*
=========================================================
START MEDIA SERVER
=========================================================
*/

try {

    const nms =
        new NodeMediaServer(
            mediaServerConfig
        );

    nms.run();

    console.log('');
    console.log('RTMP SERVER READY');

    console.log(
        'RTMP: rtmp://localhost:1935/live'
    );

    console.log(
        'KEY: ews'
    );

    console.log(
        'HLS: http://localhost:3000/hls/ews/index.m3u8'
    );

    console.log('');

} catch (error) {

    console.log(
        '[RTMP ERROR]',
        error.message
    );

}

/*
=========================================================
START WEB SERVER
=========================================================
*/

server.listen(
    PORT,
    '0.0.0.0',
    () => {

        console.log('');

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
            'CLUB SCREEN: READY'
        );

        console.log(
            `SCREEN OWNER: ${SCREEN_OWNER_USERNAME}`
        );

        console.log(
            'CHAT TRANSLATION: READY'
        );

        console.log(
            '=============================='
        );

        console.log('');

    }
);