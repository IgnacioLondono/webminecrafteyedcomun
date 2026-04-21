# Deploy in Portainer using Git Repository

Use the **Repository** option in Portainer Stacks.

## Values for the Portainer form

- Repository URL: `https://github.com/IgnacioLondono/webminecrafteyedcomun.git`
- Repository reference: `refs/heads/main`
- Compose path: `docker-compose.yml`

## Environment variables

Set these in the **Environment variables** section (or paste from `stack.env.sample`):

- `RCON_PASSWORD`
- `PORTAINER_API_KEY`
- Optional overrides: `PANEL_PORT`, `MC_HOST`, `MC_PORT`, `PORTAINER_ENDPOINT_ID`, `PORTAINER_CONTAINER_ID`, `FILES_ENABLED`

## Notes

- If `FILES_ENABLED=true`, the host path `/minecraftpruebas/data` must exist in the machine where Portainer deploys this stack.
- Open panel in: `http://<host-ip>:<PANEL_PORT>`.
- Default panel URL: `http://<host-ip>:3090`.
