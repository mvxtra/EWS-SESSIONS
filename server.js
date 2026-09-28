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

const PORT = Number(process.env.PORT || 3000);
const RTMP_PORT = Number(process.env.RTMP_PORT || 1935);
const NMS_HTTP_PORT = Number(process.env.NMS_HTTP_PORT || 8000);
const PUBLIC_DIR = path.join(__dirname,'public');
const HLS_DIR = path.join(__dirname,'hls');
const HLS_STREAM_DIR = path.join(HLS_DIR,'ews');
const USERS_FILE = path.join(__dirname,'users.json');
const SCREEN_HOST = 'mvxtra';
const GROUND_Y = 1.7;
const EMOTES = new Set([1,2,3,4,5,6]);
const PLAYER_RADIUS = 0.38;
const COLLISION_BOXES = [
  {minX:-8.7,maxX:8.7,minZ:-14.2,maxZ:-10.9},
  {minX:-8.9,maxX:-6.1,minZ:-11.45,maxZ:-9.65},
  {minX:6.1,maxX:8.9,minZ:-11.45,maxZ:-9.65},
  {minX:-3.6,maxX:3.6,minZ:15.7,maxZ:16.7}
];
function blockedPosition(x,z){
  for(const b of COLLISION_BOXES){
    const cx=Math.max(b.minX,Math.min(x,b.maxX));
    const cz=Math.max(b.minZ,Math.min(z,b.maxZ));
    const dx=x-cx, dz=z-cz;
    if(dx*dx+dz*dz < PLAYER_RADIUS*PLAYER_RADIUS) return true;
  }
  return false;
}

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

function readUsers(){
  try{
    const users=JSON.parse(fs.readFileSync(USERS_FILE,'utf8'));
    return Array.isArray(users)?users:[];
  }catch(e){
    console.error('USERS READ ERROR:',e.message);
    return [];
  }
}
function saveUsers(users){fs.writeFileSync(USERS_FILE,JSON.stringify(users,null,2),'utf8');}

function hashPassword(password){
  const salt=crypto.randomBytes(16).toString('hex');
  const hash=crypto.scryptSync(String(password),salt,64).toString('hex');
  return 'scrypt:' + salt + ':' + hash;
}
function verifyPassword(password,stored){
  const value=String(stored||'');
  if(value.startsWith('scrypt:')){
    const parts=value.split(':');
    if(parts.length!==3) return false;
    const expected=Buffer.from(parts[2],'hex');
    const actual=crypto.scryptSync(String(password),parts[1],64);
    return expected.length===actual.length && crypto.timingSafeEqual(expected,actual);
  }
  const legacy=crypto.createHash('sha256').update(String(password)).digest('hex');
  return legacy===value;
}
function upgradeLegacyPassword(user,password){
  if(String(user.password||'').startsWith('scrypt:')) return;
  user.password=hashPassword(password);
}
function cleanUsername(value){
  return String(value||'').trim().replace(/\s+/g,' ').slice(0,24);
}
function isValidUsername(username){
  return username.length>=2 && username.length<=24 && /^[a-zA-Z0-9_\-а-яА-ЯёЁ ]+$/.test(username);
}
function isScreenHost(username){
  return String(username||'').trim().toLowerCase()===SCREEN_HOST;
}
function clamp(v,min,max){return Math.max(min,Math.min(max,v));}

const authAttempts=new Map();
const AUTH_WINDOW_MS=10*60*1000;
const AUTH_MAX_ATTEMPTS=20;
function authRateLimited(req){
  const key=req.ip || req.socket.remoteAddress || 'unknown';
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

app.get('/api/status',(req,res)=>res.json({
  ok:true,
  service:'EWS SESSIONS',
  online:onlineUsers.size,
  stream:true
}));

app.post('/api/register',(req,res)=>{
  if(authRateLimited(req)) return res.status(429).json({ok:false,error:'Слишком много попыток. Попробуйте позже.'});
  const username=cleanUsername(req.body.username);
  const password=String(req.body.password||'');
  if(!isValidUsername(username)) return res.status(400).json({ok:false,error:'Некорректное имя пользователя.'});
  if(password.length<4) return res.status(400).json({ok:false,error:'Пароль должен быть минимум 4 символа.'});
  const users=readUsers();
  if(users.some(u=>String(u.username).toLowerCase()===username.toLowerCase())){
    return res.status(409).json({ok:false,error:'Такой пользователь уже существует.'});
  }
  users.push({username,password:hashPassword(password),createdAt:Date.now()});
  saveUsers(users);
  res.json({ok:true,username});
});

app.post('/api/login',(req,res)=>{
  if(authRateLimited(req)) return res.status(429).json({ok:false,error:'Слишком много попыток. Попробуйте позже.'});
  const username=cleanUsername(req.body.username);
  const password=String(req.body.password||'');
  const users=readUsers();
  const user=users.find(u=>String(u.username).toLowerCase()===username.toLowerCase());
  if(!user) return res.status(401).json({ok:false,error:'Пользователь не найден.'});
  if(!verifyPassword(password,user.password)) return res.status(401).json({ok:false,error:'Неверный пароль.'});
  if(!String(user.password||'').startsWith('scrypt:')){
    upgradeLegacyPassword(user,password);
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
    const url='https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl='+
      encodeURIComponent(target)+'&dt=t&q='+encodeURIComponent(source);
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
  const text=String(req.body.text||'');
  const target=String(req.body.target||'en');
  if(!text) return res.json({ok:true,text:''});
  res.json({ok:true,text:await translateText(text,target)});
});

const onlineUsers=new Map();
const players=new Map();
const clubScreenState={active:false,src:'',url:'',name:'',owner:SCREEN_HOST};
const SPAWN_POINTS=[
  {x:0,z:13},{x:3,z:10},{x:-3,z:10},{x:6,z:7},
  {x:-6,z:7},{x:8,z:3},{x:-8,z:3}
];

function getSpawnPoint(){
  for(const point of SPAWN_POINTS){
    const occupied=[...players.values()].some(
      p=>Math.abs(p.x-point.x)<1.5&&Math.abs(p.z-point.z)<1.5
    );
    if(!occupied) return {x:point.x,z:point.z};
  }
  return {x:Math.round(Math.random()*14-7),z:Math.round(Math.random()*8+5)};
}
function getOnlineUsers(){
  return [...onlineUsers.values()].map(u=>({username:u.username,language:u.language}));
}
function broadcastOnline(){
  io.emit('online-users',getOnlineUsers());
  io.emit('online',getOnlineUsers());
}
function publicPlayer(player){
  const copy={...player};
  delete copy.lastUpdateAt;
  return copy;
}
function getPlayers(){
  return [...players.values()].map(publicPlayer);
}
function sendPlayersSnapshot(socket){
  socket.emit('players-state',getPlayers().filter(p=>p.id!==socket.id));
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

    onlineUsers.set(socket.id,{id:socket.id,username,language});

    const spawn=getSpawnPoint();
    const player={
      id:socket.id,
      username,
      x:spawn.x,
      y:GROUND_Y,
      z:spawn.z,
      yaw:0,
      pitch:0,
      moving:false,
      jumping:false,
      dance:0,
      danceStartedAt:0,
      avatar:['male','female'].includes(String(data.avatar))?String(data.avatar):'male',
      lastUpdateAt:Date.now()
    };
    players.set(socket.id,player);

    socket.emit('screen-host',{host:isScreenHost(username),username:SCREEN_HOST});
    socket.emit('player-spawn',publicPlayer(player));
    sendPlayersSnapshot(socket);
    socket.broadcast.emit('player-state',publicPlayer(player));
    broadcastOnline();
    // Send a direct authoritative snapshot to the newly joined socket as well.
    socket.emit('online-users',getOnlineUsers());
    socket.emit('club-screen-state',clubScreenState);
    socket.emit('online',getOnlineUsers());

    console.log('JOIN:',username,'|',language);
  });

  socket.on('request-online',()=>socket.emit('online-users',getOnlineUsers()));
  socket.on('request-players',()=>sendPlayersSnapshot(socket));
  socket.on('request-club-screen',()=>socket.emit('club-screen-state',clubScreenState));

  // One movement channel only. Server owns ground height and rejects impossible horizontal jumps.
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
      // Resolve each axis separately so the player slides along solid objects.
      if(!blockedPosition(nextX,player.z)) player.x=nextX;
      if(!blockedPosition(player.x,nextZ)) player.z=nextZ;
    }

    if(Boolean(data.jumping) && Number.isFinite(y)){
      player.y=clamp(y,GROUND_Y,4.8);
      player.jumping=true;
    }else{
      player.y=GROUND_Y;
      player.jumping=false;
    }

    if(Number.isFinite(yaw)) player.yaw=yaw;
    if(Number.isFinite(pitch)) player.pitch=clamp(pitch,-Math.PI/2,Math.PI/2);
    if(typeof data.moving==='boolean') player.moving=data.moving;
    if(Number.isFinite(Number(data.dance))){
      const dance=Number(data.dance);
      player.dance=EMOTES.has(dance)?dance:0;
    }
    if(['male','female'].includes(String(data.avatar))){
      player.avatar=String(data.avatar);
    }
    if(Number.isFinite(Number(data.danceStartedAt))){
      player.danceStartedAt=Number(data.danceStartedAt)||0;
    }

    player.lastUpdateAt=now;
    socket.broadcast.emit('player-state',publicPlayer(player));
  });

  socket.on('player-avatar',data=>{
    const player=players.get(socket.id);
    if(!player) return;
    const avatar=String(data?.avatar||'');
    if(!['male','female'].includes(avatar)) return;
    player.avatar=avatar;
    io.emit('player-state',publicPlayer(player));
  });

  socket.on('player-emote',data=>{
    const player=players.get(socket.id);
    if(!player) return;
    const id=Number(data?.dance ?? data?.emote ?? 0);
    player.dance=EMOTES.has(id)?id:0;
    player.danceStartedAt=player.dance?Date.now():0;
    io.emit('player-state',publicPlayer(player));
  });

  socket.on('club-screen-state',state=>{
    if(!isScreenHost(socket.username)){
      console.log('SCREEN DENIED:',socket.username);
      return;
    }
    state=state||{};
    if(state.active===true && (
      (typeof state.url==='string'&&state.url.trim()) ||
      (typeof state.src==='string'&&state.src.trim())
    )){
      clubScreenState.active=true;
      clubScreenState.src=typeof state.src==='string'?state.src.trim().slice(0,2000):'';
      clubScreenState.url=typeof state.url==='string'?state.url.trim().slice(0,2000):'';
      clubScreenState.name=String(state.name||'MEDIA').slice(0,100);
    }else{
      clubScreenState.active=false;
      clubScreenState.src='';
      clubScreenState.url='';
      clubScreenState.name='';
    }
    clubScreenState.owner=SCREEN_HOST;
    io.emit('club-screen-state',clubScreenState);
  });

  socket.on('chat-message',message=>{
    if(!socket.username) return;
    const original=String(message?.text||'').trim().slice(0,500);
    if(!original) return;

    const recipients=[...onlineUsers.entries()];
    const targetLanguages=[...new Set(
      recipients.map(([,user])=>normalizeLanguage(user.language))
    )];
    const ts=Date.now();

    // Each language is translated independently. A slow translator cannot block other users.
    for(const targetLanguage of targetLanguages){
      translateText(original,targetLanguage).then(translated=>{
        for(const [id,user] of recipients){
          if(normalizeLanguage(user.language)!==targetLanguage) continue;
          const targetSocket=io.sockets.sockets.get(id);
          if(!targetSocket) continue;
          targetSocket.emit('chat-message',{
            user:socket.username,
            username:socket.username,
            text:translated||original,
            original,
            targetLanguage,
            translated:true,
            ts
          });
        }
      }).catch(()=>{
        for(const [id,user] of recipients){
          if(normalizeLanguage(user.language)!==targetLanguage) continue;
          const targetSocket=io.sockets.sockets.get(id);
          if(!targetSocket) continue;
          targetSocket.emit('chat-message',{
            user:socket.username,
            username:socket.username,
            text:original,
            original,
            targetLanguage,
            translated:false,
            ts
          });
        }
      });
    }
  });

  socket.on('language-change',language=>{
    if(!socket.username) return;
    socket.language=normalizeLanguage(language);
    const user=onlineUsers.get(socket.id);
    if(user) user.language=socket.language;
    socket.emit('language-updated',{language:socket.language});
    broadcastOnline();
  });

  socket.on('disconnect',reason=>{
    const username=socket.username||'unknown';
    onlineUsers.delete(socket.id);
    players.delete(socket.id);
    io.emit('player-left',socket.id);
    io.emit('player-removed',socket.id);
    broadcastOnline();
    console.log('DISCONNECT:',username,'|',reason);
  });
});

const nmsConfig={
  rtmp:{
    port:RTMP_PORT,
    chunk_size:60000,
    gop_cache:true,
    ping:30,
    ping_timeout:60
  },
  http:{
    port:NMS_HTTP_PORT,
    mediaroot:HLS_DIR,
    allow_origin:'*'
  },
  trans:{
    ffmpeg:process.env.FFMPEG_PATH||'ffmpeg',
    tasks:[{
      app:'live',
      hls:true,
      hlsFlags:'[hls_time=2:hls_list_size=6:hls_flags=delete_segments+append_list]',
      hlsKeepSegments:6,
      dash:false
    }]
  }
};

let nms=null;
try{
  nms=new NodeMediaServer(nmsConfig);
  nms.run();
  console.log('RTMP SERVER READY');
  console.log('RTMP: rtmp://localhost:'+RTMP_PORT+'/live');
}catch(error){
  console.error('NODE MEDIA SERVER ERROR:',error);
}

app.get('/',(req,res)=>{
  const index=path.join(PUBLIC_DIR,'index.html');
  if(fs.existsSync(index)) return res.sendFile(index);
  res.status(404).send('EWS SESSIONS: index.html not found in public folder.');
});

app.use('/api',(req,res)=>res.status(404).json({ok:false,error:'API endpoint not found.'}));
app.use((err,req,res,next)=>{
  console.error('EXPRESS ERROR:',err);
  if(res.headersSent) return next(err);
  res.status(500).json({ok:false,error:'Internal server error.'});
});

server.listen(PORT,'0.0.0.0',()=>{
  console.log('========================================');
  console.log('        EWS SESSIONS SERVER READY');
  console.log('========================================');
  console.log('WEB: http://localhost:'+PORT);
  console.log('RTMP: rtmp://localhost:'+RTMP_PORT+'/live');
  console.log('HLS: http://localhost:'+PORT+'/hls/');
  console.log('SCREEN OWNER: mvxtra');
  console.log('CHAT TRANSLATION: PERSONAL');
  console.log('MULTIPLAYER: ON');
  console.log('ONLINE USERS: ON');
  console.log('DANCES / EMOTES: ON');
  console.log('USERS FILE: ./users.json');
  console.log('========================================');
});

function shutdown(){
  console.log('EWS SESSIONS shutting down...');
  try{if(nms) nms.stop();}catch(e){console.error(e);}
  server.close(()=>process.exit(0));
}
process.on('SIGINT',shutdown);
process.on('SIGTERM',shutdown);
