# Phase 2 — `GrokBotBackend` (interim computer-gateway callback)

Date: 2026-08-14  
Status: **interim, unofficial** — no first-party Discord / Channels inbound API  
Repo role: keep Discord UX + access control; persona/tools live in a Grok Bot agent

## What we have today

| Piece | State |
|-------|--------|
| Discord gateway (`discord.js`) | Production |
| `OpenAICompatibleBackend` | **Default production path** (`AGENT_BACKEND=openai`) |
| `GrokBotBackend` | Implemented against the **undocumented-but-real** Grok Bot computer HTTP gateway + a bridge callback |
| Access / rate limit / split / thread memory / channel context | Done |
| `POST /internal/reply` | Authenticated in-process HTTP server on the bridge |

Grok Bot has **no official Discord plugin**. The working community path is a private HTTP gateway on each Grok Bot computer (typically port **1340**, bearer token in that computer's `gateway.json`).

Verified gateway methods (do not invent others):

- `POST /api/listAgents`
- `POST /api/sendPrompt` `{ agentId, prompt }`
- `GET /health`

`sendPrompt` **wakes the agent asynchronously**. It does **not** return the agent's reply. Replies normally go to Grok Bot chat via the agent's `SendMessage`. Discord only receives text the agent `POST`s back to this bridge.

This design is **unofficial and may break** if the computer gateway changes.

## Interim architecture

```mermaid
flowchart LR
  D[Discord Gateway] --> B[discord-agent-bridge]
  B --> A[Access + rate limit]
  A --> G[GrokBotBackend]
  G --> GW[POST /api/sendPrompt]
  GW --> Agent[Grok Bot agent]
  Agent --> CB[POST /internal/reply]
  CB --> B
  B --> D
```

1. Discord message passes access control.
2. `GrokBotBackend.generate()` creates a `correlationId`, registers a pending waiter, and `POST`s `sendPrompt` to `GROK_BOT_GATEWAY_URL`.
3. The prompt includes a machine-readable `DISCORD_BRIDGE_REPLY` block plus the human Discord message and `AgentRequest` context.
4. The Grok Bot agent `POST`s `{ correlationId, text }` to `BRIDGE_PUBLIC_URL/internal/reply` with the one-time bearer capability from that request's prompt.
5. The bridge looks up the pending request, posts `text` to the matching Discord channel/thread (same ~1900 split as existing replies), then resolves `generate()`.
6. If nothing arrives within `GROK_BOT_TIMEOUT_MS` (default 120s), `generate()` fails so Discord is not stuck typing.

## Callback contract

`POST /internal/reply`

| Rule | Behavior |
|------|----------|
| Listen | `BRIDGE_HTTP_HOST` / `BRIDGE_HTTP_PORT` (defaults `0.0.0.0` / `8788`) |
| Auth | `Authorization: Bearer <per-request capability>` — **fail closed** if missing or wrong → 401 |
| Body | `{ "correlationId": string, "text": string }` (`error` optional) |
| Unknown / expired id | 404 |
| Missing fields | 400 |
| Discord delivery failure | 503 `{ "error": "delivery_failed" }` — pending entry kept for retry |
| Success | 200 `{ "ok": true }` |

This is **not** an unauthenticated public webhook. `BRIDGE_REPLY_TOKEN` remains server-side and protects the one-time capabilities. Do not log it, the capabilities, or `GROK_BOT_TOKEN`.

`replyUrl` given to the agent is `BRIDGE_PUBLIC_URL + /internal/reply`. That URL must be reachable from the Grok Bot computer. Two topologies:

| Topology | Where the bridge runs | Typical URLs | Network |
|----------|----------------------|--------------|---------|
| **Colocated host process (works today)** | `npm start` on the Grok Bot computer (same host network as the gateway — **not** Docker Compose) | `GROK_BOT_GATEWAY_URL=http://127.0.0.1:1340`, `BRIDGE_PUBLIC_URL=http://127.0.0.1:8788`, `BRIDGE_HTTP_HOST=127.0.0.1` | No Tailscale. Bind the callback to the **host** loopback only. |
| **Split-machine** | A different machine (for example Docker on a laptop) | Gateway URL is the Grok Bot host; `BRIDGE_PUBLIC_URL` is the bridge host | `localhost` on the Grok Bot computer is **not** the bridge. Use Tailscale, an SSH tunnel, or another private path. |

`docker compose` + `127.0.0.1` on the Grok Bot computer is **not** the colocated topology. Inside the container, `127.0.0.1:1340` is the container, not the host gateway, and `BRIDGE_HTTP_HOST=127.0.0.1` binds the callback to the container loopback so Compose's published port cannot reach it. Docker on that same host is a different setup: reach the host gateway via `host.docker.internal` / `extra_hosts`, and do **not** bind the callback to the container's `127.0.0.1` if you need a published port. Prefer the host-process path.

**Never** expose the Grok Bot gateway port (`:1340`) or the callback port (`:8788`) to the internet. Keep `DISCORD_BOT_TOKEN` in the bridge's local `.env` only — never in the Grok Bot agent, `gateway.json`, or git.

## Env (grok-bot mode)

| Variable | Required | Purpose |
|----------|----------|---------|
| `AGENT_BACKEND=grok-bot` | yes (to select) | Select this backend |
| `GROK_BOT_GATEWAY_URL` | yes | Colocated host process: `http://127.0.0.1:1340`. Split-machine: private host URL. |
| `GROK_BOT_TOKEN` | yes | Bearer from that computer's `gateway.json` (password) |
| `GROK_BOT_AGENT_ID` | yes | Target agent id from `POST /api/listAgents` (from env; do not hardcode a real id) |
| `GROK_BOT_TIMEOUT_MS` | no | Default `120000` |
| `BRIDGE_HTTP_HOST` | no | Default `0.0.0.0`. Colocated host process: `127.0.0.1` |
| `BRIDGE_HTTP_PORT` | no | Default `8788` (Compose maps `${BRIDGE_HTTP_PORT:-8788}:${BRIDGE_HTTP_PORT:-8788}`) |
| `BRIDGE_PUBLIC_URL` | yes | URL the Grok Bot computer uses to reach the bridge. Colocated host process: `http://127.0.0.1:8788` |
| `BRIDGE_REPLY_TOKEN` | yes | Server-side capability key (generate locally; do not commit or place in prompts) |

OpenAI-compatible remains the default. grok-bot fails closed if required vars are missing.

### Colocated setup (host process on the Grok Bot computer)

This is the path that works today without Tailscale or a tunnel: a **host-process-only** topology (`npm start` on the Grok Bot computer). It is **not** `docker compose` on that host.

**Prerequisites:** Node.js 20+ on the Grok Bot computer (host process, not a container); Discord bot token in a local `.env` only; gateway on `127.0.0.1:1340`.

1. Copy `.env.example` → `.env` on the Grok Bot computer. Set `AGENT_BACKEND=grok-bot` and:

   ```
   GROK_BOT_GATEWAY_URL=http://127.0.0.1:1340
   BRIDGE_PUBLIC_URL=http://127.0.0.1:8788
   BRIDGE_HTTP_HOST=127.0.0.1
   ```

2. `GROK_BOT_TOKEN` — bearer from that computer's `gateway.json`. Grok Bot computers commonly store this at `/home/box/sand-data/gateway.json`; use the path that computer actually uses. Treat the token like a password.

3. `GROK_BOT_AGENT_ID` — from `POST /api/listAgents` on the gateway (`Authorization: Bearer <GROK_BOT_TOKEN>`). Pick the target agent id from the response. Do not hardcode a real id in this repo.

4. Generate `BRIDGE_REPLY_TOKEN` (`openssl rand -hex 32` or equivalent). Do not commit it.

5. Set Discord allowlists. Keep the Discord application **private**.

6. `npm ci && npm run build && npm start`. An optional `while true; do npm start; ...; done` loop only restarts the Node child if it exits **while that shell stays alive**. A Grok Bot computer **Update** keeps files on disk but stops running processes, including the wrapper shell. The loop does **not** survive an Update. After an Update, something outside that shell must start the bridge again (manual `npm start`, a Grok Bot routine that checks and relaunches, or another supervisor that is re-armed after the update).

In this host-process mode, **never** expose `:1340` or `:8788` beyond localhost.

### Split-machine setup

When the bridge runs on a different machine, `localhost` on the Grok Bot computer is not the bridge. Point `GROK_BOT_GATEWAY_URL` at a private path to `:1340` (Tailscale, SSH tunnel, or LAN). Set `BRIDGE_PUBLIC_URL` to a URL the Grok Bot computer can reach (not `http://127.0.0.1:8788` on that computer unless you have tunneled it there). Default `BRIDGE_HTTP_HOST=0.0.0.0` is typical so the callback listens on the private interface. Still never publish `:1340` or `:8788` to the internet.

## Prompt block (what the agent must parse)

The bridge embeds a JSON block between `---BEGIN DISCORD_BRIDGE_REPLY---` / `---END DISCORD_BRIDGE_REPLY---` containing:

- `correlationId`
- `replyUrl`
- `authorization` (`Bearer <one-time request capability>`)
- `httpMethod` / `contentType` / example `body`

Plus Discord context already on `AgentRequest`: `conversationKey`, `channelName`, `threadName`, `channelTopic`, `guildName`, `authorDisplayName`, `content`.

Persona stays in the Grok Bot agent / `SYSTEM_PROMPT_FILE`. This repo is plumbing.

## Errors

Gateway HTTP failures and callback timeouts throw a short Discord-friendly error. The Discord message handler still uses the existing “Sorry — I hit an error generating a reply…” UX and logs the detail (without tokens).

## Official North Star (still blocked)

A documented Discord/Channels inbound API would replace this callback. Until then, do **not** invent a different official API — only `/api/sendPrompt` + this bridge callback.

## Cutover / smoke

1. Set grok-bot env vars for the topology you are using (colocated host process, or split-machine + Tailscale/tunnel); keep `AGENT_BACKEND=openai` as fallback.
2. Confirm `BRIDGE_PUBLIC_URL` is reachable from the Grok Bot computer (`POST /internal/reply` with a wrong token should 401; do not test with real tokens in logs).
3. Mention the bot in Discord → gateway `sendPrompt` → agent callback → Discord reply.
4. If the unofficial gateway changes, park grok-bot mode and stay on OpenAI.

## Watch list

- Official Discord Channel connector / inbound API
- Computer gateway path or auth changes
- Forum / docs: “Channels”, “inbound”, “messaging”
