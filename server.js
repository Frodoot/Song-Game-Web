const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const axios = require('axios');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const getMP3Duration = require('mp3-duration');

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
app.use('/songs', express.static('songs'));

// Создаём папку для загрузок
const uploadDir = './songs';
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

// Настройка multer для загрузки MP3
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const unique = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, unique + '.mp3');
  }
});
const upload = multer({ storage, limits: { fileSize: 20 * 1024 * 1024 } });

// Хранилище песен в памяти (загружаем из файловой системы при старте)
let songs = [];
let nextSongId = 1;
const songsFilePath = path.join(uploadDir, 'songs_index.json');

// Загрузка индекса песен при запуске
function loadSongsIndex() {
  if (fs.existsSync(songsFilePath)) {
    const data = fs.readFileSync(songsFilePath, 'utf8');
    const loaded = JSON.parse(data);
    songs = loaded.songs;
    nextSongId = loaded.nextSongId;
    console.log(`Загружено ${songs.length} песен из индекса`);
  } else {
    songs = [];
    nextSongId = 1;
  }
}

// Сохранение индекса песен
function saveSongsIndex() {
  fs.writeFileSync(songsFilePath, JSON.stringify({ songs, nextSongId }, null, 2));
}

loadSongsIndex();

// Получение текста через lyrics.ovh API
async function fetchLyrics(artist, title) {
  try {
    const response = await axios.get(`https://api.lyrics.ovh/v1/${encodeURIComponent(artist)}/${encodeURIComponent(title)}`);
    return response.data.lyrics;
  } catch (error) {
    console.error('Ошибка получения текста:', error.message);
    return null;
  }
}

// Разбивка текста на строки
function splitLyricsToLines(lyrics) {
  return lyrics.split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0);
}

// Генерация таймстампов равномерно по длительности
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
  res.json(songs.map(s => ({
    id: s.id,
    title: s.title,
    artist: s.artist,
    duration: s.duration,
    audioUrl: `/songs/${s.audioFile}`,
    jsonUrl: `/songs/${s.jsonFile}`
  })));
});

// API: добавить новую песню (загрузка MP3)
app.post('/api/songs', upload.single('audio'), async (req, res) => {
  try {
    const { title, artist } = req.body;
    if (!title || !artist || !req.file) {
      return res.status(400).json({ error: 'Не заполнены название, исполнитель или не загружен MP3' });
    }

    const audioPath = path.join(uploadDir, req.file.filename);
    
    // Получаем длительность из MP3
    let duration;
    try {
      duration = await new Promise((resolve, reject) => {
        getMP3Duration(audioPath, (err, dur) => {
          if (err) reject(err);
          else resolve(dur);
        });
      });
    } catch (err) {
      fs.unlinkSync(audioPath);
      return res.status(400).json({ error: 'Не удалось прочитать длительность MP3-файла' });
    }

    // Получаем текст через API
    const lyrics = await fetchLyrics(artist, title);
    if (!lyrics) {
      fs.unlinkSync(audioPath);
      return res.status(404).json({ error: 'Текст песни не найден' });
    }

    const linesRaw = splitLyricsToLines(lyrics);
    if (linesRaw.length === 0) {
      fs.unlinkSync(audioPath);
      return res.status(400).json({ error: 'Текст песни пуст' });
    }

    const linesWithTime = generateTimestamps(linesRaw, duration);

    // Сохраняем JSON файл
    const jsonFilename = req.file.filename.replace('.mp3', '.json');
    const jsonPath = path.join(uploadDir, jsonFilename);
    fs.writeFileSync(jsonPath, JSON.stringify({
      title,
      artist,
      duration,
      lines: linesWithTime
    }, null, 2));

    const newSong = {
      id: nextSongId++,
      title,
      artist,
      duration,
      audioFile: req.file.filename,
      jsonFile: jsonFilename
    };

    songs.push(newSong);
    saveSongsIndex();

    res.status(201).json({
      id: newSong.id,
      title,
      artist,
      duration,
      audioUrl: `/songs/${req.file.filename}`,
      jsonUrl: `/songs/${jsonFilename}`
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

// --- Socket.IO логика (как была, но с корректной передачей комнат) ---
// Для работы комнат используем Map, объявленный вне, чтобы он сохранялся между соединениями
const rooms = new Map();

io.on('connection', (socket) => {
  console.log('Новый игрок подключился:', socket.id);

  socket.on('createRoom', ({ playerName, songId }) => {
    const roomId = Math.random().toString(36).substring(2, 8).toUpperCase();
    const song = songs.find(s => s.id === songId);
    if (!song) {
      socket.emit('error', 'Песня не найдена');
      return;
    }
    
    // Загружаем полные данные песни из JSON файла
    const jsonPath = path.join(uploadDir, song.jsonFile);
    let songData;
    try {
      songData = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    } catch (e) {
      socket.emit('error', 'Ошибка загрузки данных песни');
      return;
    }
    
    rooms.set(roomId, {
      players: new Map(),
      song: { ...song, lines: songData.lines, duration: songData.duration },
      currentLineIndex: -1,
      gameActive: false,
      gameInterval: null,
      nextLineTimeout: null,
      hostId: socket.id,
      roomId: roomId
    });
    
    socket.join(roomId);
    rooms.get(roomId).players.set(socket.id, { name: playerName, score: 0 });
    
    socket.emit('roomCreated', { roomId });
    io.to(roomId).emit('playersUpdate', getPlayersList(roomId));
  });
  
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
    socket.emit('roomJoined', { roomId, song: { ...room.song, audioUrl: `/songs/${room.song.audioFile}` } });
  });
  
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
    for (let [id, player] of room.players.entries()) {
      player.score = 0;
    }
    io.to(roomId).emit('playersUpdate', getPlayersList(roomId));
    io.to(roomId).emit('gameStarting', { song: { ...room.song, audioUrl: `/songs/${room.song.audioFile}` } });
    
    startGameLoop(roomId);
  });
  
    socket.on('pressLine', ({ roomId, selectedText }) => {
        const room = rooms.get(roomId);
        if (!room || !room.gameActive) return;
        const currentIndex = room.currentLineIndex;
        if (currentIndex === -1) return;
        const correctText = room.song.lines[currentIndex].text;
        const player = room.players.get(socket.id);
        if (!player) return;

        if (selectedText !== correctText) {
            // Неправильный ответ – можно отправить уведомление, но не переходить
            io.to(roomId).emit('wrongAnswer', { playerName: player.name, selectedText });
            return;
        }

        // Правильный ответ
        player.score += 10;
        io.to(roomId).emit('playersUpdate', getPlayersList(roomId));
        io.to(roomId).emit('correctAnswer', { playerName: player.name });
        nextLine(roomId);
    });
  
  socket.on('disconnect', () => {
    console.log('Игрок отключился:', socket.id);
    for (let [roomId, room] of rooms.entries()) {
      if (room.players.has(socket.id)) {
        room.players.delete(socket.id);
        if (room.players.size === 0) {
          if (room.gameInterval) clearInterval(room.gameInterval);
          if (room.nextLineTimeout) clearTimeout(room.nextLineTimeout);
          rooms.delete(roomId);
        } else {
          io.to(roomId).emit('playersUpdate', getPlayersList(roomId));
          if (socket.id === room.hostId && room.gameActive === false) {
            const newHost = room.players.keys().next().value;
            room.hostId = newHost;
            io.to(roomId).emit('hostChanged', { newHostId: newHost });
          }
          if (room.gameActive) {
            if (room.gameInterval) clearInterval(room.gameInterval);
            if (room.nextLineTimeout) clearTimeout(room.nextLineTimeout);
            room.gameActive = false;
            io.to(roomId).emit('gameAborted', 'Один из игроков отключился');
          }
        }
        break;
      }
    }
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
        endGame(roomId);
        return;
        }
        
        room.currentLineIndex = lineIndex;
        const correctLine = lines[lineIndex];
        // Генерируем варианты
        const distractors = getDistractors(correctLine.text, lines, 3);
        let options = [correctLine.text, ...distractors];
        // Перемешиваем варианты
        for (let i = options.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [options[i], options[j]] = [options[j], options[i]];
        }
        
        io.to(roomId).emit('newQuestion', {
        lineIndex: lineIndex,
        correctText: correctLine.text,
        options: options,
        time: correctLine.time
        });
        
        const nextTime = (lineIndex < lines.length - 1) ? lines[lineIndex+1].time : room.song.duration;
        const lineDuration = nextTime - correctLine.time;
        room.nextLineTimeout = setTimeout(() => {
        if (room.gameActive && room.currentLineIndex === lineIndex) {
            // Время вышло – никто не ответил, переходим к следующей строке
            nextLine(roomId);
        }
        }, lineDuration * 1000);
        
        lineIndex++;
    }

    room.gameInterval = setInterval(() => {
        if (room.gameActive && room.currentLineIndex === -1) {
        scheduleNextLine();
        }
    }, 100);

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
    // Клиенту можно отправить сигнал, что строка завершена (опционально)
    io.to(roomId).emit('lineFinished');
  }
  
  function endGame(roomId) {
    const room = rooms.get(roomId);
    if (!room) return;
    room.gameActive = false;
    if (room.gameInterval) clearInterval(room.gameInterval);
    if (room.nextLineTimeout) clearTimeout(room.nextLineTimeout);
    
    let winner = null;
    let maxScore = -1;
    for (let [id, player] of room.players.entries()) {
      if (player.score > maxScore) {
        maxScore = player.score;
        winner = player.name;
      }
    }
    io.to(roomId).emit('gameEnded', { winner, players: getPlayersList(roomId) });
    rooms.delete(roomId);
  }
});

// Генерация отвлекающих вариантов (distractors)
function getDistractors(currentLineText, allLines, count = 3) {
  // allLines - массив объектов {text, time}
  const otherLines = allLines.filter(line => line.text !== currentLineText).map(line => line.text);
  const uniqueOthers = [...new Set(otherLines)]; // убираем дубликаты текста
  if (uniqueOthers.length < count) {
    // Если недостаточно уникальных строк, повторяем
    while (uniqueOthers.length < count) uniqueOthers.push(...uniqueOthers);
  }
  // Перемешиваем и берём первые count
  for (let i = uniqueOthers.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [uniqueOthers[i], uniqueOthers[j]] = [uniqueOthers[j], uniqueOthers[i]];
  }
  return uniqueOthers.slice(0, count);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Сервер запущен на порту ${PORT}`);
});