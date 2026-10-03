# pi-openrouter-presets

Use [OpenRouter presets](https://openrouter.ai/docs/guides/features/presets) as first-class models in [Pi](https://pi.dev).

OpenRouter presets are named, versioned, server-side configurations that bundle a
base model, system prompt, sampling parameters, provider routing, and tools. A
request addresses one with `model: "@preset/<slug>"`. This Pi package discovers
the presets of your OpenRouter account and lists each one in `/model` as:

```
openrouter-presets/@preset/<slug>
```

Selecting one is all it takes: OpenRouter applies the preset's system prompt,
routing, and parameters on its side.

## Install

From git:

```bash
pi install git:github.com/jan5o7o/pi-openrouter-presets
```

From a local checkout while developing:

```bash
pi install ./pi-openrouter-presets
```

Or try it for a single run without installing:

```bash
pi -e ./pi-openrouter-presets
```

## Use

Start Pi and run:

```
/presets
```

That lists the presets on your account, for example:

```
openrouter-presets/@preset/ec-dp4-decart -> deepseek/deepseek-v4.1-flash
```

Then open `/model` and pick one under **OpenRouter Presets**, or select it directly:

```
/model openrouter-presets/@preset/ec-dp4-decart
```

### Commands

| Command | Description |
|---|---|
| `/presets` | Refresh the preset list and show it. |
| `/presets list` | Show the last known list without refreshing. |

The current preset count is shown in the status line, and selecting a preset
displays its base model.

## How it works

The extension registers a dedicated provider, `openrouter-presets`, and leaves
the built-in `openrouter` provider untouched:

- **Discovery** — `GET https://openrouter.ai/api/v1/presets`, then
  `GET /presets/{slug}` for each preset to learn its base model. Each preset
  becomes a `@preset/<slug>` model whose context window, reasoning support, cost,
  and modality metadata are copied from the matching model in Pi's bundled
  OpenRouter catalog. Presets whose base model is unknown still appear with
  conservative defaults.
- **Requests** — the discovered models are registered on the OpenAI-compatible
  OpenRouter endpoint, so a request sends `model: "@preset/<slug>"` and
  OpenRouter applies the preset. The base model's API (`openai-completions` or
  `anthropic-messages`) is preserved per model.
- **Authentication** — reuses your existing OpenRouter login. The provider's key
  resolves on demand with
  `pi auth print-api-key --provider openrouter`, falling back to
  `pi auth print-bearer-token --provider openrouter` for OAuth setups. No second
  login is required.
- **Caching** — the discovered list is persisted in Pi's model store, so presets
  are restored on offline startup and are available to `pi --model` before the
  first network refresh.

## Requirements

- Pi 1.0.0 or newer.
- A configured OpenRouter credential: `/login openrouter`, `OPENROUTER_API_KEY`,
  or OpenRouter OAuth.
- The `pi` executable on `PATH` (used to resolve the OpenRouter credential at
  request time).

## Configuration

No configuration is required. The provider is always registered; presets appear
once a refresh completes (at startup in the background, on `/presets`, or during
Pi's interactive model-catalog refresh).

Set `PI_ORP_DEBUG=1` to print debug logs from the extension to stderr.

## Development

```bash
# Run against your account without installing
pi -e ./pi-openrouter-presets

# Then, in Pi
/presets
```

The extension is a single TypeScript file, [`extensions/index.ts`](extensions/index.ts),
loaded through Pi's extension loader (jiti), so there is no build step.

## Limitations

- Preset **management** (create/update/delete) is not exposed; manage presets in
  the OpenRouter dashboard. This package only makes existing presets selectable
  and usable.
- Preset discovery needs one request per preset to read its base model. For very
  large accounts this means a handful of `GET /presets/{slug}` calls, fetched with
  bounded concurrency.

## License

MIT
