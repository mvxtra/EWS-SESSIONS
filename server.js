const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const https = require('https');
const { Server } = require('socket.io');

const app = express();
const httpServer = http.createServer(app);

const io = new Server(httpServer, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  transports: ['websocket', 'polling'],
  pingInterval: 10000,
  pingTimeout: 25000
});

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, 'public');
const USERS_FILE = path.join(__dirname, 'users.json');

const CLUB_ROOM = 'ews-club';
const SCREEN_HOST = 'mvxtra';

const WORLD = Object.freeze({
  groundY: 0,
  minX: -16,
  maxX: 16,
  minZ: -14,
  maxZ: 14
});

const SPAWNS = [
  { x: 0, z: 10 },
  { x: 3, z: 8 },
  { x: -3, z: 8 },
  { x: 6, z: 5 },
  { x: -6, z: 5 },
  { x: 8, z: 1 },
  { x: -8, z: 1 },
  { x: 4, z: -1 },
  { x: -4, z: -1 }
];

const EMOTES = new Set([1, 2, 3, 4, 5, 6]);
const LANGUAGES = new Set([
  'ru','en','es','de','fr','zh','ja','ko','ar','hi','pt','it','tr','uk','nl','pl'
]);

fs.mkdirSync(PUBLIC_DIR, { recursive: true });
if (!fs.existsSync(USERS_FILE)) {
  fs.writeFileSync(USERS_FILE, '[]\n', 'utf8');
}

function ensureDefaultHostAccount() {
  try {
    const users = readUsers();
    const exists = users.some(user =>
      String(user.username || '').toLowerCase() === 'mvxtra'
    );

    if (!exists) {
      users.push({
        username: 'mvxtra',
        password: '8d969eef6ecad3c29a3a629280e686cf0c3f5d5a86aff3ca12020c923adc6c92',
        createdAt: new Date().toISOString()
      });
      saveUsers(users);
      console.log('[AUTH] default host account restored');
    }
  } catch (error) {
    console.error('[AUTH] unable to restore host account:', error.message);
  }
}

app.use(express.json({ limit: '64kb' }));
app.use(express.urlencoded({ extended: false }));
app.use(express.static(PUBLIC_DIR));

function readUsers() {
  try {
    const value = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function saveUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), 'utf8');
}

function cleanUsername(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, 24);
}

function validUsername(name) {
  return name.length >= 2 &&
    name.length <= 24 &&
    /^[a-zA-Z0-9_\-а-яА-ЯёЁ ]+$/.test(name);
}

ensureDefaultHostAccount();

function normalizeLanguage(value) {
  const lang = String(value || 'en').trim().toLowerCase();
  return LANGUAGES.has(lang) ? lang : 'en';
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return 'scrypt:' + salt + ':' + hash;
}

function verifyPassword(password, stored) {
  const value = String(stored || '');

  if (!value.startsWith('scrypt:')) {
    const legacy = crypto.createHash('sha256')
      .update(String(password))
      .digest('hex');
    return legacy === value;
  }

  const parts = value.split(':');
  if (parts.length !== 3) return false;

  const expected = Buffer.from(parts[2], 'hex');
  const actual = crypto.scryptSync(String(password), parts[1], 64);

  return expected.length === actual.length &&
    crypto.timingSafeEqual(expected, actual);
}

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    club: 'EWS SESSIONS',
    multiplayer: true,
    screen: true
  });
});

app.post('/api/register', (req, res) => {
  const username = cleanUsername(req.body.username);
  const password = String(req.body.password || '');

  if (!validUsername(username)) {
    return res.status(400).json({ ok: false, error: 'Invalid username.' });
  }

  if (password.length < 4 || password.length > 128) {
    return res.status(400).json({ ok: false, error: 'Invalid password.' });
  }

  const users = readUsers();
  const exists = users.some(user =>
    String(user.username || '').toLowerCase() === username.toLowerCase()
  );

  if (exists) {
    return res.status(409).json({
      ok: false,
      error: 'Username already exists.'
    });
  }

  users.push({
    username,
    password: hashPassword(password),
    createdAt: new Date().toISOString()
  });

  saveUsers(users);
  res.json({ ok: true, username });
});

const translationCache = new Map();
const MAX_TRANSLATION_CACHE = 500;

function httpsGetText(url, timeout = 4000) {
  return new Promise((resolve, reject) => {
    const request = https.get(
      url,
      {
        headers: {
          'User-Agent': 'EWS-SESSIONS/2.0'
        }
      },
      response => {
        let body = '';

        response.setEncoding('utf8');
        response.on('data', chunk => {
          body += chunk;
        });

        response.on('end', () => {
          if (response.statusCode >= 200 && response.statusCode < 300) {
            resolve(body);
          } else {
            reject(new Error('HTTP ' + response.statusCode));
          }
        });
      }
    );

    request.setTimeout(timeout, () => {
      request.destroy(new Error('translation timeout'));
    });

    request.on('error', reject);
  });
}

async function translateText(text, targetLanguage) {
  const source = String(text || '').trim();
  if (!source) return '';

  const target = normalizeLanguage(targetLanguage);
  const key = target + '\n' + source;

  if (translationCache.has(key)) {
    return translationCache.get(key);
  }

  try {
    const url =
      'https://translate.googleapis.com/translate_a/single' +
      '?client=gtx' +
      '&sl=auto' +
      '&tl=' + encodeURIComponent(target) +
      '&dt=t' +
      '&q=' + encodeURIComponent(source);

    const raw = await httpsGetText(url);
    const data = JSON.parse(raw);

    const translated =
      Array.isArray(data) && Array.isArray(data[0])
        ? data[0]
            .map(part => Array.isArray(part) ? part[0] : '')
            .join('')
        : source;

    const result = translated || source;

    if (translationCache.size >= MAX_TRANSLATION_CACHE) {
      const first = translationCache.keys().next().value;
      if (first) translationCache.delete(first);
    }

    translationCache.set(key, result);
    return result;
  } catch (error) {
    console.error('[TRANSLATION]', error.message);
    return source;
  }
}

app.post('/api/translate', async (req, res) => {
  const source = String(req.body?.text || '').trim().slice(0, 500);
  const target = String(req.body?.target || 'en');

  if (!source) {
    return res.json({ ok: true, text: '' });
  }

  res.json({
    ok: true,
    text: await translateText(source, target)
  });
});

app.post('/api/login', (req, res) => {
  const username = cleanUsername(req.body.username);
  const password = String(req.body.password || '');

  const users = readUsers();
  const user = users.find(item =>
    String(item.username || '').toLowerCase() === username.toLowerCase()
  );

  if (!user || !verifyPassword(password, user.password)) {
    return res.status(401).json({
      ok: false,
      error: 'Invalid login.'
    });
  }

  res.json({ ok: true, username: user.username });
});

const players = new Map();

const screen = {
  active: false,
  src: '',
  url: '',
  name: '',
  owner: SCREEN_HOST,
  version: 0
};

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function screenSnapshot() {
  return {
    active: screen.active,
    src: screen.src,
    url: screen.url,
    name: screen.name,
    owner: SCREEN_HOST,
    version: screen.version
  };
}

function playerSnapshot(player) {
  return {
    id: player.id,
    username: player.username,
    language: player.language,
    avatar: 'human-v1',
    x: player.x,
    y: WORLD.groundY,
    z: player.z,
    yaw: player.yaw,
    moving: player.moving,
    jumping: false,
    dance: player.dance,
    danceStartedAt: player.danceStartedAt
  };
}

function onlineSnapshot() {
  return [...players.values()].map(player => ({
    username: player.username,
    language: player.language
  }));
}

function worldSnapshot() {
  return {
    players: [...players.values()].map(playerSnapshot),
    screen: screenSnapshot()
  };
}

function emitOnline() {
  io.to(CLUB_ROOM).emit('online:state', onlineSnapshot());
}

function spawnPoint() {
  const free = SPAWNS.filter(point => {
    return ![...players.values()].some(player =>
      Math.hypot(player.x - point.x, player.z - point.z) < 1.8
    );
  });

  return free[Math.floor(Math.random() * free.length)] ||
    {
      x: Math.random() * 12 - 6,
      z: Math.random() * 10 - 3
    };
}

io.on('connection', socket => {
  console.log('[SOCKET] connect', socket.id);

  socket.on('join', data => {
    const username = cleanUsername(data && data.username);

    if (!validUsername(username)) return;

    players.delete(socket.id);

    const spawn = spawnPoint();

    socket.join(CLUB_ROOM);
    socket.data.joined = true;
    socket.data.username = username;

    const player = {
      id: socket.id,
      username,
      language: normalizeLanguage(data && data.language),
      x: clamp(Number(spawn.x) || 0, WORLD.minX, WORLD.maxX),
      y: WORLD.groundY,
      z: clamp(Number(spawn.z) || 0, WORLD.minZ, WORLD.maxZ),
      yaw: 0,
      moving: false,
      dance: 0,
      danceStartedAt: 0,
      updatedAt: Date.now()
    };

    players.set(socket.id, player);

    socket.emit('club:ready', {
      username,
      host: username.toLowerCase() === SCREEN_HOST,
      screen: screenSnapshot()
    });

    socket.emit('world:state', worldSnapshot());
    socket.emit('online:state', onlineSnapshot());

    socket.to(CLUB_ROOM).emit('player:joined', playerSnapshot(player));
    emitOnline();

    console.log('[JOIN]', username, socket.id);
  });

  socket.on('world:request', () => {
    if (!socket.data.joined) return;

    socket.emit('world:state', worldSnapshot());
    socket.emit('online:state', onlineSnapshot());
  });

  socket.on('screen:request', () => {
    if (!socket.data.joined) return;
    socket.emit('screen:state', screenSnapshot());
  });

  socket.on('player:state', data => {
    if (!socket.data.joined) return;

    const player = players.get(socket.id);
    if (!player || !data) return;

    player.x = clamp(Number(data.x) || 0, WORLD.minX, WORLD.maxX);
    player.y = WORLD.groundY;
    player.z = clamp(Number(data.z) || 0, WORLD.minZ, WORLD.maxZ);
    player.yaw = Number.isFinite(Number(data.yaw))
      ? Number(data.yaw)
      : player.yaw;
    player.moving = Boolean(data.moving);
    player.updatedAt = Date.now();

    socket.to(CLUB_ROOM).emit(
      'player:state',
      playerSnapshot(player)
    );
  });

  socket.on('player:emote', value => {
    if (!socket.data.joined) return;

    const player = players.get(socket.id);
    const dance = Number(value);

    if (!player || !EMOTES.has(dance)) return;

    player.dance = dance;
    player.danceStartedAt = Date.now();

    io.to(CLUB_ROOM).emit(
      'player:state',
      playerSnapshot(player)
    );
  });

  socket.on('player:language', value => {
    if (!socket.data.joined) return;

    const player = players.get(socket.id);
    if (!player) return;

    player.language = normalizeLanguage(value);

    socket.emit(
      'player:state',
      playerSnapshot(player)
    );

    emitOnline();
  });

  socket.on('chat:message', value => {
    if (!socket.data.joined) return;

    const player = players.get(socket.id);
    if (!player) return;

    const text = String(value || '').trim().slice(0, 240);
    if (!text) return;

    io.to(CLUB_ROOM).emit('chat:message', {
      user: player.username,
      text,
      ts: Date.now()
    });
  });

  socket.on('screen:set', state => {
    if (!socket.data.joined) return;

    const username =
      String(socket.data.username || '').trim().toLowerCase();

    if (username !== SCREEN_HOST) {
      console.log('[SCREEN] denied:', socket.data.username);
      return;
    }

    const active =
      state &&
      state.active === true &&
      String(state.src || '').trim().length > 0;

    if (active) {
      screen.active = true;
      screen.src = String(state.src).trim().slice(0, 2000);
      screen.url = String(state.url || '').trim().slice(0, 2000);
      screen.name = String(state.name || 'MEDIA').trim().slice(0, 80);
    } else {
      screen.active = false;
      screen.src = '';
      screen.url = '';
      screen.name = '';
    }

    screen.owner = SCREEN_HOST;
    screen.version += 1;

    io.to(CLUB_ROOM).emit(
      'screen:state',
      screenSnapshot()
    );

    console.log(
      '[SCREEN]',
      screen.active ? 'ON' : 'OFF',
      screen.name,
      'v' + screen.version
    );
  });

  socket.on('disconnect', reason => {
    const player = players.get(socket.id);

    if (!player) return;

    players.delete(socket.id);
    socket.to(CLUB_ROOM).emit('player:left', socket.id);
    emitOnline();

    console.log(
      '[LEAVE]',
      player.username,
      reason
    );
  });
});

/* Twitch OAuth */
const TWITCH_CLIENT_ID =
  process.env.TWITCH_CLIENT_ID ||
  'jyay7d0zpwy8i02kbng9bgizwnynsa';

const TWITCH_CLIENT_SECRET =
  process.env.TWITCH_CLIENT_SECRET || '';

const TWITCH_REDIRECT_URI =
  process.env.TWITCH_REDIRECT_URI ||
  'https://ews-sessions.onrender.com/auth/twitch/callback';

const twitchStates = new Map();
const twitchTickets = new Map();

function randomToken(bytes=24){
  return crypto.randomBytes(bytes).toString('hex');
}

function cleanupTwitchAuth(){
  const now=Date.now();

  for(const [key,value] of twitchStates){
    if(value.expiresAt<=now) twitchStates.delete(key);
  }

  for(const [key,value] of twitchTickets){
    if(value.expiresAt<=now) twitchTickets.delete(key);
  }
}

app.get('/auth/twitch', (_req,res)=>{
  cleanupTwitchAuth();

  if(!TWITCH_CLIENT_SECRET){
    return res.status(503).send('Twitch login is not configured on the server.');
  }

  const state=randomToken(24);
  twitchStates.set(state,{expiresAt:Date.now()+10*60*1000});

  const params=new URLSearchParams({
    client_id:TWITCH_CLIENT_ID,
    redirect_uri:TWITCH_REDIRECT_URI,
    response_type:'code',
    scope:'openid',
    state
  });

  res.redirect('https://id.twitch.tv/oauth2/authorize?'+params.toString());
});

app.get('/auth/twitch/callback',async(req,res)=>{
  cleanupTwitchAuth();

  const code=String(req.query.code||'');
  const state=String(req.query.state||'');

  if(!code || !state || !twitchStates.has(state)){
    return res.status(400).send('Invalid Twitch login request.');
  }

  twitchStates.delete(state);

  try{
    const tokenResponse=await fetch('https://id.twitch.tv/oauth2/token',{
      method:'POST',
      headers:{'Content-Type':'application/x-www-form-urlencoded'},
      body:new URLSearchParams({
        client_id:TWITCH_CLIENT_ID,
        client_secret:TWITCH_CLIENT_SECRET,
        code,
        grant_type:'authorization_code',
        redirect_uri:TWITCH_REDIRECT_URI
      })
    });

    const tokenData=await tokenResponse.json();

    if(!tokenResponse.ok || !tokenData.access_token){
      console.error('[TWITCH] token exchange failed',tokenData);
      return res.status(502).send('Twitch authorization failed.');
    }

    const userResponse=await fetch('https://api.twitch.tv/helix/users',{
      headers:{
        'Authorization':'Bearer '+tokenData.access_token,
        'Client-Id':TWITCH_CLIENT_ID
      }
    });

    const userData=await userResponse.json();
    const twitchUser=userData && Array.isArray(userData.data)
      ? userData.data[0]
      : null;

    if(!userResponse.ok || !twitchUser || !twitchUser.id){
      console.error('[TWITCH] user lookup failed',userData);
      return res.status(502).send('Could not read Twitch account.');
    }

    const users=readUsers();
    let username=String(twitchUser.login||'').trim();

    if(!username){
      return res.status(400).send('Twitch account has no username.');
    }

    const existing=Object.entries(users).find(([,user])=>
      user &&
      String(user.twitchId||'')===String(twitchUser.id)
    );

    if(existing){
      username=existing[0];
      users[username].displayName=String(twitchUser.display_name||username).slice(0,80);
      users[username].twitchId=String(twitchUser.id);
    }else{
      const base=username.replace(/[^a-zA-Z0-9_-]/g,'').slice(0,24) || 'twitch';
      username=base;

      let candidate=username;
      let n=2;

      while(users[candidate]){
        candidate=(base.slice(0,Math.max(1,24-String(n).length-1))+'_'+n).slice(0,24);
        n++;
      }

      username=candidate;
      users[username]={
        password:'',
        twitchId:String(twitchUser.id),
        displayName:String(twitchUser.display_name||username).slice(0,80),
        language:'en'
      };
    }

    writeUsers(users);

    const ticket=randomToken(24);
    twitchTickets.set(ticket,{
      username,
      expiresAt:Date.now()+60*1000
    });

    res.redirect('/?twitch_ticket='+encodeURIComponent(ticket));
  }catch(error){
    console.error('[TWITCH] callback error',error);
    res.status(500).send('Twitch login failed.');
  }
});

app.post('/api/twitch/exchange',(req,res)=>{
  cleanupTwitchAuth();

  const ticket=String(req.body && req.body.ticket || '');
  const record=twitchTickets.get(ticket);

  if(!record){
    return res.status(401).json({
      ok:false,
      error:'Twitch login ticket expired.'
    });
  }

  twitchTickets.delete(ticket);

  res.json({
    ok:true,
    username:record.username
  });
});

app.get('*', (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log('================================');
  console.log('EWS SESSIONS CLEAN CORE');
  console.log('PORT:', PORT);
  console.log('MULTIPLAYER: ON');
  console.log('ONLINE: ON');
  console.log('SCREEN: ON');
  console.log('SCREEN HOST:', SCREEN_HOST);
  console.log('OWN RTMP/HLS: OFF');
  console.log('================================');
});
