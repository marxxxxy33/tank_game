const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const players = {};

function getRandomSpawn() {
  return {
    x: (Math.random() - 0.5) * 160,
    z: (Math.random() - 0.5) * 160
  };
}

io.on('connection', (socket) => {
  // Присоединение игрока с именем и выбранным танком
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

    // Отправляем новому игроку его спавн и текущих игроков
    socket.emit('initPlayer', players[socket.id]);
    socket.emit('currentPlayers', players);

    // Уведомляем остальных
    socket.broadcast.emit('newPlayer', players[socket.id]);
  });

  // Перемещение и поворот
  socket.on('playerUpdate', (data) => {
    if (players[socket.id]) {
      players[socket.id].x = data.x;
      players[socket.id].z = data.z;
      players[socket.id].rotationY = data.rotationY;
      players[socket.id].turretRotationY = data.turretRotationY;
      socket.broadcast.emit('playerMoved', players[socket.id]);
    }
  });

  // Обработка выстрела (пересылаем всем остальным)
  socket.on('shoot', (bulletData) => {
    socket.broadcast.emit('playerShot', {
      shooterId: socket.id,
      ...bulletData
    });
  });

  // Обработка попадания и смерти
  socket.on('playerHit', (data) => {
    const target = players[data.targetId];
    if (target) {
      target.hp -= data.damage;
      if (target.hp <= 0) {
        const killerName = players[socket.id] ? players[socket.id].name : 'Аноним';
        const victimName = target.name;

        // Отправляем сообщение в киллчат
        io.emit('killEvent', { killer: killerName, victim: victimName });
        
        // Уведомляем погибшего игрока о смерти
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