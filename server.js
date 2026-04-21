const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');
const { URL } = require('url');

const ROOT_DIR = __dirname;
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const CONFIG_PATH = path.join(ROOT_DIR, 'server.config.json');
const SAMPLE_CONFIG_PATH = path.join(ROOT_DIR, 'server.config.sample.json');

let minecraftProcess = null;
let startedAt = null;

function deepMerge(base, patch) {
  if (!patch || typeof patch !== 'object') {
    return base;
  }

  const out = { ...base };
  Object.keys(patch).forEach((key) => {
    const baseValue = out[key];
    const patchValue = patch[key];

    if (
      baseValue &&
      patchValue &&
      typeof baseValue === 'object' &&
      typeof patchValue === 'object' &&
      !Array.isArray(baseValue) &&
      !Array.isArray(patchValue)
    ) {
      out[key] = deepMerge(baseValue, patchValue);
      return;
    }

    out[key] = patchValue;
  });

  return out;
}

function loadConfig() {
  const fallback = JSON.parse(fs.readFileSync(SAMPLE_CONFIG_PATH, 'utf-8'));
  if (!fs.existsSync(CONFIG_PATH)) {
    return fallback;
  }

  const userConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  return deepMerge(fallback, userConfig);
}

function json(res, statusCode, data) {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1024 * 1024) {
        reject(new Error('Request demasiado grande'));
      }
    });

    req.on('end', () => {
      if (!data) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(data));
      } catch (_err) {
        reject(new Error('JSON invalido'));
      }
    });
  });
}

function readRawBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;

    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error('Archivo demasiado grande para subir'));
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      resolve(Buffer.concat(chunks));
    });

    req.on('error', (err) => {
      reject(err);
    });
  });
}

async function parseMultipartFormData(req, maxBytes = 50 * 1024 * 1024) {
  const contentType = req.headers['content-type'] || '';
  const boundaryMatch = contentType.match(/boundary=([^;]+)/i);
  if (!boundaryMatch) {
    throw new Error('Falta boundary en multipart/form-data');
  }

  const boundary = boundaryMatch[1].replace(/^"|"$/g, '');
  const boundaryToken = Buffer.from(`--${boundary}`);
  const body = await readRawBody(req, maxBytes);

  const fields = {};
  const files = {};

  let cursor = body.indexOf(boundaryToken);
  while (cursor !== -1) {
    let partStart = cursor + boundaryToken.length;

    if (body.slice(partStart, partStart + 2).toString() === '--') {
      break;
    }

    if (body.slice(partStart, partStart + 2).toString() === '\r\n') {
      partStart += 2;
    }

    const nextBoundary = body.indexOf(boundaryToken, partStart);
    if (nextBoundary === -1) {
      break;
    }

    let part = body.slice(partStart, nextBoundary);
    if (part.slice(-2).toString() === '\r\n') {
      part = part.slice(0, -2);
    }

    const headerEnd = part.indexOf(Buffer.from('\r\n\r\n'));
    if (headerEnd === -1) {
      cursor = nextBoundary;
      continue;
    }

    const headersText = part.slice(0, headerEnd).toString('utf8');
    const content = part.slice(headerEnd + 4);
    const headerLines = headersText.split('\r\n');
    const disposition = headerLines.find((line) => /^content-disposition:/i.test(line));

    if (!disposition) {
      cursor = nextBoundary;
      continue;
    }

    const nameMatch = disposition.match(/name="([^"]+)"/i);
    if (!nameMatch) {
      cursor = nextBoundary;
      continue;
    }

    const fieldName = nameMatch[1];
    const filenameMatch = disposition.match(/filename="([^"]*)"/i);

    if (filenameMatch) {
      const contentTypeLine = headerLines.find((line) => /^content-type:/i.test(line));
      const contentTypeValue = contentTypeLine ? contentTypeLine.split(':').slice(1).join(':').trim() : 'application/octet-stream';
      files[fieldName] = {
        filename: filenameMatch[1],
        contentType: contentTypeValue,
        data: content,
      };
    } else {
      fields[fieldName] = content.toString('utf8');
    }

    cursor = nextBoundary;
  }

  return { fields, files };
}

function sanitizeFileName(fileName) {
  const baseName = path.basename(fileName || '');
  return baseName.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').trim();
}

function normalizeSafePath(basePath, candidatePath) {
  const resolved = path.resolve(basePath, candidatePath || '.');
  const normalizedBase = path.resolve(basePath);
  if (resolved !== normalizedBase && !resolved.startsWith(normalizedBase + path.sep)) {
    return null;
  }
  return resolved;
}

function getLocalProcessStatus() {
  return {
    running: Boolean(minecraftProcess && !minecraftProcess.killed),
    pid: minecraftProcess ? minecraftProcess.pid : null,
    uptimeSeconds: startedAt ? Math.floor((Date.now() - startedAt) / 1000) : 0,
  };
}

function startMinecraftLocal(config) {
  if (!config.localControl || !config.localControl.enabled) {
    throw new Error('El control local esta deshabilitado');
  }

  if (minecraftProcess && !minecraftProcess.killed) {
    throw new Error('El proceso local ya esta en ejecucion');
  }

  const cwd = path.resolve(config.localControl.serverDirectory);
  if (!fs.existsSync(cwd)) {
    throw new Error('No existe localControl.serverDirectory');
  }

  minecraftProcess = spawn(config.localControl.startupCommand, {
    cwd,
    shell: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  startedAt = Date.now();
  const runtimeLog = path.join(cwd, 'panel-runtime.log');

  const writeLog = (prefix, chunk) => {
    const line = `[${new Date().toISOString()}] ${prefix} ${chunk.toString()}`;
    fs.appendFile(runtimeLog, line, () => {});
  };

  minecraftProcess.stdout.on('data', (chunk) => writeLog('STDOUT', chunk));
  minecraftProcess.stderr.on('data', (chunk) => writeLog('STDERR', chunk));

  minecraftProcess.on('exit', () => {
    minecraftProcess = null;
    startedAt = null;
  });
}

async function stopMinecraftLocal(config) {
  if (!minecraftProcess || minecraftProcess.killed) {
    throw new Error('No hay proceso local en ejecucion');
  }

  try {
    await sendRconCommand(config, 'stop');
  } catch (_err) {
    if (minecraftProcess.stdin && !minecraftProcess.stdin.destroyed) {
      minecraftProcess.stdin.write('stop\n');
    }
  }

  await new Promise((resolve) => setTimeout(resolve, 4000));
  if (minecraftProcess && !minecraftProcess.killed) {
    minecraftProcess.kill('SIGTERM');
  }
}

function writeVarInt(value) {
  const bytes = [];
  let val = value >>> 0;
  do {
    let temp = val & 0b01111111;
    val >>>= 7;
    if (val !== 0) {
      temp |= 0b10000000;
    }
    bytes.push(temp);
  } while (val !== 0);
  return Buffer.from(bytes);
}

function readVarInt(buffer, offset = 0) {
  let numRead = 0;
  let result = 0;
  let read;

  do {
    if (offset + numRead >= buffer.length) {
      return null;
    }

    read = buffer[offset + numRead];
    const value = read & 0b01111111;
    result |= value << (7 * numRead);
    numRead += 1;

    if (numRead > 5) {
      throw new Error('VarInt demasiado grande');
    }
  } while ((read & 0b10000000) !== 0);

  return { value: result, size: numRead };
}

function buildMinecraftStatusHandshake(host, port, protocolVersion) {
  const packetId = writeVarInt(0x00);
  const protocol = writeVarInt(protocolVersion);
  const hostBuffer = Buffer.from(host, 'utf8');
  const hostLength = writeVarInt(hostBuffer.length);
  const portBuffer = Buffer.alloc(2);
  portBuffer.writeUInt16BE(port, 0);
  const nextState = writeVarInt(0x01);

  const data = Buffer.concat([packetId, protocol, hostLength, hostBuffer, portBuffer, nextState]);
  const length = writeVarInt(data.length);
  return Buffer.concat([length, data]);
}

function buildMinecraftStatusRequest() {
  return Buffer.from([0x01, 0x00]);
}

function parseMinecraftStatusResponse(buffer) {
  const packetLength = readVarInt(buffer, 0);
  if (!packetLength) {
    return null;
  }

  if (buffer.length < packetLength.value + packetLength.size) {
    return null;
  }

  const packetId = readVarInt(buffer, packetLength.size);
  if (!packetId || packetId.value !== 0x00) {
    throw new Error('Respuesta de status invalida');
  }

  const jsonLengthStart = packetLength.size + packetId.size;
  const jsonLength = readVarInt(buffer, jsonLengthStart);
  if (!jsonLength) {
    return null;
  }

  const jsonStart = jsonLengthStart + jsonLength.size;
  const jsonEnd = jsonStart + jsonLength.value;
  if (buffer.length < jsonEnd) {
    return null;
  }

  const payload = buffer.toString('utf8', jsonStart, jsonEnd);
  return JSON.parse(payload);
}

function pingMinecraftServer(config) {
  const host = config.minecraft.host;
  const port = config.minecraft.port;
  const protocolVersion = config.minecraft.protocolVersion || 760;
  const timeoutMs = config.minecraft.timeoutMs || 5000;

  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    let chunks = [];
    let done = false;

    const finish = (fn) => {
      if (done) {
        return;
      }
      done = true;
      socket.destroy();
      fn();
    };

    socket.setTimeout(timeoutMs);

    socket.connect(port, host, () => {
      socket.write(buildMinecraftStatusHandshake(host, port, protocolVersion));
      socket.write(buildMinecraftStatusRequest());
    });

    socket.on('data', (data) => {
      chunks.push(data);
      try {
        const merged = Buffer.concat(chunks);
        const parsed = parseMinecraftStatusResponse(merged);
        if (!parsed) {
          return;
        }

        finish(() => {
          resolve({
            online: true,
            host,
            port,
            version: parsed.version ? parsed.version.name : 'unknown',
            protocol: parsed.version ? parsed.version.protocol : null,
            players: {
              online: parsed.players ? parsed.players.online : null,
              max: parsed.players ? parsed.players.max : null,
              sample: parsed.players && parsed.players.sample ? parsed.players.sample.map((p) => p.name) : [],
            },
            motd: parsed.description,
            favicon: parsed.favicon || null,
          });
        });
      } catch (err) {
        finish(() => reject(err));
      }
    });

    socket.on('timeout', () => finish(() => reject(new Error('Timeout al consultar estado de Minecraft'))));
    socket.on('error', (err) => finish(() => reject(new Error(`No se pudo conectar a ${host}:${port} (${err.message})`))));
  });
}

function encodeRconPacket(id, type, payload) {
  const payloadBuffer = Buffer.from(payload, 'utf8');
  const length = 4 + 4 + payloadBuffer.length + 2;
  const packet = Buffer.alloc(4 + length);
  packet.writeInt32LE(length, 0);
  packet.writeInt32LE(id, 4);
  packet.writeInt32LE(type, 8);
  payloadBuffer.copy(packet, 12);
  packet.writeInt16LE(0, 12 + payloadBuffer.length);
  return packet;
}

function decodeRconPacket(buffer) {
  const length = buffer.readInt32LE(0);
  const id = buffer.readInt32LE(4);
  const type = buffer.readInt32LE(8);
  const payload = buffer.toString('utf8', 12, 12 + length - 10);
  return { id, type, payload };
}

function sendRconCommand(config, command) {
  if (!config.rcon || !config.rcon.enabled) {
    return Promise.reject(new Error('RCON no esta habilitado'));
  }

  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    const requestId = 1337;
    const authPacket = encodeRconPacket(requestId, 3, config.rcon.password || '');
    const commandPacket = encodeRconPacket(requestId + 1, 2, command);
    let stage = 'auth';

    socket.setTimeout(config.rcon.timeoutMs || 5000);
    socket.connect(config.rcon.port, config.rcon.host, () => {
      socket.write(authPacket);
    });

    socket.on('data', (data) => {
      if (data.length < 12) {
        return;
      }

      const packet = decodeRconPacket(data);

      if (stage === 'auth') {
        if (packet.id === -1) {
          socket.destroy();
          reject(new Error('Autenticacion RCON fallida'));
          return;
        }

        stage = 'command';
        socket.write(commandPacket);
        return;
      }

      resolve(packet.payload || 'OK');
      socket.end();
    });

    socket.on('timeout', () => {
      socket.destroy();
      reject(new Error('Timeout de RCON'));
    });

    socket.on('error', (err) => {
      reject(new Error(`RCON error: ${err.message}`));
    });
  });
}

function parsePlayerListOutput(output) {
  const onlineMatch = output.match(/There are\s+(\d+)\s+of a max of\s+(\d+)\s+players online:?\s*(.*)$/i);
  if (!onlineMatch) {
    return {
      online: null,
      max: null,
      players: [],
      raw: output,
    };
  }

  const playersRaw = (onlineMatch[3] || '').trim();
  const players = playersRaw
    ? playersRaw.split(',').map((name) => name.trim()).filter(Boolean)
    : [];

  return {
    online: Number(onlineMatch[1]),
    max: Number(onlineMatch[2]),
    players,
    raw: output,
  };
}

function getPortainerHeaders(config) {
  if (!config.portainer || !config.portainer.enabled) {
    throw new Error('Portainer no esta habilitado');
  }

  if (!config.portainer.baseUrl || !config.portainer.endpointId || !config.portainer.containerId) {
    throw new Error('Falta configurar baseUrl, endpointId o containerId de Portainer');
  }

  const headers = { 'Content-Type': 'application/json' };
  if (config.portainer.authType === 'apiKey') {
    if (!config.portainer.apiKey) {
      throw new Error('Falta portainer.apiKey');
    }
    headers['X-API-Key'] = config.portainer.apiKey;
  } else if (config.portainer.authType === 'bearer') {
    if (!config.portainer.bearerToken) {
      throw new Error('Falta portainer.bearerToken');
    }
    headers.Authorization = `Bearer ${config.portainer.bearerToken}`;
  } else {
    throw new Error('portainer.authType debe ser apiKey o bearer');
  }

  return headers;
}

function requestJson(fullUrl, options = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(fullUrl);
    const isHttps = parsed.protocol === 'https:';
    const driver = isHttps ? https : http;

    const req = driver.request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method: options.method || 'GET',
        headers: options.headers || {},
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let parsedBody = null;

          if (text) {
            try {
              parsedBody = JSON.parse(text);
            } catch (_err) {
              parsedBody = text;
            }
          }

          if (res.statusCode >= 400) {
            const suffix = typeof parsedBody === 'string'
              ? parsedBody
              : JSON.stringify(parsedBody);
            reject(new Error(`HTTP ${res.statusCode} en ${parsed.pathname}: ${suffix}`));
            return;
          }

          resolve(parsedBody);
        });
      }
    );

    req.setTimeout(options.timeoutMs || 8000, () => {
      req.destroy(new Error('Timeout HTTP'));
    });

    req.on('error', (err) => reject(new Error(`Error HTTP: ${err.message}`)));

    if (options.body) {
      req.write(options.body);
    }

    req.end();
  });
}

function getPortainerBase(config) {
  return config.portainer.baseUrl.replace(/\/$/, '');
}

async function getPortainerContainerStatus(config) {
  if (!config.portainer.enabled) {
    return {
      enabled: false,
      message: 'Portainer deshabilitado',
    };
  }

  const base = getPortainerBase(config);
  const headers = getPortainerHeaders(config);
  const endpointId = encodeURIComponent(config.portainer.endpointId);
  const containerId = encodeURIComponent(config.portainer.containerId);

  const inspect = await requestJson(
    `${base}/api/endpoints/${endpointId}/docker/containers/${containerId}/json`,
    { headers, timeoutMs: config.portainer.timeoutMs || 8000 }
  );

  return {
    enabled: true,
    id: inspect.Id,
    name: inspect.Name ? inspect.Name.replace(/^\//, '') : config.portainer.containerId,
    image: inspect.Config ? inspect.Config.Image : null,
    state: inspect.State ? inspect.State.Status : 'unknown',
    running: Boolean(inspect.State && inspect.State.Running),
    startedAt: inspect.State ? inspect.State.StartedAt : null,
    finishedAt: inspect.State ? inspect.State.FinishedAt : null,
    restartCount: inspect.RestartCount,
  };
}

async function portainerContainerAction(config, action) {
  const normalized = String(action || '').toLowerCase();
  if (!['start', 'stop', 'restart'].includes(normalized)) {
    throw new Error('Accion de contenedor invalida');
  }

  const base = getPortainerBase(config);
  const headers = getPortainerHeaders(config);
  const endpointId = encodeURIComponent(config.portainer.endpointId);
  const containerId = encodeURIComponent(config.portainer.containerId);

  await requestJson(
    `${base}/api/endpoints/${endpointId}/docker/containers/${containerId}/${normalized}`,
    {
      method: 'POST',
      headers,
      timeoutMs: config.portainer.timeoutMs || 8000,
      body: '',
    }
  );

  return {
    ok: true,
    action: normalized,
  };
}

async function performServerAction(config, action) {
  if (config.controlMode === 'portainer') {
    return portainerContainerAction(config, action);
  }

  if (config.controlMode === 'local') {
    if (action === 'start') {
      startMinecraftLocal(config);
      return { ok: true, action };
    }

    if (action === 'stop') {
      await stopMinecraftLocal(config);
      return { ok: true, action };
    }

    if (action === 'restart') {
      try {
        await stopMinecraftLocal(config);
      } catch (_err) {
      }
      startMinecraftLocal(config);
      return { ok: true, action };
    }
  }

  throw new Error('controlMode no soportado. Usa portainer o local');
}

function getPublicConfig(config) {
  return {
    panelPort: config.port,
    controlMode: config.controlMode,
    minecraft: {
      host: config.minecraft.host,
      port: config.minecraft.port,
      protocolVersion: config.minecraft.protocolVersion,
    },
    rcon: {
      enabled: config.rcon.enabled,
      host: config.rcon.host,
      port: config.rcon.port,
    },
    portainer: {
      enabled: config.portainer.enabled,
      baseUrl: config.portainer.baseUrl,
      endpointId: config.portainer.endpointId,
      containerId: config.portainer.containerId,
      authType: config.portainer.authType,
    },
    files: {
      enabled: config.files.enabled,
      rootDirectory: config.files.rootDirectory,
      logsPath: config.files.logsPath,
    },
  };
}

function serveStatic(req, res, pathname) {
  const safePath = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.join(PUBLIC_DIR, safePath);
  const normalizedPublic = path.resolve(PUBLIC_DIR);
  const normalizedFile = path.resolve(filePath);

  if (!normalizedFile.startsWith(normalizedPublic)) {
    json(res, 403, { ok: false, error: 'Ruta no permitida' });
    return;
  }

  fs.readFile(normalizedFile, (err, data) => {
    if (err) {
      json(res, 404, { ok: false, error: 'No encontrado' });
      return;
    }

    const ext = path.extname(normalizedFile).toLowerCase();
    const mime = {
      '.html': 'text/html; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
    }[ext] || 'application/octet-stream';

    res.writeHead(200, { 'Content-Type': mime });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const config = loadConfig();
  const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
  const pathname = parsedUrl.pathname;

  try {
    if (pathname === '/api/status' && req.method === 'GET') {
      const localProcess = getLocalProcessStatus();
      let minecraft = null;
      let portainer = null;

      try {
        minecraft = await pingMinecraftServer(config);
      } catch (err) {
        minecraft = {
          online: false,
          host: config.minecraft.host,
          port: config.minecraft.port,
          error: err.message,
        };
      }

      if (config.portainer.enabled) {
        try {
          portainer = await getPortainerContainerStatus(config);
        } catch (err) {
          portainer = {
            enabled: true,
            error: err.message,
          };
        }
      }

      json(res, 200, {
        ok: true,
        serverTime: new Date().toISOString(),
        localProcess,
        minecraft,
        portainer,
        mode: config.controlMode,
      });
      return;
    }

    if (pathname === '/api/config/public' && req.method === 'GET') {
      json(res, 200, { ok: true, config: getPublicConfig(config) });
      return;
    }

    if (pathname === '/api/minecraft/ping' && req.method === 'GET') {
      const data = await pingMinecraftServer(config);
      json(res, 200, { ok: true, ...data });
      return;
    }

    if (pathname === '/api/server/start' && req.method === 'POST') {
      await performServerAction(config, 'start');
      json(res, 200, { ok: true, message: 'Solicitud de inicio enviada' });
      return;
    }

    if (pathname === '/api/server/stop' && req.method === 'POST') {
      await performServerAction(config, 'stop');
      json(res, 200, { ok: true, message: 'Solicitud de apagado enviada' });
      return;
    }

    if (pathname === '/api/server/restart' && req.method === 'POST') {
      await performServerAction(config, 'restart');
      json(res, 200, { ok: true, message: 'Solicitud de reinicio enviada' });
      return;
    }

    if (pathname === '/api/server/command' && req.method === 'POST') {
      const body = await parseBody(req);
      if (!body.command || typeof body.command !== 'string') {
        json(res, 400, { ok: false, error: 'Debes enviar { command }' });
        return;
      }

      const output = await sendRconCommand(config, body.command);
      json(res, 200, { ok: true, command: body.command, output });
      return;
    }

    if (pathname === '/api/players' && req.method === 'GET') {
      const listResponse = await sendRconCommand(config, 'list');
      json(res, 200, { ok: true, ...parsePlayerListOutput(listResponse) });
      return;
    }

    if (pathname === '/api/portainer/status' && req.method === 'GET') {
      const status = await getPortainerContainerStatus(config);
      json(res, 200, { ok: true, ...status });
      return;
    }

    if (pathname === '/api/portainer/action' && req.method === 'POST') {
      const body = await parseBody(req);
      const result = await portainerContainerAction(config, body.action);
      json(res, 200, result);
      return;
    }

    if (pathname === '/api/folders' && req.method === 'GET') {
      if (!config.files.enabled) {
        json(res, 400, { ok: false, error: 'Explorador de archivos deshabilitado en config' });
        return;
      }

      const relativePath = parsedUrl.searchParams.get('path') || '.';
      const safeDir = normalizeSafePath(config.files.rootDirectory, relativePath);
      if (!safeDir) {
        json(res, 400, { ok: false, error: 'Ruta invalida' });
        return;
      }

      if (!fs.existsSync(safeDir)) {
        json(res, 404, { ok: false, error: 'Ruta no existe' });
        return;
      }

      const entries = fs.readdirSync(safeDir, { withFileTypes: true })
        .map((entry) => {
          const fullPath = path.join(safeDir, entry.name);
          const stats = fs.statSync(fullPath);
          return {
            name: entry.name,
            type: entry.isDirectory() ? 'dir' : 'file',
            size: entry.isDirectory() ? null : stats.size,
            modifiedAt: stats.mtime.toISOString(),
          };
        })
        .sort((a, b) => {
          if (a.type !== b.type) {
            return a.type === 'dir' ? -1 : 1;
          }
          return a.name.localeCompare(b.name);
        });

      const currentRelative = path.relative(path.resolve(config.files.rootDirectory), safeDir) || '.';
      const parentRelative = currentRelative === '.' ? null : path.dirname(currentRelative);

      json(res, 200, {
        ok: true,
        currentPath: currentRelative,
        parentPath: parentRelative,
        entries,
      });
      return;
    }

    if (pathname === '/api/files/upload' && req.method === 'POST') {
      if (!config.files.enabled) {
        json(res, 400, { ok: false, error: 'Subida de archivos deshabilitada en config' });
        return;
      }

      const multipart = await parseMultipartFormData(req, 100 * 1024 * 1024);
      const fileField = multipart.files.file || Object.values(multipart.files)[0];
      if (!fileField) {
        json(res, 400, { ok: false, error: 'No se envio archivo en el campo file' });
        return;
      }

      const targetPath = multipart.fields.targetPath || '.';
      const safeDir = normalizeSafePath(config.files.rootDirectory, targetPath);
      if (!safeDir) {
        json(res, 400, { ok: false, error: 'Ruta destino invalida' });
        return;
      }

      if (!fs.existsSync(safeDir)) {
        json(res, 404, { ok: false, error: 'La carpeta destino no existe' });
        return;
      }

      const safeName = sanitizeFileName(fileField.filename);
      if (!safeName) {
        json(res, 400, { ok: false, error: 'Nombre de archivo invalido' });
        return;
      }

      const destination = path.join(safeDir, safeName);
      const overwrite = String(multipart.fields.overwrite || '').toLowerCase() === 'true';

      if (fs.existsSync(destination) && !overwrite) {
        json(res, 409, { ok: false, error: 'El archivo ya existe. Activa overwrite para reemplazarlo.' });
        return;
      }

      fs.writeFileSync(destination, fileField.data);

      json(res, 200, {
        ok: true,
        fileName: safeName,
        bytes: fileField.data.length,
        currentPath: path.relative(path.resolve(config.files.rootDirectory), safeDir) || '.',
      });
      return;
    }

    if (pathname === '/api/logs' && req.method === 'GET') {
      if (!config.files.enabled) {
        json(res, 400, { ok: false, error: 'Logs deshabilitados en config' });
        return;
      }

      const lines = Math.min(Number(parsedUrl.searchParams.get('lines') || 120), 700);
      const logPath = path.resolve(config.files.logsPath);

      if (!fs.existsSync(logPath)) {
        json(res, 200, { ok: true, lines: [], message: `No existe ${logPath}` });
        return;
      }

      const content = fs.readFileSync(logPath, 'utf-8');
      const dataLines = content.split(/\r?\n/).filter(Boolean);

      json(res, 200, {
        ok: true,
        path: logPath,
        lines: dataLines.slice(-lines),
      });
      return;
    }

    if (pathname === '/api/diagnostics' && req.method === 'GET') {
      const diagnostics = {
        minecraftPing: { ok: false },
        rcon: { ok: false },
        portainer: { ok: false },
      };

      try {
        const ping = await pingMinecraftServer(config);
        diagnostics.minecraftPing = { ok: true, online: ping.online, version: ping.version };
      } catch (err) {
        diagnostics.minecraftPing = { ok: false, error: err.message };
      }

      try {
        const rcon = await sendRconCommand(config, 'list');
        diagnostics.rcon = { ok: true, output: rcon };
      } catch (err) {
        diagnostics.rcon = { ok: false, error: err.message };
      }

      try {
        const p = await getPortainerContainerStatus(config);
        diagnostics.portainer = { ok: true, running: p.running, state: p.state };
      } catch (err) {
        diagnostics.portainer = { ok: false, error: err.message };
      }

      json(res, 200, { ok: true, diagnostics });
      return;
    }

    serveStatic(req, res, pathname);
  } catch (err) {
    json(res, 500, { ok: false, error: err.message });
  }
});

const cfg = loadConfig();
server.listen(cfg.port, () => {
  console.log(`Panel disponible en http://localhost:${cfg.port}`);
  if (!fs.existsSync(CONFIG_PATH)) {
    console.log('Crea server.config.json a partir de server.config.sample.json');
  }
});
