# API guide

Swagger UI: [`/docs`](http://localhost:3000/docs). OpenAPI JSON: [`/openapi.json`](http://localhost:3000/openapi.json).

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
