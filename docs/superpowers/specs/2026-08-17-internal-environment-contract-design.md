# Internal Environment Contract Design

## Goal

Remove the application-owned environment-variable branding from the repository.
Application configuration uses concise unprefixed names; external providers,
container images, and framework conventions retain their own names. Provider
credentials are configured only through the persisted Settings screen.

## Scope

- Rename every application-owned environment variable in runtime code,
  Compose, development scripts, tests, CI, documentation, plans, and specs.
- Remove the application-owned prefix from internal transport, storage,
  worker, development, test, skill-runtime, and port variables.
- Keep names owned by external systems or frameworks unchanged, including
  `NEXT_PUBLIC_*`, `POSTGRES_*`, `HEYGEN_*`, `COMFYUI_*`, and `WHISPER__*`.
- Remove provider API-key environment injection and fallback reads for LLM,
  image, speech, and HeyGen runtime flows. The persisted Settings records are
  the only application runtime source for those credentials.
- Keep the worker token, database/Redis connectivity, service URLs, queues,
  ports, CORS, local-ASR, storage, and other operational configuration as
  environment-driven internal settings, without a branding prefix.
- Do not rename database names, table names, volume names, or historical
  business identifiers containing `wemedia`.

## Runtime design

The migration is intentionally breaking for the application-owned environment
contract: old application-prefixed variables are no longer read. Compose and
the development script emit only the new internal names. The API and worker
continue to share the same internal worker token, and the protected Settings
runtime endpoints continue to deliver provider credentials to the trusted
worker.

LLM, image, speech, and HeyGen jobs fail with an explicit Settings
configuration error when their persisted provider configuration is missing.
They do not consult an environment variable after the Settings request returns
an empty configuration or fails. One-off external-provider smoke tools may
retain an explicit provider-specific input when they are not part of the
application runtime fallback path.

## Migration mapping

The implementation strips the application-owned prefix from every internal
variable, including database and Redis URLs, API and web URLs, worker
authentication and queues, scheduler flags, storage paths, local-ASR options,
development lifecycle state, skill runtime limits, E2E settings, and image
selection variables. Provider API-key variables are removed instead of being
renamed because provider credentials belong in Settings.

`NEXT_PUBLIC_API_URL` remains unchanged because it is a Next.js build-time
contract. Third-party container environment variables remain unchanged because
their names are part of those images' public interfaces.

## Persistence and compatibility

Existing PostgreSQL `AppSetting` rows are unchanged. Existing deployments must
configure provider credentials in the Settings UI before running provider-backed
jobs. Existing `.env` files using the old application-prefixed names require a
manual migration to the new names; no compatibility alias is introduced.

## Verification

- Add or update contract tests proving Compose contains the new internal names,
  does not inject provider API keys, and still protects the worker boundary.
- Add or update runtime tests proving empty Settings configuration produces a
  clear error rather than reading an environment credential.
- Run focused backend and frontend tests for settings, jobs, Compose, worker
  startup, and development runtime behavior.
- Validate Compose, TypeScript tests, the Docker build, and a repository search
  proving no application-owned legacy prefix remains in tracked files.
