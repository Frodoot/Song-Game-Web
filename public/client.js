const socket = io();

// Элементы DOM
const screens = {
    main: document.getElementById('mainMenu'),
    create: document.getElementById('createGameScreen'),
    join: document.getElementById('joinGameScreen'),
    add: document.getElementById('addSongScreen'),
    lobby: document.getElementById('lobbyScreen'),
    game: document.getElementById('gameScreen')
};

let currentRoomId = null;
let currentSong = null;
let currentLines = []; // массив строк текста для текущей песни
let activeLineIndex = -1;
let gameActive = false;

// Показать экран
function showScreen(screenName) {
    Object.values(screens).forEach(screen => screen.classList.remove('active'));
    screens[screenName].classList.add('active');
}

// Загрузка списка песен
async function loadSongs() {
    const res = await fetch('/api/songs');
    const songs = await res.json();
    const container = document.getElementById('songsContainer');
    container.innerHTML = '';
    songs.forEach(song => {
        const card = document.createElement('div');
        card.className = 'song-card';
        card.innerHTML = `<strong>${song.title}</strong><br>${song.artist}`;
        container.appendChild(card);
    });
    
    // Обновляем селекты
    const selectCreate = document.getElementById('songSelectCreate');
    selectCreate.innerHTML = '<option disabled selected>Выберите песню</option>';
    songs.forEach(song => {
        const option = document.createElement('option');
        option.value = song.id;
        option.textContent = `${song.artist} - ${song.title}`;
        selectCreate.appendChild(option);
    });
}

// Добавление песни (с загрузкой файла)
document.getElementById('submitSongBtn').addEventListener('click', async () => {
    const title = document.getElementById('songTitle').value.trim();
    const artist = document.getElementById('songArtist').value.trim();
    const fileInput = document.getElementById('songAudioFile');
    const file = fileInput.files[0];
    
    if (!title || !artist || !file) {
        document.getElementById('addSongStatus').innerHTML = '<span style="color:red;">Заполните все поля и выберите MP3 файл</span>';
        return;
    }
    
    const formData = new FormData();
    formData.append('title', title);
    formData.append('artist', artist);
    formData.append('audio', file);
    
    document.getElementById('submitSongBtn').disabled = true;
    document.getElementById('addSongStatus').innerHTML = 'Загрузка MP3 и получение текста...';
    
    try {
        const res = await fetch('/api/songs', {
            method: 'POST',
            body: formData
        });
        if (res.ok) {
            document.getElementById('addSongStatus').innerHTML = '<span style="color:lightgreen;">Песня добавлена!</span>';
            setTimeout(() => {
                document.getElementById('addSongStatus').innerHTML = '';
                showScreen('main');
                loadSongs();
                // Очистка полей
                document.getElementById('songTitle').value = '';
                document.getElementById('songArtist').value = '';
                fileInput.value = '';
            }, 1500);
        } else {
            const err = await res.json();
            document.getElementById('addSongStatus').innerHTML = `<span style="color:red;">Ошибка: ${err.error}</span>`;
        }
    } catch (err) {
        document.getElementById('addSongStatus').innerHTML = '<span style="color:red;">Ошибка сети</span>';
    } finally {
        document.getElementById('submitSongBtn').disabled = false;
    }
});

// Навигация
document.getElementById('createGameBtn').onclick = () => showScreen('create');
document.getElementById('joinGameBtn').onclick = () => showScreen('join');
document.getElementById('addSongBtn').onclick = () => showScreen('add');
document.querySelectorAll('.backBtn').forEach(btn => btn.onclick = () => showScreen('main'));

// Создание комнаты
document.getElementById('confirmCreateBtn').onclick = () => {
    const playerName = document.getElementById('playerNameCreate').value.trim();
    const songId = parseInt(document.getElementById('songSelectCreate').value);
    if (!playerName || !songId) {
        alert('Введите имя и выберите песню');
        return;
    }
    socket.emit('createRoom', { playerName, songId });
};

socket.on('roomCreated', ({ roomId }) => {
    currentRoomId = roomId;
    document.getElementById('roomCodeDisplay').innerText = roomId;
    showScreen('lobby');
    document.getElementById('startGameBtn').style.display = 'block'; // хост может стартовать
    document.getElementById('lobbySongInfo').innerHTML = 'Песня выбрана. Ожидание игроков...';
});

// Присоединение
document.getElementById('confirmJoinBtn').onclick = () => {
    const roomId = document.getElementById('roomCode').value.trim().toUpperCase();
    const playerName = document.getElementById('playerNameJoin').value.trim();
    if (!roomId || !playerName) {
        alert('Введите код комнаты и имя');
        return;
    }
    socket.emit('joinRoom', { roomId, playerName });
};

socket.on('roomJoined', ({ roomId, song }) => {
    currentRoomId = roomId;
    currentSong = song;
    document.getElementById('roomCodeDisplay').innerText = roomId;
    document.getElementById('lobbySongInfo').innerHTML = `Песня: ${song.artist} - ${song.title}`;
    document.getElementById('startGameBtn').style.display = 'none';
    showScreen('lobby');
});

socket.on('playersUpdate', (players) => {
    const container = document.getElementById('playersList');
    container.innerHTML = '';
    players.forEach(p => {
        const div = document.createElement('div');
        div.className = 'player-card';
        div.innerHTML = `<div class="player-name">${p.name}</div><div class="player-score">${p.score} очков</div>`;
        container.appendChild(div);
    });
});

// Старт игры (хост)
document.getElementById('startGameBtn').onclick = () => {
    socket.emit('startGame', { roomId: currentRoomId });
};

socket.on('gameStarting', ({ song }) => {
    currentSong = song;
    currentLines = song.lines;
    gameActive = true;
    // Подготовка игрового экрана
    const container = document.getElementById('optionsContainer');
    container.innerHTML = '';
    // Перемешиваем кнопки для интереса
    const shuffled = [...currentLines];
    for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    shuffled.forEach((line, idx) => {
        const btn = document.createElement('button');
        btn.className = 'lyric-btn';
        btn.innerText = line.text;
        btn.dataset.index = currentLines.findIndex(l => l.text === line.text); // сохраняем реальный индекс
        btn.onclick = () => {
            if (gameActive && activeLineIndex !== -1 && parseInt(btn.dataset.index) === activeLineIndex) {
                socket.emit('pressLine', { roomId: currentRoomId, lineIndex: activeLineIndex, lineText: line.text });
            } else if (gameActive) {
                // визуальный фидбек о неправильной кнопке
                btn.style.background = '#ff6b6b';
                setTimeout(() => btn.style.background = '', 300);
            }
        };
        container.appendChild(btn);
    });
    
    // Запуск аудио
    const audio = document.getElementById('gameAudio');
    audio.src = currentSong.audioUrl;
    audio.play().catch(e => console.log('Автовоспроизведение заблокировано', e));
    
    showScreen('game');
    document.getElementById('currentLyricDisplay').innerText = 'Ожидание первого куплета...';
});

socket.on('newLine', ({ lineIndex, lineText }) => {
    activeLineIndex = lineIndex;
    document.getElementById('currentLyricDisplay').innerHTML = `🎵 ${lineText} 🎵`;
    // Подсветить активную кнопку
    const btns = document.querySelectorAll('.lyric-btn');
    btns.forEach(btn => {
        if (parseInt(btn.dataset.index) === lineIndex) {
            btn.classList.add('active');
        } else {
            btn.classList.remove('active');
        }
    });
});

socket.on('newQuestion', ({ lineIndex, correctText, options }) => {
  activeLineIndex = lineIndex;
  currentCorrectText = correctText;
  document.getElementById('currentLyricDisplay').innerHTML = '🎵 Какая строка сейчас звучит? 🎵';
  // Создаём кнопки вариантов
  const container = document.getElementById('optionsContainer');
  container.innerHTML = '';
  options.forEach(opt => {
    const btn = document.createElement('button');
    btn.className = 'option-btn';
    btn.innerText = opt;
    btn.onclick = () => {
      if (!gameActive) return;
      if (activeLineIndex !== lineIndex) return; // устаревший вопрос
      socket.emit('pressLine', { roomId: currentRoomId, selectedText: opt });
    };
    container.appendChild(btn);
  });
});

socket.on('correctAnswer', ({ playerName }) => {
  showToast(`${playerName} угадал! +10 очков`, 'success');
});

socket.on('wrongAnswer', ({ playerName, selectedText }) => {
  showToast(`${playerName} ошибся: "${selectedText}"`, 'error');
});

socket.on('lineFinished', () => {
  // можно подсветить, что строка закончилась
  document.getElementById('currentLyricDisplay').innerHTML = 'Следующая строка...';
});

function showToast(msg, type) {
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerText = msg;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 2000);
}

socket.on('linePressed', ({ playerName, lineText }) => {
    // Визуальное оповещение
    const notify = document.createElement('div');
    notify.className = 'toast-notify';
    notify.innerText = `${playerName} нажал: "${lineText.substring(0, 30)}..." +10`;
    notify.style.position = 'fixed';
    notify.style.bottom = '20px';
    notify.style.right = '20px';
    notify.style.background = '#4caf50';
    notify.style.padding = '10px 20px';
    notify.style.borderRadius = '30px';
    notify.style.zIndex = '1000';
    document.body.appendChild(notify);
    setTimeout(() => notify.remove(), 2000);
});

socket.on('gameEnded', ({ winner, players }) => {
    gameActive = false;
    alert(`Игра окончена! Победитель: ${winner}`);
    showScreen('main');
    currentRoomId = null;
});

socket.on('gameAborted', (msg) => {
    alert(msg);
    showScreen('main');
    gameActive = false;
});

socket.on('error', (msg) => {
    alert(msg);
});

// Обновление счета в игре
socket.on('playersUpdate', (players) => {
    const scoreDiv = document.getElementById('gameScoreboard');
    if (scoreDiv) {
        scoreDiv.innerHTML = players.map(p => `<div class="score-item">${p.name}: ${p.score}</div>`).join('');
    }
    // Также обновляем лобби, если там
    const lobbyPlayers = document.getElementById('playersList');
    if (lobbyPlayers && screens.lobby.classList.contains('active')) {
        lobbyPlayers.innerHTML = players.map(p => `<div class="player-card"><div class="player-name">${p.name}</div><div class="player-score">${p.score}</div></div>`).join('');
    }
});

document.getElementById('leaveLobbyBtn')?.addEventListener('click', () => {
    if (currentRoomId) {
        socket.disconnect();
        setTimeout(() => socket.connect(), 100);
        currentRoomId = null;
        showScreen('main');
    }
});

document.getElementById('quitGameBtn')?.addEventListener('click', () => {
    if (currentRoomId) {
        socket.disconnect();
        setTimeout(() => socket.connect(), 100);
        currentRoomId = null;
        showScreen('main');
        gameActive = false;
    }
});

// Инициализация
loadSongs();