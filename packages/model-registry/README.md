# @standin/model-registry

Named models from one config file to ready `LlmClient`s (the framework's `createChatClient`).

- **Interface:** `parseModelConfig(json) -> ModelConfig` (validates everything, reports all problems by path); `createModelRegistry({ config, secrets, createClient?, fetch? })` with `names()`, `defaultName()`, `get(name?)`. Config shape: `{ default?, models: { <name>: { baseUrl, model, contextWindow, apiKey: "env:NAME", compat?: "deepseek" | "moonshot" | "openai" | {overrides}, headers?, idleTimeoutMs?, headerTimeoutMs? } } }`. `@standin/model-registry/testing` has a fake client factory.
- **Hides:** how a key is fetched (through `secrets`), the compat presets, client caching.
- **Never knows:** sessions, tools, where the config file lives (the caller reads it).
- **Rules:** a literal key in the file is refused (`apiKey` and credential headers must be secret references) and never repeated in an error; a client is built once per model on first use; a failed build is retried on the next call.
