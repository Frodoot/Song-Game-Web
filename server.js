// server.js
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const axios = require('axios');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Хранилище песен в памяти
let songs = [];
let nextSongId = 1;

// Комнаты: { roomId: { players: { socketId: { name, score, ... }, ... }, currentSong, currentLineIndex, gameActive, lineTimeout, nextLineTime, gameInterval } }
const rooms = new Map();

// Вспомогательная функция: получение текста песни через lyrics.ovh API
async function fetchLyrics(artist, title) {
  try {
    const response = await axios.get(`https://api.lyrics.ovh/v1/${encodeURIComponent(artist)}/${encodeURIComponent(title)}`);
    return response.data.lyrics;
  } catch (error) {
    console.error('Ошибка получения текста:', error.message);
    return null;
  }
}

// Разбивка текста на строки (непустые строки, обрезаем)
function splitLyricsToLines(lyrics) {
  return lyrics.split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0);
}

// Создание временных меток для строк (равномерно по длительности песни)
function generateTimestamps(lines, durationSeconds) {
  if (lines.length === 0) return [];
  const interval = durationSeconds / lines.length;
  return lines.map((line, index) => ({
    text: line,
    time: index * interval
  }));
}

// API: получить все песни
app.get('/api/songs', (req, res) => {
  res.json(songs);
});

// API: добавить новую песню
app.post('/api/songs', async (req, res) => {
  const { title, artist, audioUrl, duration } = req.body;
  if (!title || !artist || !audioUrl || !duration) {
    return res.status(400).json({ error: 'Не все поля заполнены' });
  }
  
  // Получаем текст через API
  const lyrics = await fetchLyrics(artist, title);
  if (!lyrics) {
    return res.status(404).json({ error: 'Текст песни не найден' });
  }
  
  const linesRaw = splitLyricsToLines(lyrics);
  if (linesRaw.length === 0) {
    return res.status(400).json({ error: 'Текст песни пуст' });
  }
  
  const linesWithTime = generateTimestamps(linesRaw, parseFloat(duration));
  
  const newSong = {
    id: nextSongId++,
    title,
    artist,
    audioUrl,
    duration: parseFloat(duration),
    lines: linesWithTime
  };
  
  songs.push(newSong);
  res.status(201).json(newSong);
});

// Socket.IO логика
io.on('connection', (socket) => {
  console.log('Новый игрок подключился:', socket.id);
  
  // Создание комнаты
  socket.on('createRoom', ({ playerName, songId }) => {
    const roomId = Math.random().toString(36).substring(2, 8).toUpperCase();
    const song = songs.find(s => s.id === songId);
    if (!song) {
      socket.emit('error', 'Песня не найдена');
      return;
    }
    
    rooms.set(roomId, {
      players: new Map(), // socketId -> { name, score }
      song: song,
      currentLineIndex: -1,
      gameActive: false,
      gameInterval: null,
      hostId: socket.id,
      roomId: roomId
    });
    
    socket.join(roomId);
    rooms.get(roomId).players.set(socket.id, { name: playerName, score: 0 });
    
    socket.emit('roomCreated', { roomId });
    io.to(roomId).emit('playersUpdate', getPlayersList(roomId));
  });
  
  // Присоединение к комнате
  socket.on('joinRoom', ({ roomId, playerName }) => {
    const room = rooms.get(roomId);
    if (!room) {
      socket.emit('error', 'Комната не найдена');
      return;
    }
    if (room.gameActive) {
      socket.emit('error', 'Игра уже началась');
      return;
    }
    
    socket.join(roomId);
    room.players.set(socket.id, { name: playerName, score: 0 });
    
    io.to(roomId).emit('playersUpdate', getPlayersList(roomId));
    socket.emit('roomJoined', { roomId, song: room.song });
  });
  
  // Запуск игры (только хост)
  socket.on('startGame', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    if (socket.id !== room.hostId) {
      socket.emit('error', 'Только создатель комнаты может начать игру');
      return;
    }
    if (room.gameActive) return;
    
    room.gameActive = true;
    room.currentLineIndex = -1;
    // Обнуляем очки игроков
    for (let [id, player] of room.players.entries()) {
      player.score = 0;
    }
    io.to(roomId).emit('playersUpdate', getPlayersList(roomId));
    
    // Рассылаем команду на запуск аудио и начало игры
    io.to(roomId).emit('gameStarting', { song: room.song });
    
    // Запускаем игровой таймер (смена строк)
    startGameLoop(roomId);
  });
  
  // Нажатие на строку игроком
  socket.on('pressLine', ({ roomId, lineIndex, lineText }) => {
    const room = rooms.get(roomId);
    if (!room || !room.gameActive) return;
    if (room.currentLineIndex !== lineIndex) return; // Не та строка
    
    const player = room.players.get(socket.id);
    if (!player) return;
    
    // Начисляем очки (чем быстрее, тем больше, но для простоты +10)
    player.score += 10;
    io.to(roomId).emit('playersUpdate', getPlayersList(roomId));
    io.to(roomId).emit('linePressed', { playerName: player.name, lineText });
    
    // Переходим к следующей строке
    nextLine(roomId);
  });
  
  // Отключение игрока
  socket.on('disconnect', () => {
    console.log('Игрок отключился:', socket.id);
    for (let [roomId, room] of rooms.entries()) {
      if (room.players.has(socket.id)) {
        room.players.delete(socket.id);
        if (room.players.size === 0) {
          // Комната пуста, удаляем
          if (room.gameInterval) clearInterval(room.gameInterval);
          rooms.delete(roomId);
        } else {
          io.to(roomId).emit('playersUpdate', getPlayersList(roomId));
          if (socket.id === room.hostId && room.gameActive === false) {
            // Хост ушёл, назначаем нового хоста
            const newHost = room.players.keys().next().value;
            room.hostId = newHost;
            io.to(roomId).emit('hostChanged', { newHostId: newHost });
          }
          if (room.gameActive) {
            // Если игра активна, прекращаем её
            if (room.gameInterval) clearInterval(room.gameInterval);
            room.gameActive = false;
            io.to(roomId).emit('gameAborted', 'Один из игроков отключился');
          }
        }
        break;
      }
    }
  });
});

function getPlayersList(roomId) {
  const room = rooms.get(roomId);
  if (!room) return [];
  return Array.from(room.players.entries()).map(([id, p]) => ({
    id,
    name: p.name,
    score: p.score
  }));
}

function startGameLoop(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  
  const lines = room.song.lines;
  let lineIndex = 0;
  
  function scheduleNextLine() {
    if (!room.gameActive) return;
    if (lineIndex >= lines.length) {
      // Игра окончена
      endGame(roomId);
      return;
    }
    
    room.currentLineIndex = lineIndex;
    const line = lines[lineIndex];
    io.to(roomId).emit('newLine', { lineIndex: lineIndex, lineText: line.text, time: line.time });
    
    // Устанавливаем таймаут для автоматического перехода к следующей строке, если никто не нажал
    const lineDuration = (lineIndex < lines.length - 1) ? (lines[lineIndex+1].time - line.time) : (room.song.duration - line.time);
    room.nextLineTimeout = setTimeout(() => {
      if (room.gameActive && room.currentLineIndex === lineIndex) {
        nextLine(roomId);
      }
    }, lineDuration * 1000);
    
    lineIndex++;
  }
  
  room.gameInterval = setInterval(() => {
    if (room.gameActive && room.currentLineIndex === -1) {
      // Запускаем первую строку
      scheduleNextLine();
    }
  }, 100);
  
  // Небольшая задержка для синхронизации с аудио
  setTimeout(() => {
    if (room.gameActive && room.currentLineIndex === -1) {
      scheduleNextLine();
    }
  }, 500);
}

function nextLine(roomId) {
  const room = rooms.get(roomId);
  if (!room || !room.gameActive) return;
  if (room.nextLineTimeout) clearTimeout(room.nextLineTimeout);
  room.currentLineIndex = -1;
  // Следующая строка будет взята в цикле
}

function endGame(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  room.gameActive = false;
  if (room.gameInterval) clearInterval(room.gameInterval);
  if (room.nextLineTimeout) clearTimeout(room.nextLineTimeout);
  
  // Определяем победителя
  let winner = null;
  let maxScore = -1;
  for (let [id, player] of room.players.entries()) {
    if (player.score > maxScore) {
      maxScore = player.score;
      winner = player.name;
    }
  }
  io.to(roomId).emit('gameEnded', { winner, players: getPlayersList(roomId) });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Сервер запущен на порту ${PORT}`);
});