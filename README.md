# Panel Web Profesional para Minecraft + Portainer

Panel web completo para administrar un servidor de Minecraft remoto (o local) con multiples pantallas:

- Dashboard operativo en tiempo real
- Control de encendido/apagado/reinicio
- Consola de comandos RCON
- Jugadores conectados
- Estado del contenedor en Portainer
- Explorador de archivos (opcional)
- Logs en vivo
- Diagnostico de conectividad

## Escenario recomendado (tu caso)

Servidor Minecraft remoto en `192.168.50.197:25565` con despliegue en Portainer.

El panel ya viene preparado para este modo en el archivo de ejemplo.

## 1) Configuracion

1. Copia `server.config.sample.json` a `server.config.json`.
2. Completa estos datos en `server.config.json`:
  - `rcon.password`
  - `portainer.apiKey` (o bearer token)
  - `portainer.endpointId`
  - `portainer.containerId`
3. Si quieres explorar archivos/logs desde el panel, activa `files.enabled` y configura rutas reales en `files.rootDirectory` y `files.logsPath`.

## 2) Configuracion de Minecraft

En `server.properties` del servidor:

```properties
enable-rcon=true
rcon.port=25575
rcon.password=TU_PASSWORD
```

## 3) Configuracion de Portainer

En Portainer:

1. Crea una API Key para tu usuario.
2. Ubica el `endpointId` (entorno Docker).
3. Obtiene el `containerId` del contenedor del servidor.

El panel usa la API Docker proxy de Portainer para start/stop/restart.

## 4) Ejecutar

```bash
npm start
```

Abre `http://localhost:3000`.

## Seguridad

- No expongas este panel directo a internet.
- Si lo publicas, usa reverse proxy con TLS + autenticacion.
- Mantén la API key de Portainer fuera de repositorios.
