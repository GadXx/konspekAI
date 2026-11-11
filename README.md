# KonspekAI

**KonspekAI turns lectures and source text into readable, structured notes.** Upload video or audio, or submit text. The service transcribes media locally with Vosk, restores punctuation in a first language-model pass, then creates the requested note in a second pass.

![CI](https://github.com/GadXx/konspekAI/actions/workflows/ci.yml/badge.svg)

## What it does

- Accepts audio/video files and text; remote links are not accepted.
- Uses local Vosk models for speech recognition. Russian is configured by default.
- Uses Ollama (`qwen2.5:14b`) by default, or a generic OpenAI-compatible chat API selected at startup.
- Creates `detailed`, `brief`, and `bullet_points` notes.
- Returns a structured JSON note with a Markdown rendering.
- Runs as an asynchronous API plus worker, with persisted jobs, retries, and lease recovery.
- Provides Swagger UI and OpenAPI JSON.

## Quick start

Requirements: Docker Compose, an Ollama installation with `qwen2.5:14b`, and enough memory to run that model. The API and worker run in Docker; the default profile connects to Ollama on the host.

```bash
cp .env.example .env
docker compose up --build
```

The first run downloads the Russian Vosk small model (about 45 MB) into a persistent Docker volume. Choose the larger server model by setting `VOSK_MODEL_URL=https://alphacephei.com/vosk/models/vosk-model-ru-0.42.zip` before startup; it is about 1.8 GB and may use substantially more memory. The Ollama model is not downloaded again in the default setup. Linux Ollama installations often listen only on loopback, which containers cannot reach. Bind Ollama to the Docker host gateway address only (commonly `172.17.0.1:11434`) or configure a TCP forward restricted to the Docker bridge; do not expose the unauthenticated Ollama API on `0.0.0.0`. Set `OLLAMA_BASE_URL` to the reachable address. The optional `ollama` profile avoids host networking entirely.

Open:

- API: <http://localhost:3000>
- Swagger UI: <http://localhost:3000/docs>
- OpenAPI JSON: <http://localhost:3000/openapi.json>

Compose runs with `APP_ENV=development`, so completed results include the raw recognized text and normalized transcript. For production, set `API_ACCESS_TOKEN` to a random value of at least 32 characters, configure TLS and an external reverse proxy, then run:

```bash
docker compose -f docker-compose.yml -f docker-compose.production.yml up --build
```

The production overlay binds the API only to `127.0.0.1`, uses a read-only container filesystem, drops Linux capabilities, and returns only the final note. API job routes require `Authorization: Bearer <API_ACCESS_TOKEN>`; this shared machine token requires no user accounts. The default in-process rate limit is 30 requests per minute per client IP. With multiple API replicas, enforce a shared limit at the reverse proxy or gateway. Set `TRUST_PROXY` only when the API is behind a trusted proxy.

### Use the Ollama container profile

This profile keeps Ollama data in its own named volume and downloads the model into that volume. It does not reuse the host Ollama cache.

```bash
docker compose --profile ollama -f docker-compose.yml -f docker-compose.ollama.yml up --build
```

### Use PostgreSQL

SQLite is the default for one local worker. For multiple workers, use PostgreSQL and the compose overlay:

```bash
docker compose --profile postgres -f docker-compose.yml -f docker-compose.postgres.yml up --build
```

Set a strong `POSTGRES_PASSWORD` and matching percent-encoded `DATABASE_URL` in `.env`; the PostgreSQL overlay refuses to start with empty credentials. For multi-node deployment, use managed PostgreSQL and configure backups, TLS, and restore drills.

## API example

Create a text note:

```bash
curl -X POST http://localhost:3000/api/v1/jobs \
  -H 'Content-Type: application/json' \
  -d '{"text":"Текст лекции о работе очередей.","language":"ru","summary_type":"detailed"}'
```

The response is `202 Accepted` with a job `id`, `status_url`, and `result_url`. Poll the status, then fetch the result:

```bash
curl http://localhost:3000/api/v1/jobs/JOB_ID
curl http://localhost:3000/api/v1/jobs/JOB_ID/result
```

Upload media as multipart data:

```bash
curl -X POST http://localhost:3000/api/v1/jobs \
  -F 'media=@lecture.mp4' \
  -F 'language=ru' \
  -F 'summary_type=bullet_points'
```

See [API guide](docs/api.md) or Swagger for the complete contract.

## Data handling

Speech recognition is local, but transcripts are sent to the configured LLM provider for normalization and note generation. The Ollama provider keeps this processing on the configured Ollama host; the OpenAI-compatible provider sends it to the configured API. Job text, transcript, status, and result are retained in the configured database for `JOB_RETENTION_DAYS` (7 days by default). Uploaded media is removed after successful transcription or terminal failure; stale orphan uploads are swept separately. Protect database storage and backups as sensitive data.

## Configuration

Copy `.env.example` and edit the values you need. Settings are read at process start.

| Setting | Default | Purpose |
|---|---:|---|
| `APP_ENV` | `production` | Production returns only the final note; development includes diagnostic transcript fields. Compose overrides this to development by default. |
| `DATABASE_DIALECT` | `sqlite` | `sqlite` for one local worker; `postgres` for concurrent workers. |
| `SQLITE_PATH` | `/data/konspekai.sqlite` | SQLite database path. |
| `DATABASE_URL` | local PostgreSQL URL | PostgreSQL connection string when the dialect is `postgres`. |
| `LLM_PROVIDER` | `ollama` | `ollama`, `openai-compatible`, or `nvidia`. |
| `OLLAMA_BASE_URL` | `http://host.docker.internal:11434` | Host Ollama endpoint for the default Compose profile. |
| `OLLAMA_MODEL` | `qwen2.5:14b` | Default local model. |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | Base URL for a compatible chat completions API. |
| `OPENAI_API_KEY`, `OPENAI_MODEL` | empty | Required when `LLM_PROVIDER=openai-compatible`. |
| `NVIDIA_BASE_URL` | `https://integrate.api.nvidia.com/v1` | NVIDIA NIM OpenAI-compatible endpoint. |
| `NVIDIA_API_KEY` | empty | Required by the worker when `LLM_PROVIDER=nvidia`; keep it in `.env` or a secret manager. |
| `NVIDIA_MODEL` | `nvidia/nemotron-3.5-lightning-30b-a3b` | NVIDIA NIM model used unless stage-specific overrides are set. |
| `NVIDIA_ENABLE_THINKING` | `false` | Enables Nemotron thinking for summary generation when set to `true`. |
| `NVIDIA_NORMALIZATION_ENABLE_THINKING` | `false` | Keeps thinking off during punctuation normalization so the short output budget is used for the transcript. |
| `NVIDIA_REASONING_BUDGET` | `4096` | Nemotron thinking budget; leaves output-token room for the structured response. |
| `LLM_NORMALIZATION_MAX_INPUT_CHARS` | `4000` | Smaller transcript chunks keep speech normalization complete and within the model output budget. |
| `LLM_NORMALIZATION_MIN_LENGTH_RATIO` | `0.65` | Reject and retry normalization if it loses more than the configured share of source text. |
| `API_ACCESS_TOKEN` | empty in development | Required in production; bearer token for job submission, status, and result routes. Use a random value of at least 32 characters. |
| `RATE_LIMIT_MAX`, `RATE_LIMIT_WINDOW_MS` | `120/60000` in development, `30/60000` in production | In-process per-client-IP request limit. Use a gateway limit for multiple API replicas. |
| `TRUST_PROXY` | `false` | Trusted proxy hop count/address; configure only behind a known proxy. |
| `LLM_NORMALIZATION_MODEL`, `LLM_SUMMARY_MODEL` | inherits provider model | Optional per-stage model overrides. |
| `PROMPTS_DIRECTORY` | `packages/llm/prompts` | Editable normalization and summary system prompt templates. Restart the service after changes. |
| `LLM_MAX_RETRIES` | `1` | Provider SDK retries for transient OpenAI-compatible API failures. |
| `VOSK_MODELS_JSON` | `{"ru":"/models/ru"}` | Language code to mounted model directory map. Add a language only after installing its model. |
| `VOSK_MODEL_URL` | Russian small model archive | Vosk model archive downloaded into the Compose volume on startup. Change to the server model URL to use the larger model. |
| `MAX_UPLOAD_BYTES` | `536870912` | Maximum upload size (512 MiB). |
| `MAX_TEXT_CHARS` | `1000000` | Maximum submitted text length. |
| `MAX_MEDIA_DURATION_SECONDS` | `14400` | Maximum media duration (4 hours). |
| `WORKER_CONCURRENCY` | `1` | Number of simultaneous jobs in one worker. SQLite requires 1. |
| `JOB_MAX_ATTEMPTS` | `3` | Total job attempts, including the first. |
| `JOB_RETRY_BASE_MS` | `5000` | Exponential retry delay base. |
| `JOB_LEASE_SECONDS` | `900` | Worker lease duration, renewed during processing. |
| `JOB_RETENTION_DAYS` | `7` | Job, text, and result retention. |
| `LLM_MAX_INPUT_CHARS` | `24000` | Text chunk size limit for each logical LLM stage. |

Supported media extensions: `.wav`, `.mp3`, `.m4a`, `.aac`, `.ogg`, `.opus`, `.flac`, `.wma`, `.mp4`, `.mkv`, `.mov`, `.webm`, `.avi`, `.m4v`.

## Development

```bash
npm ci
npm run db:migrate
npm run lint
npm test
```

When running the API and worker directly instead of through Compose, run the migration command once before starting either process. Compose runs a one-shot migration container before API and worker startup.

The tests cover API job creation/status contracts, input validation, the note schema, and transcript chunking. They do not require live Vosk or Ollama inference. CI also builds the Docker image.

See [architecture](docs/architecture.md), [API guide](docs/api.md), [domain glossary](CONTEXT.md), and [architecture decisions](docs/adr/).
