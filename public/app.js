const state = {
  activePath: '.',
  currentScreen: 'dashboard',
};

const ui = {
  heroTitle: document.getElementById('heroTitle'),
  heroSubtitle: document.getElementById('heroSubtitle'),
  mcStatus: document.getElementById('mcStatus'),
  playersMetric: document.getElementById('playersMetric'),
  containerMetric: document.getElementById('containerMetric'),
  modeMetric: document.getElementById('modeMetric'),
  playersList: document.getElementById('playersList'),
  commandInput: document.getElementById('commandInput'),
  commandOutput: document.getElementById('commandOutput'),
  logsOutput: document.getElementById('logsOutput'),
  folderList: document.getElementById('folderList'),
  currentPath: document.getElementById('currentPath'),
  uploadFileInput: document.getElementById('uploadFileInput'),
  uploadFileBtn: document.getElementById('uploadFileBtn'),
  uploadOverwrite: document.getElementById('uploadOverwrite'),
  opStatusList: document.getElementById('opStatusList'),
  portainerStatusList: document.getElementById('portainerStatusList'),
  configOutput: document.getElementById('configOutput'),
  diagOutput: document.getElementById('diagOutput'),
};

function showToast(message, type = 'success') {
  const container = document.getElementById('toastContainer');
  const item = document.createElement('div');
  item.className = `toast ${type}`;
  item.textContent = message;
  container.appendChild(item);

  setTimeout(() => item.remove(), 3200);
}

async function callApi(url, options) {
  const isFormData = options && options.body instanceof FormData;
  const customHeaders = options && options.headers ? options.headers : {};
  const defaultHeaders = isFormData ? {} : { 'Content-Type': 'application/json' };

  const response = await fetch(url, {
    headers: {
      ...defaultHeaders,
      ...customHeaders,
    },
    ...options,
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) {
    throw new Error(data.error || `Error API en ${url}`);
  }

  return data;
}

function setScreen(screenName) {
  state.currentScreen = screenName;

  document.querySelectorAll('.screen').forEach((screen) => {
    screen.classList.toggle('active', screen.id === `screen-${screenName}`);
  });

  document.querySelectorAll('.screen-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.screen === screenName);
  });
}

async function refreshStatus() {
  const data = await callApi('/api/status');

  const minecraftOnline = data.minecraft && data.minecraft.online;
  const playersOnline = data.minecraft && data.minecraft.players ? data.minecraft.players.online : null;
  const playersMax = data.minecraft && data.minecraft.players ? data.minecraft.players.max : null;
  const containerState = data.portainer && data.portainer.enabled
    ? (data.portainer.state || (data.portainer.running ? 'running' : 'stopped'))
    : 'n/a';

  ui.mcStatus.textContent = minecraftOnline ? 'Online' : 'Offline';
  ui.playersMetric.textContent = playersOnline != null && playersMax != null ? `${playersOnline}/${playersMax}` : '-';
  ui.containerMetric.textContent = containerState;
  ui.modeMetric.textContent = data.mode || '-';

  if (minecraftOnline) {
    ui.heroTitle.textContent = `Servidor online en ${data.minecraft.host}:${data.minecraft.port}`;
    ui.heroSubtitle.textContent = `Version: ${data.minecraft.version || 'unknown'} | Contenedor: ${containerState}`;
  } else {
    ui.heroTitle.textContent = 'Servidor offline o no alcanzable';
    ui.heroSubtitle.textContent = data.minecraft && data.minecraft.error
      ? data.minecraft.error
      : 'No se pudo obtener estado desde Minecraft ping';
  }

  ui.opStatusList.innerHTML = '';
  const rows = [
    `Modo de control: ${data.mode || '-'}`,
    `Minecraft: ${minecraftOnline ? 'online' : 'offline'}`,
    `Host: ${data.minecraft ? `${data.minecraft.host}:${data.minecraft.port}` : '-'}`,
    `Proceso local activo: ${data.localProcess && data.localProcess.running ? 'si' : 'no'}`,
    `Contenedor: ${containerState}`,
    `Hora panel: ${new Date(data.serverTime).toLocaleString()}`,
  ];

  rows.forEach((row) => {
    const li = document.createElement('li');
    li.textContent = row;
    ui.opStatusList.appendChild(li);
  });

  return data;
}

async function refreshPlayers() {
  try {
    const data = await callApi('/api/players');
    ui.playersList.innerHTML = '';

    const summary = document.createElement('li');
    summary.textContent = data.online != null && data.max != null
      ? `Conectados: ${data.online}/${data.max}`
      : 'No fue posible parsear el total de jugadores';
    ui.playersList.appendChild(summary);

    if (!data.players || !data.players.length) {
      const li = document.createElement('li');
      li.textContent = 'No hay jugadores conectados.';
      ui.playersList.appendChild(li);
      return;
    }

    data.players.forEach((name) => {
      const li = document.createElement('li');
      li.textContent = name;
      ui.playersList.appendChild(li);
    });
  } catch (err) {
    ui.playersList.innerHTML = `<li>Error consultando jugadores: ${err.message}</li>`;
  }
}

async function refreshPortainer() {
  try {
    const data = await callApi('/api/portainer/status');
    ui.portainerStatusList.innerHTML = '';
    [
      `Nombre: ${data.name || '-'}`,
      `ID: ${data.id || '-'}`,
      `Imagen: ${data.image || '-'}`,
      `Estado: ${data.state || '-'}`,
      `Running: ${data.running ? 'si' : 'no'}`,
      `Inicio: ${data.startedAt || '-'}`,
      `Reinicios: ${data.restartCount ?? '-'}`,
    ].forEach((line) => {
      const li = document.createElement('li');
      li.textContent = line;
      ui.portainerStatusList.appendChild(li);
    });
  } catch (err) {
    ui.portainerStatusList.innerHTML = `<li>Error Portainer: ${err.message}</li>`;
  }
}

async function refreshFolders(pathValue = '.') {
  try {
    const data = await callApi(`/api/folders?path=${encodeURIComponent(pathValue)}`);
    state.activePath = data.currentPath || '.';
    ui.currentPath.textContent = state.activePath;
    ui.folderList.innerHTML = '';

    data.entries.forEach((entry) => {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.className = 'folder-item-btn';

      const icon = entry.type === 'dir' ? '[DIR]' : '[FILE]';
      const size = entry.type === 'file' ? ` (${Math.max(1, Math.round(entry.size / 1024))} KB)` : '';
      btn.textContent = `${icon} ${entry.name}${size}`;

      if (entry.type === 'dir') {
        btn.addEventListener('click', () => {
          const next = state.activePath === '.' ? entry.name : `${state.activePath}/${entry.name}`;
          refreshFolders(next);
        });
      }

      li.appendChild(btn);
      ui.folderList.appendChild(li);
    });
  } catch (err) {
    ui.folderList.innerHTML = `<li>${err.message}</li>`;
  }
}

async function refreshLogs() {
  try {
    const data = await callApi('/api/logs?lines=180');
    ui.logsOutput.textContent = data.lines && data.lines.length
      ? data.lines.join('\n')
      : (data.message || 'Sin logs disponibles');
    ui.logsOutput.scrollTop = ui.logsOutput.scrollHeight;
  } catch (err) {
    ui.logsOutput.textContent = `Error cargando logs: ${err.message}`;
  }
}

async function refreshConfig() {
  const data = await callApi('/api/config/public');
  ui.configOutput.textContent = JSON.stringify(data.config, null, 2);
}

async function runDiagnostics() {
  try {
    const data = await callApi('/api/diagnostics');
    ui.diagOutput.textContent = JSON.stringify(data.diagnostics, null, 2);
    showToast('Diagnostico completado', 'success');
  } catch (err) {
    ui.diagOutput.textContent = err.message;
    showToast(err.message, 'error');
  }
}

async function triggerServerAction(action) {
  try {
    await callApi(`/api/server/${action}`, { method: 'POST' });
    showToast(`Accion ${action} enviada`, 'success');
    await refreshAll();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function sendCommand() {
  const command = ui.commandInput.value.trim();
  if (!command) {
    showToast('Escribe un comando', 'error');
    return;
  }

  try {
    const data = await callApi('/api/server/command', {
      method: 'POST',
      body: JSON.stringify({ command }),
    });
    ui.commandOutput.textContent = data.output || 'Comando enviado sin salida';
    ui.commandInput.value = '';
    await refreshPlayers();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function triggerPortainerAction(action) {
  try {
    await callApi('/api/portainer/action', {
      method: 'POST',
      body: JSON.stringify({ action }),
    });
    showToast(`Portainer: ${action} enviado`, 'success');
    await refreshPortainer();
    await refreshStatus();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function refreshAll() {
  await Promise.all([
    refreshStatus(),
    refreshPlayers(),
    refreshPortainer(),
    refreshFolders(state.activePath),
    refreshLogs(),
    refreshConfig(),
  ]);
}

async function uploadCurrentFile() {
  const file = ui.uploadFileInput.files && ui.uploadFileInput.files[0];
  if (!file) {
    showToast('Selecciona un archivo para subir', 'error');
    return;
  }

  try {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('targetPath', state.activePath || '.');
    formData.append('overwrite', ui.uploadOverwrite.checked ? 'true' : 'false');

    const result = await callApi('/api/files/upload', {
      method: 'POST',
      body: formData,
    });

    showToast(`Archivo subido: ${result.fileName}`, 'success');
    ui.uploadFileInput.value = '';
    await refreshFolders(state.activePath);
  } catch (err) {
    showToast(err.message, 'error');
  }
}

document.getElementById('screenNav').addEventListener('click', (event) => {
  const btn = event.target.closest('.screen-btn');
  if (!btn) {
    return;
  }

  setScreen(btn.dataset.screen);
});

document.getElementById('refreshAllBtn').addEventListener('click', refreshAll);
document.getElementById('runDiagBtn').addEventListener('click', runDiagnostics);
document.getElementById('refreshPlayersBtn').addEventListener('click', refreshPlayers);
document.getElementById('refreshPortainerBtn').addEventListener('click', refreshPortainer);
document.getElementById('refreshLogsBtn').addEventListener('click', refreshLogs);
document.getElementById('startBtn').addEventListener('click', () => triggerServerAction('start'));
document.getElementById('stopBtn').addEventListener('click', () => triggerServerAction('stop'));
document.getElementById('restartBtn').addEventListener('click', () => triggerServerAction('restart'));
document.getElementById('opStartBtn').addEventListener('click', () => triggerServerAction('start'));
document.getElementById('opStopBtn').addEventListener('click', () => triggerServerAction('stop'));
document.getElementById('opRestartBtn').addEventListener('click', () => triggerServerAction('restart'));
document.getElementById('sendCommandBtn').addEventListener('click', sendCommand);

ui.commandInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    sendCommand();
  }
});

document.querySelectorAll('.portainer-action-btn').forEach((btn) => {
  btn.addEventListener('click', () => triggerPortainerAction(btn.dataset.portainerAction));
});

document.getElementById('folderUpBtn').addEventListener('click', () => {
  if (state.activePath === '.') {
    return;
  }

  const parts = state.activePath.split('/').filter(Boolean);
  parts.pop();
  const next = parts.length ? parts.join('/') : '.';
  refreshFolders(next);
});

ui.uploadFileBtn.addEventListener('click', uploadCurrentFile);

setInterval(() => {
  refreshStatus();
  refreshPlayers();
}, 9000);

setInterval(() => {
  if (state.currentScreen === 'logs') {
    refreshLogs();
  }
}, 10000);

refreshAll().catch((err) => {
  showToast(err.message, 'error');
});
