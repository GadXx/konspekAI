# Contributing

1. Copy `.env.example` to `.env` and configure the local model endpoint.
2. Install dependencies with `npm ci`.
3. Run `npm run db:migrate` before starting the API or worker directly.
4. Run `npm run lint` and `npm test` before submitting a change.
5. Keep API behavior and OpenAPI documentation aligned.
6. Add focused tests for changes to the job lifecycle, validation, and note schema.

GitHub Actions checks dependency advisories, lint, tests, Compose configuration, and a Docker image build. Dependabot opens weekly dependency update pull requests.
