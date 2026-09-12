const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Статические файлы из папки public
app.use(express.static(path.join(__dirname, 'public')));

// Резервный маршрут для отдачи index.html
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const players = {};

function getRandomSpawn() {
  return {
    x: (Math.random() - 0.5) * 160,
    z: (Math.random() - 0.5) * 160
  };
}

io.on('connection', (socket) => {
  socket.on('joinGame', (data) => {
    const spawn = getRandomSpawn();
    players[socket.id] = {
      id: socket.id,
      name: data.name || 'Игрок',
      type: data.type,
      x: spawn.x,
      z: spawn.z,
      rotationY: 0,
      turretRotationY: 0,
      hp: data.maxHp
    };

    socket.emit('initPlayer', players[socket.id]);
    socket.emit('currentPlayers', players);
    socket.broadcast.emit('newPlayer', players[socket.id]);
  });

  socket.on('playerUpdate', (data) => {
    if (players[socket.id]) {
      players[socket.id].x = data.x;
      players[socket.id].z = data.z;
      players[socket.id].rotationY = data.rotationY;
      players[socket.id].turretRotationY = data.turretRotationY;
      socket.broadcast.emit('playerMoved', players[socket.id]);
    }
  });

  socket.on('shoot', (bulletData) => {
    socket.broadcast.emit('playerShot', {
      shooterId: socket.id,
      ...bulletData
    });
  });

  socket.on('playerHit', (data) => {
    const target = players[data.targetId];
    if (target) {
      target.hp -= data.damage;
      if (target.hp <= 0) {
        const killerName = players[socket.id] ? players[socket.id].name : 'Аноним';
        const victimName = target.name;

        io.emit('killEvent', { killer: killerName, victim: victimName });
        io.to(data.targetId).emit('youDied');
        
        delete players[data.targetId];
        io.emit('playerDisconnected', data.targetId);
      } else {
        io.emit('hpUpdate', { id: target.id, hp: target.hp });
      }
    }
  });

  socket.on('disconnect', () => {
    delete players[socket.id];
    io.emit('playerDisconnected', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Сервер запущен на порту ${PORT}`);
});
