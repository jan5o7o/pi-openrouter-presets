/**
 * Pi OpenRouter Presets
 *
 * Makes OpenRouter presets available in Pi as first-class models.
 *
 * A preset is a server-side saved configuration (base model, system prompt,
 * sampling params, provider routing, tools) that OpenRouter applies when a
 * request asks for `model: "@preset/<slug>"`. This extension discovers the
 * presets of the signed-in OpenRouter account and exposes each one as
 * `openrouter-presets/@preset/<slug>` in `/model`.
 *
 * It reuses the existing OpenRouter credential (from `/login openrouter`, a
 * stored key, or `OPENROUTER_API_KEY`) and the built-in OpenRouter catalog for
 * capability metadata, so no second login is required. Presets live under their
 * own provider, leaving the built-in `openrouter` provider untouched.
 *
 * @example
 * pi -e ./pi-openrouter-presets
 * # then pick a preset in /model, or run /presets
 */

import type { AnyModel, Api, Credential, Model, ProviderModelConfig } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// =============================================================================
// Constants
// =============================================================================

/** The provider this extension registers. */
const PROVIDER_ID = "openrouter-presets";
/** The Pi provider that owns the credential and the base catalog. */
const SOURCE_PROVIDER_ID = "openrouter";
/** OpenRouter's OpenAI-compatible API root. */
const API_BASE_URL = "https://openrouter.ai/api/v1";
/** Prefix OpenRouter uses to address a preset as a model. */
const PRESET_PREFIX = "@preset/";
/**
 * Request-time credential for the presets provider. Reuses the OpenRouter login:
 * `print-api-key` covers stored/env API keys, `print-bearer-token` covers OAuth
 * (OpenRouter OAuth issues an API-key-like token, but Pi stores it as OAuth).
 * Pi caches the command output for the process lifetime.
 */
const AUTH_COMMAND =
	"!pi auth print-api-key --provider openrouter || pi auth print-bearer-token --provider openrouter";
/** Where Pi can report problems with this package. */
const REFERER = "https://github.com/jan5o7o/pi-openrouter-presets";

const PAGE_LIMIT = 100;
const MAX_PAGES = 5;
const REQUEST_TIMEOUT_MS = 10_000;
const DETAIL_CONCURRENCY = 6;
/** Do not re-fetch the preset list more often than this during catalog refreshes. */
const REFRESH_INTERVAL_MS = 5 * 60 * 1000;

const DEFAULT_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 8_192;

// =============================================================================
// OpenRouter presets API types
// =============================================================================

interface PresetSummary {
	id: string;
	name: string;
	slug: string;
	description?: string | null;
	status?: string | null;
	designated_version_id?: string | null;
	updated_at?: string | null;
}

interface PresetVersion {
	version?: number;
	system_prompt?: string | null;
	config?: {
		model?: string;
		[key: string]: unknown;
	};
}

interface PresetDetail extends PresetSummary {
	designated_version?: PresetVersion | null;
}

interface ListPresetsResponse {
	data?: PresetSummary[];
	total_count?: number;
}

interface GetPresetResponse {
	data?: PresetDetail;
}

/** Per-preset info kept for the `/presets` command and the status line. */
interface PresetInfo {
	slug: string;
	name: string;
	baseModelId?: string;
	status?: string;
	modelId: string;
}

// =============================================================================
// Module state (lives for the current Pi process)
// =============================================================================

let presetModels: Model<Api>[] = [];
let presetInfo: PresetInfo[] = [];
let lastFetchAt: number | undefined;
let lastError: string | undefined;

// =============================================================================
// Helpers
// =============================================================================

function debug(...args: unknown[]): void {
	if (process.env.PI_ORP_DEBUG) console.error("[pi-openrouter-presets]", ...args);
}

/** The built-in OpenRouter provider, freshly constructed. */
function openRouterProvider() {
	const base = builtinProviders().find((provider) => provider.id === SOURCE_PROVIDER_ID);
	if (!base) throw new Error(`Pi has no built-in "${SOURCE_PROVIDER_ID}" provider.`);
	return base;
}

function credentialApiKey(credential: Credential | undefined): string | undefined {
	if (!credential) return undefined;
	if (credential.type === "oauth") return credential.access;
	return credential.key;
}

function requestHeaders(apiKey: string): Record<string, string> {
	return {
		accept: "application/json",
		authorization: `Bearer ${apiKey}`,
		"HTTP-Referer": REFERER,
		"X-Title": "pi-openrouter-presets",
	};
}

async function getJson<T>(url: string, apiKey: string, signal: AbortSignal): Promise<T> {
	const response = await fetch(url, {
		headers: requestHeaders(apiKey),
		signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
	});
	if (!response.ok) {
		const body = await response.text().catch(() => "");
		throw new Error(`${url} -> HTTP ${response.status}${body ? `: ${body.slice(0, 200)}` : ""}`);
	}
	return (await response.json()) as T;
}

/** Run `worker` over `items` with bounded concurrency, preserving input order. */
async function mapConcurrent<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let next = 0;
	const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
		while (true) {
			const index = next++;
			if (index >= items.length) return;
			results[index] = await worker(items[index]);
		}
	});
	await Promise.all(runners);
	return results;
}

/** Fetch every preset of the account, following pagination. */
async function listPresets(apiKey: string, signal: AbortSignal): Promise<PresetSummary[]> {
	const presets: PresetSummary[] = [];
	for (let page = 0; page < MAX_PAGES; page++) {
		const offset = page * PAGE_LIMIT;
		const body = await getJson<ListPresetsResponse>(
			`${API_BASE_URL}/presets?offset=${offset}&limit=${PAGE_LIMIT}`,
			apiKey,
			signal,
		);
		const batch = body.data ?? [];
		presets.push(...batch);
		const total = body.total_count ?? presets.length;
		if (batch.length === 0 || presets.length >= total) break;
	}
	return presets;
}

/**
 * Build one Pi model backed by the OpenRouter preset slug.
 *
 * The preset owns the system prompt and sampling/routing config server-side, so
 * the model only carries the base model's capabilities (context window,
 * reasoning, cost, modality) for Pi to schedule and price requests correctly.
 */
function buildPresetModel(
	baseModels: AnyModel[],
	preset: PresetSummary,
	detail?: PresetDetail,
): Model<Api> {
	const baseModelId = detail?.designated_version?.config?.model;
	const base = baseModels.find(
		(model) => (model.type ?? "chat") === "chat" && model.id === baseModelId,
	) as Model<Api> | undefined;

	const model = {
		type: "chat",
		id: `${PRESET_PREFIX}${preset.slug}`,
		name: baseModelId ? `${preset.name} (${baseModelId})` : preset.name,
		// Presets are addressed through OpenRouter, so keep the base model's API
		// (OpenRouter models use both `openai-completions` and `anthropic-messages`).
		api: base?.api ?? "openai-completions",
		provider: PROVIDER_ID,
		baseUrl: API_BASE_URL,
		reasoning: base?.reasoning ?? false,
		input: base?.input ?? ["text"],
		cost: base?.cost ?? DEFAULT_COST,
		contextWindow: base?.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
		maxTokens: base?.maxTokens ?? DEFAULT_MAX_TOKENS,
		...(base?.thinkingLevelMap ? { thinkingLevelMap: base.thinkingLevelMap } : {}),
		...(base?.compat ? { compat: base.compat } : {}),
		...(base?.inputLimits ? { inputLimits: base.inputLimits } : {}),
		...(base?.promptCache ? { promptCache: base.promptCache } : {}),
		...(base?.samplingParams ? { samplingParams: base.samplingParams } : {}),
	} as Model<Api>;
	return model;
}

function infoFromDetail(preset: PresetSummary, detail: PresetDetail | undefined, modelId: string): PresetInfo {
	return {
		slug: preset.slug,
		name: preset.name,
		baseModelId: detail?.designated_version?.config?.model,
		status: preset.status ?? undefined,
		modelId,
	};
}

/**
 * Fetch all presets and turn them into Pi models. Detail requests are
 * best-effort: a preset whose detail cannot be fetched still becomes
 * selectable with conservative metadata, so one hiccup never hides the account.
 */
async function loadPresets(
	baseModels: AnyModel[],
	apiKey: string,
	signal: AbortSignal,
): Promise<{ models: Model<Api>[]; info: PresetInfo[] }> {
	const presets = await listPresets(apiKey, signal);

	const details = await mapConcurrent(presets, DETAIL_CONCURRENCY, async (preset) => {
		try {
			const body = await getJson<GetPresetResponse>(
				`${API_BASE_URL}/presets/${encodeURIComponent(preset.slug)}`,
				apiKey,
				signal,
			);
			return body.data;
		} catch {
			return undefined;
		}
	});

	const models: Model<Api>[] = [];
	const info: PresetInfo[] = [];
	for (let index = 0; index < presets.length; index++) {
		const model = buildPresetModel(baseModels, presets[index], details[index]);
		models.push(model);
		info.push(infoFromDetail(presets[index], details[index], model.id));
	}
	return { models, info };
}

function baseCatalog(): AnyModel[] {
	const base = openRouterProvider();
	return [...(base.getAllModels?.() ?? base.getModels())];
}

function toConfigs(): ProviderModelConfig[] {
	return presetModels as unknown as ProviderModelConfig[];
}

// =============================================================================
// Provider registration
// =============================================================================

/**
 * Register (or re-register) the presets provider. Re-registration merges over
 * the previous config and takes effect immediately.
 */
function register(models: Model<Api>[] = presetModels): void {
	extensionApi?.registerProvider(PROVIDER_ID, {
		name: "OpenRouter Presets",
		baseUrl: API_BASE_URL,
		api: "openai-completions",
		apiKey: AUTH_COMMAND,
		models: models as unknown as ProviderModelConfig[],
		refreshModels: async (context) => {
			// Restore the persisted list first, so presets survive offline startup.
			const stored = (context.stored?.models ?? []).filter(
				(model) => typeof model?.id === "string" && model.id.startsWith(PRESET_PREFIX),
			);
			if (stored.length > 0 && presetModels.length === 0) {
				presetModels = stored as Model<Api>[];
				presetInfo = presetModels.map((model) => ({
					slug: model.id.slice(PRESET_PREFIX.length),
					name: model.name,
					modelId: model.id,
				}));
				if (!(await context.publish({ update: () => {} }))) return toConfigs();
			}

			if (!context.allowNetwork || context.signal.aborted) return toConfigs();
			if (!context.force && lastFetchAt !== undefined && Date.now() - lastFetchAt < REFRESH_INTERVAL_MS) {
				// Already fetched recently; still persist so headless runs can restore.
				if (presetModels.length > 0) {
					await context.publish({ persist: { models: presetModels, checkedAt: Date.now() } });
				}
				return toConfigs();
			}
			const apiKey = credentialApiKey(context.credential);
			if (!apiKey) return toConfigs();

			try {
				const { models, info } = await loadPresets(baseCatalog(), apiKey, context.signal);
				if (context.signal.aborted) return toConfigs();
				presetModels = models;
				presetInfo = info;
				lastFetchAt = Date.now();
				lastError = undefined;
				debug("loaded", models.length, models.map((model) => model.id));
				await context.publish({ persist: { models, checkedAt: Date.now() } });
			} catch (error) {
				// Keep the previous list; surface the reason through /presets.
				lastError = error instanceof Error ? error.message : String(error);
				debug("load failed:", lastError);
			}
			return toConfigs();
		},
	});
}

/** Resolve the OpenRouter credential and fetch presets, then register them. */
async function refreshPresets(
	ctx: Pick<ExtensionContext, "modelRegistry" | "ui">,
	quiet = false,
): Promise<void> {
	const apiKey = await ctx.modelRegistry.getApiKeyForProvider(SOURCE_PROVIDER_ID);
	if (!apiKey) {
		if (!quiet) ctx.ui.notify("No OpenRouter credential found. Run /login openrouter first.", "warning");
		return;
	}
	try {
		const { models, info } = await loadPresets(baseCatalog(), apiKey, new AbortController().signal);
		presetModels = models;
		presetInfo = info;
		lastFetchAt = Date.now();
		lastError = undefined;
		register(models);
		debug("refreshPresets registered", models.length);
		// Recompose the provider so the new models are in the snapshot, and let
		// refreshModels persist them for offline/headless startup.
		await ctx.modelRegistry.refresh({ providers: [PROVIDER_ID] });
		if (!quiet) ctx.ui.notify(`Loaded ${models.length} OpenRouter preset(s).`, "info");
	} catch (error) {
		lastError = error instanceof Error ? error.message : String(error);
		if (!quiet) ctx.ui.notify(`Failed to load OpenRouter presets: ${lastError}`, "error");
	}
}

function formatPresets(): string {
	if (lastError) return `OpenRouter presets unavailable: ${lastError}`;
	if (presetInfo.length === 0) return "No OpenRouter presets found for this account.";
	return presetInfo
		.map((entry) => {
			const base = entry.baseModelId ? ` -> ${entry.baseModelId}` : "";
			const status = entry.status && entry.status !== "active" ? ` [${entry.status}]` : "";
			return `${PROVIDER_ID}/${entry.modelId}${base}${status}`;
		})
		.join("\n");
}

// =============================================================================
// Extension entry point
// =============================================================================

/** The active extension API, captured so callers can re-register the provider. */
let extensionApi: ExtensionAPI | undefined;

export default function openrouterPresets(pi: ExtensionAPI): void {
	debug("extension loaded");
	extensionApi = pi;
	// Register eagerly so the provider exists during startup model resolution.
	register();

	pi.registerCommand("presets", {
		description: "List and refresh OpenRouter presets (use: /presets [list|refresh])",
		handler: async (args, ctx) => {
			const subcommand = (args ?? "").trim().toLowerCase();
			if (subcommand === "list" && presetInfo.length > 0) {
				ctx.ui.notify(formatPresets(), "info");
				return;
			}
			await refreshPresets(ctx);
			ctx.ui.notify(formatPresets(), "info");
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		ctx.ui.setStatus("openrouter-presets", presetInfo.length > 0 ? `presets: ${presetInfo.length}` : undefined);
		if (presetInfo.length > 0 || process.env.PI_OFFLINE !== undefined) return;
		// Fetch in the background so presets are ready without waiting for Pi's
		// interactive catalog refresh (which does not run in print mode).
		void refreshPresets(ctx, true).then(() =>
			ctx.ui.setStatus(
				"openrouter-presets",
				presetInfo.length > 0 ? `presets: ${presetInfo.length}` : undefined,
			),
		);
	});

	pi.on("model_select", async (event, ctx) => {
		if (!event.model.id.startsWith(PRESET_PREFIX)) return;
		const match = presetInfo.find((entry) => entry.modelId === event.model.id);
		ctx.ui.setStatus(
			"openrouter-presets",
			match?.baseModelId ? `preset: ${event.model.id} -> ${match.baseModelId}` : `preset: ${event.model.id}`,
		);
	});
}
