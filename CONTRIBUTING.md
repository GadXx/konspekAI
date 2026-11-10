# Contributing

1. Copy `.env.example` to `.env` and configure the local model endpoint.
2. Install dependencies with `npm ci`.
3. Run `npm run lint` and `npm test` before submitting a change.
4. Keep API behavior and OpenAPI documentation aligned.
5. Add focused tests for changes to the job lifecycle, validation, and note schema.

The `main` branch is verified by GitHub Actions for lint, tests, and a Docker image build.
