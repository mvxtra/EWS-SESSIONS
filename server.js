const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const https = require('https');
const { Server } = require('socket.io');
const NodeMediaServer = require('node-media-server');

const app = express();
app.set('trust proxy', 1);
const server = http.createServer(app);
const io = new Server(server, { cors: { origin:'*', methods:['GET','POST'] } });

const PORT = process.env.PORT || 3000;
const RTMP_PORT = process.env.RTMP_PORT || 1935;
const NMS_HTTP_PORT = process.env.NMS_HTTP_PORT || 8000;
const PUBLIC_DIR = path.join(__dirname,'public');
const HLS_DIR = path.join(__dirname,'hls');
const HLS_STREAM_DIR = path.join(HLS_DIR,'ews');
const USERS_FILE = path.join(__dirname,'users.json');
const SCREEN_HOST = 'mvxtra';
const GROUND_Y = 1.7;
const EMOTES = new Set([1,2,3,4,5,6]);

for(const dir of [PUBLIC_DIR,HLS_DIR,HLS_STREAM_DIR]) fs.mkdirSync(dir,{recursive:true});
if(!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE,JSON.stringify([],null,2),'utf8');

app.use(express.json({limit:'2mb'}));
app.use(express.urlencoded({extended:true}));
app.use(express.static(PUBLIC_DIR));
app.use('/hls',express.static(HLS_DIR,{setHeaders:(res,filePath)=>{
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Cache-Control','no-cache, no-store, must-revalidate');
  if(filePath.endsWith('.m3u8')) res.setHeader('Content-Type','application/vnd.apple.mpegurl');
  if(filePath.endsWith('.ts')) res.setHeader('Content-Type','video/mp2t');
}}));

function readUsers(){try{const users=JSON.parse(fs.readFileSync(USERS_FILE,'utf8'));return Array.isArray(users)?users:[];}catch(e){console.error('USERS READ ERROR:',e.message);return[];}}
function saveUsers(users){fs.writeFileSync(USERS_FILE,JSON.stringify(users,null,2),'utf8');}
function hashPassword(password){
  const salt=crypto.randomBytes(16).toString('hex');
  const hash=crypto.scryptSync(String(password),salt,64).toString('hex');
  return 'scrypt
function cleanUsername(value){return String(value||'').trim().replace(/\s+/g,' ').slice(0,24);}
function isValidUsername(username){return username.length>=2&&username.length<=24&&/^[a-zA-Z0-9_\-а-яА-ЯёЁ ]+$/.test(username);}
function isScreenHost(username){return String(username||'').trim().toLowerCase()===SCREEN_HOST;}
function clamp(v,min,max){return Math.max(min,Math.min(max,v));}

app.get('/api/status',(req,res)=>res.json({ok:true,service:'EWS SESSIONS',online:onlineUsers.size,stream:true}));

const authAttempts=new Map();
const AUTH_WINDOW_MS=10*60*1000;
const AUTH_MAX_ATTEMPTS=20;
function authRateLimited(req){
  const key=req.ip||req.socket.remoteAddress||'unknown';
  const now=Date.now();
  const item=authAttempts.get(key);
  if(!item || now-item.startedAt>AUTH_WINDOW_MS){
    authAttempts.set(key,{startedAt:now,count:1});
    return false;
  }
  item.count++;
  return item.count>AUTH_MAX_ATTEMPTS;
}
setInterval(()=>{
  const now=Date.now();
  for(const [key,item] of authAttempts){
    if(now-item.startedAt>AUTH_WINDOW_MS) authAttempts.delete(key);
  }
},AUTH_WINDOW_MS).unref();

app.post('/api/register',(req,res)=>{
  if(authRateLimited(req)) return res.status(429).json({ok:false,error:'Слишком много попыток. Попробуйте позже.'});
  const username=cleanUsername(req.body.username), password=String(req.body.password||'');
  if(!isValidUsername(username)) return res.status(400).json({ok:false,error:'Некорректное имя пользователя.'});
  if(password.length<4) return res.status(400).json({ok:false,error:'Пароль должен быть минимум 4 символа.'});
  const users=readUsers();
  if(users.some(u=>String(u.username).toLowerCase()===username.toLowerCase())) return res.status(409).json({ok:false,error:'Такой пользователь уже существует.'});
  users.push({username,password:hashPassword(password),createdAt:Date.now()}); saveUsers(users);
  res.json({ok:true,username});
});

app.post('/api/login',(req,res)=>{
  if(authRateLimited(req)) return res.status(429).json({ok:false,error:'Слишком много попыток. Попробуйте позже.'});
  const username=cleanUsername(req.body.username), password=String(req.body.password||'');
  const user=readUsers().find(u=>String(u.username).toLowerCase()===username.toLowerCase());
  if(!user) return res.status(401).json({ok:false,error:'Пользователь не найден.'});
  if(!verifyPassword(password,user.password)) return res.status(401).json({ok:false,error:'Неверный пароль.'});
  const users=readUsers();
  const storedUser=users.find(u=>String(u.username).toLowerCase()===username.toLowerCase());
  if(storedUser && !String(storedUser.password||'').startsWith('scrypt
});

const SUPPORTED_LANGUAGES=new Set(['ru','en','es','de','fr','zh','ja','ko','ar','hi','pt','it','tr','uk','nl','pl']);
const translationCache=new Map();
const MAX_TRANSLATION_CACHE=500;

function normalizeLanguage(value){
  const lang=String(value||'en').trim().toLowerCase();
  return SUPPORTED_LANGUAGES.has(lang)?lang:'en';
}

function httpsGetText(url,timeout=2500){
  return new Promise((resolve,reject)=>{
    const req=https.get(url,{headers:{'User-Agent':'EWS-SESSIONS/1.0'}},res=>{
      let body='';
      res.setEncoding('utf8');
      res.on('data',chunk=>body+=chunk);
      res.on('end',()=>{
        if(res.statusCode>=200&&res.statusCode<300) resolve(body);
        else reject(new Error('HTTP '+res.statusCode));
      });
    });
    req.setTimeout(timeout,()=>req.destroy(new Error('translation timeout')));
    req.on('error',reject);
  });
}

async function translateText(text,targetLanguage){
  if(!text) return '';
  const target=normalizeLanguage(targetLanguage);
  const source=String(text);
  const key=target+'\n'+source;
  if(translationCache.has(key)) return translationCache.get(key);

  try{
    const url='https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl='+encodeURIComponent(target)+'&dt=t&q='+encodeURIComponent(source);
    const raw=await httpsGetText(url);
    const data=JSON.parse(raw);
    const translated=Array.isArray(data)&&Array.isArray(data[0])
      ? data[0].map(part=>Array.isArray(part)?part[0]:'').join('')
      : source;

    if(translationCache.size>=MAX_TRANSLATION_CACHE){
      const firstKey=translationCache.keys().next().value;
      if(firstKey) translationCache.delete(firstKey);
    }
    translationCache.set(key,translated||source);
    return translated||source;
  }catch(e){
    console.error('TRANSLATION ERROR:',e.message);
    return source;
  }
}

app.post('/api/translate',async(req,res)=>{
  const text=String(req.body.text||''), target=String(req.body.target||'en');
  if(!text) return res.json({ok:true,text:''});
  res.json({ok:true,text:await translateText(text,target)});
});

const onlineUsers=new Map();
const players=new Map();
const clubScreenState={active:false,src:'',url:'',name:'',owner:SCREEN_HOST};

const SPAWN_POINTS=[
  {x:0,z:13},
  {x:3,z:10},
  {x:-3,z:10},
  {x:6,z:7},
  {x:-6,z:7},
  {x:8,z:3},
  {x:-8,z:3}
];

function getSpawnPoint(){
  for(const point of SPAWN_POINTS){
    const occupied=[...players.values()].some(
      p=>Math.abs(p.x-point.x)<1.5&&Math.abs(p.z-point.z)<1.5
    );
    if(!occupied) return {x:point.x,z:point.z};
  }
  return {
    x:Math.round(Math.random()*14-7),
    z:Math.round(Math.random()*8+5)
  };
}

function getOnlineUsers(){
  return [...onlineUsers.values()].map(
    u=>({username:u.username,language:u.language})
  );
}

function broadcastOnline(){
  io.emit('online-users',getOnlineUsers());
  io.emit('online',getOnlineUsers());
}

function getPlayers(){
  return [...players.values()].map(p=>({...p}));
}

function sendPlayersSnapshot(socket){
  socket.emit(
    'players-state',
    getPlayers().filter(p=>p.id!==socket.id)
  );
}

io.on('connection',socket=>{
  console.log('SOCKET CONNECT:',socket.id);

  socket.on('join',data=>{
    data=data||{};

    const username=cleanUsername(data.username);
    if(!username) return;

    const language=normalizeLanguage(data.language);

    socket.username=username;
    socket.language=language;

    onlineUsers.set(
      socket.id,
      {
        id:socket.id,
        username,
        language
      }
    );

    const spawn=getSpawnPoint();

    const player={
      id:socket.id,
      username,
      x:spawn.x,
      y:1.7,
      z:spawn.z,
      yaw:0,
      pitch:0,
      moving:false,
      jumping:false,
      dance:0,
      danceStartedAt:0
    };

    players.set(socket.id,player);

    socket.emit(
      'screen-host',
      {
        host:isScreenHost(username),
        username:SCREEN_HOST
      }
    );

    socket.emit('player-spawn',player);

    sendPlayersSnapshot(socket);

    socket.broadcast.emit(
      'player-state',
      player
    );

    broadcastOnline();

    socket.emit(
      'club-screen-state',
      clubScreenState
    );

    socket.emit(
      'online',
      getOnlineUsers()
    );

    console.log(
      'JOIN:',
      username,
      '|',
      language
    );
  });

  socket.on(
    'request-online',
    ()=>socket.emit(
      'online-users',
      getOnlineUsers()
    )
  );

  socket.on(
    'request-players',
    ()=>sendPlayersSnapshot(socket)
  );

  socket.on(
    'request-club-screen',
    ()=>socket.emit(
      'club-screen-state',
      clubScreenState
    )
  );

  socket.on('player-state',data=>{
    const player=players.get(socket.id);
    if(!player) return;

    data=data||{};

    const now=Date.now();
    const dt=Math.min(0.25,Math.max(0.016,(now-(player.lastUpdateAt||now))/1000));
    const x=Number(data.x);
    const y=Number(data.y);
    const z=Number(data.z);
    const yaw=Number(data.yaw);
    const pitch=Number(data.pitch);

    const nextX=Number.isFinite(x)?clamp(x,-16,16):player.x;
    const nextZ=Number.isFinite(z)?clamp(z,-15.5,15.5):player.z;
    const dx=nextX-player.x;
    const dz=nextZ-player.z;
    const distance=Math.hypot(dx,dz);
    const maxDistance=Math.max(0.75,8*dt+0.35);

    if(distance<=maxDistance){
      player.x=nextX;
      player.z=nextZ;
    }

    // Ground is authoritative. A client cannot keep another player floating.
    const requestedJump=Boolean(data.jumping);
    if(requestedJump && Number.isFinite(y)){
      player.y=clamp(y,GROUND_Y,4.8);
      player.jumping=true;
    }else{
      player.y=GROUND_Y;
      player.jumping=false;
    }

    if(Number.isFinite(yaw))
      player.yaw=yaw;

    if(Number.isFinite(pitch))
      player.pitch=clamp(pitch,-Math.PI/2,Math.PI/2);

    if(typeof data.moving==='boolean')
      player.moving=data.moving;

    if(Number.isFinite(Number(data.dance)))
      player.dance=EMOTES.has(Number(data.dance))?Number(data.dance):0;

    if(Number.isFinite(Number(data.danceStartedAt)))
      player.danceStartedAt=Number(data.danceStartedAt)||0;

    player.lastUpdateAt=now;

    socket.broadcast.emit('player-state',player);
  });

  // =====================================================
  // DANCES / EMOTES
  // =====================================================

  socket.on('player-emote',data=>{
    const player=players.get(socket.id);
    if(!player) return;

    const id=Number(
      data?.dance ??
      data?.emote ??
      0
    );

    player.dance=
      EMOTES.has(id)
        ? id
        : 0;

    player.danceStartedAt=
      player.dance
        ? Date.now()
        : 0;

    io.emit(
      'player-state',
      player
    );
  });

  socket.on('club-screen-state',state=>{
    if(!isScreenHost(socket.username)){
      console.log(
        'SCREEN DENIED:',
        socket.username
      );
      return;
    }

    state=state||{};

    if(
      state.active===true &&
      (
        (typeof state.url==='string'&&state.url.trim()) ||
        (typeof state.src==='string'&&state.src.trim())
      )
    ){
      clubScreenState.active=true;

      clubScreenState.src=
        typeof state.src==='string'
          ? state.src.trim().slice(0,2000)
          : '';

      clubScreenState.url=
        typeof state.url==='string'
          ? state.url.trim().slice(0,2000)
          : '';

      clubScreenState.name=
        String(
          state.name||'MEDIA'
        ).slice(0,100);

    }else{
      clubScreenState.active=false;
      clubScreenState.src='';
      clubScreenState.url='';
      clubScreenState.name='';
    }

    clubScreenState.owner=SCREEN_HOST;

    io.emit(
      'club-screen-state',
      clubScreenState
    );
  });

  socket.on('chat-message',async message=>{
    if(!socket.username) return;

    const original=
      String(message?.text||'')
        .trim()
        .slice(0,500);

    if(!original) return;

    // Every guest receives the same message in THEIR selected language.
    // Translation is done once per unique target language and then reused.

    const recipients=[
      ...onlineUsers.entries()
    ];

    const targetLanguages=[
      ...new Set(
        recipients.map(
          ([,user])=>
            normalizeLanguage(user.language)
        )
      )
    ];

    const translations=new Map();
    // Never block delivery of the whole chat on one translation request.
    await Promise.all(
      targetLanguages.map(async targetLanguage=>{
        try{
          translations.set(
            targetLanguage,
            await translateText(original,targetLanguage)
          );
        }catch{
          translations.set(targetLanguage,original);
        }
      })
    );

    const ts=Date.now();

    for(const [id,user] of recipients){

      const targetSocket=
        io.sockets.sockets.get(id);

      if(!targetSocket) continue;

      const targetLanguage=
        normalizeLanguage(
          user.language
        );

      targetSocket.emit(
        'chat-message',
        {
          user:socket.username,
          username:socket.username,
          text:
            translations.get(
              targetLanguage
            )||original,
          original,
          targetLanguage,
          translated:true,
          ts
        }
      );
    }
  });

  socket.on(
    'language-change',
    language=>{
      if(!socket.username) return;

      socket.language=
        normalizeLanguage(language);

      const user=
        onlineUsers.get(socket.id);

      if(user)
        user.language=
          socket.language;

      socket.emit(
        'language-updated',
        {
          language:
            socket.language
        }
      );

      broadcastOnline();
    }
  );

  socket.on(
    'disconnect',
    reason=>{
      const username=
        socket.username||'unknown';

      onlineUsers.delete(
        socket.id
      );

      players.delete(
        socket.id
      );

      io.emit(
        'player-left',
        socket.id
      );

      io.emit(
        'player-removed',
        socket.id
      );

      broadcastOnline();

      console.log(
        'DISCONNECT:',
        username,
        '|',
        reason
      );
    }
  );
});

const nmsConfig={
  rtmp:{
    port:Number(RTMP_PORT),
    chunk_size:60000,
    gop_cache:true,
    ping:30,
    ping_timeout:60
  },

  http:{
    port:Number(NMS_HTTP_PORT),
    mediaroot:HLS_DIR,
    allow_origin:'*'
  },

  trans:{
    ffmpeg:
      process.env.FFMPEG_PATH||
      'ffmpeg',

    tasks:[
      {
        app:'live',
        hls:true,
        hlsFlags:
          '[hls_time=2:hls_list_size=6:hls_flags=delete_segments+append_list]',
        hlsKeepSegments:6,
        dash:false
      }
    ]
  }
};

let nms=null;

try{
  nms=
    new NodeMediaServer(
      nmsConfig
    );

  nms.run();

  console.log(
    'RTMP SERVER READY'
  );

  console.log(
    `RTMP: rtmp://localhost:${RTMP_PORT}/live`
  );

}catch(error){
  console.error(
    'NODE MEDIA SERVER ERROR:',
    error
  );
}

app.get(
  '/',
  (req,res)=>{
    const index=
      path.join(
        PUBLIC_DIR,
        'index.html'
      );

    if(fs.existsSync(index))
      return res.sendFile(index);

    res.status(404).send(
      'EWS SESSIONS: index.html not found in public folder.'
    );
  }
);

app.use(
  '/api',
  (req,res)=>
    res.status(404).json({
      ok:false,
      error:'API endpoint not found.'
    })
);

app.use(
  (err,req,res,next)=>{
    console.error(
      'EXPRESS ERROR:',
      err
    );

    if(res.headersSent)
      return next(err);

    res.status(500).json({
      ok:false,
      error:'Internal server error.'
    });
  }
);

server.listen(
  PORT,
  '0.0.0.0',
  ()=>{
    console.log('');
    console.log(
      '========================================'
    );
    console.log(
      '        EWS SESSIONS SERVER READY'
    );
    console.log(
      '========================================'
    );

    console.log(
      `WEB:  http://localhost:${PORT}`
    );

    console.log(
      `RTMP: rtmp://localhost:${RTMP_PORT}/live`
    );

    console.log(
      `HLS:  http://localhost:${PORT}/hls/`
    );

    console.log(
      'SCREEN OWNER: mvxtra'
    );

    console.log(
      'CHAT TRANSLATION: PERSONAL'
    );

    console.log(
      'MULTIPLAYER: ON'
    );

    console.log(
      'ONLINE USERS: ON'
    );

    console.log(
      'DANCES / EMOTES: ON'
    );

    console.log(
      'USERS FILE: ./users.json'
    );

    console.log(
      '========================================'
    );

    console.log('');
  }
);

function shutdown(){
  console.log(
    'EWS SESSIONS shutting down...'
  );

  try{
    if(nms)
      nms.stop();
  }catch(e){
    console.error(e);
  }

  server.close(
    ()=>process.exit(0)
  );
}

process.on(
  'SIGINT',
  shutdown
);

process.on(
  'SIGTERM',
  shutdown
);+salt+'
function cleanUsername(value){return String(value||'').trim().replace(/\s+/g,' ').slice(0,24);}
function isValidUsername(username){return username.length>=2&&username.length<=24&&/^[a-zA-Z0-9_\-а-яА-ЯёЁ ]+$/.test(username);}
function isScreenHost(username){return String(username||'').trim().toLowerCase()===SCREEN_HOST;}
function clamp(v,min,max){return Math.max(min,Math.min(max,v));}

app.get('/api/status',(req,res)=>res.json({ok:true,service:'EWS SESSIONS',online:onlineUsers.size,stream:true}));

app.post('/api/register',(req,res)=>{
  const username=cleanUsername(req.body.username), password=String(req.body.password||'');
  if(!isValidUsername(username)) return res.status(400).json({ok:false,error:'Некорректное имя пользователя.'});
  if(password.length<4) return res.status(400).json({ok:false,error:'Пароль должен быть минимум 4 символа.'});
  const users=readUsers();
  if(users.some(u=>String(u.username).toLowerCase()===username.toLowerCase())) return res.status(409).json({ok:false,error:'Такой пользователь уже существует.'});
  users.push({username,password:hashPassword(password),createdAt:Date.now()}); saveUsers(users);
  res.json({ok:true,username});
});

app.post('/api/login',(req,res)=>{
  const username=cleanUsername(req.body.username), password=String(req.body.password||'');
  const user=readUsers().find(u=>String(u.username).toLowerCase()===username.toLowerCase());
  if(!user) return res.status(401).json({ok:false,error:'Пользователь не найден.'});
  if(user.password!==hashPassword(password)) return res.status(401).json({ok:false,error:'Неверный пароль.'});
  res.json({ok:true,username:user.username});
});

const SUPPORTED_LANGUAGES=new Set(['ru','en','es','de','fr','zh','ja','ko','ar','hi','pt','it','tr','uk','nl','pl']);
const translationCache=new Map();
const MAX_TRANSLATION_CACHE=500;

function normalizeLanguage(value){
  const lang=String(value||'en').trim().toLowerCase();
  return SUPPORTED_LANGUAGES.has(lang)?lang:'en';
}

function httpsGetText(url,timeout=8000){
  return new Promise((resolve,reject)=>{
    const req=https.get(url,{headers:{'User-Agent':'EWS-SESSIONS/1.0'}},res=>{
      let body='';
      res.setEncoding('utf8');
      res.on('data',chunk=>body+=chunk);
      res.on('end',()=>{
        if(res.statusCode>=200&&res.statusCode<300) resolve(body);
        else reject(new Error('HTTP '+res.statusCode));
      });
    });
    req.setTimeout(timeout,()=>req.destroy(new Error('translation timeout')));
    req.on('error',reject);
  });
}

async function translateText(text,targetLanguage){
  if(!text) return '';
  const target=normalizeLanguage(targetLanguage);
  const source=String(text);
  const key=target+'\n'+source;
  if(translationCache.has(key)) return translationCache.get(key);

  try{
    const url='https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl='+encodeURIComponent(target)+'&dt=t&q='+encodeURIComponent(source);
    const raw=await httpsGetText(url);
    const data=JSON.parse(raw);
    const translated=Array.isArray(data)&&Array.isArray(data[0])
      ? data[0].map(part=>Array.isArray(part)?part[0]:'').join('')
      : source;

    if(translationCache.size>=MAX_TRANSLATION_CACHE){
      const firstKey=translationCache.keys().next().value;
      if(firstKey) translationCache.delete(firstKey);
    }
    translationCache.set(key,translated||source);
    return translated||source;
  }catch(e){
    console.error('TRANSLATION ERROR:',e.message);
    return source;
  }
}

app.post('/api/translate',async(req,res)=>{
  const text=String(req.body.text||''), target=String(req.body.target||'en');
  if(!text) return res.json({ok:true,text:''});
  res.json({ok:true,text:await translateText(text,target)});
});

const onlineUsers=new Map();
const players=new Map();
const clubScreenState={active:false,src:'',url:'',name:'',owner:SCREEN_HOST};

const SPAWN_POINTS=[
  {x:0,z:13},
  {x:3,z:10},
  {x:-3,z:10},
  {x:6,z:7},
  {x:-6,z:7},
  {x:8,z:3},
  {x:-8,z:3}
];

function getSpawnPoint(){
  for(const point of SPAWN_POINTS){
    const occupied=[...players.values()].some(
      p=>Math.abs(p.x-point.x)<1.5&&Math.abs(p.z-point.z)<1.5
    );
    if(!occupied) return {x:point.x,z:point.z};
  }
  return {
    x:Math.round(Math.random()*14-7),
    z:Math.round(Math.random()*8+5)
  };
}

function getOnlineUsers(){
  return [...onlineUsers.values()].map(
    u=>({username:u.username,language:u.language})
  );
}

function broadcastOnline(){
  io.emit('online-users',getOnlineUsers());
  io.emit('online',getOnlineUsers());
}

function getPlayers(){
  return [...players.values()].map(p=>({...p}));
}

function sendPlayersSnapshot(socket){
  socket.emit(
    'players-state',
    getPlayers().filter(p=>p.id!==socket.id)
  );
}

io.on('connection',socket=>{
  console.log('SOCKET CONNECT:',socket.id);

  socket.on('join',data=>{
    data=data||{};

    const username=cleanUsername(data.username);
    if(!username) return;

    const language=normalizeLanguage(data.language);

    socket.username=username;
    socket.language=language;

    onlineUsers.set(
      socket.id,
      {
        id:socket.id,
        username,
        language
      }
    );

    const spawn=getSpawnPoint();

    const player={
      id:socket.id,
      username,
      x:spawn.x,
      y:1.7,
      z:spawn.z,
      yaw:0,
      pitch:0,
      moving:false,
      jumping:false,
      dance:0,
      danceStartedAt:0
    };

    players.set(socket.id,player);

    socket.emit(
      'screen-host',
      {
        host:isScreenHost(username),
        username:SCREEN_HOST
      }
    );

    socket.emit('player-spawn',player);

    sendPlayersSnapshot(socket);

    socket.broadcast.emit(
      'player-state',
      player
    );

    broadcastOnline();

    socket.emit(
      'club-screen-state',
      clubScreenState
    );

    socket.emit(
      'online',
      getOnlineUsers()
    );

    console.log(
      'JOIN:',
      username,
      '|',
      language
    );
  });

  socket.on(
    'request-online',
    ()=>socket.emit(
      'online-users',
      getOnlineUsers()
    )
  );

  socket.on(
    'request-players',
    ()=>sendPlayersSnapshot(socket)
  );

  socket.on(
    'request-club-screen',
    ()=>socket.emit(
      'club-screen-state',
      clubScreenState
    )
  );

  socket.on('player-state',data=>{
    const player=players.get(socket.id);
    if(!player) return;

    data=data||{};

    const x=Number(data.x);
    const y=Number(data.y);
    const z=Number(data.z);
    const yaw=Number(data.yaw);
    const pitch=Number(data.pitch);

    if(Number.isFinite(x))
      player.x=clamp(x,-16,16);

    if(Number.isFinite(y))
      player.y=clamp(y,0,8);

    if(Number.isFinite(z))
      player.z=clamp(z,-15.5,15.5);

    if(Number.isFinite(yaw))
      player.yaw=yaw;

    if(Number.isFinite(pitch))
      player.pitch=pitch;

    if(typeof data.moving==='boolean')
      player.moving=data.moving;

    if(typeof data.jumping==='boolean')
      player.jumping=data.jumping;

    if(Number.isFinite(Number(data.dance)))
      player.dance=
        EMOTES.has(Number(data.dance))
          ? Number(data.dance)
          : 0;

    if(Number.isFinite(Number(data.danceStartedAt)))
      player.danceStartedAt=
        Number(data.danceStartedAt)||0;

    socket.broadcast.emit(
      'player-state',
      player
    );
  });

  socket.on('player-move',data=>{
    const player=players.get(socket.id);
    if(!player) return;

    data=data||{};

    if(Number.isFinite(Number(data.x)))
      player.x=clamp(Number(data.x),-16,16);

    if(Number.isFinite(Number(data.y)))
      player.y=clamp(Number(data.y),0,8);

    if(Number.isFinite(Number(data.z)))
      player.z=clamp(Number(data.z),-15.5,15.5);

    if(Number.isFinite(Number(data.yaw)))
      player.yaw=Number(data.yaw);

    if(Number.isFinite(Number(data.pitch)))
      player.pitch=Number(data.pitch);

    socket.broadcast.emit(
      'player-state',
      player
    );
  });

  // =====================================================
  // DANCES / EMOTES
  // =====================================================

  socket.on('player-emote',data=>{
    const player=players.get(socket.id);
    if(!player) return;

    const id=Number(
      data?.dance ??
      data?.emote ??
      0
    );

    player.dance=
      EMOTES.has(id)
        ? id
        : 0;

    player.danceStartedAt=
      player.dance
        ? Date.now()
        : 0;

    io.emit(
      'player-state',
      player
    );
  });

  socket.on('club-screen-state',state=>{
    if(!isScreenHost(socket.username)){
      console.log(
        'SCREEN DENIED:',
        socket.username
      );
      return;
    }

    state=state||{};

    if(
      state.active===true &&
      (
        (typeof state.url==='string'&&state.url.trim()) ||
        (typeof state.src==='string'&&state.src.trim())
      )
    ){
      clubScreenState.active=true;

      clubScreenState.src=
        typeof state.src==='string'
          ? state.src.trim().slice(0,2000)
          : '';

      clubScreenState.url=
        typeof state.url==='string'
          ? state.url.trim().slice(0,2000)
          : '';

      clubScreenState.name=
        String(
          state.name||'MEDIA'
        ).slice(0,100);

    }else{
      clubScreenState.active=false;
      clubScreenState.src='';
      clubScreenState.url='';
      clubScreenState.name='';
    }

    clubScreenState.owner=SCREEN_HOST;

    io.emit(
      'club-screen-state',
      clubScreenState
    );
  });

  socket.on('chat-message',async message=>{
    if(!socket.username) return;

    const original=
      String(message?.text||'')
        .trim()
        .slice(0,500);

    if(!original) return;

    // Every guest receives the same message in THEIR selected language.
    // Translation is done once per unique target language and then reused.

    const recipients=[
      ...onlineUsers.entries()
    ];

    const targetLanguages=[
      ...new Set(
        recipients.map(
          ([,user])=>
            normalizeLanguage(user.language)
        )
      )
    ];

    const translations=new Map();

    await Promise.all(
      targetLanguages.map(
        async targetLanguage=>{
          translations.set(
            targetLanguage,
            await translateText(
              original,
              targetLanguage
            )
          );
        }
      )
    );

    const ts=Date.now();

    for(const [id,user] of recipients){

      const targetSocket=
        io.sockets.sockets.get(id);

      if(!targetSocket) continue;

      const targetLanguage=
        normalizeLanguage(
          user.language
        );

      targetSocket.emit(
        'chat-message',
        {
          user:socket.username,
          username:socket.username,
          text:
            translations.get(
              targetLanguage
            )||original,
          original,
          targetLanguage,
          translated:true,
          ts
        }
      );
    }
  });

  socket.on(
    'language-change',
    language=>{
      if(!socket.username) return;

      socket.language=
        normalizeLanguage(language);

      const user=
        onlineUsers.get(socket.id);

      if(user)
        user.language=
          socket.language;

      socket.emit(
        'language-updated',
        {
          language:
            socket.language
        }
      );

      broadcastOnline();
    }
  );

  socket.on(
    'disconnect',
    reason=>{
      const username=
        socket.username||'unknown';

      onlineUsers.delete(
        socket.id
      );

      players.delete(
        socket.id
      );

      io.emit(
        'player-left',
        socket.id
      );

      io.emit(
        'player-removed',
        socket.id
      );

      broadcastOnline();

      console.log(
        'DISCONNECT:',
        username,
        '|',
        reason
      );
    }
  );
});

const nmsConfig={
  rtmp:{
    port:Number(RTMP_PORT),
    chunk_size:60000,
    gop_cache:true,
    ping:30,
    ping_timeout:60
  },

  http:{
    port:Number(NMS_HTTP_PORT),
    mediaroot:HLS_DIR,
    allow_origin:'*'
  },

  trans:{
    ffmpeg:
      process.env.FFMPEG_PATH||
      'ffmpeg',

    tasks:[
      {
        app:'live',
        hls:true,
        hlsFlags:
          '[hls_time=2:hls_list_size=6:hls_flags=delete_segments+append_list]',
        hlsKeepSegments:6,
        dash:false
      }
    ]
  }
};

let nms=null;

try{
  nms=
    new NodeMediaServer(
      nmsConfig
    );

  nms.run();

  console.log(
    'RTMP SERVER READY'
  );

  console.log(
    `RTMP: rtmp://localhost:${RTMP_PORT}/live`
  );

}catch(error){
  console.error(
    'NODE MEDIA SERVER ERROR:',
    error
  );
}

app.get(
  '/',
  (req,res)=>{
    const index=
      path.join(
        PUBLIC_DIR,
        'index.html'
      );

    if(fs.existsSync(index))
      return res.sendFile(index);

    res.status(404).send(
      'EWS SESSIONS: index.html not found in public folder.'
    );
  }
);

app.use(
  '/api',
  (req,res)=>
    res.status(404).json({
      ok:false,
      error:'API endpoint not found.'
    })
);

app.use(
  (err,req,res,next)=>{
    console.error(
      'EXPRESS ERROR:',
      err
    );

    if(res.headersSent)
      return next(err);

    res.status(500).json({
      ok:false,
      error:'Internal server error.'
    });
  }
);

server.listen(
  PORT,
  '0.0.0.0',
  ()=>{
    console.log('');
    console.log(
      '========================================'
    );
    console.log(
      '        EWS SESSIONS SERVER READY'
    );
    console.log(
      '========================================'
    );

    console.log(
      `WEB:  http://localhost:${PORT}`
    );

    console.log(
      `RTMP: rtmp://localhost:${RTMP_PORT}/live`
    );

    console.log(
      `HLS:  http://localhost:${PORT}/hls/`
    );

    console.log(
      'SCREEN OWNER: mvxtra'
    );

    console.log(
      'CHAT TRANSLATION: PERSONAL'
    );

    console.log(
      'MULTIPLAYER: ON'
    );

    console.log(
      'ONLINE USERS: ON'
    );

    console.log(
      'DANCES / EMOTES: ON'
    );

    console.log(
      'USERS FILE: ./users.json'
    );

    console.log(
      '========================================'
    );

    console.log('');
  }
);

function shutdown(){
  console.log(
    'EWS SESSIONS shutting down...'
  );

  try{
    if(nms)
      nms.stop();
  }catch(e){
    console.error(e);
  }

  server.close(
    ()=>process.exit(0)
  );
}

process.on(
  'SIGINT',
  shutdown
);

process.on(
  'SIGTERM',
  shutdown
);+hash;
}
function verifyPassword(password,stored){
  const value=String(stored||'');
  if(value.startsWith('scrypt
function cleanUsername(value){return String(value||'').trim().replace(/\s+/g,' ').slice(0,24);}
function isValidUsername(username){return username.length>=2&&username.length<=24&&/^[a-zA-Z0-9_\-а-яА-ЯёЁ ]+$/.test(username);}
function isScreenHost(username){return String(username||'').trim().toLowerCase()===SCREEN_HOST;}
function clamp(v,min,max){return Math.max(min,Math.min(max,v));}

app.get('/api/status',(req,res)=>res.json({ok:true,service:'EWS SESSIONS',online:onlineUsers.size,stream:true}));

app.post('/api/register',(req,res)=>{
  const username=cleanUsername(req.body.username), password=String(req.body.password||'');
  if(!isValidUsername(username)) return res.status(400).json({ok:false,error:'Некорректное имя пользователя.'});
  if(password.length<4) return res.status(400).json({ok:false,error:'Пароль должен быть минимум 4 символа.'});
  const users=readUsers();
  if(users.some(u=>String(u.username).toLowerCase()===username.toLowerCase())) return res.status(409).json({ok:false,error:'Такой пользователь уже существует.'});
  users.push({username,password:hashPassword(password),createdAt:Date.now()}); saveUsers(users);
  res.json({ok:true,username});
});

app.post('/api/login',(req,res)=>{
  const username=cleanUsername(req.body.username), password=String(req.body.password||'');
  const user=readUsers().find(u=>String(u.username).toLowerCase()===username.toLowerCase());
  if(!user) return res.status(401).json({ok:false,error:'Пользователь не найден.'});
  if(user.password!==hashPassword(password)) return res.status(401).json({ok:false,error:'Неверный пароль.'});
  res.json({ok:true,username:user.username});
});

const SUPPORTED_LANGUAGES=new Set(['ru','en','es','de','fr','zh','ja','ko','ar','hi','pt','it','tr','uk','nl','pl']);
const translationCache=new Map();
const MAX_TRANSLATION_CACHE=500;

function normalizeLanguage(value){
  const lang=String(value||'en').trim().toLowerCase();
  return SUPPORTED_LANGUAGES.has(lang)?lang:'en';
}

function httpsGetText(url,timeout=8000){
  return new Promise((resolve,reject)=>{
    const req=https.get(url,{headers:{'User-Agent':'EWS-SESSIONS/1.0'}},res=>{
      let body='';
      res.setEncoding('utf8');
      res.on('data',chunk=>body+=chunk);
      res.on('end',()=>{
        if(res.statusCode>=200&&res.statusCode<300) resolve(body);
        else reject(new Error('HTTP '+res.statusCode));
      });
    });
    req.setTimeout(timeout,()=>req.destroy(new Error('translation timeout')));
    req.on('error',reject);
  });
}

async function translateText(text,targetLanguage){
  if(!text) return '';
  const target=normalizeLanguage(targetLanguage);
  const source=String(text);
  const key=target+'\n'+source;
  if(translationCache.has(key)) return translationCache.get(key);

  try{
    const url='https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl='+encodeURIComponent(target)+'&dt=t&q='+encodeURIComponent(source);
    const raw=await httpsGetText(url);
    const data=JSON.parse(raw);
    const translated=Array.isArray(data)&&Array.isArray(data[0])
      ? data[0].map(part=>Array.isArray(part)?part[0]:'').join('')
      : source;

    if(translationCache.size>=MAX_TRANSLATION_CACHE){
      const firstKey=translationCache.keys().next().value;
      if(firstKey) translationCache.delete(firstKey);
    }
    translationCache.set(key,translated||source);
    return translated||source;
  }catch(e){
    console.error('TRANSLATION ERROR:',e.message);
    return source;
  }
}

app.post('/api/translate',async(req,res)=>{
  const text=String(req.body.text||''), target=String(req.body.target||'en');
  if(!text) return res.json({ok:true,text:''});
  res.json({ok:true,text:await translateText(text,target)});
});

const onlineUsers=new Map();
const players=new Map();
const clubScreenState={active:false,src:'',url:'',name:'',owner:SCREEN_HOST};

const SPAWN_POINTS=[
  {x:0,z:13},
  {x:3,z:10},
  {x:-3,z:10},
  {x:6,z:7},
  {x:-6,z:7},
  {x:8,z:3},
  {x:-8,z:3}
];

function getSpawnPoint(){
  for(const point of SPAWN_POINTS){
    const occupied=[...players.values()].some(
      p=>Math.abs(p.x-point.x)<1.5&&Math.abs(p.z-point.z)<1.5
    );
    if(!occupied) return {x:point.x,z:point.z};
  }
  return {
    x:Math.round(Math.random()*14-7),
    z:Math.round(Math.random()*8+5)
  };
}

function getOnlineUsers(){
  return [...onlineUsers.values()].map(
    u=>({username:u.username,language:u.language})
  );
}

function broadcastOnline(){
  io.emit('online-users',getOnlineUsers());
  io.emit('online',getOnlineUsers());
}

function getPlayers(){
  return [...players.values()].map(p=>({...p}));
}

function sendPlayersSnapshot(socket){
  socket.emit(
    'players-state',
    getPlayers().filter(p=>p.id!==socket.id)
  );
}

io.on('connection',socket=>{
  console.log('SOCKET CONNECT:',socket.id);

  socket.on('join',data=>{
    data=data||{};

    const username=cleanUsername(data.username);
    if(!username) return;

    const language=normalizeLanguage(data.language);

    socket.username=username;
    socket.language=language;

    onlineUsers.set(
      socket.id,
      {
        id:socket.id,
        username,
        language
      }
    );

    const spawn=getSpawnPoint();

    const player={
      id:socket.id,
      username,
      x:spawn.x,
      y:1.7,
      z:spawn.z,
      yaw:0,
      pitch:0,
      moving:false,
      jumping:false,
      dance:0,
      danceStartedAt:0
    };

    players.set(socket.id,player);

    socket.emit(
      'screen-host',
      {
        host:isScreenHost(username),
        username:SCREEN_HOST
      }
    );

    socket.emit('player-spawn',player);

    sendPlayersSnapshot(socket);

    socket.broadcast.emit(
      'player-state',
      player
    );

    broadcastOnline();

    socket.emit(
      'club-screen-state',
      clubScreenState
    );

    socket.emit(
      'online',
      getOnlineUsers()
    );

    console.log(
      'JOIN:',
      username,
      '|',
      language
    );
  });

  socket.on(
    'request-online',
    ()=>socket.emit(
      'online-users',
      getOnlineUsers()
    )
  );

  socket.on(
    'request-players',
    ()=>sendPlayersSnapshot(socket)
  );

  socket.on(
    'request-club-screen',
    ()=>socket.emit(
      'club-screen-state',
      clubScreenState
    )
  );

  socket.on('player-state',data=>{
    const player=players.get(socket.id);
    if(!player) return;

    data=data||{};

    const x=Number(data.x);
    const y=Number(data.y);
    const z=Number(data.z);
    const yaw=Number(data.yaw);
    const pitch=Number(data.pitch);

    if(Number.isFinite(x))
      player.x=clamp(x,-16,16);

    if(Number.isFinite(y))
      player.y=clamp(y,0,8);

    if(Number.isFinite(z))
      player.z=clamp(z,-15.5,15.5);

    if(Number.isFinite(yaw))
      player.yaw=yaw;

    if(Number.isFinite(pitch))
      player.pitch=pitch;

    if(typeof data.moving==='boolean')
      player.moving=data.moving;

    if(typeof data.jumping==='boolean')
      player.jumping=data.jumping;

    if(Number.isFinite(Number(data.dance)))
      player.dance=
        EMOTES.has(Number(data.dance))
          ? Number(data.dance)
          : 0;

    if(Number.isFinite(Number(data.danceStartedAt)))
      player.danceStartedAt=
        Number(data.danceStartedAt)||0;

    socket.broadcast.emit(
      'player-state',
      player
    );
  });

  socket.on('player-move',data=>{
    const player=players.get(socket.id);
    if(!player) return;

    data=data||{};

    if(Number.isFinite(Number(data.x)))
      player.x=clamp(Number(data.x),-16,16);

    if(Number.isFinite(Number(data.y)))
      player.y=clamp(Number(data.y),0,8);

    if(Number.isFinite(Number(data.z)))
      player.z=clamp(Number(data.z),-15.5,15.5);

    if(Number.isFinite(Number(data.yaw)))
      player.yaw=Number(data.yaw);

    if(Number.isFinite(Number(data.pitch)))
      player.pitch=Number(data.pitch);

    socket.broadcast.emit(
      'player-state',
      player
    );
  });

  // =====================================================
  // DANCES / EMOTES
  // =====================================================

  socket.on('player-emote',data=>{
    const player=players.get(socket.id);
    if(!player) return;

    const id=Number(
      data?.dance ??
      data?.emote ??
      0
    );

    player.dance=
      EMOTES.has(id)
        ? id
        : 0;

    player.danceStartedAt=
      player.dance
        ? Date.now()
        : 0;

    io.emit(
      'player-state',
      player
    );
  });

  socket.on('club-screen-state',state=>{
    if(!isScreenHost(socket.username)){
      console.log(
        'SCREEN DENIED:',
        socket.username
      );
      return;
    }

    state=state||{};

    if(
      state.active===true &&
      (
        (typeof state.url==='string'&&state.url.trim()) ||
        (typeof state.src==='string'&&state.src.trim())
      )
    ){
      clubScreenState.active=true;

      clubScreenState.src=
        typeof state.src==='string'
          ? state.src.trim().slice(0,2000)
          : '';

      clubScreenState.url=
        typeof state.url==='string'
          ? state.url.trim().slice(0,2000)
          : '';

      clubScreenState.name=
        String(
          state.name||'MEDIA'
        ).slice(0,100);

    }else{
      clubScreenState.active=false;
      clubScreenState.src='';
      clubScreenState.url='';
      clubScreenState.name='';
    }

    clubScreenState.owner=SCREEN_HOST;

    io.emit(
      'club-screen-state',
      clubScreenState
    );
  });

  socket.on('chat-message',async message=>{
    if(!socket.username) return;

    const original=
      String(message?.text||'')
        .trim()
        .slice(0,500);

    if(!original) return;

    // Every guest receives the same message in THEIR selected language.
    // Translation is done once per unique target language and then reused.

    const recipients=[
      ...onlineUsers.entries()
    ];

    const targetLanguages=[
      ...new Set(
        recipients.map(
          ([,user])=>
            normalizeLanguage(user.language)
        )
      )
    ];

    const translations=new Map();

    await Promise.all(
      targetLanguages.map(
        async targetLanguage=>{
          translations.set(
            targetLanguage,
            await translateText(
              original,
              targetLanguage
            )
          );
        }
      )
    );

    const ts=Date.now();

    for(const [id,user] of recipients){

      const targetSocket=
        io.sockets.sockets.get(id);

      if(!targetSocket) continue;

      const targetLanguage=
        normalizeLanguage(
          user.language
        );

      targetSocket.emit(
        'chat-message',
        {
          user:socket.username,
          username:socket.username,
          text:
            translations.get(
              targetLanguage
            )||original,
          original,
          targetLanguage,
          translated:true,
          ts
        }
      );
    }
  });

  socket.on(
    'language-change',
    language=>{
      if(!socket.username) return;

      socket.language=
        normalizeLanguage(language);

      const user=
        onlineUsers.get(socket.id);

      if(user)
        user.language=
          socket.language;

      socket.emit(
        'language-updated',
        {
          language:
            socket.language
        }
      );

      broadcastOnline();
    }
  );

  socket.on(
    'disconnect',
    reason=>{
      const username=
        socket.username||'unknown';

      onlineUsers.delete(
        socket.id
      );

      players.delete(
        socket.id
      );

      io.emit(
        'player-left',
        socket.id
      );

      io.emit(
        'player-removed',
        socket.id
      );

      broadcastOnline();

      console.log(
        'DISCONNECT:',
        username,
        '|',
        reason
      );
    }
  );
});

const nmsConfig={
  rtmp:{
    port:Number(RTMP_PORT),
    chunk_size:60000,
    gop_cache:true,
    ping:30,
    ping_timeout:60
  },

  http:{
    port:Number(NMS_HTTP_PORT),
    mediaroot:HLS_DIR,
    allow_origin:'*'
  },

  trans:{
    ffmpeg:
      process.env.FFMPEG_PATH||
      'ffmpeg',

    tasks:[
      {
        app:'live',
        hls:true,
        hlsFlags:
          '[hls_time=2:hls_list_size=6:hls_flags=delete_segments+append_list]',
        hlsKeepSegments:6,
        dash:false
      }
    ]
  }
};

let nms=null;

try{
  nms=
    new NodeMediaServer(
      nmsConfig
    );

  nms.run();

  console.log(
    'RTMP SERVER READY'
  );

  console.log(
    `RTMP: rtmp://localhost:${RTMP_PORT}/live`
  );

}catch(error){
  console.error(
    'NODE MEDIA SERVER ERROR:',
    error
  );
}

app.get(
  '/',
  (req,res)=>{
    const index=
      path.join(
        PUBLIC_DIR,
        'index.html'
      );

    if(fs.existsSync(index))
      return res.sendFile(index);

    res.status(404).send(
      'EWS SESSIONS: index.html not found in public folder.'
    );
  }
);

app.use(
  '/api',
  (req,res)=>
    res.status(404).json({
      ok:false,
      error:'API endpoint not found.'
    })
);

app.use(
  (err,req,res,next)=>{
    console.error(
      'EXPRESS ERROR:',
      err
    );

    if(res.headersSent)
      return next(err);

    res.status(500).json({
      ok:false,
      error:'Internal server error.'
    });
  }
);

server.listen(
  PORT,
  '0.0.0.0',
  ()=>{
    console.log('');
    console.log(
      '========================================'
    );
    console.log(
      '        EWS SESSIONS SERVER READY'
    );
    console.log(
      '========================================'
    );

    console.log(
      `WEB:  http://localhost:${PORT}`
    );

    console.log(
      `RTMP: rtmp://localhost:${RTMP_PORT}/live`
    );

    console.log(
      `HLS:  http://localhost:${PORT}/hls/`
    );

    console.log(
      'SCREEN OWNER: mvxtra'
    );

    console.log(
      'CHAT TRANSLATION: PERSONAL'
    );

    console.log(
      'MULTIPLAYER: ON'
    );

    console.log(
      'ONLINE USERS: ON'
    );

    console.log(
      'DANCES / EMOTES: ON'
    );

    console.log(
      'USERS FILE: ./users.json'
    );

    console.log(
      '========================================'
    );

    console.log('');
  }
);

function shutdown(){
  console.log(
    'EWS SESSIONS shutting down...'
  );

  try{
    if(nms)
      nms.stop();
  }catch(e){
    console.error(e);
  }

  server.close(
    ()=>process.exit(0)
  );
}

process.on(
  'SIGINT',
  shutdown
);

process.on(
  'SIGTERM',
  shutdown
);)){
    const parts=value.split('
function cleanUsername(value){return String(value||'').trim().replace(/\s+/g,' ').slice(0,24);}
function isValidUsername(username){return username.length>=2&&username.length<=24&&/^[a-zA-Z0-9_\-а-яА-ЯёЁ ]+$/.test(username);}
function isScreenHost(username){return String(username||'').trim().toLowerCase()===SCREEN_HOST;}
function clamp(v,min,max){return Math.max(min,Math.min(max,v));}

app.get('/api/status',(req,res)=>res.json({ok:true,service:'EWS SESSIONS',online:onlineUsers.size,stream:true}));

app.post('/api/register',(req,res)=>{
  const username=cleanUsername(req.body.username), password=String(req.body.password||'');
  if(!isValidUsername(username)) return res.status(400).json({ok:false,error:'Некорректное имя пользователя.'});
  if(password.length<4) return res.status(400).json({ok:false,error:'Пароль должен быть минимум 4 символа.'});
  const users=readUsers();
  if(users.some(u=>String(u.username).toLowerCase()===username.toLowerCase())) return res.status(409).json({ok:false,error:'Такой пользователь уже существует.'});
  users.push({username,password:hashPassword(password),createdAt:Date.now()}); saveUsers(users);
  res.json({ok:true,username});
});

app.post('/api/login',(req,res)=>{
  const username=cleanUsername(req.body.username), password=String(req.body.password||'');
  const user=readUsers().find(u=>String(u.username).toLowerCase()===username.toLowerCase());
  if(!user) return res.status(401).json({ok:false,error:'Пользователь не найден.'});
  if(user.password!==hashPassword(password)) return res.status(401).json({ok:false,error:'Неверный пароль.'});
  res.json({ok:true,username:user.username});
});

const SUPPORTED_LANGUAGES=new Set(['ru','en','es','de','fr','zh','ja','ko','ar','hi','pt','it','tr','uk','nl','pl']);
const translationCache=new Map();
const MAX_TRANSLATION_CACHE=500;

function normalizeLanguage(value){
  const lang=String(value||'en').trim().toLowerCase();
  return SUPPORTED_LANGUAGES.has(lang)?lang:'en';
}

function httpsGetText(url,timeout=8000){
  return new Promise((resolve,reject)=>{
    const req=https.get(url,{headers:{'User-Agent':'EWS-SESSIONS/1.0'}},res=>{
      let body='';
      res.setEncoding('utf8');
      res.on('data',chunk=>body+=chunk);
      res.on('end',()=>{
        if(res.statusCode>=200&&res.statusCode<300) resolve(body);
        else reject(new Error('HTTP '+res.statusCode));
      });
    });
    req.setTimeout(timeout,()=>req.destroy(new Error('translation timeout')));
    req.on('error',reject);
  });
}

async function translateText(text,targetLanguage){
  if(!text) return '';
  const target=normalizeLanguage(targetLanguage);
  const source=String(text);
  const key=target+'\n'+source;
  if(translationCache.has(key)) return translationCache.get(key);

  try{
    const url='https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl='+encodeURIComponent(target)+'&dt=t&q='+encodeURIComponent(source);
    const raw=await httpsGetText(url);
    const data=JSON.parse(raw);
    const translated=Array.isArray(data)&&Array.isArray(data[0])
      ? data[0].map(part=>Array.isArray(part)?part[0]:'').join('')
      : source;

    if(translationCache.size>=MAX_TRANSLATION_CACHE){
      const firstKey=translationCache.keys().next().value;
      if(firstKey) translationCache.delete(firstKey);
    }
    translationCache.set(key,translated||source);
    return translated||source;
  }catch(e){
    console.error('TRANSLATION ERROR:',e.message);
    return source;
  }
}

app.post('/api/translate',async(req,res)=>{
  const text=String(req.body.text||''), target=String(req.body.target||'en');
  if(!text) return res.json({ok:true,text:''});
  res.json({ok:true,text:await translateText(text,target)});
});

const onlineUsers=new Map();
const players=new Map();
const clubScreenState={active:false,src:'',url:'',name:'',owner:SCREEN_HOST};

const SPAWN_POINTS=[
  {x:0,z:13},
  {x:3,z:10},
  {x:-3,z:10},
  {x:6,z:7},
  {x:-6,z:7},
  {x:8,z:3},
  {x:-8,z:3}
];

function getSpawnPoint(){
  for(const point of SPAWN_POINTS){
    const occupied=[...players.values()].some(
      p=>Math.abs(p.x-point.x)<1.5&&Math.abs(p.z-point.z)<1.5
    );
    if(!occupied) return {x:point.x,z:point.z};
  }
  return {
    x:Math.round(Math.random()*14-7),
    z:Math.round(Math.random()*8+5)
  };
}

function getOnlineUsers(){
  return [...onlineUsers.values()].map(
    u=>({username:u.username,language:u.language})
  );
}

function broadcastOnline(){
  io.emit('online-users',getOnlineUsers());
  io.emit('online',getOnlineUsers());
}

function getPlayers(){
  return [...players.values()].map(p=>({...p}));
}

function sendPlayersSnapshot(socket){
  socket.emit(
    'players-state',
    getPlayers().filter(p=>p.id!==socket.id)
  );
}

io.on('connection',socket=>{
  console.log('SOCKET CONNECT:',socket.id);

  socket.on('join',data=>{
    data=data||{};

    const username=cleanUsername(data.username);
    if(!username) return;

    const language=normalizeLanguage(data.language);

    socket.username=username;
    socket.language=language;

    onlineUsers.set(
      socket.id,
      {
        id:socket.id,
        username,
        language
      }
    );

    const spawn=getSpawnPoint();

    const player={
      id:socket.id,
      username,
      x:spawn.x,
      y:1.7,
      z:spawn.z,
      yaw:0,
      pitch:0,
      moving:false,
      jumping:false,
      dance:0,
      danceStartedAt:0
    };

    players.set(socket.id,player);

    socket.emit(
      'screen-host',
      {
        host:isScreenHost(username),
        username:SCREEN_HOST
      }
    );

    socket.emit('player-spawn',player);

    sendPlayersSnapshot(socket);

    socket.broadcast.emit(
      'player-state',
      player
    );

    broadcastOnline();

    socket.emit(
      'club-screen-state',
      clubScreenState
    );

    socket.emit(
      'online',
      getOnlineUsers()
    );

    console.log(
      'JOIN:',
      username,
      '|',
      language
    );
  });

  socket.on(
    'request-online',
    ()=>socket.emit(
      'online-users',
      getOnlineUsers()
    )
  );

  socket.on(
    'request-players',
    ()=>sendPlayersSnapshot(socket)
  );

  socket.on(
    'request-club-screen',
    ()=>socket.emit(
      'club-screen-state',
      clubScreenState
    )
  );

  socket.on('player-state',data=>{
    const player=players.get(socket.id);
    if(!player) return;

    data=data||{};

    const x=Number(data.x);
    const y=Number(data.y);
    const z=Number(data.z);
    const yaw=Number(data.yaw);
    const pitch=Number(data.pitch);

    if(Number.isFinite(x))
      player.x=clamp(x,-16,16);

    if(Number.isFinite(y))
      player.y=clamp(y,0,8);

    if(Number.isFinite(z))
      player.z=clamp(z,-15.5,15.5);

    if(Number.isFinite(yaw))
      player.yaw=yaw;

    if(Number.isFinite(pitch))
      player.pitch=pitch;

    if(typeof data.moving==='boolean')
      player.moving=data.moving;

    if(typeof data.jumping==='boolean')
      player.jumping=data.jumping;

    if(Number.isFinite(Number(data.dance)))
      player.dance=
        EMOTES.has(Number(data.dance))
          ? Number(data.dance)
          : 0;

    if(Number.isFinite(Number(data.danceStartedAt)))
      player.danceStartedAt=
        Number(data.danceStartedAt)||0;

    socket.broadcast.emit(
      'player-state',
      player
    );
  });

  socket.on('player-move',data=>{
    const player=players.get(socket.id);
    if(!player) return;

    data=data||{};

    if(Number.isFinite(Number(data.x)))
      player.x=clamp(Number(data.x),-16,16);

    if(Number.isFinite(Number(data.y)))
      player.y=clamp(Number(data.y),0,8);

    if(Number.isFinite(Number(data.z)))
      player.z=clamp(Number(data.z),-15.5,15.5);

    if(Number.isFinite(Number(data.yaw)))
      player.yaw=Number(data.yaw);

    if(Number.isFinite(Number(data.pitch)))
      player.pitch=Number(data.pitch);

    socket.broadcast.emit(
      'player-state',
      player
    );
  });

  // =====================================================
  // DANCES / EMOTES
  // =====================================================

  socket.on('player-emote',data=>{
    const player=players.get(socket.id);
    if(!player) return;

    const id=Number(
      data?.dance ??
      data?.emote ??
      0
    );

    player.dance=
      EMOTES.has(id)
        ? id
        : 0;

    player.danceStartedAt=
      player.dance
        ? Date.now()
        : 0;

    io.emit(
      'player-state',
      player
    );
  });

  socket.on('club-screen-state',state=>{
    if(!isScreenHost(socket.username)){
      console.log(
        'SCREEN DENIED:',
        socket.username
      );
      return;
    }

    state=state||{};

    if(
      state.active===true &&
      (
        (typeof state.url==='string'&&state.url.trim()) ||
        (typeof state.src==='string'&&state.src.trim())
      )
    ){
      clubScreenState.active=true;

      clubScreenState.src=
        typeof state.src==='string'
          ? state.src.trim().slice(0,2000)
          : '';

      clubScreenState.url=
        typeof state.url==='string'
          ? state.url.trim().slice(0,2000)
          : '';

      clubScreenState.name=
        String(
          state.name||'MEDIA'
        ).slice(0,100);

    }else{
      clubScreenState.active=false;
      clubScreenState.src='';
      clubScreenState.url='';
      clubScreenState.name='';
    }

    clubScreenState.owner=SCREEN_HOST;

    io.emit(
      'club-screen-state',
      clubScreenState
    );
  });

  socket.on('chat-message',async message=>{
    if(!socket.username) return;

    const original=
      String(message?.text||'')
        .trim()
        .slice(0,500);

    if(!original) return;

    // Every guest receives the same message in THEIR selected language.
    // Translation is done once per unique target language and then reused.

    const recipients=[
      ...onlineUsers.entries()
    ];

    const targetLanguages=[
      ...new Set(
        recipients.map(
          ([,user])=>
            normalizeLanguage(user.language)
        )
      )
    ];

    const translations=new Map();

    await Promise.all(
      targetLanguages.map(
        async targetLanguage=>{
          translations.set(
            targetLanguage,
            await translateText(
              original,
              targetLanguage
            )
          );
        }
      )
    );

    const ts=Date.now();

    for(const [id,user] of recipients){

      const targetSocket=
        io.sockets.sockets.get(id);

      if(!targetSocket) continue;

      const targetLanguage=
        normalizeLanguage(
          user.language
        );

      targetSocket.emit(
        'chat-message',
        {
          user:socket.username,
          username:socket.username,
          text:
            translations.get(
              targetLanguage
            )||original,
          original,
          targetLanguage,
          translated:true,
          ts
        }
      );
    }
  });

  socket.on(
    'language-change',
    language=>{
      if(!socket.username) return;

      socket.language=
        normalizeLanguage(language);

      const user=
        onlineUsers.get(socket.id);

      if(user)
        user.language=
          socket.language;

      socket.emit(
        'language-updated',
        {
          language:
            socket.language
        }
      );

      broadcastOnline();
    }
  );

  socket.on(
    'disconnect',
    reason=>{
      const username=
        socket.username||'unknown';

      onlineUsers.delete(
        socket.id
      );

      players.delete(
        socket.id
      );

      io.emit(
        'player-left',
        socket.id
      );

      io.emit(
        'player-removed',
        socket.id
      );

      broadcastOnline();

      console.log(
        'DISCONNECT:',
        username,
        '|',
        reason
      );
    }
  );
});

const nmsConfig={
  rtmp:{
    port:Number(RTMP_PORT),
    chunk_size:60000,
    gop_cache:true,
    ping:30,
    ping_timeout:60
  },

  http:{
    port:Number(NMS_HTTP_PORT),
    mediaroot:HLS_DIR,
    allow_origin:'*'
  },

  trans:{
    ffmpeg:
      process.env.FFMPEG_PATH||
      'ffmpeg',

    tasks:[
      {
        app:'live',
        hls:true,
        hlsFlags:
          '[hls_time=2:hls_list_size=6:hls_flags=delete_segments+append_list]',
        hlsKeepSegments:6,
        dash:false
      }
    ]
  }
};

let nms=null;

try{
  nms=
    new NodeMediaServer(
      nmsConfig
    );

  nms.run();

  console.log(
    'RTMP SERVER READY'
  );

  console.log(
    `RTMP: rtmp://localhost:${RTMP_PORT}/live`
  );

}catch(error){
  console.error(
    'NODE MEDIA SERVER ERROR:',
    error
  );
}

app.get(
  '/',
  (req,res)=>{
    const index=
      path.join(
        PUBLIC_DIR,
        'index.html'
      );

    if(fs.existsSync(index))
      return res.sendFile(index);

    res.status(404).send(
      'EWS SESSIONS: index.html not found in public folder.'
    );
  }
);

app.use(
  '/api',
  (req,res)=>
    res.status(404).json({
      ok:false,
      error:'API endpoint not found.'
    })
);

app.use(
  (err,req,res,next)=>{
    console.error(
      'EXPRESS ERROR:',
      err
    );

    if(res.headersSent)
      return next(err);

    res.status(500).json({
      ok:false,
      error:'Internal server error.'
    });
  }
);

server.listen(
  PORT,
  '0.0.0.0',
  ()=>{
    console.log('');
    console.log(
      '========================================'
    );
    console.log(
      '        EWS SESSIONS SERVER READY'
    );
    console.log(
      '========================================'
    );

    console.log(
      `WEB:  http://localhost:${PORT}`
    );

    console.log(
      `RTMP: rtmp://localhost:${RTMP_PORT}/live`
    );

    console.log(
      `HLS:  http://localhost:${PORT}/hls/`
    );

    console.log(
      'SCREEN OWNER: mvxtra'
    );

    console.log(
      'CHAT TRANSLATION: PERSONAL'
    );

    console.log(
      'MULTIPLAYER: ON'
    );

    console.log(
      'ONLINE USERS: ON'
    );

    console.log(
      'DANCES / EMOTES: ON'
    );

    console.log(
      'USERS FILE: ./users.json'
    );

    console.log(
      '========================================'
    );

    console.log('');
  }
);

function shutdown(){
  console.log(
    'EWS SESSIONS shutting down...'
  );

  try{
    if(nms)
      nms.stop();
  }catch(e){
    console.error(e);
  }

  server.close(
    ()=>process.exit(0)
  );
}

process.on(
  'SIGINT',
  shutdown
);

process.on(
  'SIGTERM',
  shutdown
););
    if(parts.length!==3) return false;
    const salt=parts[1];
    const expected=Buffer.from(parts[2],'hex');
    const actual=crypto.scryptSync(String(password),salt,64);
    return expected.length===actual.length && crypto.timingSafeEqual(expected,actual);
  }
  // Legacy SHA-256 users are accepted once and transparently upgraded on login.
  const legacy=crypto.createHash('sha256').update(String(password)).digest('hex');
  return legacy===value;
}
function upgradeLegacyPassword(user,password){
  if(String(user.password||'').startsWith('scrypt
function cleanUsername(value){return String(value||'').trim().replace(/\s+/g,' ').slice(0,24);}
function isValidUsername(username){return username.length>=2&&username.length<=24&&/^[a-zA-Z0-9_\-а-яА-ЯёЁ ]+$/.test(username);}
function isScreenHost(username){return String(username||'').trim().toLowerCase()===SCREEN_HOST;}
function clamp(v,min,max){return Math.max(min,Math.min(max,v));}

app.get('/api/status',(req,res)=>res.json({ok:true,service:'EWS SESSIONS',online:onlineUsers.size,stream:true}));

app.post('/api/register',(req,res)=>{
  const username=cleanUsername(req.body.username), password=String(req.body.password||'');
  if(!isValidUsername(username)) return res.status(400).json({ok:false,error:'Некорректное имя пользователя.'});
  if(password.length<4) return res.status(400).json({ok:false,error:'Пароль должен быть минимум 4 символа.'});
  const users=readUsers();
  if(users.some(u=>String(u.username).toLowerCase()===username.toLowerCase())) return res.status(409).json({ok:false,error:'Такой пользователь уже существует.'});
  users.push({username,password:hashPassword(password),createdAt:Date.now()}); saveUsers(users);
  res.json({ok:true,username});
});

app.post('/api/login',(req,res)=>{
  const username=cleanUsername(req.body.username), password=String(req.body.password||'');
  const user=readUsers().find(u=>String(u.username).toLowerCase()===username.toLowerCase());
  if(!user) return res.status(401).json({ok:false,error:'Пользователь не найден.'});
  if(user.password!==hashPassword(password)) return res.status(401).json({ok:false,error:'Неверный пароль.'});
  res.json({ok:true,username:user.username});
});

const SUPPORTED_LANGUAGES=new Set(['ru','en','es','de','fr','zh','ja','ko','ar','hi','pt','it','tr','uk','nl','pl']);
const translationCache=new Map();
const MAX_TRANSLATION_CACHE=500;

function normalizeLanguage(value){
  const lang=String(value||'en').trim().toLowerCase();
  return SUPPORTED_LANGUAGES.has(lang)?lang:'en';
}

function httpsGetText(url,timeout=8000){
  return new Promise((resolve,reject)=>{
    const req=https.get(url,{headers:{'User-Agent':'EWS-SESSIONS/1.0'}},res=>{
      let body='';
      res.setEncoding('utf8');
      res.on('data',chunk=>body+=chunk);
      res.on('end',()=>{
        if(res.statusCode>=200&&res.statusCode<300) resolve(body);
        else reject(new Error('HTTP '+res.statusCode));
      });
    });
    req.setTimeout(timeout,()=>req.destroy(new Error('translation timeout')));
    req.on('error',reject);
  });
}

async function translateText(text,targetLanguage){
  if(!text) return '';
  const target=normalizeLanguage(targetLanguage);
  const source=String(text);
  const key=target+'\n'+source;
  if(translationCache.has(key)) return translationCache.get(key);

  try{
    const url='https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl='+encodeURIComponent(target)+'&dt=t&q='+encodeURIComponent(source);
    const raw=await httpsGetText(url);
    const data=JSON.parse(raw);
    const translated=Array.isArray(data)&&Array.isArray(data[0])
      ? data[0].map(part=>Array.isArray(part)?part[0]:'').join('')
      : source;

    if(translationCache.size>=MAX_TRANSLATION_CACHE){
      const firstKey=translationCache.keys().next().value;
      if(firstKey) translationCache.delete(firstKey);
    }
    translationCache.set(key,translated||source);
    return translated||source;
  }catch(e){
    console.error('TRANSLATION ERROR:',e.message);
    return source;
  }
}

app.post('/api/translate',async(req,res)=>{
  const text=String(req.body.text||''), target=String(req.body.target||'en');
  if(!text) return res.json({ok:true,text:''});
  res.json({ok:true,text:await translateText(text,target)});
});

const onlineUsers=new Map();
const players=new Map();
const clubScreenState={active:false,src:'',url:'',name:'',owner:SCREEN_HOST};

const SPAWN_POINTS=[
  {x:0,z:13},
  {x:3,z:10},
  {x:-3,z:10},
  {x:6,z:7},
  {x:-6,z:7},
  {x:8,z:3},
  {x:-8,z:3}
];

function getSpawnPoint(){
  for(const point of SPAWN_POINTS){
    const occupied=[...players.values()].some(
      p=>Math.abs(p.x-point.x)<1.5&&Math.abs(p.z-point.z)<1.5
    );
    if(!occupied) return {x:point.x,z:point.z};
  }
  return {
    x:Math.round(Math.random()*14-7),
    z:Math.round(Math.random()*8+5)
  };
}

function getOnlineUsers(){
  return [...onlineUsers.values()].map(
    u=>({username:u.username,language:u.language})
  );
}

function broadcastOnline(){
  io.emit('online-users',getOnlineUsers());
  io.emit('online',getOnlineUsers());
}

function getPlayers(){
  return [...players.values()].map(p=>({...p}));
}

function sendPlayersSnapshot(socket){
  socket.emit(
    'players-state',
    getPlayers().filter(p=>p.id!==socket.id)
  );
}

io.on('connection',socket=>{
  console.log('SOCKET CONNECT:',socket.id);

  socket.on('join',data=>{
    data=data||{};

    const username=cleanUsername(data.username);
    if(!username) return;

    const language=normalizeLanguage(data.language);

    socket.username=username;
    socket.language=language;

    onlineUsers.set(
      socket.id,
      {
        id:socket.id,
        username,
        language
      }
    );

    const spawn=getSpawnPoint();

    const player={
      id:socket.id,
      username,
      x:spawn.x,
      y:1.7,
      z:spawn.z,
      yaw:0,
      pitch:0,
      moving:false,
      jumping:false,
      dance:0,
      danceStartedAt:0
    };

    players.set(socket.id,player);

    socket.emit(
      'screen-host',
      {
        host:isScreenHost(username),
        username:SCREEN_HOST
      }
    );

    socket.emit('player-spawn',player);

    sendPlayersSnapshot(socket);

    socket.broadcast.emit(
      'player-state',
      player
    );

    broadcastOnline();

    socket.emit(
      'club-screen-state',
      clubScreenState
    );

    socket.emit(
      'online',
      getOnlineUsers()
    );

    console.log(
      'JOIN:',
      username,
      '|',
      language
    );
  });

  socket.on(
    'request-online',
    ()=>socket.emit(
      'online-users',
      getOnlineUsers()
    )
  );

  socket.on(
    'request-players',
    ()=>sendPlayersSnapshot(socket)
  );

  socket.on(
    'request-club-screen',
    ()=>socket.emit(
      'club-screen-state',
      clubScreenState
    )
  );

  socket.on('player-state',data=>{
    const player=players.get(socket.id);
    if(!player) return;

    data=data||{};

    const x=Number(data.x);
    const y=Number(data.y);
    const z=Number(data.z);
    const yaw=Number(data.yaw);
    const pitch=Number(data.pitch);

    if(Number.isFinite(x))
      player.x=clamp(x,-16,16);

    if(Number.isFinite(y))
      player.y=clamp(y,0,8);

    if(Number.isFinite(z))
      player.z=clamp(z,-15.5,15.5);

    if(Number.isFinite(yaw))
      player.yaw=yaw;

    if(Number.isFinite(pitch))
      player.pitch=pitch;

    if(typeof data.moving==='boolean')
      player.moving=data.moving;

    if(typeof data.jumping==='boolean')
      player.jumping=data.jumping;

    if(Number.isFinite(Number(data.dance)))
      player.dance=
        EMOTES.has(Number(data.dance))
          ? Number(data.dance)
          : 0;

    if(Number.isFinite(Number(data.danceStartedAt)))
      player.danceStartedAt=
        Number(data.danceStartedAt)||0;

    socket.broadcast.emit(
      'player-state',
      player
    );
  });

  socket.on('player-move',data=>{
    const player=players.get(socket.id);
    if(!player) return;

    data=data||{};

    if(Number.isFinite(Number(data.x)))
      player.x=clamp(Number(data.x),-16,16);

    if(Number.isFinite(Number(data.y)))
      player.y=clamp(Number(data.y),0,8);

    if(Number.isFinite(Number(data.z)))
      player.z=clamp(Number(data.z),-15.5,15.5);

    if(Number.isFinite(Number(data.yaw)))
      player.yaw=Number(data.yaw);

    if(Number.isFinite(Number(data.pitch)))
      player.pitch=Number(data.pitch);

    socket.broadcast.emit(
      'player-state',
      player
    );
  });

  // =====================================================
  // DANCES / EMOTES
  // =====================================================

  socket.on('player-emote',data=>{
    const player=players.get(socket.id);
    if(!player) return;

    const id=Number(
      data?.dance ??
      data?.emote ??
      0
    );

    player.dance=
      EMOTES.has(id)
        ? id
        : 0;

    player.danceStartedAt=
      player.dance
        ? Date.now()
        : 0;

    io.emit(
      'player-state',
      player
    );
  });

  socket.on('club-screen-state',state=>{
    if(!isScreenHost(socket.username)){
      console.log(
        'SCREEN DENIED:',
        socket.username
      );
      return;
    }

    state=state||{};

    if(
      state.active===true &&
      (
        (typeof state.url==='string'&&state.url.trim()) ||
        (typeof state.src==='string'&&state.src.trim())
      )
    ){
      clubScreenState.active=true;

      clubScreenState.src=
        typeof state.src==='string'
          ? state.src.trim().slice(0,2000)
          : '';

      clubScreenState.url=
        typeof state.url==='string'
          ? state.url.trim().slice(0,2000)
          : '';

      clubScreenState.name=
        String(
          state.name||'MEDIA'
        ).slice(0,100);

    }else{
      clubScreenState.active=false;
      clubScreenState.src='';
      clubScreenState.url='';
      clubScreenState.name='';
    }

    clubScreenState.owner=SCREEN_HOST;

    io.emit(
      'club-screen-state',
      clubScreenState
    );
  });

  socket.on('chat-message',async message=>{
    if(!socket.username) return;

    const original=
      String(message?.text||'')
        .trim()
        .slice(0,500);

    if(!original) return;

    // Every guest receives the same message in THEIR selected language.
    // Translation is done once per unique target language and then reused.

    const recipients=[
      ...onlineUsers.entries()
    ];

    const targetLanguages=[
      ...new Set(
        recipients.map(
          ([,user])=>
            normalizeLanguage(user.language)
        )
      )
    ];

    const translations=new Map();

    await Promise.all(
      targetLanguages.map(
        async targetLanguage=>{
          translations.set(
            targetLanguage,
            await translateText(
              original,
              targetLanguage
            )
          );
        }
      )
    );

    const ts=Date.now();

    for(const [id,user] of recipients){

      const targetSocket=
        io.sockets.sockets.get(id);

      if(!targetSocket) continue;

      const targetLanguage=
        normalizeLanguage(
          user.language
        );

      targetSocket.emit(
        'chat-message',
        {
          user:socket.username,
          username:socket.username,
          text:
            translations.get(
              targetLanguage
            )||original,
          original,
          targetLanguage,
          translated:true,
          ts
        }
      );
    }
  });

  socket.on(
    'language-change',
    language=>{
      if(!socket.username) return;

      socket.language=
        normalizeLanguage(language);

      const user=
        onlineUsers.get(socket.id);

      if(user)
        user.language=
          socket.language;

      socket.emit(
        'language-updated',
        {
          language:
            socket.language
        }
      );

      broadcastOnline();
    }
  );

  socket.on(
    'disconnect',
    reason=>{
      const username=
        socket.username||'unknown';

      onlineUsers.delete(
        socket.id
      );

      players.delete(
        socket.id
      );

      io.emit(
        'player-left',
        socket.id
      );

      io.emit(
        'player-removed',
        socket.id
      );

      broadcastOnline();

      console.log(
        'DISCONNECT:',
        username,
        '|',
        reason
      );
    }
  );
});

const nmsConfig={
  rtmp:{
    port:Number(RTMP_PORT),
    chunk_size:60000,
    gop_cache:true,
    ping:30,
    ping_timeout:60
  },

  http:{
    port:Number(NMS_HTTP_PORT),
    mediaroot:HLS_DIR,
    allow_origin:'*'
  },

  trans:{
    ffmpeg:
      process.env.FFMPEG_PATH||
      'ffmpeg',

    tasks:[
      {
        app:'live',
        hls:true,
        hlsFlags:
          '[hls_time=2:hls_list_size=6:hls_flags=delete_segments+append_list]',
        hlsKeepSegments:6,
        dash:false
      }
    ]
  }
};

let nms=null;

try{
  nms=
    new NodeMediaServer(
      nmsConfig
    );

  nms.run();

  console.log(
    'RTMP SERVER READY'
  );

  console.log(
    `RTMP: rtmp://localhost:${RTMP_PORT}/live`
  );

}catch(error){
  console.error(
    'NODE MEDIA SERVER ERROR:',
    error
  );
}

app.get(
  '/',
  (req,res)=>{
    const index=
      path.join(
        PUBLIC_DIR,
        'index.html'
      );

    if(fs.existsSync(index))
      return res.sendFile(index);

    res.status(404).send(
      'EWS SESSIONS: index.html not found in public folder.'
    );
  }
);

app.use(
  '/api',
  (req,res)=>
    res.status(404).json({
      ok:false,
      error:'API endpoint not found.'
    })
);

app.use(
  (err,req,res,next)=>{
    console.error(
      'EXPRESS ERROR:',
      err
    );

    if(res.headersSent)
      return next(err);

    res.status(500).json({
      ok:false,
      error:'Internal server error.'
    });
  }
);

server.listen(
  PORT,
  '0.0.0.0',
  ()=>{
    console.log('');
    console.log(
      '========================================'
    );
    console.log(
      '        EWS SESSIONS SERVER READY'
    );
    console.log(
      '========================================'
    );

    console.log(
      `WEB:  http://localhost:${PORT}`
    );

    console.log(
      `RTMP: rtmp://localhost:${RTMP_PORT}/live`
    );

    console.log(
      `HLS:  http://localhost:${PORT}/hls/`
    );

    console.log(
      'SCREEN OWNER: mvxtra'
    );

    console.log(
      'CHAT TRANSLATION: PERSONAL'
    );

    console.log(
      'MULTIPLAYER: ON'
    );

    console.log(
      'ONLINE USERS: ON'
    );

    console.log(
      'DANCES / EMOTES: ON'
    );

    console.log(
      'USERS FILE: ./users.json'
    );

    console.log(
      '========================================'
    );

    console.log('');
  }
);

function shutdown(){
  console.log(
    'EWS SESSIONS shutting down...'
  );

  try{
    if(nms)
      nms.stop();
  }catch(e){
    console.error(e);
  }

  server.close(
    ()=>process.exit(0)
  );
}

process.on(
  'SIGINT',
  shutdown
);

process.on(
  'SIGTERM',
  shutdown
);)) return;
  user.password=hashPassword(password);
}
function cleanUsername(value){return String(value||'').trim().replace(/\s+/g,' ').slice(0,24);}
function isValidUsername(username){return username.length>=2&&username.length<=24&&/^[a-zA-Z0-9_\-а-яА-ЯёЁ ]+$/.test(username);}
function isScreenHost(username){return String(username||'').trim().toLowerCase()===SCREEN_HOST;}
function clamp(v,min,max){return Math.max(min,Math.min(max,v));}

app.get('/api/status',(req,res)=>res.json({ok:true,service:'EWS SESSIONS',online:onlineUsers.size,stream:true}));

app.post('/api/register',(req,res)=>{
  const username=cleanUsername(req.body.username), password=String(req.body.password||'');
  if(!isValidUsername(username)) return res.status(400).json({ok:false,error:'Некорректное имя пользователя.'});
  if(password.length<4) return res.status(400).json({ok:false,error:'Пароль должен быть минимум 4 символа.'});
  const users=readUsers();
  if(users.some(u=>String(u.username).toLowerCase()===username.toLowerCase())) return res.status(409).json({ok:false,error:'Такой пользователь уже существует.'});
  users.push({username,password:hashPassword(password),createdAt:Date.now()}); saveUsers(users);
  res.json({ok:true,username});
});

app.post('/api/login',(req,res)=>{
  const username=cleanUsername(req.body.username), password=String(req.body.password||'');
  const user=readUsers().find(u=>String(u.username).toLowerCase()===username.toLowerCase());
  if(!user) return res.status(401).json({ok:false,error:'Пользователь не найден.'});
  if(user.password!==hashPassword(password)) return res.status(401).json({ok:false,error:'Неверный пароль.'});
  res.json({ok:true,username:user.username});
});

const SUPPORTED_LANGUAGES=new Set(['ru','en','es','de','fr','zh','ja','ko','ar','hi','pt','it','tr','uk','nl','pl']);
const translationCache=new Map();
const MAX_TRANSLATION_CACHE=500;

function normalizeLanguage(value){
  const lang=String(value||'en').trim().toLowerCase();
  return SUPPORTED_LANGUAGES.has(lang)?lang:'en';
}

function httpsGetText(url,timeout=8000){
  return new Promise((resolve,reject)=>{
    const req=https.get(url,{headers:{'User-Agent':'EWS-SESSIONS/1.0'}},res=>{
      let body='';
      res.setEncoding('utf8');
      res.on('data',chunk=>body+=chunk);
      res.on('end',()=>{
        if(res.statusCode>=200&&res.statusCode<300) resolve(body);
        else reject(new Error('HTTP '+res.statusCode));
      });
    });
    req.setTimeout(timeout,()=>req.destroy(new Error('translation timeout')));
    req.on('error',reject);
  });
}

async function translateText(text,targetLanguage){
  if(!text) return '';
  const target=normalizeLanguage(targetLanguage);
  const source=String(text);
  const key=target+'\n'+source;
  if(translationCache.has(key)) return translationCache.get(key);

  try{
    const url='https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl='+encodeURIComponent(target)+'&dt=t&q='+encodeURIComponent(source);
    const raw=await httpsGetText(url);
    const data=JSON.parse(raw);
    const translated=Array.isArray(data)&&Array.isArray(data[0])
      ? data[0].map(part=>Array.isArray(part)?part[0]:'').join('')
      : source;

    if(translationCache.size>=MAX_TRANSLATION_CACHE){
      const firstKey=translationCache.keys().next().value;
      if(firstKey) translationCache.delete(firstKey);
    }
    translationCache.set(key,translated||source);
    return translated||source;
  }catch(e){
    console.error('TRANSLATION ERROR:',e.message);
    return source;
  }
}

app.post('/api/translate',async(req,res)=>{
  const text=String(req.body.text||''), target=String(req.body.target||'en');
  if(!text) return res.json({ok:true,text:''});
  res.json({ok:true,text:await translateText(text,target)});
});

const onlineUsers=new Map();
const players=new Map();
const clubScreenState={active:false,src:'',url:'',name:'',owner:SCREEN_HOST};

const SPAWN_POINTS=[
  {x:0,z:13},
  {x:3,z:10},
  {x:-3,z:10},
  {x:6,z:7},
  {x:-6,z:7},
  {x:8,z:3},
  {x:-8,z:3}
];

function getSpawnPoint(){
  for(const point of SPAWN_POINTS){
    const occupied=[...players.values()].some(
      p=>Math.abs(p.x-point.x)<1.5&&Math.abs(p.z-point.z)<1.5
    );
    if(!occupied) return {x:point.x,z:point.z};
  }
  return {
    x:Math.round(Math.random()*14-7),
    z:Math.round(Math.random()*8+5)
  };
}

function getOnlineUsers(){
  return [...onlineUsers.values()].map(
    u=>({username:u.username,language:u.language})
  );
}

function broadcastOnline(){
  io.emit('online-users',getOnlineUsers());
  io.emit('online',getOnlineUsers());
}

function getPlayers(){
  return [...players.values()].map(p=>({...p}));
}

function sendPlayersSnapshot(socket){
  socket.emit(
    'players-state',
    getPlayers().filter(p=>p.id!==socket.id)
  );
}

io.on('connection',socket=>{
  console.log('SOCKET CONNECT:',socket.id);

  socket.on('join',data=>{
    data=data||{};

    const username=cleanUsername(data.username);
    if(!username) return;

    const language=normalizeLanguage(data.language);

    socket.username=username;
    socket.language=language;

    onlineUsers.set(
      socket.id,
      {
        id:socket.id,
        username,
        language
      }
    );

    const spawn=getSpawnPoint();

    const player={
      id:socket.id,
      username,
      x:spawn.x,
      y:1.7,
      z:spawn.z,
      yaw:0,
      pitch:0,
      moving:false,
      jumping:false,
      dance:0,
      danceStartedAt:0
    };

    players.set(socket.id,player);

    socket.emit(
      'screen-host',
      {
        host:isScreenHost(username),
        username:SCREEN_HOST
      }
    );

    socket.emit('player-spawn',player);

    sendPlayersSnapshot(socket);

    socket.broadcast.emit(
      'player-state',
      player
    );

    broadcastOnline();

    socket.emit(
      'club-screen-state',
      clubScreenState
    );

    socket.emit(
      'online',
      getOnlineUsers()
    );

    console.log(
      'JOIN:',
      username,
      '|',
      language
    );
  });

  socket.on(
    'request-online',
    ()=>socket.emit(
      'online-users',
      getOnlineUsers()
    )
  );

  socket.on(
    'request-players',
    ()=>sendPlayersSnapshot(socket)
  );

  socket.on(
    'request-club-screen',
    ()=>socket.emit(
      'club-screen-state',
      clubScreenState
    )
  );

  socket.on('player-state',data=>{
    const player=players.get(socket.id);
    if(!player) return;

    data=data||{};

    const x=Number(data.x);
    const y=Number(data.y);
    const z=Number(data.z);
    const yaw=Number(data.yaw);
    const pitch=Number(data.pitch);

    if(Number.isFinite(x))
      player.x=clamp(x,-16,16);

    if(Number.isFinite(y))
      player.y=clamp(y,0,8);

    if(Number.isFinite(z))
      player.z=clamp(z,-15.5,15.5);

    if(Number.isFinite(yaw))
      player.yaw=yaw;

    if(Number.isFinite(pitch))
      player.pitch=pitch;

    if(typeof data.moving==='boolean')
      player.moving=data.moving;

    if(typeof data.jumping==='boolean')
      player.jumping=data.jumping;

    if(Number.isFinite(Number(data.dance)))
      player.dance=
        EMOTES.has(Number(data.dance))
          ? Number(data.dance)
          : 0;

    if(Number.isFinite(Number(data.danceStartedAt)))
      player.danceStartedAt=
        Number(data.danceStartedAt)||0;

    socket.broadcast.emit(
      'player-state',
      player
    );
  });

  socket.on('player-move',data=>{
    const player=players.get(socket.id);
    if(!player) return;

    data=data||{};

    if(Number.isFinite(Number(data.x)))
      player.x=clamp(Number(data.x),-16,16);

    if(Number.isFinite(Number(data.y)))
      player.y=clamp(Number(data.y),0,8);

    if(Number.isFinite(Number(data.z)))
      player.z=clamp(Number(data.z),-15.5,15.5);

    if(Number.isFinite(Number(data.yaw)))
      player.yaw=Number(data.yaw);

    if(Number.isFinite(Number(data.pitch)))
      player.pitch=Number(data.pitch);

    socket.broadcast.emit(
      'player-state',
      player
    );
  });

  // =====================================================
  // DANCES / EMOTES
  // =====================================================

  socket.on('player-emote',data=>{
    const player=players.get(socket.id);
    if(!player) return;

    const id=Number(
      data?.dance ??
      data?.emote ??
      0
    );

    player.dance=
      EMOTES.has(id)
        ? id
        : 0;

    player.danceStartedAt=
      player.dance
        ? Date.now()
        : 0;

    io.emit(
      'player-state',
      player
    );
  });

  socket.on('club-screen-state',state=>{
    if(!isScreenHost(socket.username)){
      console.log(
        'SCREEN DENIED:',
        socket.username
      );
      return;
    }

    state=state||{};

    if(
      state.active===true &&
      (
        (typeof state.url==='string'&&state.url.trim()) ||
        (typeof state.src==='string'&&state.src.trim())
      )
    ){
      clubScreenState.active=true;

      clubScreenState.src=
        typeof state.src==='string'
          ? state.src.trim().slice(0,2000)
          : '';

      clubScreenState.url=
        typeof state.url==='string'
          ? state.url.trim().slice(0,2000)
          : '';

      clubScreenState.name=
        String(
          state.name||'MEDIA'
        ).slice(0,100);

    }else{
      clubScreenState.active=false;
      clubScreenState.src='';
      clubScreenState.url='';
      clubScreenState.name='';
    }

    clubScreenState.owner=SCREEN_HOST;

    io.emit(
      'club-screen-state',
      clubScreenState
    );
  });

  socket.on('chat-message',async message=>{
    if(!socket.username) return;

    const original=
      String(message?.text||'')
        .trim()
        .slice(0,500);

    if(!original) return;

    // Every guest receives the same message in THEIR selected language.
    // Translation is done once per unique target language and then reused.

    const recipients=[
      ...onlineUsers.entries()
    ];

    const targetLanguages=[
      ...new Set(
        recipients.map(
          ([,user])=>
            normalizeLanguage(user.language)
        )
      )
    ];

    const translations=new Map();

    await Promise.all(
      targetLanguages.map(
        async targetLanguage=>{
          translations.set(
            targetLanguage,
            await translateText(
              original,
              targetLanguage
            )
          );
        }
      )
    );

    const ts=Date.now();

    for(const [id,user] of recipients){

      const targetSocket=
        io.sockets.sockets.get(id);

      if(!targetSocket) continue;

      const targetLanguage=
        normalizeLanguage(
          user.language
        );

      targetSocket.emit(
        'chat-message',
        {
          user:socket.username,
          username:socket.username,
          text:
            translations.get(
              targetLanguage
            )||original,
          original,
          targetLanguage,
          translated:true,
          ts
        }
      );
    }
  });

  socket.on(
    'language-change',
    language=>{
      if(!socket.username) return;

      socket.language=
        normalizeLanguage(language);

      const user=
        onlineUsers.get(socket.id);

      if(user)
        user.language=
          socket.language;

      socket.emit(
        'language-updated',
        {
          language:
            socket.language
        }
      );

      broadcastOnline();
    }
  );

  socket.on(
    'disconnect',
    reason=>{
      const username=
        socket.username||'unknown';

      onlineUsers.delete(
        socket.id
      );

      players.delete(
        socket.id
      );

      io.emit(
        'player-left',
        socket.id
      );

      io.emit(
        'player-removed',
        socket.id
      );

      broadcastOnline();

      console.log(
        'DISCONNECT:',
        username,
        '|',
        reason
      );
    }
  );
});

const nmsConfig={
  rtmp:{
    port:Number(RTMP_PORT),
    chunk_size:60000,
    gop_cache:true,
    ping:30,
    ping_timeout:60
  },

  http:{
    port:Number(NMS_HTTP_PORT),
    mediaroot:HLS_DIR,
    allow_origin:'*'
  },

  trans:{
    ffmpeg:
      process.env.FFMPEG_PATH||
      'ffmpeg',

    tasks:[
      {
        app:'live',
        hls:true,
        hlsFlags:
          '[hls_time=2:hls_list_size=6:hls_flags=delete_segments+append_list]',
        hlsKeepSegments:6,
        dash:false
      }
    ]
  }
};

let nms=null;

try{
  nms=
    new NodeMediaServer(
      nmsConfig
    );

  nms.run();

  console.log(
    'RTMP SERVER READY'
  );

  console.log(
    `RTMP: rtmp://localhost:${RTMP_PORT}/live`
  );

}catch(error){
  console.error(
    'NODE MEDIA SERVER ERROR:',
    error
  );
}

app.get(
  '/',
  (req,res)=>{
    const index=
      path.join(
        PUBLIC_DIR,
        'index.html'
      );

    if(fs.existsSync(index))
      return res.sendFile(index);

    res.status(404).send(
      'EWS SESSIONS: index.html not found in public folder.'
    );
  }
);

app.use(
  '/api',
  (req,res)=>
    res.status(404).json({
      ok:false,
      error:'API endpoint not found.'
    })
);

app.use(
  (err,req,res,next)=>{
    console.error(
      'EXPRESS ERROR:',
      err
    );

    if(res.headersSent)
      return next(err);

    res.status(500).json({
      ok:false,
      error:'Internal server error.'
    });
  }
);

server.listen(
  PORT,
  '0.0.0.0',
  ()=>{
    console.log('');
    console.log(
      '========================================'
    );
    console.log(
      '        EWS SESSIONS SERVER READY'
    );
    console.log(
      '========================================'
    );

    console.log(
      `WEB:  http://localhost:${PORT}`
    );

    console.log(
      `RTMP: rtmp://localhost:${RTMP_PORT}/live`
    );

    console.log(
      `HLS:  http://localhost:${PORT}/hls/`
    );

    console.log(
      'SCREEN OWNER: mvxtra'
    );

    console.log(
      'CHAT TRANSLATION: PERSONAL'
    );

    console.log(
      'MULTIPLAYER: ON'
    );

    console.log(
      'ONLINE USERS: ON'
    );

    console.log(
      'DANCES / EMOTES: ON'
    );

    console.log(
      'USERS FILE: ./users.json'
    );

    console.log(
      '========================================'
    );

    console.log('');
  }
);

function shutdown(){
  console.log(
    'EWS SESSIONS shutting down...'
  );

  try{
    if(nms)
      nms.stop();
  }catch(e){
    console.error(e);
  }

  server.close(
    ()=>process.exit(0)
  );
}

process.on(
  'SIGINT',
  shutdown
);

process.on(
  'SIGTERM',
  shutdown
);)){
    upgradeLegacyPassword(storedUser,password);
    saveUsers(users);
  }
  res.json({ok:true,username:user.username});
});

const SUPPORTED_LANGUAGES=new Set(['ru','en','es','de','fr','zh','ja','ko','ar','hi','pt','it','tr','uk','nl','pl']);
const translationCache=new Map();
const MAX_TRANSLATION_CACHE=500;

function normalizeLanguage(value){
  const lang=String(value||'en').trim().toLowerCase();
  return SUPPORTED_LANGUAGES.has(lang)?lang:'en';
}

function httpsGetText(url,timeout=8000){
  return new Promise((resolve,reject)=>{
    const req=https.get(url,{headers:{'User-Agent':'EWS-SESSIONS/1.0'}},res=>{
      let body='';
      res.setEncoding('utf8');
      res.on('data',chunk=>body+=chunk);
      res.on('end',()=>{
        if(res.statusCode>=200&&res.statusCode<300) resolve(body);
        else reject(new Error('HTTP '+res.statusCode));
      });
    });
    req.setTimeout(timeout,()=>req.destroy(new Error('translation timeout')));
    req.on('error',reject);
  });
}

async function translateText(text,targetLanguage){
  if(!text) return '';
  const target=normalizeLanguage(targetLanguage);
  const source=String(text);
  const key=target+'\n'+source;
  if(translationCache.has(key)) return translationCache.get(key);

  try{
    const url='https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl='+encodeURIComponent(target)+'&dt=t&q='+encodeURIComponent(source);
    const raw=await httpsGetText(url);
    const data=JSON.parse(raw);
    const translated=Array.isArray(data)&&Array.isArray(data[0])
      ? data[0].map(part=>Array.isArray(part)?part[0]:'').join('')
      : source;

    if(translationCache.size>=MAX_TRANSLATION_CACHE){
      const firstKey=translationCache.keys().next().value;
      if(firstKey) translationCache.delete(firstKey);
    }
    translationCache.set(key,translated||source);
    return translated||source;
  }catch(e){
    console.error('TRANSLATION ERROR:',e.message);
    return source;
  }
}

app.post('/api/translate',async(req,res)=>{
  const text=String(req.body.text||''), target=String(req.body.target||'en');
  if(!text) return res.json({ok:true,text:''});
  res.json({ok:true,text:await translateText(text,target)});
});

const onlineUsers=new Map();
const players=new Map();
const clubScreenState={active:false,src:'',url:'',name:'',owner:SCREEN_HOST};

const SPAWN_POINTS=[
  {x:0,z:13},
  {x:3,z:10},
  {x:-3,z:10},
  {x:6,z:7},
  {x:-6,z:7},
  {x:8,z:3},
  {x:-8,z:3}
];

function getSpawnPoint(){
  for(const point of SPAWN_POINTS){
    const occupied=[...players.values()].some(
      p=>Math.abs(p.x-point.x)<1.5&&Math.abs(p.z-point.z)<1.5
    );
    if(!occupied) return {x:point.x,z:point.z};
  }
  return {
    x:Math.round(Math.random()*14-7),
    z:Math.round(Math.random()*8+5)
  };
}

function getOnlineUsers(){
  return [...onlineUsers.values()].map(
    u=>({username:u.username,language:u.language})
  );
}

function broadcastOnline(){
  io.emit('online-users',getOnlineUsers());
  io.emit('online',getOnlineUsers());
}

function getPlayers(){
  return [...players.values()].map(p=>({...p}));
}

function sendPlayersSnapshot(socket){
  socket.emit(
    'players-state',
    getPlayers().filter(p=>p.id!==socket.id)
  );
}

io.on('connection',socket=>{
  console.log('SOCKET CONNECT:',socket.id);

  socket.on('join',data=>{
    data=data||{};

    const username=cleanUsername(data.username);
    if(!username) return;

    const language=normalizeLanguage(data.language);

    socket.username=username;
    socket.language=language;

    onlineUsers.set(
      socket.id,
      {
        id:socket.id,
        username,
        language
      }
    );

    const spawn=getSpawnPoint();

    const player={
      id:socket.id,
      username,
      x:spawn.x,
      y:1.7,
      z:spawn.z,
      yaw:0,
      pitch:0,
      moving:false,
      jumping:false,
      dance:0,
      danceStartedAt:0
    };

    players.set(socket.id,player);

    socket.emit(
      'screen-host',
      {
        host:isScreenHost(username),
        username:SCREEN_HOST
      }
    );

    socket.emit('player-spawn',player);

    sendPlayersSnapshot(socket);

    socket.broadcast.emit(
      'player-state',
      player
    );

    broadcastOnline();

    socket.emit(
      'club-screen-state',
      clubScreenState
    );

    socket.emit(
      'online',
      getOnlineUsers()
    );

    console.log(
      'JOIN:',
      username,
      '|',
      language
    );
  });

  socket.on(
    'request-online',
    ()=>socket.emit(
      'online-users',
      getOnlineUsers()
    )
  );

  socket.on(
    'request-players',
    ()=>sendPlayersSnapshot(socket)
  );

  socket.on(
    'request-club-screen',
    ()=>socket.emit(
      'club-screen-state',
      clubScreenState
    )
  );

  socket.on('player-state',data=>{
    const player=players.get(socket.id);
    if(!player) return;

    data=data||{};

    const x=Number(data.x);
    const y=Number(data.y);
    const z=Number(data.z);
    const yaw=Number(data.yaw);
    const pitch=Number(data.pitch);

    if(Number.isFinite(x))
      player.x=clamp(x,-16,16);

    if(Number.isFinite(y))
      player.y=clamp(y,0,8);

    if(Number.isFinite(z))
      player.z=clamp(z,-15.5,15.5);

    if(Number.isFinite(yaw))
      player.yaw=yaw;

    if(Number.isFinite(pitch))
      player.pitch=pitch;

    if(typeof data.moving==='boolean')
      player.moving=data.moving;

    if(typeof data.jumping==='boolean')
      player.jumping=data.jumping;

    if(Number.isFinite(Number(data.dance)))
      player.dance=
        EMOTES.has(Number(data.dance))
          ? Number(data.dance)
          : 0;

    if(Number.isFinite(Number(data.danceStartedAt)))
      player.danceStartedAt=
        Number(data.danceStartedAt)||0;

    socket.broadcast.emit(
      'player-state',
      player
    );
  });

  socket.on('player-move',data=>{
    const player=players.get(socket.id);
    if(!player) return;

    data=data||{};

    if(Number.isFinite(Number(data.x)))
      player.x=clamp(Number(data.x),-16,16);

    if(Number.isFinite(Number(data.y)))
      player.y=clamp(Number(data.y),0,8);

    if(Number.isFinite(Number(data.z)))
      player.z=clamp(Number(data.z),-15.5,15.5);

    if(Number.isFinite(Number(data.yaw)))
      player.yaw=Number(data.yaw);

    if(Number.isFinite(Number(data.pitch)))
      player.pitch=Number(data.pitch);

    socket.broadcast.emit(
      'player-state',
      player
    );
  });

  // =====================================================
  // DANCES / EMOTES
  // =====================================================

  socket.on('player-emote',data=>{
    const player=players.get(socket.id);
    if(!player) return;

    const id=Number(
      data?.dance ??
      data?.emote ??
      0
    );

    player.dance=
      EMOTES.has(id)
        ? id
        : 0;

    player.danceStartedAt=
      player.dance
        ? Date.now()
        : 0;

    io.emit(
      'player-state',
      player
    );
  });

  socket.on('club-screen-state',state=>{
    if(!isScreenHost(socket.username)){
      console.log(
        'SCREEN DENIED:',
        socket.username
      );
      return;
    }

    state=state||{};

    if(
      state.active===true &&
      (
        (typeof state.url==='string'&&state.url.trim()) ||
        (typeof state.src==='string'&&state.src.trim())
      )
    ){
      clubScreenState.active=true;

      clubScreenState.src=
        typeof state.src==='string'
          ? state.src.trim().slice(0,2000)
          : '';

      clubScreenState.url=
        typeof state.url==='string'
          ? state.url.trim().slice(0,2000)
          : '';

      clubScreenState.name=
        String(
          state.name||'MEDIA'
        ).slice(0,100);

    }else{
      clubScreenState.active=false;
      clubScreenState.src='';
      clubScreenState.url='';
      clubScreenState.name='';
    }

    clubScreenState.owner=SCREEN_HOST;

    io.emit(
      'club-screen-state',
      clubScreenState
    );
  });

  socket.on('chat-message',async message=>{
    if(!socket.username) return;

    const original=
      String(message?.text||'')
        .trim()
        .slice(0,500);

    if(!original) return;

    // Every guest receives the same message in THEIR selected language.
    // Translation is done once per unique target language and then reused.

    const recipients=[
      ...onlineUsers.entries()
    ];

    const targetLanguages=[
      ...new Set(
        recipients.map(
          ([,user])=>
            normalizeLanguage(user.language)
        )
      )
    ];

    const translations=new Map();

    await Promise.all(
      targetLanguages.map(
        async targetLanguage=>{
          translations.set(
            targetLanguage,
            await translateText(
              original,
              targetLanguage
            )
          );
        }
      )
    );

    const ts=Date.now();

    for(const [id,user] of recipients){

      const targetSocket=
        io.sockets.sockets.get(id);

      if(!targetSocket) continue;

      const targetLanguage=
        normalizeLanguage(
          user.language
        );

      targetSocket.emit(
        'chat-message',
        {
          user:socket.username,
          username:socket.username,
          text:
            translations.get(
              targetLanguage
            )||original,
          original,
          targetLanguage,
          translated:true,
          ts
        }
      );
    }
  });

  socket.on(
    'language-change',
    language=>{
      if(!socket.username) return;

      socket.language=
        normalizeLanguage(language);

      const user=
        onlineUsers.get(socket.id);

      if(user)
        user.language=
          socket.language;

      socket.emit(
        'language-updated',
        {
          language:
            socket.language
        }
      );

      broadcastOnline();
    }
  );

  socket.on(
    'disconnect',
    reason=>{
      const username=
        socket.username||'unknown';

      onlineUsers.delete(
        socket.id
      );

      players.delete(
        socket.id
      );

      io.emit(
        'player-left',
        socket.id
      );

      io.emit(
        'player-removed',
        socket.id
      );

      broadcastOnline();

      console.log(
        'DISCONNECT:',
        username,
        '|',
        reason
      );
    }
  );
});

const nmsConfig={
  rtmp:{
    port:Number(RTMP_PORT),
    chunk_size:60000,
    gop_cache:true,
    ping:30,
    ping_timeout:60
  },

  http:{
    port:Number(NMS_HTTP_PORT),
    mediaroot:HLS_DIR,
    allow_origin:'*'
  },

  trans:{
    ffmpeg:
      process.env.FFMPEG_PATH||
      'ffmpeg',

    tasks:[
      {
        app:'live',
        hls:true,
        hlsFlags:
          '[hls_time=2:hls_list_size=6:hls_flags=delete_segments+append_list]',
        hlsKeepSegments:6,
        dash:false
      }
    ]
  }
};

let nms=null;

try{
  nms=
    new NodeMediaServer(
      nmsConfig
    );

  nms.run();

  console.log(
    'RTMP SERVER READY'
  );

  console.log(
    `RTMP: rtmp://localhost:${RTMP_PORT}/live`
  );

}catch(error){
  console.error(
    'NODE MEDIA SERVER ERROR:',
    error
  );
}

app.get(
  '/',
  (req,res)=>{
    const index=
      path.join(
        PUBLIC_DIR,
        'index.html'
      );

    if(fs.existsSync(index))
      return res.sendFile(index);

    res.status(404).send(
      'EWS SESSIONS: index.html not found in public folder.'
    );
  }
);

app.use(
  '/api',
  (req,res)=>
    res.status(404).json({
      ok:false,
      error:'API endpoint not found.'
    })
);

app.use(
  (err,req,res,next)=>{
    console.error(
      'EXPRESS ERROR:',
      err
    );

    if(res.headersSent)
      return next(err);

    res.status(500).json({
      ok:false,
      error:'Internal server error.'
    });
  }
);

server.listen(
  PORT,
  '0.0.0.0',
  ()=>{
    console.log('');
    console.log(
      '========================================'
    );
    console.log(
      '        EWS SESSIONS SERVER READY'
    );
    console.log(
      '========================================'
    );

    console.log(
      `WEB:  http://localhost:${PORT}`
    );

    console.log(
      `RTMP: rtmp://localhost:${RTMP_PORT}/live`
    );

    console.log(
      `HLS:  http://localhost:${PORT}/hls/`
    );

    console.log(
      'SCREEN OWNER: mvxtra'
    );

    console.log(
      'CHAT TRANSLATION: PERSONAL'
    );

    console.log(
      'MULTIPLAYER: ON'
    );

    console.log(
      'ONLINE USERS: ON'
    );

    console.log(
      'DANCES / EMOTES: ON'
    );

    console.log(
      'USERS FILE: ./users.json'
    );

    console.log(
      '========================================'
    );

    console.log('');
  }
);

function shutdown(){
  console.log(
    'EWS SESSIONS shutting down...'
  );

  try{
    if(nms)
      nms.stop();
  }catch(e){
    console.error(e);
  }

  server.close(
    ()=>process.exit(0)
  );
}

process.on(
  'SIGINT',
  shutdown
);

process.on(
  'SIGTERM',
  shutdown
);+salt+'
function cleanUsername(value){return String(value||'').trim().replace(/\s+/g,' ').slice(0,24);}
function isValidUsername(username){return username.length>=2&&username.length<=24&&/^[a-zA-Z0-9_\-а-яА-ЯёЁ ]+$/.test(username);}
function isScreenHost(username){return String(username||'').trim().toLowerCase()===SCREEN_HOST;}
function clamp(v,min,max){return Math.max(min,Math.min(max,v));}

app.get('/api/status',(req,res)=>res.json({ok:true,service:'EWS SESSIONS',online:onlineUsers.size,stream:true}));

app.post('/api/register',(req,res)=>{
  const username=cleanUsername(req.body.username), password=String(req.body.password||'');
  if(!isValidUsername(username)) return res.status(400).json({ok:false,error:'Некорректное имя пользователя.'});
  if(password.length<4) return res.status(400).json({ok:false,error:'Пароль должен быть минимум 4 символа.'});
  const users=readUsers();
  if(users.some(u=>String(u.username).toLowerCase()===username.toLowerCase())) return res.status(409).json({ok:false,error:'Такой пользователь уже существует.'});
  users.push({username,password:hashPassword(password),createdAt:Date.now()}); saveUsers(users);
  res.json({ok:true,username});
});

app.post('/api/login',(req,res)=>{
  const username=cleanUsername(req.body.username), password=String(req.body.password||'');
  const user=readUsers().find(u=>String(u.username).toLowerCase()===username.toLowerCase());
  if(!user) return res.status(401).json({ok:false,error:'Пользователь не найден.'});
  if(user.password!==hashPassword(password)) return res.status(401).json({ok:false,error:'Неверный пароль.'});
  res.json({ok:true,username:user.username});
});

const SUPPORTED_LANGUAGES=new Set(['ru','en','es','de','fr','zh','ja','ko','ar','hi','pt','it','tr','uk','nl','pl']);
const translationCache=new Map();
const MAX_TRANSLATION_CACHE=500;

function normalizeLanguage(value){
  const lang=String(value||'en').trim().toLowerCase();
  return SUPPORTED_LANGUAGES.has(lang)?lang:'en';
}

function httpsGetText(url,timeout=8000){
  return new Promise((resolve,reject)=>{
    const req=https.get(url,{headers:{'User-Agent':'EWS-SESSIONS/1.0'}},res=>{
      let body='';
      res.setEncoding('utf8');
      res.on('data',chunk=>body+=chunk);
      res.on('end',()=>{
        if(res.statusCode>=200&&res.statusCode<300) resolve(body);
        else reject(new Error('HTTP '+res.statusCode));
      });
    });
    req.setTimeout(timeout,()=>req.destroy(new Error('translation timeout')));
    req.on('error',reject);
  });
}

async function translateText(text,targetLanguage){
  if(!text) return '';
  const target=normalizeLanguage(targetLanguage);
  const source=String(text);
  const key=target+'\n'+source;
  if(translationCache.has(key)) return translationCache.get(key);

  try{
    const url='https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl='+encodeURIComponent(target)+'&dt=t&q='+encodeURIComponent(source);
    const raw=await httpsGetText(url);
    const data=JSON.parse(raw);
    const translated=Array.isArray(data)&&Array.isArray(data[0])
      ? data[0].map(part=>Array.isArray(part)?part[0]:'').join('')
      : source;

    if(translationCache.size>=MAX_TRANSLATION_CACHE){
      const firstKey=translationCache.keys().next().value;
      if(firstKey) translationCache.delete(firstKey);
    }
    translationCache.set(key,translated||source);
    return translated||source;
  }catch(e){
    console.error('TRANSLATION ERROR:',e.message);
    return source;
  }
}

app.post('/api/translate',async(req,res)=>{
  const text=String(req.body.text||''), target=String(req.body.target||'en');
  if(!text) return res.json({ok:true,text:''});
  res.json({ok:true,text:await translateText(text,target)});
});

const onlineUsers=new Map();
const players=new Map();
const clubScreenState={active:false,src:'',url:'',name:'',owner:SCREEN_HOST};

const SPAWN_POINTS=[
  {x:0,z:13},
  {x:3,z:10},
  {x:-3,z:10},
  {x:6,z:7},
  {x:-6,z:7},
  {x:8,z:3},
  {x:-8,z:3}
];

function getSpawnPoint(){
  for(const point of SPAWN_POINTS){
    const occupied=[...players.values()].some(
      p=>Math.abs(p.x-point.x)<1.5&&Math.abs(p.z-point.z)<1.5
    );
    if(!occupied) return {x:point.x,z:point.z};
  }
  return {
    x:Math.round(Math.random()*14-7),
    z:Math.round(Math.random()*8+5)
  };
}

function getOnlineUsers(){
  return [...onlineUsers.values()].map(
    u=>({username:u.username,language:u.language})
  );
}

function broadcastOnline(){
  io.emit('online-users',getOnlineUsers());
  io.emit('online',getOnlineUsers());
}

function getPlayers(){
  return [...players.values()].map(p=>({...p}));
}

function sendPlayersSnapshot(socket){
  socket.emit(
    'players-state',
    getPlayers().filter(p=>p.id!==socket.id)
  );
}

io.on('connection',socket=>{
  console.log('SOCKET CONNECT:',socket.id);

  socket.on('join',data=>{
    data=data||{};

    const username=cleanUsername(data.username);
    if(!username) return;

    const language=normalizeLanguage(data.language);

    socket.username=username;
    socket.language=language;

    onlineUsers.set(
      socket.id,
      {
        id:socket.id,
        username,
        language
      }
    );

    const spawn=getSpawnPoint();

    const player={
      id:socket.id,
      username,
      x:spawn.x,
      y:1.7,
      z:spawn.z,
      yaw:0,
      pitch:0,
      moving:false,
      jumping:false,
      dance:0,
      danceStartedAt:0
    };

    players.set(socket.id,player);

    socket.emit(
      'screen-host',
      {
        host:isScreenHost(username),
        username:SCREEN_HOST
      }
    );

    socket.emit('player-spawn',player);

    sendPlayersSnapshot(socket);

    socket.broadcast.emit(
      'player-state',
      player
    );

    broadcastOnline();

    socket.emit(
      'club-screen-state',
      clubScreenState
    );

    socket.emit(
      'online',
      getOnlineUsers()
    );

    console.log(
      'JOIN:',
      username,
      '|',
      language
    );
  });

  socket.on(
    'request-online',
    ()=>socket.emit(
      'online-users',
      getOnlineUsers()
    )
  );

  socket.on(
    'request-players',
    ()=>sendPlayersSnapshot(socket)
  );

  socket.on(
    'request-club-screen',
    ()=>socket.emit(
      'club-screen-state',
      clubScreenState
    )
  );

  socket.on('player-state',data=>{
    const player=players.get(socket.id);
    if(!player) return;

    data=data||{};

    const x=Number(data.x);
    const y=Number(data.y);
    const z=Number(data.z);
    const yaw=Number(data.yaw);
    const pitch=Number(data.pitch);

    if(Number.isFinite(x))
      player.x=clamp(x,-16,16);

    if(Number.isFinite(y))
      player.y=clamp(y,0,8);

    if(Number.isFinite(z))
      player.z=clamp(z,-15.5,15.5);

    if(Number.isFinite(yaw))
      player.yaw=yaw;

    if(Number.isFinite(pitch))
      player.pitch=pitch;

    if(typeof data.moving==='boolean')
      player.moving=data.moving;

    if(typeof data.jumping==='boolean')
      player.jumping=data.jumping;

    if(Number.isFinite(Number(data.dance)))
      player.dance=
        EMOTES.has(Number(data.dance))
          ? Number(data.dance)
          : 0;

    if(Number.isFinite(Number(data.danceStartedAt)))
      player.danceStartedAt=
        Number(data.danceStartedAt)||0;

    socket.broadcast.emit(
      'player-state',
      player
    );
  });

  socket.on('player-move',data=>{
    const player=players.get(socket.id);
    if(!player) return;

    data=data||{};

    if(Number.isFinite(Number(data.x)))
      player.x=clamp(Number(data.x),-16,16);

    if(Number.isFinite(Number(data.y)))
      player.y=clamp(Number(data.y),0,8);

    if(Number.isFinite(Number(data.z)))
      player.z=clamp(Number(data.z),-15.5,15.5);

    if(Number.isFinite(Number(data.yaw)))
      player.yaw=Number(data.yaw);

    if(Number.isFinite(Number(data.pitch)))
      player.pitch=Number(data.pitch);

    socket.broadcast.emit(
      'player-state',
      player
    );
  });

  // =====================================================
  // DANCES / EMOTES
  // =====================================================

  socket.on('player-emote',data=>{
    const player=players.get(socket.id);
    if(!player) return;

    const id=Number(
      data?.dance ??
      data?.emote ??
      0
    );

    player.dance=
      EMOTES.has(id)
        ? id
        : 0;

    player.danceStartedAt=
      player.dance
        ? Date.now()
        : 0;

    io.emit(
      'player-state',
      player
    );
  });

  socket.on('club-screen-state',state=>{
    if(!isScreenHost(socket.username)){
      console.log(
        'SCREEN DENIED:',
        socket.username
      );
      return;
    }

    state=state||{};

    if(
      state.active===true &&
      (
        (typeof state.url==='string'&&state.url.trim()) ||
        (typeof state.src==='string'&&state.src.trim())
      )
    ){
      clubScreenState.active=true;

      clubScreenState.src=
        typeof state.src==='string'
          ? state.src.trim().slice(0,2000)
          : '';

      clubScreenState.url=
        typeof state.url==='string'
          ? state.url.trim().slice(0,2000)
          : '';

      clubScreenState.name=
        String(
          state.name||'MEDIA'
        ).slice(0,100);

    }else{
      clubScreenState.active=false;
      clubScreenState.src='';
      clubScreenState.url='';
      clubScreenState.name='';
    }

    clubScreenState.owner=SCREEN_HOST;

    io.emit(
      'club-screen-state',
      clubScreenState
    );
  });

  socket.on('chat-message',async message=>{
    if(!socket.username) return;

    const original=
      String(message?.text||'')
        .trim()
        .slice(0,500);

    if(!original) return;

    // Every guest receives the same message in THEIR selected language.
    // Translation is done once per unique target language and then reused.

    const recipients=[
      ...onlineUsers.entries()
    ];

    const targetLanguages=[
      ...new Set(
        recipients.map(
          ([,user])=>
            normalizeLanguage(user.language)
        )
      )
    ];

    const translations=new Map();

    await Promise.all(
      targetLanguages.map(
        async targetLanguage=>{
          translations.set(
            targetLanguage,
            await translateText(
              original,
              targetLanguage
            )
          );
        }
      )
    );

    const ts=Date.now();

    for(const [id,user] of recipients){

      const targetSocket=
        io.sockets.sockets.get(id);

      if(!targetSocket) continue;

      const targetLanguage=
        normalizeLanguage(
          user.language
        );

      targetSocket.emit(
        'chat-message',
        {
          user:socket.username,
          username:socket.username,
          text:
            translations.get(
              targetLanguage
            )||original,
          original,
          targetLanguage,
          translated:true,
          ts
        }
      );
    }
  });

  socket.on(
    'language-change',
    language=>{
      if(!socket.username) return;

      socket.language=
        normalizeLanguage(language);

      const user=
        onlineUsers.get(socket.id);

      if(user)
        user.language=
          socket.language;

      socket.emit(
        'language-updated',
        {
          language:
            socket.language
        }
      );

      broadcastOnline();
    }
  );

  socket.on(
    'disconnect',
    reason=>{
      const username=
        socket.username||'unknown';

      onlineUsers.delete(
        socket.id
      );

      players.delete(
        socket.id
      );

      io.emit(
        'player-left',
        socket.id
      );

      io.emit(
        'player-removed',
        socket.id
      );

      broadcastOnline();

      console.log(
        'DISCONNECT:',
        username,
        '|',
        reason
      );
    }
  );
});

const nmsConfig={
  rtmp:{
    port:Number(RTMP_PORT),
    chunk_size:60000,
    gop_cache:true,
    ping:30,
    ping_timeout:60
  },

  http:{
    port:Number(NMS_HTTP_PORT),
    mediaroot:HLS_DIR,
    allow_origin:'*'
  },

  trans:{
    ffmpeg:
      process.env.FFMPEG_PATH||
      'ffmpeg',

    tasks:[
      {
        app:'live',
        hls:true,
        hlsFlags:
          '[hls_time=2:hls_list_size=6:hls_flags=delete_segments+append_list]',
        hlsKeepSegments:6,
        dash:false
      }
    ]
  }
};

let nms=null;

try{
  nms=
    new NodeMediaServer(
      nmsConfig
    );

  nms.run();

  console.log(
    'RTMP SERVER READY'
  );

  console.log(
    `RTMP: rtmp://localhost:${RTMP_PORT}/live`
  );

}catch(error){
  console.error(
    'NODE MEDIA SERVER ERROR:',
    error
  );
}

app.get(
  '/',
  (req,res)=>{
    const index=
      path.join(
        PUBLIC_DIR,
        'index.html'
      );

    if(fs.existsSync(index))
      return res.sendFile(index);

    res.status(404).send(
      'EWS SESSIONS: index.html not found in public folder.'
    );
  }
);

app.use(
  '/api',
  (req,res)=>
    res.status(404).json({
      ok:false,
      error:'API endpoint not found.'
    })
);

app.use(
  (err,req,res,next)=>{
    console.error(
      'EXPRESS ERROR:',
      err
    );

    if(res.headersSent)
      return next(err);

    res.status(500).json({
      ok:false,
      error:'Internal server error.'
    });
  }
);

server.listen(
  PORT,
  '0.0.0.0',
  ()=>{
    console.log('');
    console.log(
      '========================================'
    );
    console.log(
      '        EWS SESSIONS SERVER READY'
    );
    console.log(
      '========================================'
    );

    console.log(
      `WEB:  http://localhost:${PORT}`
    );

    console.log(
      `RTMP: rtmp://localhost:${RTMP_PORT}/live`
    );

    console.log(
      `HLS:  http://localhost:${PORT}/hls/`
    );

    console.log(
      'SCREEN OWNER: mvxtra'
    );

    console.log(
      'CHAT TRANSLATION: PERSONAL'
    );

    console.log(
      'MULTIPLAYER: ON'
    );

    console.log(
      'ONLINE USERS: ON'
    );

    console.log(
      'DANCES / EMOTES: ON'
    );

    console.log(
      'USERS FILE: ./users.json'
    );

    console.log(
      '========================================'
    );

    console.log('');
  }
);

function shutdown(){
  console.log(
    'EWS SESSIONS shutting down...'
  );

  try{
    if(nms)
      nms.stop();
  }catch(e){
    console.error(e);
  }

  server.close(
    ()=>process.exit(0)
  );
}

process.on(
  'SIGINT',
  shutdown
);

process.on(
  'SIGTERM',
  shutdown
);+hash;
}
function verifyPassword(password,stored){
  const value=String(stored||'');
  if(value.startsWith('scrypt
function cleanUsername(value){return String(value||'').trim().replace(/\s+/g,' ').slice(0,24);}
function isValidUsername(username){return username.length>=2&&username.length<=24&&/^[a-zA-Z0-9_\-а-яА-ЯёЁ ]+$/.test(username);}
function isScreenHost(username){return String(username||'').trim().toLowerCase()===SCREEN_HOST;}
function clamp(v,min,max){return Math.max(min,Math.min(max,v));}

app.get('/api/status',(req,res)=>res.json({ok:true,service:'EWS SESSIONS',online:onlineUsers.size,stream:true}));

app.post('/api/register',(req,res)=>{
  const username=cleanUsername(req.body.username), password=String(req.body.password||'');
  if(!isValidUsername(username)) return res.status(400).json({ok:false,error:'Некорректное имя пользователя.'});
  if(password.length<4) return res.status(400).json({ok:false,error:'Пароль должен быть минимум 4 символа.'});
  const users=readUsers();
  if(users.some(u=>String(u.username).toLowerCase()===username.toLowerCase())) return res.status(409).json({ok:false,error:'Такой пользователь уже существует.'});
  users.push({username,password:hashPassword(password),createdAt:Date.now()}); saveUsers(users);
  res.json({ok:true,username});
});

app.post('/api/login',(req,res)=>{
  const username=cleanUsername(req.body.username), password=String(req.body.password||'');
  const user=readUsers().find(u=>String(u.username).toLowerCase()===username.toLowerCase());
  if(!user) return res.status(401).json({ok:false,error:'Пользователь не найден.'});
  if(user.password!==hashPassword(password)) return res.status(401).json({ok:false,error:'Неверный пароль.'});
  res.json({ok:true,username:user.username});
});

const SUPPORTED_LANGUAGES=new Set(['ru','en','es','de','fr','zh','ja','ko','ar','hi','pt','it','tr','uk','nl','pl']);
const translationCache=new Map();
const MAX_TRANSLATION_CACHE=500;

function normalizeLanguage(value){
  const lang=String(value||'en').trim().toLowerCase();
  return SUPPORTED_LANGUAGES.has(lang)?lang:'en';
}

function httpsGetText(url,timeout=8000){
  return new Promise((resolve,reject)=>{
    const req=https.get(url,{headers:{'User-Agent':'EWS-SESSIONS/1.0'}},res=>{
      let body='';
      res.setEncoding('utf8');
      res.on('data',chunk=>body+=chunk);
      res.on('end',()=>{
        if(res.statusCode>=200&&res.statusCode<300) resolve(body);
        else reject(new Error('HTTP '+res.statusCode));
      });
    });
    req.setTimeout(timeout,()=>req.destroy(new Error('translation timeout')));
    req.on('error',reject);
  });
}

async function translateText(text,targetLanguage){
  if(!text) return '';
  const target=normalizeLanguage(targetLanguage);
  const source=String(text);
  const key=target+'\n'+source;
  if(translationCache.has(key)) return translationCache.get(key);

  try{
    const url='https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl='+encodeURIComponent(target)+'&dt=t&q='+encodeURIComponent(source);
    const raw=await httpsGetText(url);
    const data=JSON.parse(raw);
    const translated=Array.isArray(data)&&Array.isArray(data[0])
      ? data[0].map(part=>Array.isArray(part)?part[0]:'').join('')
      : source;

    if(translationCache.size>=MAX_TRANSLATION_CACHE){
      const firstKey=translationCache.keys().next().value;
      if(firstKey) translationCache.delete(firstKey);
    }
    translationCache.set(key,translated||source);
    return translated||source;
  }catch(e){
    console.error('TRANSLATION ERROR:',e.message);
    return source;
  }
}

app.post('/api/translate',async(req,res)=>{
  const text=String(req.body.text||''), target=String(req.body.target||'en');
  if(!text) return res.json({ok:true,text:''});
  res.json({ok:true,text:await translateText(text,target)});
});

const onlineUsers=new Map();
const players=new Map();
const clubScreenState={active:false,src:'',url:'',name:'',owner:SCREEN_HOST};

const SPAWN_POINTS=[
  {x:0,z:13},
  {x:3,z:10},
  {x:-3,z:10},
  {x:6,z:7},
  {x:-6,z:7},
  {x:8,z:3},
  {x:-8,z:3}
];

function getSpawnPoint(){
  for(const point of SPAWN_POINTS){
    const occupied=[...players.values()].some(
      p=>Math.abs(p.x-point.x)<1.5&&Math.abs(p.z-point.z)<1.5
    );
    if(!occupied) return {x:point.x,z:point.z};
  }
  return {
    x:Math.round(Math.random()*14-7),
    z:Math.round(Math.random()*8+5)
  };
}

function getOnlineUsers(){
  return [...onlineUsers.values()].map(
    u=>({username:u.username,language:u.language})
  );
}

function broadcastOnline(){
  io.emit('online-users',getOnlineUsers());
  io.emit('online',getOnlineUsers());
}

function getPlayers(){
  return [...players.values()].map(p=>({...p}));
}

function sendPlayersSnapshot(socket){
  socket.emit(
    'players-state',
    getPlayers().filter(p=>p.id!==socket.id)
  );
}

io.on('connection',socket=>{
  console.log('SOCKET CONNECT:',socket.id);

  socket.on('join',data=>{
    data=data||{};

    const username=cleanUsername(data.username);
    if(!username) return;

    const language=normalizeLanguage(data.language);

    socket.username=username;
    socket.language=language;

    onlineUsers.set(
      socket.id,
      {
        id:socket.id,
        username,
        language
      }
    );

    const spawn=getSpawnPoint();

    const player={
      id:socket.id,
      username,
      x:spawn.x,
      y:1.7,
      z:spawn.z,
      yaw:0,
      pitch:0,
      moving:false,
      jumping:false,
      dance:0,
      danceStartedAt:0
    };

    players.set(socket.id,player);

    socket.emit(
      'screen-host',
      {
        host:isScreenHost(username),
        username:SCREEN_HOST
      }
    );

    socket.emit('player-spawn',player);

    sendPlayersSnapshot(socket);

    socket.broadcast.emit(
      'player-state',
      player
    );

    broadcastOnline();

    socket.emit(
      'club-screen-state',
      clubScreenState
    );

    socket.emit(
      'online',
      getOnlineUsers()
    );

    console.log(
      'JOIN:',
      username,
      '|',
      language
    );
  });

  socket.on(
    'request-online',
    ()=>socket.emit(
      'online-users',
      getOnlineUsers()
    )
  );

  socket.on(
    'request-players',
    ()=>sendPlayersSnapshot(socket)
  );

  socket.on(
    'request-club-screen',
    ()=>socket.emit(
      'club-screen-state',
      clubScreenState
    )
  );

  socket.on('player-state',data=>{
    const player=players.get(socket.id);
    if(!player) return;

    data=data||{};

    const x=Number(data.x);
    const y=Number(data.y);
    const z=Number(data.z);
    const yaw=Number(data.yaw);
    const pitch=Number(data.pitch);

    if(Number.isFinite(x))
      player.x=clamp(x,-16,16);

    if(Number.isFinite(y))
      player.y=clamp(y,0,8);

    if(Number.isFinite(z))
      player.z=clamp(z,-15.5,15.5);

    if(Number.isFinite(yaw))
      player.yaw=yaw;

    if(Number.isFinite(pitch))
      player.pitch=pitch;

    if(typeof data.moving==='boolean')
      player.moving=data.moving;

    if(typeof data.jumping==='boolean')
      player.jumping=data.jumping;

    if(Number.isFinite(Number(data.dance)))
      player.dance=
        EMOTES.has(Number(data.dance))
          ? Number(data.dance)
          : 0;

    if(Number.isFinite(Number(data.danceStartedAt)))
      player.danceStartedAt=
        Number(data.danceStartedAt)||0;

    socket.broadcast.emit(
      'player-state',
      player
    );
  });

  socket.on('player-move',data=>{
    const player=players.get(socket.id);
    if(!player) return;

    data=data||{};

    if(Number.isFinite(Number(data.x)))
      player.x=clamp(Number(data.x),-16,16);

    if(Number.isFinite(Number(data.y)))
      player.y=clamp(Number(data.y),0,8);

    if(Number.isFinite(Number(data.z)))
      player.z=clamp(Number(data.z),-15.5,15.5);

    if(Number.isFinite(Number(data.yaw)))
      player.yaw=Number(data.yaw);

    if(Number.isFinite(Number(data.pitch)))
      player.pitch=Number(data.pitch);

    socket.broadcast.emit(
      'player-state',
      player
    );
  });

  // =====================================================
  // DANCES / EMOTES
  // =====================================================

  socket.on('player-emote',data=>{
    const player=players.get(socket.id);
    if(!player) return;

    const id=Number(
      data?.dance ??
      data?.emote ??
      0
    );

    player.dance=
      EMOTES.has(id)
        ? id
        : 0;

    player.danceStartedAt=
      player.dance
        ? Date.now()
        : 0;

    io.emit(
      'player-state',
      player
    );
  });

  socket.on('club-screen-state',state=>{
    if(!isScreenHost(socket.username)){
      console.log(
        'SCREEN DENIED:',
        socket.username
      );
      return;
    }

    state=state||{};

    if(
      state.active===true &&
      (
        (typeof state.url==='string'&&state.url.trim()) ||
        (typeof state.src==='string'&&state.src.trim())
      )
    ){
      clubScreenState.active=true;

      clubScreenState.src=
        typeof state.src==='string'
          ? state.src.trim().slice(0,2000)
          : '';

      clubScreenState.url=
        typeof state.url==='string'
          ? state.url.trim().slice(0,2000)
          : '';

      clubScreenState.name=
        String(
          state.name||'MEDIA'
        ).slice(0,100);

    }else{
      clubScreenState.active=false;
      clubScreenState.src='';
      clubScreenState.url='';
      clubScreenState.name='';
    }

    clubScreenState.owner=SCREEN_HOST;

    io.emit(
      'club-screen-state',
      clubScreenState
    );
  });

  socket.on('chat-message',async message=>{
    if(!socket.username) return;

    const original=
      String(message?.text||'')
        .trim()
        .slice(0,500);

    if(!original) return;

    // Every guest receives the same message in THEIR selected language.
    // Translation is done once per unique target language and then reused.

    const recipients=[
      ...onlineUsers.entries()
    ];

    const targetLanguages=[
      ...new Set(
        recipients.map(
          ([,user])=>
            normalizeLanguage(user.language)
        )
      )
    ];

    const translations=new Map();

    await Promise.all(
      targetLanguages.map(
        async targetLanguage=>{
          translations.set(
            targetLanguage,
            await translateText(
              original,
              targetLanguage
            )
          );
        }
      )
    );

    const ts=Date.now();

    for(const [id,user] of recipients){

      const targetSocket=
        io.sockets.sockets.get(id);

      if(!targetSocket) continue;

      const targetLanguage=
        normalizeLanguage(
          user.language
        );

      targetSocket.emit(
        'chat-message',
        {
          user:socket.username,
          username:socket.username,
          text:
            translations.get(
              targetLanguage
            )||original,
          original,
          targetLanguage,
          translated:true,
          ts
        }
      );
    }
  });

  socket.on(
    'language-change',
    language=>{
      if(!socket.username) return;

      socket.language=
        normalizeLanguage(language);

      const user=
        onlineUsers.get(socket.id);

      if(user)
        user.language=
          socket.language;

      socket.emit(
        'language-updated',
        {
          language:
            socket.language
        }
      );

      broadcastOnline();
    }
  );

  socket.on(
    'disconnect',
    reason=>{
      const username=
        socket.username||'unknown';

      onlineUsers.delete(
        socket.id
      );

      players.delete(
        socket.id
      );

      io.emit(
        'player-left',
        socket.id
      );

      io.emit(
        'player-removed',
        socket.id
      );

      broadcastOnline();

      console.log(
        'DISCONNECT:',
        username,
        '|',
        reason
      );
    }
  );
});

const nmsConfig={
  rtmp:{
    port:Number(RTMP_PORT),
    chunk_size:60000,
    gop_cache:true,
    ping:30,
    ping_timeout:60
  },

  http:{
    port:Number(NMS_HTTP_PORT),
    mediaroot:HLS_DIR,
    allow_origin:'*'
  },

  trans:{
    ffmpeg:
      process.env.FFMPEG_PATH||
      'ffmpeg',

    tasks:[
      {
        app:'live',
        hls:true,
        hlsFlags:
          '[hls_time=2:hls_list_size=6:hls_flags=delete_segments+append_list]',
        hlsKeepSegments:6,
        dash:false
      }
    ]
  }
};

let nms=null;

try{
  nms=
    new NodeMediaServer(
      nmsConfig
    );

  nms.run();

  console.log(
    'RTMP SERVER READY'
  );

  console.log(
    `RTMP: rtmp://localhost:${RTMP_PORT}/live`
  );

}catch(error){
  console.error(
    'NODE MEDIA SERVER ERROR:',
    error
  );
}

app.get(
  '/',
  (req,res)=>{
    const index=
      path.join(
        PUBLIC_DIR,
        'index.html'
      );

    if(fs.existsSync(index))
      return res.sendFile(index);

    res.status(404).send(
      'EWS SESSIONS: index.html not found in public folder.'
    );
  }
);

app.use(
  '/api',
  (req,res)=>
    res.status(404).json({
      ok:false,
      error:'API endpoint not found.'
    })
);

app.use(
  (err,req,res,next)=>{
    console.error(
      'EXPRESS ERROR:',
      err
    );

    if(res.headersSent)
      return next(err);

    res.status(500).json({
      ok:false,
      error:'Internal server error.'
    });
  }
);

server.listen(
  PORT,
  '0.0.0.0',
  ()=>{
    console.log('');
    console.log(
      '========================================'
    );
    console.log(
      '        EWS SESSIONS SERVER READY'
    );
    console.log(
      '========================================'
    );

    console.log(
      `WEB:  http://localhost:${PORT}`
    );

    console.log(
      `RTMP: rtmp://localhost:${RTMP_PORT}/live`
    );

    console.log(
      `HLS:  http://localhost:${PORT}/hls/`
    );

    console.log(
      'SCREEN OWNER: mvxtra'
    );

    console.log(
      'CHAT TRANSLATION: PERSONAL'
    );

    console.log(
      'MULTIPLAYER: ON'
    );

    console.log(
      'ONLINE USERS: ON'
    );

    console.log(
      'DANCES / EMOTES: ON'
    );

    console.log(
      'USERS FILE: ./users.json'
    );

    console.log(
      '========================================'
    );

    console.log('');
  }
);

function shutdown(){
  console.log(
    'EWS SESSIONS shutting down...'
  );

  try{
    if(nms)
      nms.stop();
  }catch(e){
    console.error(e);
  }

  server.close(
    ()=>process.exit(0)
  );
}

process.on(
  'SIGINT',
  shutdown
);

process.on(
  'SIGTERM',
  shutdown
);)){
    const parts=value.split('
function cleanUsername(value){return String(value||'').trim().replace(/\s+/g,' ').slice(0,24);}
function isValidUsername(username){return username.length>=2&&username.length<=24&&/^[a-zA-Z0-9_\-а-яА-ЯёЁ ]+$/.test(username);}
function isScreenHost(username){return String(username||'').trim().toLowerCase()===SCREEN_HOST;}
function clamp(v,min,max){return Math.max(min,Math.min(max,v));}

app.get('/api/status',(req,res)=>res.json({ok:true,service:'EWS SESSIONS',online:onlineUsers.size,stream:true}));

app.post('/api/register',(req,res)=>{
  const username=cleanUsername(req.body.username), password=String(req.body.password||'');
  if(!isValidUsername(username)) return res.status(400).json({ok:false,error:'Некорректное имя пользователя.'});
  if(password.length<4) return res.status(400).json({ok:false,error:'Пароль должен быть минимум 4 символа.'});
  const users=readUsers();
  if(users.some(u=>String(u.username).toLowerCase()===username.toLowerCase())) return res.status(409).json({ok:false,error:'Такой пользователь уже существует.'});
  users.push({username,password:hashPassword(password),createdAt:Date.now()}); saveUsers(users);
  res.json({ok:true,username});
});

app.post('/api/login',(req,res)=>{
  const username=cleanUsername(req.body.username), password=String(req.body.password||'');
  const user=readUsers().find(u=>String(u.username).toLowerCase()===username.toLowerCase());
  if(!user) return res.status(401).json({ok:false,error:'Пользователь не найден.'});
  if(user.password!==hashPassword(password)) return res.status(401).json({ok:false,error:'Неверный пароль.'});
  res.json({ok:true,username:user.username});
});

const SUPPORTED_LANGUAGES=new Set(['ru','en','es','de','fr','zh','ja','ko','ar','hi','pt','it','tr','uk','nl','pl']);
const translationCache=new Map();
const MAX_TRANSLATION_CACHE=500;

function normalizeLanguage(value){
  const lang=String(value||'en').trim().toLowerCase();
  return SUPPORTED_LANGUAGES.has(lang)?lang:'en';
}

function httpsGetText(url,timeout=8000){
  return new Promise((resolve,reject)=>{
    const req=https.get(url,{headers:{'User-Agent':'EWS-SESSIONS/1.0'}},res=>{
      let body='';
      res.setEncoding('utf8');
      res.on('data',chunk=>body+=chunk);
      res.on('end',()=>{
        if(res.statusCode>=200&&res.statusCode<300) resolve(body);
        else reject(new Error('HTTP '+res.statusCode));
      });
    });
    req.setTimeout(timeout,()=>req.destroy(new Error('translation timeout')));
    req.on('error',reject);
  });
}

async function translateText(text,targetLanguage){
  if(!text) return '';
  const target=normalizeLanguage(targetLanguage);
  const source=String(text);
  const key=target+'\n'+source;
  if(translationCache.has(key)) return translationCache.get(key);

  try{
    const url='https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl='+encodeURIComponent(target)+'&dt=t&q='+encodeURIComponent(source);
    const raw=await httpsGetText(url);
    const data=JSON.parse(raw);
    const translated=Array.isArray(data)&&Array.isArray(data[0])
      ? data[0].map(part=>Array.isArray(part)?part[0]:'').join('')
      : source;

    if(translationCache.size>=MAX_TRANSLATION_CACHE){
      const firstKey=translationCache.keys().next().value;
      if(firstKey) translationCache.delete(firstKey);
    }
    translationCache.set(key,translated||source);
    return translated||source;
  }catch(e){
    console.error('TRANSLATION ERROR:',e.message);
    return source;
  }
}

app.post('/api/translate',async(req,res)=>{
  const text=String(req.body.text||''), target=String(req.body.target||'en');
  if(!text) return res.json({ok:true,text:''});
  res.json({ok:true,text:await translateText(text,target)});
});

const onlineUsers=new Map();
const players=new Map();
const clubScreenState={active:false,src:'',url:'',name:'',owner:SCREEN_HOST};

const SPAWN_POINTS=[
  {x:0,z:13},
  {x:3,z:10},
  {x:-3,z:10},
  {x:6,z:7},
  {x:-6,z:7},
  {x:8,z:3},
  {x:-8,z:3}
];

function getSpawnPoint(){
  for(const point of SPAWN_POINTS){
    const occupied=[...players.values()].some(
      p=>Math.abs(p.x-point.x)<1.5&&Math.abs(p.z-point.z)<1.5
    );
    if(!occupied) return {x:point.x,z:point.z};
  }
  return {
    x:Math.round(Math.random()*14-7),
    z:Math.round(Math.random()*8+5)
  };
}

function getOnlineUsers(){
  return [...onlineUsers.values()].map(
    u=>({username:u.username,language:u.language})
  );
}

function broadcastOnline(){
  io.emit('online-users',getOnlineUsers());
  io.emit('online',getOnlineUsers());
}

function getPlayers(){
  return [...players.values()].map(p=>({...p}));
}

function sendPlayersSnapshot(socket){
  socket.emit(
    'players-state',
    getPlayers().filter(p=>p.id!==socket.id)
  );
}

io.on('connection',socket=>{
  console.log('SOCKET CONNECT:',socket.id);

  socket.on('join',data=>{
    data=data||{};

    const username=cleanUsername(data.username);
    if(!username) return;

    const language=normalizeLanguage(data.language);

    socket.username=username;
    socket.language=language;

    onlineUsers.set(
      socket.id,
      {
        id:socket.id,
        username,
        language
      }
    );

    const spawn=getSpawnPoint();

    const player={
      id:socket.id,
      username,
      x:spawn.x,
      y:1.7,
      z:spawn.z,
      yaw:0,
      pitch:0,
      moving:false,
      jumping:false,
      dance:0,
      danceStartedAt:0
    };

    players.set(socket.id,player);

    socket.emit(
      'screen-host',
      {
        host:isScreenHost(username),
        username:SCREEN_HOST
      }
    );

    socket.emit('player-spawn',player);

    sendPlayersSnapshot(socket);

    socket.broadcast.emit(
      'player-state',
      player
    );

    broadcastOnline();

    socket.emit(
      'club-screen-state',
      clubScreenState
    );

    socket.emit(
      'online',
      getOnlineUsers()
    );

    console.log(
      'JOIN:',
      username,
      '|',
      language
    );
  });

  socket.on(
    'request-online',
    ()=>socket.emit(
      'online-users',
      getOnlineUsers()
    )
  );

  socket.on(
    'request-players',
    ()=>sendPlayersSnapshot(socket)
  );

  socket.on(
    'request-club-screen',
    ()=>socket.emit(
      'club-screen-state',
      clubScreenState
    )
  );

  socket.on('player-state',data=>{
    const player=players.get(socket.id);
    if(!player) return;

    data=data||{};

    const x=Number(data.x);
    const y=Number(data.y);
    const z=Number(data.z);
    const yaw=Number(data.yaw);
    const pitch=Number(data.pitch);

    if(Number.isFinite(x))
      player.x=clamp(x,-16,16);

    if(Number.isFinite(y))
      player.y=clamp(y,0,8);

    if(Number.isFinite(z))
      player.z=clamp(z,-15.5,15.5);

    if(Number.isFinite(yaw))
      player.yaw=yaw;

    if(Number.isFinite(pitch))
      player.pitch=pitch;

    if(typeof data.moving==='boolean')
      player.moving=data.moving;

    if(typeof data.jumping==='boolean')
      player.jumping=data.jumping;

    if(Number.isFinite(Number(data.dance)))
      player.dance=
        EMOTES.has(Number(data.dance))
          ? Number(data.dance)
          : 0;

    if(Number.isFinite(Number(data.danceStartedAt)))
      player.danceStartedAt=
        Number(data.danceStartedAt)||0;

    socket.broadcast.emit(
      'player-state',
      player
    );
  });

  socket.on('player-move',data=>{
    const player=players.get(socket.id);
    if(!player) return;

    data=data||{};

    if(Number.isFinite(Number(data.x)))
      player.x=clamp(Number(data.x),-16,16);

    if(Number.isFinite(Number(data.y)))
      player.y=clamp(Number(data.y),0,8);

    if(Number.isFinite(Number(data.z)))
      player.z=clamp(Number(data.z),-15.5,15.5);

    if(Number.isFinite(Number(data.yaw)))
      player.yaw=Number(data.yaw);

    if(Number.isFinite(Number(data.pitch)))
      player.pitch=Number(data.pitch);

    socket.broadcast.emit(
      'player-state',
      player
    );
  });

  // =====================================================
  // DANCES / EMOTES
  // =====================================================

  socket.on('player-emote',data=>{
    const player=players.get(socket.id);
    if(!player) return;

    const id=Number(
      data?.dance ??
      data?.emote ??
      0
    );

    player.dance=
      EMOTES.has(id)
        ? id
        : 0;

    player.danceStartedAt=
      player.dance
        ? Date.now()
        : 0;

    io.emit(
      'player-state',
      player
    );
  });

  socket.on('club-screen-state',state=>{
    if(!isScreenHost(socket.username)){
      console.log(
        'SCREEN DENIED:',
        socket.username
      );
      return;
    }

    state=state||{};

    if(
      state.active===true &&
      (
        (typeof state.url==='string'&&state.url.trim()) ||
        (typeof state.src==='string'&&state.src.trim())
      )
    ){
      clubScreenState.active=true;

      clubScreenState.src=
        typeof state.src==='string'
          ? state.src.trim().slice(0,2000)
          : '';

      clubScreenState.url=
        typeof state.url==='string'
          ? state.url.trim().slice(0,2000)
          : '';

      clubScreenState.name=
        String(
          state.name||'MEDIA'
        ).slice(0,100);

    }else{
      clubScreenState.active=false;
      clubScreenState.src='';
      clubScreenState.url='';
      clubScreenState.name='';
    }

    clubScreenState.owner=SCREEN_HOST;

    io.emit(
      'club-screen-state',
      clubScreenState
    );
  });

  socket.on('chat-message',async message=>{
    if(!socket.username) return;

    const original=
      String(message?.text||'')
        .trim()
        .slice(0,500);

    if(!original) return;

    // Every guest receives the same message in THEIR selected language.
    // Translation is done once per unique target language and then reused.

    const recipients=[
      ...onlineUsers.entries()
    ];

    const targetLanguages=[
      ...new Set(
        recipients.map(
          ([,user])=>
            normalizeLanguage(user.language)
        )
      )
    ];

    const translations=new Map();

    await Promise.all(
      targetLanguages.map(
        async targetLanguage=>{
          translations.set(
            targetLanguage,
            await translateText(
              original,
              targetLanguage
            )
          );
        }
      )
    );

    const ts=Date.now();

    for(const [id,user] of recipients){

      const targetSocket=
        io.sockets.sockets.get(id);

      if(!targetSocket) continue;

      const targetLanguage=
        normalizeLanguage(
          user.language
        );

      targetSocket.emit(
        'chat-message',
        {
          user:socket.username,
          username:socket.username,
          text:
            translations.get(
              targetLanguage
            )||original,
          original,
          targetLanguage,
          translated:true,
          ts
        }
      );
    }
  });

  socket.on(
    'language-change',
    language=>{
      if(!socket.username) return;

      socket.language=
        normalizeLanguage(language);

      const user=
        onlineUsers.get(socket.id);

      if(user)
        user.language=
          socket.language;

      socket.emit(
        'language-updated',
        {
          language:
            socket.language
        }
      );

      broadcastOnline();
    }
  );

  socket.on(
    'disconnect',
    reason=>{
      const username=
        socket.username||'unknown';

      onlineUsers.delete(
        socket.id
      );

      players.delete(
        socket.id
      );

      io.emit(
        'player-left',
        socket.id
      );

      io.emit(
        'player-removed',
        socket.id
      );

      broadcastOnline();

      console.log(
        'DISCONNECT:',
        username,
        '|',
        reason
      );
    }
  );
});

const nmsConfig={
  rtmp:{
    port:Number(RTMP_PORT),
    chunk_size:60000,
    gop_cache:true,
    ping:30,
    ping_timeout:60
  },

  http:{
    port:Number(NMS_HTTP_PORT),
    mediaroot:HLS_DIR,
    allow_origin:'*'
  },

  trans:{
    ffmpeg:
      process.env.FFMPEG_PATH||
      'ffmpeg',

    tasks:[
      {
        app:'live',
        hls:true,
        hlsFlags:
          '[hls_time=2:hls_list_size=6:hls_flags=delete_segments+append_list]',
        hlsKeepSegments:6,
        dash:false
      }
    ]
  }
};

let nms=null;

try{
  nms=
    new NodeMediaServer(
      nmsConfig
    );

  nms.run();

  console.log(
    'RTMP SERVER READY'
  );

  console.log(
    `RTMP: rtmp://localhost:${RTMP_PORT}/live`
  );

}catch(error){
  console.error(
    'NODE MEDIA SERVER ERROR:',
    error
  );
}

app.get(
  '/',
  (req,res)=>{
    const index=
      path.join(
        PUBLIC_DIR,
        'index.html'
      );

    if(fs.existsSync(index))
      return res.sendFile(index);

    res.status(404).send(
      'EWS SESSIONS: index.html not found in public folder.'
    );
  }
);

app.use(
  '/api',
  (req,res)=>
    res.status(404).json({
      ok:false,
      error:'API endpoint not found.'
    })
);

app.use(
  (err,req,res,next)=>{
    console.error(
      'EXPRESS ERROR:',
      err
    );

    if(res.headersSent)
      return next(err);

    res.status(500).json({
      ok:false,
      error:'Internal server error.'
    });
  }
);

server.listen(
  PORT,
  '0.0.0.0',
  ()=>{
    console.log('');
    console.log(
      '========================================'
    );
    console.log(
      '        EWS SESSIONS SERVER READY'
    );
    console.log(
      '========================================'
    );

    console.log(
      `WEB:  http://localhost:${PORT}`
    );

    console.log(
      `RTMP: rtmp://localhost:${RTMP_PORT}/live`
    );

    console.log(
      `HLS:  http://localhost:${PORT}/hls/`
    );

    console.log(
      'SCREEN OWNER: mvxtra'
    );

    console.log(
      'CHAT TRANSLATION: PERSONAL'
    );

    console.log(
      'MULTIPLAYER: ON'
    );

    console.log(
      'ONLINE USERS: ON'
    );

    console.log(
      'DANCES / EMOTES: ON'
    );

    console.log(
      'USERS FILE: ./users.json'
    );

    console.log(
      '========================================'
    );

    console.log('');
  }
);

function shutdown(){
  console.log(
    'EWS SESSIONS shutting down...'
  );

  try{
    if(nms)
      nms.stop();
  }catch(e){
    console.error(e);
  }

  server.close(
    ()=>process.exit(0)
  );
}

process.on(
  'SIGINT',
  shutdown
);

process.on(
  'SIGTERM',
  shutdown
););
    if(parts.length!==3) return false;
    const salt=parts[1];
    const expected=Buffer.from(parts[2],'hex');
    const actual=crypto.scryptSync(String(password),salt,64);
    return expected.length===actual.length && crypto.timingSafeEqual(expected,actual);
  }
  // Legacy SHA-256 users are accepted once and transparently upgraded on login.
  const legacy=crypto.createHash('sha256').update(String(password)).digest('hex');
  return legacy===value;
}
function upgradeLegacyPassword(user,password){
  if(String(user.password||'').startsWith('scrypt
function cleanUsername(value){return String(value||'').trim().replace(/\s+/g,' ').slice(0,24);}
function isValidUsername(username){return username.length>=2&&username.length<=24&&/^[a-zA-Z0-9_\-а-яА-ЯёЁ ]+$/.test(username);}
function isScreenHost(username){return String(username||'').trim().toLowerCase()===SCREEN_HOST;}
function clamp(v,min,max){return Math.max(min,Math.min(max,v));}

app.get('/api/status',(req,res)=>res.json({ok:true,service:'EWS SESSIONS',online:onlineUsers.size,stream:true}));

app.post('/api/register',(req,res)=>{
  const username=cleanUsername(req.body.username), password=String(req.body.password||'');
  if(!isValidUsername(username)) return res.status(400).json({ok:false,error:'Некорректное имя пользователя.'});
  if(password.length<4) return res.status(400).json({ok:false,error:'Пароль должен быть минимум 4 символа.'});
  const users=readUsers();
  if(users.some(u=>String(u.username).toLowerCase()===username.toLowerCase())) return res.status(409).json({ok:false,error:'Такой пользователь уже существует.'});
  users.push({username,password:hashPassword(password),createdAt:Date.now()}); saveUsers(users);
  res.json({ok:true,username});
});

app.post('/api/login',(req,res)=>{
  const username=cleanUsername(req.body.username), password=String(req.body.password||'');
  const user=readUsers().find(u=>String(u.username).toLowerCase()===username.toLowerCase());
  if(!user) return res.status(401).json({ok:false,error:'Пользователь не найден.'});
  if(user.password!==hashPassword(password)) return res.status(401).json({ok:false,error:'Неверный пароль.'});
  res.json({ok:true,username:user.username});
});

const SUPPORTED_LANGUAGES=new Set(['ru','en','es','de','fr','zh','ja','ko','ar','hi','pt','it','tr','uk','nl','pl']);
const translationCache=new Map();
const MAX_TRANSLATION_CACHE=500;

function normalizeLanguage(value){
  const lang=String(value||'en').trim().toLowerCase();
  return SUPPORTED_LANGUAGES.has(lang)?lang:'en';
}

function httpsGetText(url,timeout=8000){
  return new Promise((resolve,reject)=>{
    const req=https.get(url,{headers:{'User-Agent':'EWS-SESSIONS/1.0'}},res=>{
      let body='';
      res.setEncoding('utf8');
      res.on('data',chunk=>body+=chunk);
      res.on('end',()=>{
        if(res.statusCode>=200&&res.statusCode<300) resolve(body);
        else reject(new Error('HTTP '+res.statusCode));
      });
    });
    req.setTimeout(timeout,()=>req.destroy(new Error('translation timeout')));
    req.on('error',reject);
  });
}

async function translateText(text,targetLanguage){
  if(!text) return '';
  const target=normalizeLanguage(targetLanguage);
  const source=String(text);
  const key=target+'\n'+source;
  if(translationCache.has(key)) return translationCache.get(key);

  try{
    const url='https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl='+encodeURIComponent(target)+'&dt=t&q='+encodeURIComponent(source);
    const raw=await httpsGetText(url);
    const data=JSON.parse(raw);
    const translated=Array.isArray(data)&&Array.isArray(data[0])
      ? data[0].map(part=>Array.isArray(part)?part[0]:'').join('')
      : source;

    if(translationCache.size>=MAX_TRANSLATION_CACHE){
      const firstKey=translationCache.keys().next().value;
      if(firstKey) translationCache.delete(firstKey);
    }
    translationCache.set(key,translated||source);
    return translated||source;
  }catch(e){
    console.error('TRANSLATION ERROR:',e.message);
    return source;
  }
}

app.post('/api/translate',async(req,res)=>{
  const text=String(req.body.text||''), target=String(req.body.target||'en');
  if(!text) return res.json({ok:true,text:''});
  res.json({ok:true,text:await translateText(text,target)});
});

const onlineUsers=new Map();
const players=new Map();
const clubScreenState={active:false,src:'',url:'',name:'',owner:SCREEN_HOST};

const SPAWN_POINTS=[
  {x:0,z:13},
  {x:3,z:10},
  {x:-3,z:10},
  {x:6,z:7},
  {x:-6,z:7},
  {x:8,z:3},
  {x:-8,z:3}
];

function getSpawnPoint(){
  for(const point of SPAWN_POINTS){
    const occupied=[...players.values()].some(
      p=>Math.abs(p.x-point.x)<1.5&&Math.abs(p.z-point.z)<1.5
    );
    if(!occupied) return {x:point.x,z:point.z};
  }
  return {
    x:Math.round(Math.random()*14-7),
    z:Math.round(Math.random()*8+5)
  };
}

function getOnlineUsers(){
  return [...onlineUsers.values()].map(
    u=>({username:u.username,language:u.language})
  );
}

function broadcastOnline(){
  io.emit('online-users',getOnlineUsers());
  io.emit('online',getOnlineUsers());
}

function getPlayers(){
  return [...players.values()].map(p=>({...p}));
}

function sendPlayersSnapshot(socket){
  socket.emit(
    'players-state',
    getPlayers().filter(p=>p.id!==socket.id)
  );
}

io.on('connection',socket=>{
  console.log('SOCKET CONNECT:',socket.id);

  socket.on('join',data=>{
    data=data||{};

    const username=cleanUsername(data.username);
    if(!username) return;

    const language=normalizeLanguage(data.language);

    socket.username=username;
    socket.language=language;

    onlineUsers.set(
      socket.id,
      {
        id:socket.id,
        username,
        language
      }
    );

    const spawn=getSpawnPoint();

    const player={
      id:socket.id,
      username,
      x:spawn.x,
      y:1.7,
      z:spawn.z,
      yaw:0,
      pitch:0,
      moving:false,
      jumping:false,
      dance:0,
      danceStartedAt:0
    };

    players.set(socket.id,player);

    socket.emit(
      'screen-host',
      {
        host:isScreenHost(username),
        username:SCREEN_HOST
      }
    );

    socket.emit('player-spawn',player);

    sendPlayersSnapshot(socket);

    socket.broadcast.emit(
      'player-state',
      player
    );

    broadcastOnline();

    socket.emit(
      'club-screen-state',
      clubScreenState
    );

    socket.emit(
      'online',
      getOnlineUsers()
    );

    console.log(
      'JOIN:',
      username,
      '|',
      language
    );
  });

  socket.on(
    'request-online',
    ()=>socket.emit(
      'online-users',
      getOnlineUsers()
    )
  );

  socket.on(
    'request-players',
    ()=>sendPlayersSnapshot(socket)
  );

  socket.on(
    'request-club-screen',
    ()=>socket.emit(
      'club-screen-state',
      clubScreenState
    )
  );

  socket.on('player-state',data=>{
    const player=players.get(socket.id);
    if(!player) return;

    data=data||{};

    const x=Number(data.x);
    const y=Number(data.y);
    const z=Number(data.z);
    const yaw=Number(data.yaw);
    const pitch=Number(data.pitch);

    if(Number.isFinite(x))
      player.x=clamp(x,-16,16);

    if(Number.isFinite(y))
      player.y=clamp(y,0,8);

    if(Number.isFinite(z))
      player.z=clamp(z,-15.5,15.5);

    if(Number.isFinite(yaw))
      player.yaw=yaw;

    if(Number.isFinite(pitch))
      player.pitch=pitch;

    if(typeof data.moving==='boolean')
      player.moving=data.moving;

    if(typeof data.jumping==='boolean')
      player.jumping=data.jumping;

    if(Number.isFinite(Number(data.dance)))
      player.dance=
        EMOTES.has(Number(data.dance))
          ? Number(data.dance)
          : 0;

    if(Number.isFinite(Number(data.danceStartedAt)))
      player.danceStartedAt=
        Number(data.danceStartedAt)||0;

    socket.broadcast.emit(
      'player-state',
      player
    );
  });

  socket.on('player-move',data=>{
    const player=players.get(socket.id);
    if(!player) return;

    data=data||{};

    if(Number.isFinite(Number(data.x)))
      player.x=clamp(Number(data.x),-16,16);

    if(Number.isFinite(Number(data.y)))
      player.y=clamp(Number(data.y),0,8);

    if(Number.isFinite(Number(data.z)))
      player.z=clamp(Number(data.z),-15.5,15.5);

    if(Number.isFinite(Number(data.yaw)))
      player.yaw=Number(data.yaw);

    if(Number.isFinite(Number(data.pitch)))
      player.pitch=Number(data.pitch);

    socket.broadcast.emit(
      'player-state',
      player
    );
  });

  // =====================================================
  // DANCES / EMOTES
  // =====================================================

  socket.on('player-emote',data=>{
    const player=players.get(socket.id);
    if(!player) return;

    const id=Number(
      data?.dance ??
      data?.emote ??
      0
    );

    player.dance=
      EMOTES.has(id)
        ? id
        : 0;

    player.danceStartedAt=
      player.dance
        ? Date.now()
        : 0;

    io.emit(
      'player-state',
      player
    );
  });

  socket.on('club-screen-state',state=>{
    if(!isScreenHost(socket.username)){
      console.log(
        'SCREEN DENIED:',
        socket.username
      );
      return;
    }

    state=state||{};

    if(
      state.active===true &&
      (
        (typeof state.url==='string'&&state.url.trim()) ||
        (typeof state.src==='string'&&state.src.trim())
      )
    ){
      clubScreenState.active=true;

      clubScreenState.src=
        typeof state.src==='string'
          ? state.src.trim().slice(0,2000)
          : '';

      clubScreenState.url=
        typeof state.url==='string'
          ? state.url.trim().slice(0,2000)
          : '';

      clubScreenState.name=
        String(
          state.name||'MEDIA'
        ).slice(0,100);

    }else{
      clubScreenState.active=false;
      clubScreenState.src='';
      clubScreenState.url='';
      clubScreenState.name='';
    }

    clubScreenState.owner=SCREEN_HOST;

    io.emit(
      'club-screen-state',
      clubScreenState
    );
  });

  socket.on('chat-message',async message=>{
    if(!socket.username) return;

    const original=
      String(message?.text||'')
        .trim()
        .slice(0,500);

    if(!original) return;

    // Every guest receives the same message in THEIR selected language.
    // Translation is done once per unique target language and then reused.

    const recipients=[
      ...onlineUsers.entries()
    ];

    const targetLanguages=[
      ...new Set(
        recipients.map(
          ([,user])=>
            normalizeLanguage(user.language)
        )
      )
    ];

    const translations=new Map();

    await Promise.all(
      targetLanguages.map(
        async targetLanguage=>{
          translations.set(
            targetLanguage,
            await translateText(
              original,
              targetLanguage
            )
          );
        }
      )
    );

    const ts=Date.now();

    for(const [id,user] of recipients){

      const targetSocket=
        io.sockets.sockets.get(id);

      if(!targetSocket) continue;

      const targetLanguage=
        normalizeLanguage(
          user.language
        );

      targetSocket.emit(
        'chat-message',
        {
          user:socket.username,
          username:socket.username,
          text:
            translations.get(
              targetLanguage
            )||original,
          original,
          targetLanguage,
          translated:true,
          ts
        }
      );
    }
  });

  socket.on(
    'language-change',
    language=>{
      if(!socket.username) return;

      socket.language=
        normalizeLanguage(language);

      const user=
        onlineUsers.get(socket.id);

      if(user)
        user.language=
          socket.language;

      socket.emit(
        'language-updated',
        {
          language:
            socket.language
        }
      );

      broadcastOnline();
    }
  );

  socket.on(
    'disconnect',
    reason=>{
      const username=
        socket.username||'unknown';

      onlineUsers.delete(
        socket.id
      );

      players.delete(
        socket.id
      );

      io.emit(
        'player-left',
        socket.id
      );

      io.emit(
        'player-removed',
        socket.id
      );

      broadcastOnline();

      console.log(
        'DISCONNECT:',
        username,
        '|',
        reason
      );
    }
  );
});

const nmsConfig={
  rtmp:{
    port:Number(RTMP_PORT),
    chunk_size:60000,
    gop_cache:true,
    ping:30,
    ping_timeout:60
  },

  http:{
    port:Number(NMS_HTTP_PORT),
    mediaroot:HLS_DIR,
    allow_origin:'*'
  },

  trans:{
    ffmpeg:
      process.env.FFMPEG_PATH||
      'ffmpeg',

    tasks:[
      {
        app:'live',
        hls:true,
        hlsFlags:
          '[hls_time=2:hls_list_size=6:hls_flags=delete_segments+append_list]',
        hlsKeepSegments:6,
        dash:false
      }
    ]
  }
};

let nms=null;

try{
  nms=
    new NodeMediaServer(
      nmsConfig
    );

  nms.run();

  console.log(
    'RTMP SERVER READY'
  );

  console.log(
    `RTMP: rtmp://localhost:${RTMP_PORT}/live`
  );

}catch(error){
  console.error(
    'NODE MEDIA SERVER ERROR:',
    error
  );
}

app.get(
  '/',
  (req,res)=>{
    const index=
      path.join(
        PUBLIC_DIR,
        'index.html'
      );

    if(fs.existsSync(index))
      return res.sendFile(index);

    res.status(404).send(
      'EWS SESSIONS: index.html not found in public folder.'
    );
  }
);

app.use(
  '/api',
  (req,res)=>
    res.status(404).json({
      ok:false,
      error:'API endpoint not found.'
    })
);

app.use(
  (err,req,res,next)=>{
    console.error(
      'EXPRESS ERROR:',
      err
    );

    if(res.headersSent)
      return next(err);

    res.status(500).json({
      ok:false,
      error:'Internal server error.'
    });
  }
);

server.listen(
  PORT,
  '0.0.0.0',
  ()=>{
    console.log('');
    console.log(
      '========================================'
    );
    console.log(
      '        EWS SESSIONS SERVER READY'
    );
    console.log(
      '========================================'
    );

    console.log(
      `WEB:  http://localhost:${PORT}`
    );

    console.log(
      `RTMP: rtmp://localhost:${RTMP_PORT}/live`
    );

    console.log(
      `HLS:  http://localhost:${PORT}/hls/`
    );

    console.log(
      'SCREEN OWNER: mvxtra'
    );

    console.log(
      'CHAT TRANSLATION: PERSONAL'
    );

    console.log(
      'MULTIPLAYER: ON'
    );

    console.log(
      'ONLINE USERS: ON'
    );

    console.log(
      'DANCES / EMOTES: ON'
    );

    console.log(
      'USERS FILE: ./users.json'
    );

    console.log(
      '========================================'
    );

    console.log('');
  }
);

function shutdown(){
  console.log(
    'EWS SESSIONS shutting down...'
  );

  try{
    if(nms)
      nms.stop();
  }catch(e){
    console.error(e);
  }

  server.close(
    ()=>process.exit(0)
  );
}

process.on(
  'SIGINT',
  shutdown
);

process.on(
  'SIGTERM',
  shutdown
);)) return;
  user.password=hashPassword(password);
}
function cleanUsername(value){return String(value||'').trim().replace(/\s+/g,' ').slice(0,24);}
function isValidUsername(username){return username.length>=2&&username.length<=24&&/^[a-zA-Z0-9_\-а-яА-ЯёЁ ]+$/.test(username);}
function isScreenHost(username){return String(username||'').trim().toLowerCase()===SCREEN_HOST;}
function clamp(v,min,max){return Math.max(min,Math.min(max,v));}

app.get('/api/status',(req,res)=>res.json({ok:true,service:'EWS SESSIONS',online:onlineUsers.size,stream:true}));

app.post('/api/register',(req,res)=>{
  const username=cleanUsername(req.body.username), password=String(req.body.password||'');
  if(!isValidUsername(username)) return res.status(400).json({ok:false,error:'Некорректное имя пользователя.'});
  if(password.length<4) return res.status(400).json({ok:false,error:'Пароль должен быть минимум 4 символа.'});
  const users=readUsers();
  if(users.some(u=>String(u.username).toLowerCase()===username.toLowerCase())) return res.status(409).json({ok:false,error:'Такой пользователь уже существует.'});
  users.push({username,password:hashPassword(password),createdAt:Date.now()}); saveUsers(users);
  res.json({ok:true,username});
});

app.post('/api/login',(req,res)=>{
  const username=cleanUsername(req.body.username), password=String(req.body.password||'');
  const user=readUsers().find(u=>String(u.username).toLowerCase()===username.toLowerCase());
  if(!user) return res.status(401).json({ok:false,error:'Пользователь не найден.'});
  if(user.password!==hashPassword(password)) return res.status(401).json({ok:false,error:'Неверный пароль.'});
  res.json({ok:true,username:user.username});
});

const SUPPORTED_LANGUAGES=new Set(['ru','en','es','de','fr','zh','ja','ko','ar','hi','pt','it','tr','uk','nl','pl']);
const translationCache=new Map();
const MAX_TRANSLATION_CACHE=500;

function normalizeLanguage(value){
  const lang=String(value||'en').trim().toLowerCase();
  return SUPPORTED_LANGUAGES.has(lang)?lang:'en';
}

function httpsGetText(url,timeout=8000){
  return new Promise((resolve,reject)=>{
    const req=https.get(url,{headers:{'User-Agent':'EWS-SESSIONS/1.0'}},res=>{
      let body='';
      res.setEncoding('utf8');
      res.on('data',chunk=>body+=chunk);
      res.on('end',()=>{
        if(res.statusCode>=200&&res.statusCode<300) resolve(body);
        else reject(new Error('HTTP '+res.statusCode));
      });
    });
    req.setTimeout(timeout,()=>req.destroy(new Error('translation timeout')));
    req.on('error',reject);
  });
}

async function translateText(text,targetLanguage){
  if(!text) return '';
  const target=normalizeLanguage(targetLanguage);
  const source=String(text);
  const key=target+'\n'+source;
  if(translationCache.has(key)) return translationCache.get(key);

  try{
    const url='https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl='+encodeURIComponent(target)+'&dt=t&q='+encodeURIComponent(source);
    const raw=await httpsGetText(url);
    const data=JSON.parse(raw);
    const translated=Array.isArray(data)&&Array.isArray(data[0])
      ? data[0].map(part=>Array.isArray(part)?part[0]:'').join('')
      : source;

    if(translationCache.size>=MAX_TRANSLATION_CACHE){
      const firstKey=translationCache.keys().next().value;
      if(firstKey) translationCache.delete(firstKey);
    }
    translationCache.set(key,translated||source);
    return translated||source;
  }catch(e){
    console.error('TRANSLATION ERROR:',e.message);
    return source;
  }
}

app.post('/api/translate',async(req,res)=>{
  const text=String(req.body.text||''), target=String(req.body.target||'en');
  if(!text) return res.json({ok:true,text:''});
  res.json({ok:true,text:await translateText(text,target)});
});

const onlineUsers=new Map();
const players=new Map();
const clubScreenState={active:false,src:'',url:'',name:'',owner:SCREEN_HOST};

const SPAWN_POINTS=[
  {x:0,z:13},
  {x:3,z:10},
  {x:-3,z:10},
  {x:6,z:7},
  {x:-6,z:7},
  {x:8,z:3},
  {x:-8,z:3}
];

function getSpawnPoint(){
  for(const point of SPAWN_POINTS){
    const occupied=[...players.values()].some(
      p=>Math.abs(p.x-point.x)<1.5&&Math.abs(p.z-point.z)<1.5
    );
    if(!occupied) return {x:point.x,z:point.z};
  }
  return {
    x:Math.round(Math.random()*14-7),
    z:Math.round(Math.random()*8+5)
  };
}

function getOnlineUsers(){
  return [...onlineUsers.values()].map(
    u=>({username:u.username,language:u.language})
  );
}

function broadcastOnline(){
  io.emit('online-users',getOnlineUsers());
  io.emit('online',getOnlineUsers());
}

function getPlayers(){
  return [...players.values()].map(p=>({...p}));
}

function sendPlayersSnapshot(socket){
  socket.emit(
    'players-state',
    getPlayers().filter(p=>p.id!==socket.id)
  );
}

io.on('connection',socket=>{
  console.log('SOCKET CONNECT:',socket.id);

  socket.on('join',data=>{
    data=data||{};

    const username=cleanUsername(data.username);
    if(!username) return;

    const language=normalizeLanguage(data.language);

    socket.username=username;
    socket.language=language;

    onlineUsers.set(
      socket.id,
      {
        id:socket.id,
        username,
        language
      }
    );

    const spawn=getSpawnPoint();

    const player={
      id:socket.id,
      username,
      x:spawn.x,
      y:1.7,
      z:spawn.z,
      yaw:0,
      pitch:0,
      moving:false,
      jumping:false,
      dance:0,
      danceStartedAt:0
    };

    players.set(socket.id,player);

    socket.emit(
      'screen-host',
      {
        host:isScreenHost(username),
        username:SCREEN_HOST
      }
    );

    socket.emit('player-spawn',player);

    sendPlayersSnapshot(socket);

    socket.broadcast.emit(
      'player-state',
      player
    );

    broadcastOnline();

    socket.emit(
      'club-screen-state',
      clubScreenState
    );

    socket.emit(
      'online',
      getOnlineUsers()
    );

    console.log(
      'JOIN:',
      username,
      '|',
      language
    );
  });

  socket.on(
    'request-online',
    ()=>socket.emit(
      'online-users',
      getOnlineUsers()
    )
  );

  socket.on(
    'request-players',
    ()=>sendPlayersSnapshot(socket)
  );

  socket.on(
    'request-club-screen',
    ()=>socket.emit(
      'club-screen-state',
      clubScreenState
    )
  );

  socket.on('player-state',data=>{
    const player=players.get(socket.id);
    if(!player) return;

    data=data||{};

    const x=Number(data.x);
    const y=Number(data.y);
    const z=Number(data.z);
    const yaw=Number(data.yaw);
    const pitch=Number(data.pitch);

    if(Number.isFinite(x))
      player.x=clamp(x,-16,16);

    if(Number.isFinite(y))
      player.y=clamp(y,0,8);

    if(Number.isFinite(z))
      player.z=clamp(z,-15.5,15.5);

    if(Number.isFinite(yaw))
      player.yaw=yaw;

    if(Number.isFinite(pitch))
      player.pitch=pitch;

    if(typeof data.moving==='boolean')
      player.moving=data.moving;

    if(typeof data.jumping==='boolean')
      player.jumping=data.jumping;

    if(Number.isFinite(Number(data.dance)))
      player.dance=
        EMOTES.has(Number(data.dance))
          ? Number(data.dance)
          : 0;

    if(Number.isFinite(Number(data.danceStartedAt)))
      player.danceStartedAt=
        Number(data.danceStartedAt)||0;

    socket.broadcast.emit(
      'player-state',
      player
    );
  });

  socket.on('player-move',data=>{
    const player=players.get(socket.id);
    if(!player) return;

    data=data||{};

    if(Number.isFinite(Number(data.x)))
      player.x=clamp(Number(data.x),-16,16);

    if(Number.isFinite(Number(data.y)))
      player.y=clamp(Number(data.y),0,8);

    if(Number.isFinite(Number(data.z)))
      player.z=clamp(Number(data.z),-15.5,15.5);

    if(Number.isFinite(Number(data.yaw)))
      player.yaw=Number(data.yaw);

    if(Number.isFinite(Number(data.pitch)))
      player.pitch=Number(data.pitch);

    socket.broadcast.emit(
      'player-state',
      player
    );
  });

  // =====================================================
  // DANCES / EMOTES
  // =====================================================

  socket.on('player-emote',data=>{
    const player=players.get(socket.id);
    if(!player) return;

    const id=Number(
      data?.dance ??
      data?.emote ??
      0
    );

    player.dance=
      EMOTES.has(id)
        ? id
        : 0;

    player.danceStartedAt=
      player.dance
        ? Date.now()
        : 0;

    io.emit(
      'player-state',
      player
    );
  });

  socket.on('club-screen-state',state=>{
    if(!isScreenHost(socket.username)){
      console.log(
        'SCREEN DENIED:',
        socket.username
      );
      return;
    }

    state=state||{};

    if(
      state.active===true &&
      (
        (typeof state.url==='string'&&state.url.trim()) ||
        (typeof state.src==='string'&&state.src.trim())
      )
    ){
      clubScreenState.active=true;

      clubScreenState.src=
        typeof state.src==='string'
          ? state.src.trim().slice(0,2000)
          : '';

      clubScreenState.url=
        typeof state.url==='string'
          ? state.url.trim().slice(0,2000)
          : '';

      clubScreenState.name=
        String(
          state.name||'MEDIA'
        ).slice(0,100);

    }else{
      clubScreenState.active=false;
      clubScreenState.src='';
      clubScreenState.url='';
      clubScreenState.name='';
    }

    clubScreenState.owner=SCREEN_HOST;

    io.emit(
      'club-screen-state',
      clubScreenState
    );
  });

  socket.on('chat-message',async message=>{
    if(!socket.username) return;

    const original=
      String(message?.text||'')
        .trim()
        .slice(0,500);

    if(!original) return;

    // Every guest receives the same message in THEIR selected language.
    // Translation is done once per unique target language and then reused.

    const recipients=[
      ...onlineUsers.entries()
    ];

    const targetLanguages=[
      ...new Set(
        recipients.map(
          ([,user])=>
            normalizeLanguage(user.language)
        )
      )
    ];

    const translations=new Map();

    await Promise.all(
      targetLanguages.map(
        async targetLanguage=>{
          translations.set(
            targetLanguage,
            await translateText(
              original,
              targetLanguage
            )
          );
        }
      )
    );

    const ts=Date.now();

    for(const [id,user] of recipients){

      const targetSocket=
        io.sockets.sockets.get(id);

      if(!targetSocket) continue;

      const targetLanguage=
        normalizeLanguage(
          user.language
        );

      targetSocket.emit(
        'chat-message',
        {
          user:socket.username,
          username:socket.username,
          text:
            translations.get(
              targetLanguage
            )||original,
          original,
          targetLanguage,
          translated:true,
          ts
        }
      );
    }
  });

  socket.on(
    'language-change',
    language=>{
      if(!socket.username) return;

      socket.language=
        normalizeLanguage(language);

      const user=
        onlineUsers.get(socket.id);

      if(user)
        user.language=
          socket.language;

      socket.emit(
        'language-updated',
        {
          language:
            socket.language
        }
      );

      broadcastOnline();
    }
  );

  socket.on(
    'disconnect',
    reason=>{
      const username=
        socket.username||'unknown';

      onlineUsers.delete(
        socket.id
      );

      players.delete(
        socket.id
      );

      io.emit(
        'player-left',
        socket.id
      );

      io.emit(
        'player-removed',
        socket.id
      );

      broadcastOnline();

      console.log(
        'DISCONNECT:',
        username,
        '|',
        reason
      );
    }
  );
});

const nmsConfig={
  rtmp:{
    port:Number(RTMP_PORT),
    chunk_size:60000,
    gop_cache:true,
    ping:30,
    ping_timeout:60
  },

  http:{
    port:Number(NMS_HTTP_PORT),
    mediaroot:HLS_DIR,
    allow_origin:'*'
  },

  trans:{
    ffmpeg:
      process.env.FFMPEG_PATH||
      'ffmpeg',

    tasks:[
      {
        app:'live',
        hls:true,
        hlsFlags:
          '[hls_time=2:hls_list_size=6:hls_flags=delete_segments+append_list]',
        hlsKeepSegments:6,
        dash:false
      }
    ]
  }
};

let nms=null;

try{
  nms=
    new NodeMediaServer(
      nmsConfig
    );

  nms.run();

  console.log(
    'RTMP SERVER READY'
  );

  console.log(
    `RTMP: rtmp://localhost:${RTMP_PORT}/live`
  );

}catch(error){
  console.error(
    'NODE MEDIA SERVER ERROR:',
    error
  );
}

app.get(
  '/',
  (req,res)=>{
    const index=
      path.join(
        PUBLIC_DIR,
        'index.html'
      );

    if(fs.existsSync(index))
      return res.sendFile(index);

    res.status(404).send(
      'EWS SESSIONS: index.html not found in public folder.'
    );
  }
);

app.use(
  '/api',
  (req,res)=>
    res.status(404).json({
      ok:false,
      error:'API endpoint not found.'
    })
);

app.use(
  (err,req,res,next)=>{
    console.error(
      'EXPRESS ERROR:',
      err
    );

    if(res.headersSent)
      return next(err);

    res.status(500).json({
      ok:false,
      error:'Internal server error.'
    });
  }
);

server.listen(
  PORT,
  '0.0.0.0',
  ()=>{
    console.log('');
    console.log(
      '========================================'
    );
    console.log(
      '        EWS SESSIONS SERVER READY'
    );
    console.log(
      '========================================'
    );

    console.log(
      `WEB:  http://localhost:${PORT}`
    );

    console.log(
      `RTMP: rtmp://localhost:${RTMP_PORT}/live`
    );

    console.log(
      `HLS:  http://localhost:${PORT}/hls/`
    );

    console.log(
      'SCREEN OWNER: mvxtra'
    );

    console.log(
      'CHAT TRANSLATION: PERSONAL'
    );

    console.log(
      'MULTIPLAYER: ON'
    );

    console.log(
      'ONLINE USERS: ON'
    );

    console.log(
      'DANCES / EMOTES: ON'
    );

    console.log(
      'USERS FILE: ./users.json'
    );

    console.log(
      '========================================'
    );

    console.log('');
  }
);

function shutdown(){
  console.log(
    'EWS SESSIONS shutting down...'
  );

  try{
    if(nms)
      nms.stop();
  }catch(e){
    console.error(e);
  }

  server.close(
    ()=>process.exit(0)
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