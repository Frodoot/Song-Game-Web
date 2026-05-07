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

let currentPreviewAudioUrl = null;
let currentSongDuration = 0;

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
      card.innerHTML = `
        <strong>${escapeHtml(song.title)}</strong><br>${escapeHtml(song.artist)}<br>
        <button class="edit-song-btn" data-id="${song.id}">✏️ Редактировать</button>
        <button class="delete-song-btn" data-id="${song.id}">🗑️ Удалить</button>
      `;
      card.querySelector('.edit-song-btn').onclick = () => openEditor(song.id);
      card.querySelector('.delete-song-btn').onclick = (e) => {
        e.stopPropagation();
        if (confirm(`Удалить песню "${song.title}"? Это действие необратимо.`)) {
          deleteSong(song.id);
        }
      };
    } else {
      card.innerHTML = `
        <strong>${escapeHtml(song.title)}</strong><br>${escapeHtml(song.artist)}<br>
        <!-- <button class="copy-song-btn" data-id="${song.id}">📋 Копировать и редактировать</button> -->
      `;
      //card.querySelector('.copy-song-btn').onclick = () => copySong(song.id);
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

async function deleteSong(songId) {
  try {
    const res = await fetch(`/api/songs/${songId}`, { method: 'DELETE' });
    if (res.ok) {
      alert('Песня удалена');
      loadSongs(); // обновляем список
    } else {
      const err = await res.json();
      alert('Ошибка удаления: ' + err.error);
    }
  } catch(err) {
    alert('Ошибка сети');
  }
}

// Добавление песни (с загрузкой файла)
document.getElementById('submitSongBtn').onclick = async () => {
    const title = document.getElementById('songTitle').value.trim();
    const artist = document.getElementById('songArtist').value.trim();
    const fileInput = document.getElementById('songMediaFile');
    const file = fileInput.files[0];
    
    if (!title || !artist || !file) {
        document.getElementById('addSongStatus').innerHTML = '<span style="color:red;">Заполните все поля и выберите файл</span>';
        return;
    }
    
    const formData = new FormData();
    formData.append('title', title);
    formData.append('artist', artist);
    formData.append('media', file);
    
    document.getElementById('submitSongBtn').disabled = true;
    document.getElementById('addSongStatus').innerHTML = 'Загрузка и обработка файла...';
    
    try {
        const res = await fetch('/api/songs', { method: 'POST', body: formData });
        if (res.ok) {
            document.getElementById('addSongStatus').innerHTML = '<span style="color:lightgreen;">Песня добавлена!</span>';
            setTimeout(() => {
                document.getElementById('addSongStatus').innerHTML = '';
                showScreen('main');
                loadSongs();
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
};

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

let audioPreview = null;

// Открыть редактор песни
async function openEditor(songId) {
  currentEditSongId = songId;
  try {
    const res = await fetch(`/api/songs/${songId}`);
    const song = await res.json();

    currentPreviewAudioUrl = song.audioUrl;
    audioPreview = document.getElementById('previewAudio');
    audioPreview.src = currentPreviewAudioUrl;
    currentSongDuration = song.duration; 

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

// Вспомогательная функция округления времени до 2 знаков
function roundTime(t) {
    return Math.round(t * 100) / 100;
}

// Отрисовка редактора строк
function renderLinesEditor() {
  const container = document.getElementById('linesEditor');
  container.innerHTML = '';
  
  currentEditLines.sort((a,b) => a.time - b.time);
  
  currentEditLines.forEach((line, idx) => {
    const div = document.createElement('div');
    div.className = 'line-editor-row';
    div.innerHTML = `
      <input type="text" class="line-text" value="${escapeHtml(line.text)}" data-idx="${idx}">
      <div class="time-wrapper">
        <label>⏱️ сек</label>
        <input type="number" step="0.01" class="line-time" value="${roundTime(line.time).toFixed(2)}" data-idx="${idx}">
      </div>
      <button class="preview-line-btn" data-idx="${idx}" title="Прослушать с этого момента">▶</button>
      <button class="remove-line-btn" data-idx="${idx}" value ="${escapeHtml(line.text)}" title="Удалить строку">🗑️</button>
    `;
    container.appendChild(div);
  });
  
  // Обработчики удаления
  document.querySelectorAll('.remove-line-btn').forEach(btn => {
    btn.onclick = () => {
      if (confirm(`Удалить строчку "${btn.value}"?`)) {
          removeLine(parseInt(btn.dataset.idx));
        }
    }
  });
  
  // Обработчики предпрослушивания
  document.querySelectorAll('.preview-line-btn').forEach(btn => {
    btn.onclick = () => previewLine(parseInt(btn.dataset.idx));
  });
  
  // Обработчики изменения времени с синхронизацией
  const syncCheckbox = document.getElementById('syncTimeShiftCheckbox');
  document.querySelectorAll('.line-time').forEach(input => {
    input.onchange = (e) => {
      const idx = parseInt(e.target.dataset.idx);
      let newTime = parseFloat(e.target.value);
      if (isNaN(newTime)) return;
      
      const oldTime = currentEditLines[idx].time;
      const delta = newTime - oldTime;
      
      if (syncCheckbox.checked && delta !== 0) {
        for (let i = idx; i < currentEditLines.length; i++) {
          currentEditLines[i].time += delta;
          if (currentEditLines[i].time < 0) currentEditLines[i].time = 0;
        }
      } else {
        currentEditLines[idx].time = newTime;
      }
      
      currentEditLines.sort((a,b) => a.time - b.time);
      renderLinesEditor();
    };
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
      <input type="number" step="0.1" class="rule-after" value="${rule.afterDuration}" placeholder="секунд" data-idx="${idx}">
      <input type="number" class="rule-difficulty" value="${rule.difficulty}" min="2" placeholder="кол-во" data-idx="${idx}">
      <button class="remove-rule-btn" data-idx="${idx}" title="Удалить правило">🗑️</button>
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
    currentEditLines.sort((a,b) => a.time - b.time);
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
  currentEditLines.sort((a,b) => a.time - b.time);
  renderLinesEditor();
};

function previewLine(lineIndex) {
  if (!currentPreviewAudioUrl) {
    alert('Аудио недоступно');
    return;
  }
  if (!audioPreview) return;
  
  // Получаем время начала и окончания
  const startTime = currentEditLines[lineIndex].time;
  const nextLine = currentEditLines[lineIndex + 1];
  let endTime = nextLine ? nextLine.time : currentSongDuration;
  if (endTime <= startTime) endTime = startTime + 5; // запас 5 секунд
  
  // Останавливаем текущее воспроизведение
  audioPreview.pause();
  audioPreview.currentTime = 0;
  if (window.previewTimeout) clearTimeout(window.previewTimeout);
  
  // Запускаем воспроизведение
  audioPreview.currentTime = startTime;
  audioPreview.play().catch(e => console.log('Автовоспроизведение заблокировано', e));
  
  // Останавливаем через нужный интервал
  const duration = endTime - startTime;
  window.previewTimeout = setTimeout(() => {
    audioPreview.pause();
    audioPreview.currentTime = 0;
  }, duration * 1000);
}

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
    
    const prevReadyBtn = document.getElementById('readyBtn');
    if (prevReadyBtn) {
      prevReadyBtn.remove();
    }

    const readyBtn = document.createElement('button');
    readyBtn.id = 'readyBtn';
    readyBtn.innerText = 'Готов';
    readyBtn.style.margin = '10px';
    document.getElementById('lobby-controls').appendChild(readyBtn);

    let isReady = false;
    readyBtn.onclick = () => {
        if (gameActive) return;
        socket.emit('toggleReady', { roomId: currentRoomId });
        // Визуальное переключение кнопки (будет обновлено по ответу с сервера, но можно локально)
        isReady = !isReady;
        readyBtn.innerText = isReady ? 'Не готов' : 'Готов';
        readyBtn.style.background = isReady ? '#4caf50' : '#ff6b6b';
        // При нажатии на "Готов" разблокируем звук (silentAudio)
        if (isReady) {
          const audio = document.getElementById('gameAudio');
          if (audio){
            audio.volume = 0;
            audio.play();
            setTimeout( () => {audio.pause(); audio.volume = 1;}, 100);
          }
        }
    };

    showScreen('lobby');
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
  
  
  const prevReadyBtn = document.getElementById('readyBtn');
  if (prevReadyBtn) {
    prevReadyBtn.remove();
  }

  const readyBtn = document.createElement('button');
  readyBtn.id = 'readyBtn';
  readyBtn.innerText = 'Готов';
  readyBtn.style.margin = '10px';
  document.getElementById('lobby-controls').appendChild(readyBtn);

  let isReady = false;
  readyBtn.onclick = () => {
      if (gameActive) return;
      socket.emit('toggleReady', { roomId: currentRoomId });
      // Визуальное переключение кнопки (будет обновлено по ответу с сервера, но можно локально)
      isReady = !isReady;
      readyBtn.innerText = isReady ? 'Не готов' : 'Готов';
      readyBtn.style.background = isReady ? '#4caf50' : '#ff6b6b';
      // При нажатии на "Готов" разблокируем звук (silentAudio)
      if (isReady) {
          const audio = document.getElementById('gameAudio');
          if (audio){
            audio.volume = 0;
            audio.play();
            setTimeout( () => {audio.pause(); audio.volume = 1;}, 100);
          }
      }
  };
  showScreen('lobby');
});

// Слушаем событие allReady
socket.on('allReady', ({ timer }) => {
    showToast(`Все готовы! Игра начнется через ${timer} секунды...`, 'info');
});

socket.on('readyCancelled', () => {
    showToast('Кто-то не готов. Ожидание...', 'warning');
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

socket.on('readyStatusUpdate', (statusArray) => {
    updatePlayersReadyStatus(statusArray);
});

let currentQuestionIndex = -1;
let currentOptions = [];

socket.on('gameStarting', async ({ song }) => {
  currentSong = song;
  gameActive = true;
  currentQuestionIndex = -1;
  
  document.getElementById('currentLyricDisplay').innerHTML = `Ожидание игроков...`;
  document.getElementById('optionsContainer').innerHTML = '';

  showScreen('game');

  const audio = document.getElementById('gameAudio');
  audio.src = currentSong.audioUrl;
  await new Promise((resolve, reject) => {
    audio.addEventListener('canplaythrough', resolve, { once: true });
    audio.addEventListener('error', reject, { once: true });
    audio.load();
  });

  // Аудио готово – сообщаем серверу
  socket.emit('clientReady', { roomId: currentRoomId });

  // Начинаем заглушенное проигрывание
  audio.volume = 0;
  audio.play().catch(e => console.warn(e));
});

socket.on('countDown', ({count}) => {
  document.getElementById('currentLyricDisplay').innerHTML = `🎵 Игра начнётся через ${count}... 🎵`;
});

socket.on('gameLoopStart', () => {
  const audio = document.getElementById('gameAudio');
  audio.volume = 1.0;
  audio.pause();
  audio.currentTime = 0;
  audio.play().then(() => {
      document.getElementById('currentLyricDisplay').innerHTML = '🎵 Слушайте и выбирайте! 🎵';
  }).catch(err => {
      console.error('Ошибка запуска после отсчёта:', err);
  });

  document.getElementById('optionsContainer').innerHTML = '';
});

function updatePlayersReadyStatus(statusArray) {
    const playerCards = document.querySelectorAll('#playersList .player-card');
    statusArray.forEach(([socketId, isReady]) => {
        const playerDiv = Array.from(playerCards).find(card => card.dataset.socketId === socketId);
        if (playerDiv) {
            let statusSpan = playerDiv.querySelector('.ready-status');
            if (!statusSpan) {
                statusSpan = document.createElement('div');
                statusSpan.className = 'ready-status';
                playerDiv.appendChild(statusSpan);
            }
            statusSpan.innerText = isReady ? '✅ Готов' : '⏳ Не готов';
            statusSpan.style.color = isReady ? '#4caf50' : '#ff9800';
        }
    });
}

socket.on('newQuestion', ({ lineIndex, correctText, options }) => {
  currentQuestionIndex = lineIndex;
  currentOptions = options;
  document.getElementById('currentLyricDisplay').innerHTML = '🎵 Какая строка сейчас звучит? 🎵';
  
  const container = document.getElementById('optionsContainer');
  container.innerHTML = '';
  options.forEach(opt => {
    const btn = document.createElement('button');
    btn.className = 'option-btn';
    btn.innerText = opt;

    btn.addEventListener("touchstart", () => btn.classList.add("active"));
    
    btn.onclick = async (e) => {
      if (!gameActive) return;
      if (currentQuestionIndex !== lineIndex) return;
      
      // Отправляем ответ
      socket.emit('pressLine', { roomId: currentRoomId, selectedText: opt });

      // Блокируем другие кнопки
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
  renderPlayersInLobby(players);
});

function renderPlayersInLobby(players) {
    const container = document.getElementById('playersList');
    container.innerHTML = '';
    players.forEach(p => {
        const div = document.createElement('div');
        div.className = 'player-card';
        div.dataset.socketId = p.id;
        div.innerHTML = `
            <div class="player-name">${escapeHtml(p.name)}</div>
            <div class="player-score">${p.score} очков</div>
            <div class="ready-status"></div>
        `;
        container.appendChild(div);
    });
    // запросим текущий статус готовности (сервер может сам прислать после join)
    socket.emit('getReadyStatus', { roomId: currentRoomId });
}

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

// Модальное окно инструкции
const modal = document.getElementById('instructionModal');
const howToBtn = document.getElementById('howToAddSongBtn');
const closeModal = document.querySelector('.close-modal');

if (howToBtn) {
    howToBtn.onclick = () => {
        modal.style.display = 'block';
    };
}
if (closeModal) {
    closeModal.onclick = () => {
        modal.style.display = 'none';
    };
}
// Закрытие при клике вне модального окна
window.onclick = (event) => {
    if (event.target === modal) {
        modal.style.display = 'none';
    }
};

// Инициализация
loadSongs();