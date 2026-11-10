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

The first run downloads the Russian Vosk small model (about 45 MB) into a persistent Docker volume. Choose the larger server model by setting `VOSK_MODEL_URL=https://alphacephei.com/vosk/models/vosk-model-ru-0.42.zip` before startup; it is about 1.8 GB and may use substantially more memory. The Ollama model is not downloaded again in the default setup. On Linux, configure the host Ollama service to listen on an address reachable from Docker, for example `OLLAMA_HOST=0.0.0.0 ollama serve`, and keep `OLLAMA_BASE_URL=http://host.docker.internal:11434` in `.env`.

Open:

- API: <http://localhost:3000>
- Swagger UI: <http://localhost:3000/docs>
- OpenAPI JSON: <http://localhost:3000/openapi.json>

Compose runs with `APP_ENV=development`, so completed results include the raw recognized text and normalized transcript. For a production-style response, run:

```bash
docker compose -f docker-compose.yml -f docker-compose.production.yml up --build
```

That mode returns only the final note.

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

Set `POSTGRES_PASSWORD` in `.env` before using PostgreSQL outside local development.

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

## Configuration

Copy `.env.example` and edit the values you need. Settings are read at process start.

| Setting | Default | Purpose |
|---|---:|---|
| `APP_ENV` | `production` | Production returns only the final note; development includes diagnostic transcript fields. Compose overrides this to development by default. |
| `DATABASE_DIALECT` | `sqlite` | `sqlite` for one local worker; `postgres` for concurrent workers. |
| `SQLITE_PATH` | `/data/konspekai.sqlite` | SQLite database path. |
| `DATABASE_URL` | local PostgreSQL URL | PostgreSQL connection string when the dialect is `postgres`. |
| `LLM_PROVIDER` | `ollama` | `ollama` or `openai-compatible`. |
| `OLLAMA_BASE_URL` | `http://host.docker.internal:11434` | Host Ollama endpoint for the default Compose profile. |
| `OLLAMA_MODEL` | `qwen2.5:14b` | Default local model. |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | Base URL for a compatible chat completions API. |
| `OPENAI_API_KEY`, `OPENAI_MODEL` | empty | Required when `LLM_PROVIDER=openai-compatible`. |
| `LLM_NORMALIZATION_MODEL`, `LLM_SUMMARY_MODEL` | inherits provider model | Optional per-stage model overrides. |
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
npm run lint
npm test
```

The tests cover API job creation/status contracts, input validation, the note schema, and transcript chunking. They do not require live Vosk or Ollama inference. CI also builds the Docker image.

See [architecture](docs/architecture.md), [API guide](docs/api.md), [domain glossary](CONTEXT.md), and [architecture decisions](docs/adr/).
