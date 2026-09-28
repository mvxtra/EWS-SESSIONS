const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Раздаём статику из public/
app.use(express.static(path.join(__dirname, 'public')));

// Хранилище игроков
const players = {}; // socketId -> { nickname, position, rotation, avatarStyle }

io.on('connection', (socket) => {
  console.log(`[+] Подключение: ${socket.id}`);

  // --- Игрок заходит ---
  socket.on('join', (data) => {
    const nickname = data.nickname || ('Player_' + Math.floor(Math.random() * 1000));
    const avatarStyle = Math.floor(Math.random() * 4);

    players[socket.id] = {
      nickname: nickname,
      position: { x: 0, y: 0, z: 0 },
      rotation: 0,
      avatarStyle: avatarStyle
    };

    // Отправляем новому игроку список всех, кто уже в клубе
    const list = [];
    for (const [id, p] of Object.entries(players)) {
      if (id !== socket.id) {
        list.push({
          socketId: id,
          nickname: p.nickname,
          avatarData: { style: p.avatarStyle },
          position: p.position
        });
      }
    }
    socket.emit('players-list', list);

    // Сообщаем остальным о новом игроке
    socket.broadcast.emit('player-join', {
      socketId: socket.id,
      nickname: nickname,
      avatarData: { style: avatarStyle },
      position: { x: 0, y: 0, z: 0 }
    });

    console.log(`    -> ${nickname} зашёл в клуб (стиль ${avatarStyle})`);
  });

  // --- Игрок двигается ---
  socket.on('player-move', (data) => {
    if (players[socket.id]) {
      players[socket.id].position = data.position;
      players[socket.id].rotation = data.rotation || 0;

      // Рассылаем всем остальным
      socket.broadcast.emit('player-move', {
        socketId: socket.id,
        position: data.position,
        rotation: data.rotation || 0
      });
    }
  });

  // --- Эмодзи ---
  socket.on('emoji', (data) => {
    socket.broadcast.emit('emoji', {
      socketId: socket.id,
      position: data.position,
      emoji: data.emoji
    });
  });

  // --- Игрок выходит ---
  socket.on('disconnect', () => {
    if (players[socket.id]) {
      const nickname = players[socket.id].nickname;
      delete players[socket.id];
      socket.broadcast.emit('player-leave', socket.id);
      console.log(`[-] Отключение: ${nickname} (${socket.id})`);
    }
  });
});

// --- Реконнект ---
io.on('reconnect', (socket) => {
  console.log(`[~] Реконнект: ${socket.id}`);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n  Клуб запущен на http://localhost:${PORT}\n  Порт: ${PORT}\n  Ожидание посетителей...\n`);
});
