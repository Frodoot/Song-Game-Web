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

// Функция получения синхронизированных строк через API LRCLIB
async function fetchSyncedLyricsFromLRCLIB(artist, title) {
  try {
    // LRCLIB API endpoint для поиска
    const url = `https://lrclib.net/api/get?artist_name=${encodeURIComponent(artist)}&track_name=${encodeURIComponent(title)}`;
    const response = await axios.get(url);
    
    const data = response.data;
    if (!data || !data.syncedLyrics) {
      console.log(`Синхронизированный текст не найден для "${title}" от "${artist}"`);
      return null;
    }
    
    // Парсим LRC формат: [mm:ss.xx] текст строки
    const lrcString = data.syncedLyrics;
    const lines = parseLRC(lrcString);
    
    if (lines.length === 0) return null;
    
    // Преобразуем в формат { text: string, time: number (секунды) }
    return lines.map(line => ({
      text: line.text,
      time: line.time
    }));
  } catch (error) {
    console.error(`Ошибка при запросе к LRCLIB: ${error.message}`);
    return null;
  }
}

// Парсер LRC строки
function parseLRC(lrcContent) {
  const lines = lrcContent.split('\n');
  const result = [];
  const timeRegex = /\[(\d{2}):(\d{2})\.(\d{2})\]/;
  
  for (const line of lines) {
    const match = timeRegex.exec(line);
    if (match) {
      const minutes = parseInt(match[1], 10);
      const seconds = parseInt(match[2], 10);
      const centiseconds = parseInt(match[3], 10);
      const timeInSeconds = minutes * 60 + seconds + centiseconds / 100;
      
      const text = line.replace(timeRegex, '').trim();
      if (text) {
        result.push({ time: timeInSeconds, text });
      }
    }
  }
  return result;
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

    const linesWithTime = await fetchSyncedLyricsFromLRCLIB(artist, title);
    if (!linesWithTime || linesWithTime.length === 0) {
      fs.unlinkSync(audioPath);
      return res.status(404).json({ error: 'Синхронизированный текст не найден. Попробуйте другую песню.' });
    }

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
      audioUrl: `/uploads/${req.file.filename}`,
      jsonUrl: `/uploads/${jsonFilename}`
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

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
      gameActive: false,
      hostId: socket.id,
      roomId: roomId,
      questionTimeouts: [],   // массив таймаутов для всех строк
      currentLineTimeout: null, // таймаут закрытия текущего вопроса
      currentLineIndex: -1,
      answeredPlayers: new Set()
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
  
// Обработчик ответа игрока
socket.on('pressLine', ({ roomId, selectedText }) => {
  const room = rooms.get(roomId);
  if (!room || !room.gameActive) return;
  const currentIndex = room.currentLineIndex;
  if (currentIndex === -1) return;
  
  const player = room.players.get(socket.id);
  if (!player) return;
  
  if (room.answeredPlayers.has(socket.id)) {
    socket.emit('answerResult', { correct: false, message: 'Вы уже отвечали на этот вопрос!' });
    return;
  }
  
  const correctText = room.song.lines[currentIndex].text;
  if (selectedText === correctText) {
    player.score += 10;
    io.to(roomId).emit('playersUpdate', getPlayersList(roomId));
    socket.emit('answerResult', { correct: true, message: 'Правильно! +10 очков' });
  } else {
    socket.emit('answerResult', { correct: false, message: 'Неправильно!' });
  }
  room.answeredPlayers.add(socket.id);
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
  if (!room || !room.gameActive) return;
  
  const lines = room.song.lines;
  if (!lines.length) {
    endGame(roomId);
    return;
  }
  
  const startTime = Date.now();
  room.questionTimeouts = [];
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const delayMs = line.time * 1000; // время строки от начала песни
    const elapsed = Date.now() - startTime;
    let delay = delayMs - elapsed;
    if (delay < 0) delay = 0;
    
    const timeoutId = setTimeout(() => {
      if (!room.gameActive) return;
      
      // Отправляем вопрос для строки i
      room.currentLineIndex = i;
      room.answeredPlayers.clear();
      const correctLine = lines[i];
      
      // Генерация вариантов
      const distractors = getDistractors(correctLine.text, lines, 3);
      let options = [correctLine.text, ...distractors];
      for (let j = options.length - 1; j > 0; j--) {
        const k = Math.floor(Math.random() * (j + 1));
        [options[j], options[k]] = [options[k], options[j]];
      }
      
      io.to(roomId).emit('newQuestion', {
        lineIndex: i,
        correctText: correctLine.text,
        options: options,
        time: correctLine.time
      });
      
      // Длительность текущей строки (до следующей или конца песни)
      const nextTime = (i < lines.length - 1) ? lines[i+1].time : room.song.duration;
      const lineDurationSec = nextTime - line.time;
      
      // Таймаут на закрытие вопроса (автоматический переход)
      if (room.currentLineTimeout) clearTimeout(room.currentLineTimeout);
      room.currentLineTimeout = setTimeout(() => {
        if (room.gameActive && room.currentLineIndex === i) {
          // Закрываем вопрос, сбрасываем индекс
          room.currentLineIndex = -1;
          room.answeredPlayers.clear();
          // Следующий вопрос уже запланирован своим таймаутом
        }
      }, lineDurationSec * 1000);
      
    }, delay);
    
    room.questionTimeouts.push(timeoutId);
  }
  
  // Таймаут на завершение игры после последней строки
  const lastLine = lines[lines.length - 1];
  const lastLineEndSec = room.song.duration;
  const gameEndDelay = (lastLineEndSec * 1000) - (Date.now() - startTime);
  if (gameEndDelay > 0) {
    const endTimeout = setTimeout(() => {
      endGame(roomId);
    }, gameEndDelay);
    room.questionTimeouts.push(endTimeout);
  }
}

function nextLine(roomId) {
  const room = rooms.get(roomId);
  if (!room || !room.gameActive) return;
  if (room.nextLineTimeout) clearTimeout(room.nextLineTimeout);
  room.currentLineIndex = -1;
}
  
function endGame(roomId) {
    const room = rooms.get(roomId);
    if (!room) return;
    room.gameActive = false;
    if (room.gameInterval) clearInterval(room.gameInterval);
    if (room.nextLineTimeout) clearTimeout(room.nextLineTimeout);
    if (room.questionTimeouts) {
      room.questionTimeouts.forEach(clearTimeout);
      room.questionTimeouts = [];
    }
    
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
  const otherLines = allLines.filter(line => line.text !== currentLineText).map(line => line.text);
  const uniqueOthers = [...new Set(otherLines)];
  if (uniqueOthers.length < count) {
    while (uniqueOthers.length < count) uniqueOthers.push(...uniqueOthers);
  }
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