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

let currentQuestionIndex = -1;
let currentOptions = [];
let hasAnswered = false;

socket.on('gameStarting', ({ song }) => {
  currentSong = song;
  gameActive = true;
  currentQuestionIndex = -1;
  hasAnswered = false;
  showScreen('game');
  const audio = document.getElementById('gameAudio');
  audio.src = currentSong.audioUrl;
  audio.play().catch(e => console.log('Автовоспроизведение заблокировано', e));
  document.getElementById('currentLyricDisplay').innerHTML = 'Приготовьтесь...';
  document.getElementById('optionsContainer').innerHTML = '';
});

socket.on('newQuestion', ({ lineIndex, correctText, options }) => {
  currentQuestionIndex = lineIndex;
  currentOptions = options;
  hasAnswered = false;
  document.getElementById('currentLyricDisplay').innerHTML = '🎵 Какая строка сейчас звучит? 🎵';
  
  const container = document.getElementById('optionsContainer');
  container.innerHTML = '';
  options.forEach(opt => {
    const btn = document.createElement('button');
    btn.className = 'option-btn';
    btn.innerText = opt;
    btn.onclick = async (e) => {
      if (!gameActive) return;
      if (hasAnswered) {
        showToast('Вы уже ответили на этот вопрос!', 'error');
        return;
      }
      if (currentQuestionIndex !== lineIndex) return;
      
      // Отправляем ответ
      socket.emit('pressLine', { roomId: currentRoomId, selectedText: opt });
      
      // Блокируем все кнопки и добавляем анимацию затухания
      hasAnswered = true;
      const allBtns = document.querySelectorAll('.option-btn');
      allBtns.forEach(button => {
        button.disabled = true;
        button.classList.add('fade-out');
      });
    };
    container.appendChild(btn);
  });
});

socket.on('answerResult', ({ correct, message }) => {
  showToast(message, correct ? 'success' : 'error');
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
    const audio = document.getElementById('gameAudio');
    audio.pause();
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
  // Также обновляем лобби
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
        const audio = document.getElementById('gameAudio');
        audio.pause();
        socket.disconnect();
        setTimeout(() => socket.connect(), 100);
        currentRoomId = null;
        showScreen('main');
        gameActive = false;
    }
});

// Инициализация
loadSongs();