# Mirador

A production-ready web browsing automation server powered by **Playwright** and **Fastify**. Mirador exposes headless Chromium as a REST API — navigate pages, extract content, take screenshots, and control browser sessions remotely.

---

## Quick start

Requirements: **Docker** only. No Node.js or npm needed on the host.

```bash
# 1. Clone the repository
git clone https://github.com/juriel/mirador.git
cd mirador

# 2. Copy and configure environment variables
cp .env.example .env
# edit .env with your real values

# 3. Provide authentication tokens
# copy or create tokens.json in the project root

# 4. Start the service
docker compose up --build

# Or run in background
docker compose up --build -d
```

The server starts on `http://localhost:9191`.

### Local development (requires Node.js)

```bash
npm install
npx playwright install chromium
npm run dev
```

---

## Configuration

All configuration is via environment variables (see `.env.example`):

| Variable | Default | Description |
|---|---|---|
| `PORT` | `9191` | Server port |
| `MAX_BROWSER_INSTANCES` | `10` | Max concurrent Playwright instances |
| `SESSION_DEFAULT_TIMEOUT_MINUTES` | `10` | Default session inactivity timeout |
| `TOKENS_FILE_PATH` | `./tokens.json` | Path to authentication tokens file |
| `LOG_LEVEL` | `info` | Pino log level |
| `NODE_ENV` | `production` | Enables pretty-print logging when not `production` |
| `CORS_ORIGIN` | `*` | CORS origin (set to a specific origin in production) |

---

## Authentication

Requests must include an `Authorization: Bearer <secret>` header. Tokens are defined in `tokens.json`:

```json
{
  "tokens": [
    {
      "id": "tok_full",
      "name": "Admin full access",
      "secret": "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
      "rateLimit": { "requestsPerMinute": 120, "requestsPerHour": 2000 },
      "maxConcurrentSessions": 20,
      "permissions": ["full"]
    }
  ]
}
```

Each token has:
- **`rateLimit`** — sliding-window limits per minute and per hour
- **`maxConcurrentSessions`** — maximum simultaneous stateful sessions
- **`permissions`** — list of granted permissions (or `["full"]` for everything)

When a rate limit is hit, the server responds `429 Too Many Requests` with a `Retry-After` header.

---

## API

All endpoints (except `/health`) require authentication. The `requestId` in error responses matches the `X-Request-Id` response header.

### Health

```bash
curl http://localhost:9191/health
```

```json
{
  "status": "ok",
  "version": "1.0.0",
  "uptime": 3600,
  "browserPool": { "total": 10, "active": 3, "available": 7 },
  "activeSessions": 2
}
```

### Stateless endpoints — `/api/v1/browse/*`

Each request opens a browser, performs the action, and closes. No state is preserved between calls.

#### `POST /api/v1/browse/html`

```bash
curl -X POST http://localhost:9191/api/v1/browse/html \
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..." \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com"}'
```

```json
{
  "url": "https://example.com",
  "html": "<!DOCTYPE html>...",
  "title": "Example Domain",
  "statusCode": 200,
  "loadTimeMs": 1234
}
```

#### `POST /api/v1/browse/markdown`

Returns the page content converted to clean Markdown (via turndown + GFM). Scripts, styles, nav, footer, header, and hidden elements are stripped.

```bash
curl -X POST http://localhost:9191/api/v1/browse/markdown \
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..." \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com"}'
```

#### `POST /api/v1/browse/screenshot`

Returns a binary image (`image/png` or `image/jpeg`).

```bash
curl -X POST http://localhost:9191/api/v1/browse/screenshot \
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..." \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com", "format": "png", "fullPage": true}' \
  -o screenshot.png
```

#### `POST /api/v1/browse/metadata`

Extracts meta tags, Open Graph data, and page language without returning the full content.

```bash
curl -X POST http://localhost:9191/api/v1/browse/metadata \
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..." \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com"}'
```

#### `POST /api/v1/browse/extract`

Extracts content from one or more elements matching a CSS or XPath selector.

```bash
curl -X POST http://localhost:9191/api/v1/browse/extract \
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..." \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com", "selector": "h1", "multiple": false}'
```

#### `POST /api/v1/browse/table`

Extracts HTML tables as JSON or CSV.

```bash
curl -X POST http://localhost:9191/api/v1/browse/table \
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..." \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com", "format": "json"}'
```

### Common request body fields (stateless)

| Field | Type | Default | Description |
|---|---|---|---|
| `url` | string | — | Target URL (required) |
| `waitUntil` | string | `"networkidle"` | `load`, `domcontentloaded`, `networkidle`, `commit` |
| `timeout` | number | `30000` | Navigation timeout in ms |
| `viewport` | object | — | `{ "width": 1280, "height": 800 }` |
| `userAgent` | string | — | Custom User-Agent string |

---

### Stateful sessions — `/api/v1/session/*`

Sessions keep a browser page alive across multiple requests. The browser is released when the session is deleted or expires.

#### `POST /api/v1/session/create`

```bash
curl -X POST http://localhost:9191/api/v1/session/create \
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..." \
  -H "Content-Type: application/json" \
  -d '{"timeoutMinutes": 15, "viewport": {"width": 1280, "height": 800}}'
```

```json
{
  "sessionId": "sess_a1b2c3d4",
  "createdAt": "2024-01-15T10:30:00Z",
  "expiresAt": "2024-01-15T10:45:00Z",
  "timeoutMinutes": 15
}
```

#### `POST /api/v1/session/{sessionId}/navigate`

```bash
curl -X POST http://localhost:9191/api/v1/session/sess_a1b2c3d4/navigate \
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..." \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com"}'
```

#### `POST /api/v1/session/{sessionId}/click`

```bash
curl -X POST http://localhost:9191/api/v1/session/sess_a1b2c3d4/click \
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..." \
  -H "Content-Type: application/json" \
  -d '{"selector": "#login-button", "waitAfter": "networkidle"}'
```

#### `POST /api/v1/session/{sessionId}/fill`

```bash
curl -X POST http://localhost:9191/api/v1/session/sess_a1b2c3d4/fill \
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..." \
  -H "Content-Type: application/json" \
  -d '{"selector": "#email", "value": "user@example.com", "clearFirst": true}'
```

#### `POST /api/v1/session/{sessionId}/scroll`

```bash
curl -X POST http://localhost:9191/api/v1/session/sess_a1b2c3d4/scroll \
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..." \
  -H "Content-Type: application/json" \
  -d '{"direction": "bottom"}'
```

#### `POST /api/v1/session/{sessionId}/wait`

```bash
curl -X POST http://localhost:9191/api/v1/session/sess_a1b2c3d4/wait \
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..." \
  -H "Content-Type: application/json" \
  -d '{"type": "selector", "value": ".results-loaded", "state": "visible"}'
```

Wait types: `selector` (waits for element state), `timeout` (waits N ms), `networkidle`, `navigation`.

#### `POST /api/v1/session/{sessionId}/submit`

```bash
curl -X POST http://localhost:9191/api/v1/session/sess_a1b2c3d4/submit \
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..." \
  -H "Content-Type: application/json" \
  -d '{"selector": "form#login", "waitAfter": "networkidle"}'
```

#### `GET /api/v1/session/{sessionId}/html`

```bash
curl http://localhost:9191/api/v1/session/sess_a1b2c3d4/html \
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
```

#### `GET /api/v1/session/{sessionId}/markdown`

```bash
curl http://localhost:9191/api/v1/session/sess_a1b2c3d4/markdown \
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
```

#### `GET /api/v1/session/{sessionId}/screenshot`

```bash
curl "http://localhost:9191/api/v1/session/sess_a1b2c3d4/screenshot?format=png&fullPage=true" \
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..." \
  -o screenshot.png
```

#### `GET /api/v1/session/{sessionId}/extract`

```bash
curl "http://localhost:9191/api/v1/session/sess_a1b2c3d4/extract?selector=.product&selectorType=css&multiple=true" \
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
```

#### `GET /api/v1/session/{sessionId}/table`

```bash
curl "http://localhost:9191/api/v1/session/sess_a1b2c3d4/table?selector=table&format=json" \
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
```

#### `GET /api/v1/session/{sessionId}/metadata`

```bash
curl http://localhost:9191/api/v1/session/sess_a1b2c3d4/metadata \
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
```

#### `DELETE /api/v1/session/{sessionId}`

```bash
curl -X DELETE http://localhost:9191/api/v1/session/sess_a1b2c3d4 \
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
```

Returns `204 No Content`.

---

## Permissions

Each endpoint requires a specific permission. The `"full"` permission grants access to everything.

| Permission | Endpoint |
|---|---|
| `browse:html` | `POST /api/v1/browse/html` |
| `browse:markdown` | `POST /api/v1/browse/markdown` |
| `browse:screenshot` | `POST /api/v1/browse/screenshot` |
| `browse:metadata` | `POST /api/v1/browse/metadata` |
| `browse:extract` | `POST /api/v1/browse/extract` |
| `browse:table` | `POST /api/v1/browse/table` |
| `session:create` | `POST /api/v1/session/create` + `DELETE /api/v1/session/{id}` |
| `session:navigate` | `POST /api/v1/session/{id}/navigate` |
| `session:click` | `POST /api/v1/session/{id}/click` |
| `session:fill` | `POST /api/v1/session/{id}/fill` |
| `session:scroll` | `POST /api/v1/session/{id}/scroll` |
| `session:wait` | `POST /api/v1/session/{id}/wait` |
| `session:submit` | `POST /api/v1/session/{id}/submit` |
| `session:html` | `GET /api/v1/session/{id}/html` |
| `session:markdown` | `GET /api/v1/session/{id}/markdown` |
| `session:screenshot` | `GET /api/v1/session/{id}/screenshot` |
| `session:extract` | `GET /api/v1/session/{id}/extract` |
| `session:table` | `GET /api/v1/session/{id}/table` |
| `session:metadata` | `GET /api/v1/session/{id}/metadata` |

---

## Error format

All errors return a consistent JSON body:

```json
{
  "error": true,
  "code": "SESSION_EXPIRED",
  "message": "Session sess_a1b2c3d4 has expired",
  "statusCode": 410,
  "requestId": "req_xyz123"
}
```

**Error codes:** `AUTH_MISSING`, `AUTH_INVALID`, `AUTH_RATE_LIMITED`, `AUTH_FORBIDDEN`, `SESSION_NOT_FOUND`, `SESSION_EXPIRED`, `SESSION_LIMIT_EXCEEDED`, `BROWSER_POOL_FULL`, `NAVIGATION_TIMEOUT`, `NAVIGATION_ERROR`, `SELECTOR_NOT_FOUND`, `INVALID_URL`, `INVALID_PARAMS`, `INTERNAL_ERROR`.

HTTP status codes: `400` (validation), `401` (auth), `403` (permissions), `404` (not found), `410` (expired), `429` (rate limit), `500` (internal), `502`-`504` (navigation/browser errors).

---

## Project structure

```
mirador/
├── src/
│   ├── server.ts              # Fastify setup, health, graceful shutdown
│   ├── config.ts              # Environment variables
│   ├── types/index.ts         # TypeScript interfaces and AppError
│   ├── auth/
│   │   ├── tokens.ts          # Token file loader
│   │   └── middleware.ts      # Bearer auth, rate limiter, permissions
│   ├── browser/
│   │   ├── pool.ts            # Playwright instance pool
│   │   └── utils.ts           # Navigation, markdown, metadata helpers
│   ├── sessions/
│   │   └── manager.ts         # Session CRUD, timeout, cleanup
│   └── routes/
│       ├── stateless.ts       # /api/v1/browse/*
│       └── sessions.ts        # /api/v1/session/*
├── tokens.json                # Authentication tokens
├── Dockerfile
├── docker-compose.yml
└── .env.example
```
