# API guide

Swagger UI: [`/docs`](http://localhost:3000/docs). OpenAPI JSON: [`/openapi.json`](http://localhost:3000/openapi.json).

In production, send `Authorization: Bearer <API_ACCESS_TOKEN>` with every `/api/v1/jobs` request. The API uses one shared machine token and does not create user accounts. `/healthz`, `/readyz`, `/api/v1/languages`, and API documentation remain public.

The worker can use NVIDIA's OpenAI-compatible chat completions endpoint by setting `LLM_PROVIDER=nvidia` and `NVIDIA_API_KEY` in `.env`. The default model is `mistralai/mistral-large-4-1t-a52b`; configure `NVIDIA_MODEL` and `NVIDIA_REASONING_EFFORT` as needed. The NVIDIA API key is passed only to the worker container.

Example production request header: `Authorization: Bearer YOUR_CONFIGURED_TOKEN`.

## Create a job

`POST /api/v1/jobs` accepts either JSON text or multipart data containing one video/audio file. Use `summary_type=detailed|brief|bullet_points`, `language` for the configured speech model, and optional `summary_language` for the note output.

```json
{
  "text": "Текст лекции или подготовленный материал.",
  "language": "ru",
  "summary_language": "ru",
  "summary_type": "detailed"
}
```

Response: `202 Accepted` with `id`, `status_url`, and `result_url`.

## Check and fetch

- `GET /api/v1/jobs/{id}` returns state, progress, retry number, timestamps, and terminal error if any.
- `GET /api/v1/jobs/{id}/result` returns `409` while the job is not complete. In production it returns only the note. In development it also includes `recognized_text` and `normalized_transcript`.
- `GET /api/v1/languages` lists configured Vosk languages.
- `GET /healthz` and `GET /readyz` are liveness/readiness checks.

Supported input extensions: `.wav`, `.mp3`, `.m4a`, `.aac`, `.ogg`, `.opus`, `.flac`, `.wma`, `.mp4`, `.mkv`, `.mov`, `.webm`, `.avi`, `.m4v`. Upload size, text length, media duration, and retention are configured through environment variables.

The default request limit is 120 requests per minute in development and 30 per minute in production, per client IP and per API process. A reverse proxy should apply a shared limit when multiple API replicas run. Set `TRUST_PROXY` only to a known proxy configuration; otherwise Fastify ignores forwarded client addresses.
