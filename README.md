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

From npm (recommended):

```bash
pi install npm:pi-openrouter-presets
```

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

Remove it again with `pi remove npm:pi-openrouter-presets`.

## Use

Start Pi and run:

```
/presets
```

That lists the presets on your account with their current OpenRouter prices,
for example:

```
Live OpenRouter prices (fetched 1:06 AM, per million tokens):

openrouter-presets/@preset/ec-dp4-decart -> deepseek/deepseek-v4.1-flash
  price/M: in $0.09 · out $0.18 · cache-read $0.018 | decart/fp4 · fp4 · 99.98% up
  model avg/M (31 endpoints, interquartile): in $0.1919 · out $0.8382 · cache-read $0.0072
```

Each preset shows the live price of the provider it actually routes to, plus
that provider's quantization and 1-day uptime. If the preset pins no provider,
the cheapest endpoint is shown instead and labelled `cheapest`.

The second line is the **interquartile mean** price — the mean of the middle 50%
of that base model's providers, so cheap outliers or a lone premium tier do not
swing it. It is a market reference, not a price you can pin, and it is omitted
when the base model has a single endpoint.

Then open `/model` and pick one under **OpenRouter Presets**, or select it directly:

```
/model openrouter-presets/@preset/ec-dp4-decart
```

### Commands

| Command | Description |
|---|---|
| `/presets` | Refresh the preset list and its live prices, then show them. |
| `/presets list` | Show the last known list and prices without refreshing. |

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
- **Pricing** — `GET /models/{id}/endpoints` for each distinct base model. The
  preset's `provider.only` slugs are matched against each endpoint's `tag`
  prefix, so the price shown is the one the preset actually routes to. The same
  response yields an interquartile mean price across the model's providers (the
  middle 50%, so outliers do not dominate). Prices, quantization, and uptime are
  a live snapshot; endpoint failures only drop the price lines, never the preset.
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
- Preset discovery needs one request per preset to read its base model, plus one
  `GET /models/{id}/endpoints` per distinct base model for live prices. For very
  large accounts this means a handful of calls, fetched with bounded concurrency.

## License

MIT
