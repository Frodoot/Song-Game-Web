const os = require('os');
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const axios = require('axios');
const multer = require('multer');
const fs = require('fs');
const fsPromises = require('fs').promises;
const path = require('path');
const getMP3Duration = require('mp3-duration');

const cookieParser = require('cookie-parser');
const { randomUUID } = require('crypto');

const ffmpeg = require('fluent-ffmpeg');
const ffmpegStatic = require('ffmpeg-static');
const ffprobeStatic = require('ffprobe-static');
ffmpeg.setFfmpegPath(ffmpegStatic);
ffmpeg.setFfprobePath(ffprobeStatic.path);
const { tmpName } = require('tmp');
const { promisify } = require('util');
const tmpNameAsync = promisify(tmpName);
const FormData = require('form-data');

const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);

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

app.use(cookieParser());

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

// Получить количество вариантов в зависимости от времени
function getDifficultyAtTime(difficultyChanges, currentTime) {
  let currentDifficulty = 4; // по умолчанию 4 варианта
  if (!difficultyChanges) return currentDifficulty;
  // Сортируем по возрастанию afterDuration (на всякий случай)
  const sorted = [...difficultyChanges].sort((a,b) => a.afterDuration - b.afterDuration);
  for (const change of sorted) {
    if (currentTime >= change.afterDuration) {
      currentDifficulty = change.difficulty;
    } else {
      break;
    }
  }
  return currentDifficulty;
}

// Генерация вариантов с нужным количеством отвлекающих
function getOptionsForLine(correctText, allLines, difficulty) {
  const distractorsCount = difficulty - 1;
  if (distractorsCount <= 0) return [correctText];
  
  const otherLines = allLines.filter(line => line.text !== correctText).map(line => line.text);
  const uniqueOthers = [...new Set(otherLines)];
  let distractors = [];
  
  if (uniqueOthers.length >= distractorsCount) {
    // Перемешиваем и берём первые distractorsCount
    for (let i = uniqueOthers.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [uniqueOthers[i], uniqueOthers[j]] = [uniqueOthers[j], uniqueOthers[i]];
    }
    distractors = uniqueOthers.slice(0, distractorsCount);
  } else {
    // Если уникальных строк недостаточно, повторяем
    while (distractors.length < distractorsCount) {
      distractors.push(...uniqueOthers);
    }
    distractors = distractors.slice(0, distractorsCount);
  }
  
  let options = [correctText, ...distractors];
  // Перемешиваем финальный массив
  for (let i = options.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [options[i], options[j]] = [options[j], options[i]];
  }
  return options;
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
  const currentToken = req.cookies.songOwnerToken || null;
  const songsList = songs.map(s => {
    const jsonPath = path.join(uploadDir, s.jsonFile);
    let ownerToken = null;
    try {
      const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
      ownerToken = data.ownerToken;
    } catch(e) {}
    return {
      id: s.id,
      title: s.title,
      artist: s.artist,
      duration: s.duration,
      audioUrl: `/songs/${s.audioFile}`,
      jsonUrl: `/songs/${s.jsonFile}`,
      canEdit: currentToken && ownerToken && currentToken === ownerToken
    };
  });
  res.json(songsList);
});

// API: добавить новую песню
app.post('/api/songs', upload.single('media'), async (req, res) => {
    let tempAudioPath = null;
    try {
        const { title, artist } = req.body;
        const file = req.file;
        if (!title || !artist || !file) {
            throw new Error('Не заполнены название, исполнитель или файл');
        }

        const ext = path.extname(file.originalname).toLowerCase();
        const isVideo = ['.mp4', '.webm', '.avi', '.mov', '.mkv'].includes(ext);
        const isAudio = ['.mp3', '.m4a', '.wav', '.ogg'].includes(ext);
        if (!isVideo && !isAudio) {
            throw new Error('Неподдерживаемый формат. Загрузите MP3, M4A или видео.');
        }

        let audioPathForProcessing = file.path;
        if (isVideo) {
            console.log('Извлечение аудио из видео...');
            tempAudioPath = await extractAudioFromVideo(file.path);
            audioPathForProcessing = tempAudioPath;
            console.log('Аудио извлечено:', tempAudioPath);
        }

        // Длительность
        let duration = null;
        try {
            duration = await getAudioDuration(audioPathForProcessing);
            console.log('Длительность:', duration);
        } catch (err) {
            console.warn('Не удалось получить длительность:', err.message);
        }

        // Получение текста: сначала LRCLIB (только для аудио), затем транскрипция
        let lines = null;
        if (!isVideo) {
            lines = await fetchSyncedLyricsFromLRCLIB(artist, title);
            if (lines) console.log(`LRCLIB: ${lines.length} строк`);
        }

        if (!lines || lines.length === 0) {
            console.log('Транскрипция аудио...');
            lines = await transcribeAudio(audioPathForProcessing);
            console.log(`Транскрипция: ${lines.length} строк`);
        }

        if (!lines || lines.length === 0) {
            throw new Error('Не удалось получить текст песни');
        }

        if (!duration || duration === 0) {
            duration = lines[lines.length - 1].time + 2;
        }

        // Сохраняем JSON
        const jsonFilename = file.filename.replace(/\.[^/.]+$/, '.json');
        const jsonPath = path.join(uploadDir, jsonFilename);
        const ownerToken = req.cookies.songOwnerToken || randomUUID();
        res.cookie('songOwnerToken', ownerToken, { maxAge: 365 * 24 * 60 * 60 * 1000, httpOnly: true });

        const songData = {
            title,
            artist,
            duration,
            lines,
            difficultyChanges: [],
            ownerToken,
            originalFormat: isVideo ? 'video' : 'audio'
        };
        await fsPromises.writeFile(jsonPath, JSON.stringify(songData, null, 2));

        const newSong = {
            id: nextSongId++,
            title,
            artist,
            duration,
            audioFile: file.filename,
            jsonFile: jsonFilename
        };
        songs.push(newSong);
        saveSongsIndex();

        if (tempAudioPath) await fsPromises.unlink(tempAudioPath).catch(() => {});
        res.status(201).json({ id: newSong.id, title, artist, duration, audioUrl: `/songs/${file.filename}` });

    } catch (err) {
        console.error('Ошибка при добавлении песни:', err);
        if (req.file) await fsPromises.unlink(req.file.path).catch(() => {});
        if (tempAudioPath) await fsPromises.unlink(tempAudioPath).catch(() => {});
        res.status(500).json({ error: err.message });
    }
});

// Получить полные данные песни по ID
app.get('/api/songs/:id', (req, res) => {
  const song = songs.find(s => s.id == req.params.id);
  if (!song) return res.status(404).json({ error: 'Песня не найдена' });
  const jsonPath = path.join(uploadDir, song.jsonFile);
  try {
    const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    res.json({ ...song, ...data, audioUrl: `/songs/${song.audioFile}`});
  } catch (e) {
    res.status(500).json({ error: 'Ошибка чтения файла песни' });
  }
});

// Обновить данные песни
app.put('/api/songs/:id', (req, res) => {
  const song = songs.find(s => s.id == req.params.id);
  if (!song) return res.status(404).json({ error: 'Песня не найдена' });
  
  // Проверка прав
  const jsonPath = path.join(uploadDir, song.jsonFile);
  let songData;
  try {
    songData = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  } catch(e) {
    return res.status(500).json({ error: 'Ошибка чтения' });
  }
  const currentToken = req.cookies.songOwnerToken;
  if (!currentToken || songData.ownerToken !== currentToken) {
    return res.status(403).json({ error: 'Нет прав на редактирование этой песни' });
  }

  const { title, artist, lines, difficultyChanges } = req.body;

  if (!title || !artist || !Array.isArray(lines)) {
    return res.status(400).json({ error: 'Неверные данные' });
  }

  // Обновляем метаданные в индексе
  song.title = title;
  song.artist = artist;

  // Обновляем JSON-файл
  const newData = {
    title,
    artist,
    duration: song.duration,
    lines: lines.map(l => ({ text: l.text, time: parseFloat(l.time) })),
    difficultyChanges: difficultyChanges || [],
    ownerToken: currentToken
  };

  fs.writeFileSync(jsonPath, JSON.stringify(newData, null, 2));
  saveSongsIndex();
  res.json({ success: true });
});

app.post('/api/songs/:id/copy', (req, res) => {
  const originalId = parseInt(req.params.id);
  const originalSong = songs.find(s => s.id === originalId);
  if (!originalSong) return res.status(404).json({ error: 'Оригинал не найден' });
  
  // Читаем данные оригинала
  const jsonPath = path.join(uploadDir, originalSong.jsonFile);
  let originalData;
  try {
    originalData = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  } catch(e) {
    return res.status(500).json({ error: 'Ошибка чтения оригинала' });
  }
  
  // Генерируем новые файлы
  const newAudioFile = originalSong.audioFile; // Не копируем аудио, используем тот же (экономия места)
  const newJsonFilename = `${Date.now()}-${Math.random().toString(36).substr(2, 6)}.json`;
  const newJsonPath = path.join(uploadDir, newJsonFilename);
  
  // Новый токен владельца из cookie (или генерируем)
  const newOwnerToken = req.cookies.songOwnerToken || randomUUID();
  res.cookie('songOwnerToken', newOwnerToken, { maxAge: 365 * 24 * 60 * 60 * 1000, httpOnly: true });
  
  // Новое название с пометкой (копия)
  const newTitle = `${originalData.title} (копия)`;
  
  const newSongData = {
    title: newTitle,
    artist: originalData.artist,
    duration: originalData.duration,
    lines: originalData.lines,
    difficultyChanges: originalData.difficultyChanges || [],
    ownerToken: newOwnerToken,
    copiedFrom: originalId
  };
  
  fs.writeFileSync(newJsonPath, JSON.stringify(newSongData, null, 2));
  
  const newSong = {
    id: nextSongId++,
    title: newTitle,
    artist: originalData.artist,
    duration: originalData.duration,
    audioFile: originalSong.audioFile,
    jsonFile: newJsonFilename
  };
  
  songs.push(newSong);
  saveSongsIndex();
  
  res.status(201).json({ id: newSong.id });
});

app.delete('/api/songs/:id', (req, res) => {
  const songId = parseInt(req.params.id);
  const songIndex = songs.findIndex(s => s.id === songId);
  if (songIndex === -1) return res.status(404).json({ error: 'Песня не найдена' });
  
  const song = songs[songIndex];
  const jsonPath = path.join(uploadDir, song.jsonFile);
  let songData;
  try {
    songData = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  } catch(e) {
    return res.status(500).json({ error: 'Ошибка чтения файла песни' });
  }
  
  const currentToken = req.cookies.songOwnerToken;
  if (!currentToken || songData.ownerToken !== currentToken) {
    return res.status(403).json({ error: 'Нет прав на удаление этой песни' });
  }
  
  // Удаляем JSON-файл
  fs.unlinkSync(jsonPath);
  
  // Не удаляем MP3, т.к. он может использоваться другими песнями (копиями)
  // Но для экономии места можно проверить, есть ли другие песни с этим же audioFile
  const otherSongUsesAudio = songs.some((s, idx) => idx !== songIndex && s.audioFile === song.audioFile);
  if (!otherSongUsesAudio) {
    const audioPath = path.join(uploadDir, song.audioFile);
    if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath);
  }
  
  // Удаляем из массива и сохраняем индекс
  songs.splice(songIndex, 1);
  saveSongsIndex();
  
  res.json({ success: true });
});

// Функция извлечения аудио из видео
async function extractAudioFromVideo(videoPath) {
    const audioPath = await tmpNameAsync({ postfix: '.mp3' });
    return new Promise((resolve, reject) => {
        ffmpeg(videoPath)
            .output(audioPath)
            .audioCodec('libmp3lame')
            .audioBitrate(128)
            .on('end', () => resolve(audioPath))
            .on('error', (err) => reject(new Error(`FFmpeg error: ${err.message}`)))
            .run();
    });
}

// Функция получения длительности через ffprobe
function getAudioDuration(filePath) {
    return new Promise((resolve, reject) => {
        ffmpeg.ffprobe(filePath, (err, metadata) => {
            if (err) reject(new Error(`ffprobe error: ${err.message}`));
            else resolve(metadata.format.duration);
        });
    });
}

// Транскрипция через Whisper
async function transcribeAudio(audioPath) {
    throw new Error('Транскрипция на этом сервере временно недоступна');
    if (os.platform() === 'win32') {
        return transcribeWithPython(audioPath);
    } else {
        return transcribeWithWhisperCpp(audioPath);
    }
}

// Для Windows: существующий Python-скрипт
async function transcribeWithPython(audioPath) {
    const pythonCmd = 'python'; // или 'python3' на Windows
    const { stdout } = await execPromise(`${pythonCmd} transcribe.py "${audioPath}"`);
    return JSON.parse(stdout).map(seg => ({ text: seg.text, time: seg.start }));
}

// Путь к модели (абсолютный)
const MODEL_PATH = 'Song-Game-Web/models/ggml-base.bin';

// Для Linux: вызов заранее скомпилированного whisper.cpp
async function transcribeWithWhisperCpp(audioPath) {
    console.log(`Транскрипция через whisper-cpp: ${audioPath}`);
    // Команда: вывод в JSON (-oj), русский язык (-l ru)
    const command = `whisper-cpp.cli -m "${MODEL_PATH}" -f "${audioPath}" -l ru -oj`;
    try {
        const { stdout, stderr } = await execPromise(command);
        if (stderr && !stderr.includes('main: processing')) {
            console.warn('stderr от whisper-cpp:', stderr);
        }
        // Парсим JSON из stdout
        const result = JSON.parse(stdout);
        if (!result.segments || !result.segments.length) {
            throw new Error('Нет сегментов в результате');
        }
        // Приводим к нашему формату { text, time }
        const lines = result.segments.map(seg => ({
            text: seg.text.trim(),
            time: seg.start   // время начала в секундах
        }));
        console.log(`Распознано ${lines.length} строк`);
        return lines;
    } catch (err) {
        console.error('Ошибка при вызове whisper-cpp:', err);
        throw new Error(`Whisper-cpp failed: ${err.message}`);
    }
}

// Вспомогательная функция для преобразования строки времени "00:00:01.500" в секунды (1.5)
function parseTimeStringToSeconds(timeString) {
    const parts = timeString.split(':');
    if (parts.length === 3) {
        const hours = parseFloat(parts[0]);
        const minutes = parseFloat(parts[1]);
        const seconds = parseFloat(parts[2]);
        return (hours * 3600) + (minutes * 60) + seconds;
    }
    return 0;
}

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
      song: { ...song, lines: songData.lines, duration: songData.duration, difficultyChanges: songData.difficultyChanges },
      gameActive: false,
      hostId: socket.id,
      roomId: roomId,
      questionTimeouts: [],
      currentLineTimeout: null,
      currentLineIndex: -1,
      playersReady: new Set(),
      readyStatus: new Map(),
      readyTimer: null
    });
    
    socket.join(roomId);
    rooms.get(roomId).players.set(socket.id, { name: playerName, score: 0 });
    
    socket.emit('roomCreated', { roomId });
    io.to(roomId).emit('playersUpdate', getPlayersList(roomId));
    const room = rooms.get(roomId);
    room.readyStatus.set(socket.id, false);
    io.to(roomId).emit('readyStatusUpdate', Array.from(room.readyStatus.entries()));
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
    room.readyStatus.set(socket.id, false);
    
    io.to(roomId).emit('playersUpdate', getPlayersList(roomId));
    socket.emit('roomJoined', { roomId, song: { ...room.song, audioUrl: `/songs/${room.song.audioFile}` } });
    io.to(roomId).emit('readyStatusUpdate', Array.from(room.readyStatus.entries()));
  });
  
// Обработчик переключения готовности
socket.on('toggleReady', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room || room.gameActive) return;
    const current = room.readyStatus.get(socket.id) || false;
    room.readyStatus.set(socket.id, !current);
    io.to(roomId).emit('readyStatusUpdate', Array.from(room.readyStatus.entries()));
    
    // Проверка, все ли готовы
    const allReady = Array.from(room.readyStatus.values()).every(v => v === true);
    if (allReady && room.players.size > 0) {
        if (room.readyTimer) clearTimeout(room.readyTimer);
        room.readyTimer = setTimeout(() => {
            if (room && room.gameActive === false) {
                // Запускаем игру
                room.gameActive = true;
                room.currentLineIndex = -1;
                for (let [id, player] of room.players.entries()) {
                    player.score = 0;
                }
                io.to(roomId).emit('playersUpdate', getPlayersList(roomId));
                io.to(roomId).emit('gameStarting', { song: { ...room.song, audioUrl: `/songs/${room.song.audioFile}` } });
            }
            room.readyTimer = null;
        }, 3000);
        io.to(roomId).emit('allReady', { timer: 3 });
    } else {
        if (room.readyTimer) {
            clearTimeout(room.readyTimer);
            room.readyTimer = null;
            io.to(roomId).emit('readyCancelled');
        }
    }
});

let countdownTimer = null;

// Клиент сообщает, что он загрузил аудио и готов
socket.on('clientReady', ({ roomId }) => {
  const room = rooms.get(roomId);
  if (!room) return;

  // Добавляем клиента в Set готовых
  room.playersReady.add(socket.id);

  const allPlayerIds = Array.from(room.players.keys());
  const allReady = allPlayerIds.every(playerId => room.playersReady.has(playerId));

  if (allReady) {
    let countdown = 4;
    countdownTimer = setInterval(() => {
        countdown--;
        if (countdown > 0) {
            io.to(roomId).emit('countDown', { count: countdown });
        } else {
            clearInterval(countdownTimer);
            startGameLoop(roomId);
        }
    }, 1000);
  }
});

// Обработчик ответа игрока
socket.on('pressLine', ({ roomId, selectedText }) => {
  const room = rooms.get(roomId);
  if (!room || !room.gameActive) return;
  const currentIndex = room.currentLineIndex;
  if (currentIndex === -1) return;
  
  const player = room.players.get(socket.id);
  if (!player) return;
  
  const correctText = room.song.lines[currentIndex].text;
  if (selectedText === correctText) {
    player.score += 10;
    io.to(roomId).emit('playersUpdate', getPlayersList(roomId));
    socket.emit('answerResult', { correct: true, message: 'Правильно! +10 очков' });
  } else {
    socket.emit('answerResult', { correct: false, message: 'Неправильно!' });
  }
});
  
socket.on('disconnect', () => {
  console.log('Игрок отключился:', socket.id);
  for (let [roomId, room] of rooms.entries()) {
    if (room.players.has(socket.id)) {
      room.players.delete(socket.id);

      if (room.readyStatus.has(socket.id)) room.readyStatus.delete(socket.id);

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
          if (room.questionTimeouts) {
            room.questionTimeouts.forEach(clearTimeout);
            room.questionTimeouts = [];
          }
          room.gameActive = false;
          clearInterval(countdownTimer);
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
  
  io.to(roomId).emit('gameLoopStart');

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
      const correctLine = lines[i];
      
      // Генерация вариантов      
      const difficulty = getDifficultyAtTime(room.song.difficultyChanges, line.time);
      const options = getOptionsForLine(correctLine.text, room.song.lines, difficulty);

      io.to(roomId).emit('newQuestion', {
        lineIndex: i,
        correctText: correctLine.text,
        options: options,
        time: correctLine.time,
        difficulty: difficulty
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