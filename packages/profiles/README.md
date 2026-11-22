# @standin/profiles

A profile is a named list of plugins and settings for a new session.

- **Interface:** `parseProfileConfig(json)` (the profile file on the box), `resolveSession(config, request) -> ResolvedProfile` (frozen: `profile`, `title`, `model`, `floor`, `plugins`, `alwaysDeclaredTools`, `settings`, `warnings`), `parseSessionRequest`. `@standin/profiles/testing` has `sampleProfileConfig()`.
- **The safety floor:** the review and redaction plugins (`SAFETY_FLOOR`) are in every resolved profile. The only input that can lower the floor is `safetyFloor` in the config file on the box. The page's request has four fields (`profile`, `title`, `model`, `extraPlugins` from the profile's own `optionalPlugins`); any other field is refused, and a field that looks like a safety setting is `denied`. There is no function in this package that writes a profile or the floor, so there is nothing for the page to call.
- **Hides:** how plugins are built or ordered into a session.
- **Never knows:** the page, HTTP, the plugin host, models (a model is only a name here).
