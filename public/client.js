const socket = io();

// Элементы DOM
const screens = {
    main: document.getElementById('mainMenu'),
    create: document.getElementById('createGameScreen'),
    join: document.getElementById('joinGameScreen'),
    add: document.getElementById('addSongScreen'),
    editSong: document.getElementById('editSongScreen'),
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
        if (song.canEdit) {
        card.innerHTML = `<strong>${escapeHtml(song.title)}</strong><br>${escapeHtml(song.artist)}<br>
            <button class="edit-song-btn" data-id="${song.id}">✏️ Редактировать</button>`;
        card.querySelector('.edit-song-btn').onclick = () => openEditor(song.id);
        } else {
        card.innerHTML = `<strong>${escapeHtml(song.title)}</strong><br>${escapeHtml(song.artist)}<br>
            <button class="copy-song-btn" data-id="${song.id}">📋 Копировать и редактировать</button>`;
        card.querySelector('.copy-song-btn').onclick = () => copySong(song.id);
        }
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

async function copySong(songId) {
  try {
    const res = await fetch(`/api/songs/${songId}/copy`, { method: 'POST' });
    if (res.ok) {
      const { id: newId } = await res.json();
      alert('Песня скопирована! Теперь она ваша и доступна для редактирования.');
      await loadSongs();
      // Можно сразу открыть редактор новой песни
      openEditor(newId);
    } else {
      const err = await res.json();
      alert('Ошибка копирования: ' + err.error);
    }
  } catch(err) {
    alert('Ошибка сети');
  }
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

let currentEditSongId = null;
let currentEditLines = [];       // массив { text, time }
let currentEditDifficulty = [];  // массив { afterDuration, difficulty }

// Простая функция экранирования HTML
function escapeHtml(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Открыть редактор песни
async function openEditor(songId) {
  currentEditSongId = songId;
  try {
    const res = await fetch(`/api/songs/${songId}`);
    const song = await res.json();

    // Заполняем поля ввода
    document.getElementById('editSongName').value = song.title;
    document.getElementById('editSongArtist').value = song.artist;
    document.getElementById('editSongTitle').innerText = `${song.artist} - ${song.title}`;
    
    currentEditLines = song.lines.map(l => ({ text: l.text, time: l.time }));
    currentEditDifficulty = song.difficultyChanges || [];

    renderLinesEditor();
    renderDifficultyEditor();

    showScreen('editSong');
  } catch (err) {
    console.error(err);
    alert('Не удалось загрузить песню');
  }
}

// Отрисовка редактора строк
function renderLinesEditor() {
  const container = document.getElementById('linesEditor');
  container.innerHTML = '';
  currentEditLines.forEach((line, idx) => {
    const div = document.createElement('div');
    div.className = 'line-editor-row';
    div.innerHTML = `
      <input type="text" class="line-text" value="${escapeHtml(line.text)}" data-idx="${idx}">
      <input type="number" step="0.01" class="line-time" value="${line.time}" data-idx="${idx}">
      <button class="remove-line-btn" data-idx="${idx}">🗑️</button>
    `;
    container.appendChild(div);
  });
  // Привязываем события удаления
  document.querySelectorAll('.remove-line-btn').forEach(btn => {
    btn.onclick = () => removeLine(parseInt(btn.dataset.idx));
  });
}

// Отрисовка редактора правил сложности
function renderDifficultyEditor() {
  const container = document.getElementById('difficultyEditor');
  container.innerHTML = '';
  currentEditDifficulty.forEach((rule, idx) => {
    const div = document.createElement('div');
    div.className = 'difficulty-rule-row';
    div.innerHTML = `
      <input type="number" step="0.1" class="rule-after" value="${rule.afterDuration}" placeholder="Время (сек)" data-idx="${idx}">
      <input type="number" class="rule-difficulty" value="${rule.difficulty}" min="2" placeholder="Кол-во кнопок" data-idx="${idx}">
      <button class="remove-rule-btn" data-idx="${idx}">🗑️</button>
    `;
    container.appendChild(div);
  });
  document.querySelectorAll('.remove-rule-btn').forEach(btn => {
    btn.onclick = () => removeDifficultyRule(parseInt(btn.dataset.idx));
  });
}

// Удаление строки
function removeLine(index) {
  if (index >= 0 && index < currentEditLines.length) {
    currentEditLines.splice(index, 1);
    renderLinesEditor();
  }
}

// Удаление правила сложности
function removeDifficultyRule(index) {
  if (index >= 0 && index < currentEditDifficulty.length) {
    currentEditDifficulty.splice(index, 1);
    renderDifficultyEditor();
  }
}

// Добавление пустой строки
document.getElementById('addLineBtn').onclick = () => {
  currentEditLines.push({ text: 'Новая строка', time: 0 });
  renderLinesEditor();
};

// Добавление правила сложности
document.getElementById('addDifficultyRuleBtn').onclick = () => {
  currentEditDifficulty.push({ afterDuration: 0, difficulty: 2 });
  renderDifficultyEditor();
};

// Сохранение изменений
document.getElementById('saveSongBtn').onclick = async () => {
  // Получаем новые название и исполнителя
  const newTitle = document.getElementById('editSongName').value.trim();
  const newArtist = document.getElementById('editSongArtist').value.trim();
  if (!newTitle || !newArtist) {
    alert('Название и исполнитель не могут быть пустыми');
    return;
  }
  
  // Собираем строки из DOM (как было)
  const lineTexts = document.querySelectorAll('#linesEditor .line-text');
  const lineTimes = document.querySelectorAll('#linesEditor .line-time');
  const updatedLines = [];
  for (let i = 0; i < lineTexts.length; i++) {
    const text = lineTexts[i].value.trim();
    const time = parseFloat(lineTimes[i].value);
    if (text && !isNaN(time)) {
      updatedLines.push({ text, time });
    } else {
      alert(`Строка ${i+1} имеет некорректные данные`);
      return;
    }
  }
  updatedLines.sort((a,b) => a.time - b.time);
  
  // Собираем правила сложности
  const ruleAfters = document.querySelectorAll('#difficultyEditor .rule-after');
  const ruleDifficulties = document.querySelectorAll('#difficultyEditor .rule-difficulty');
  const updatedDifficulty = [];
  for (let i = 0; i < ruleAfters.length; i++) {
    const after = parseFloat(ruleAfters[i].value);
    const diff = parseInt(ruleDifficulties[i].value);
    if (!isNaN(after) && !isNaN(diff) && diff >= 2) {
      updatedDifficulty.push({ afterDuration: after, difficulty: diff });
    } else {
      alert(`Правило ${i+1} имеет некорректные данные`);
      return;
    }
  }
  updatedDifficulty.sort((a,b) => a.afterDuration - b.afterDuration);
  
  // Отправляем обновления
  try {
    const res = await fetch(`/api/songs/${currentEditSongId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: newTitle,
        artist: newArtist,
        lines: updatedLines,
        difficultyChanges: updatedDifficulty
      })
    });
    if (res.ok) {
      alert('Песня сохранена!');
      showScreen('main');
      loadSongs(); // обновляем список песен
    } else {
      const err = await res.json();
      alert('Ошибка: ' + err.error);
    }
  } catch (err) {
    console.error(err);
    alert('Ошибка сети');
  }
};

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