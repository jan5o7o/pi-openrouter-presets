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
		/** Server-side provider routing the preset applies to every request. */
		provider?: PresetProviderRouting;
		[key: string]: unknown;
	};
}

/** Provider routing block of a preset version config. */
interface PresetProviderRouting {
	/** Provider slugs the preset restricts routing to. */
	only?: unknown;
	order?: unknown;
	allow_fallbacks?: unknown;
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

/** Pricing block of a model endpoint. Values are dollars per token, as strings. */
interface EndpointPricing {
	prompt?: string | number | null;
	completion?: string | number | null;
	input_cache_read?: string | number | null;
	input_cache_write?: string | number | null;
}

/** One provider endpoint of a model, as returned by `/models/{id}/endpoints`. */
interface OpenRouterEndpoint {
	tag?: string;
	name?: string;
	provider_name?: string;
	quantization?: string | null;
	pricing?: EndpointPricing | null;
	uptime_last_1d?: number | null;
}

interface EndpointsResponse {
	data?: { id?: string; endpoints?: OpenRouterEndpoint[] };
}

/** A live endpoint price and quality, normalised to dollars per million tokens. */
interface EndpointSummary {
	tag: string;
	providerName?: string;
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	quantization?: string;
	uptime1d?: number;
}

/** Interquartile mean price across every listed endpoint of a base model. */
interface EndpointAverage {
	/** Number of endpoints the summary covers. */
	endpoints: number;
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
}

/** Per-preset info kept for the `/presets` command and the status line. */
interface PresetInfo {
	slug: string;
	name: string;
	baseModelId?: string;
	status?: string;
	modelId: string;
	/** Provider slugs the preset pins routing to (`provider.only`). */
	routeSlugs?: string[];
	/** Live price of the endpoint the preset routes to, or the cheapest one when unpinned. */
	route?: EndpointSummary;
	/** Mean price across every provider listed for the base model. */
	modelAverage?: EndpointAverage;
	/** True when the route was picked automatically because the preset pins no provider. */
	routeAuto?: boolean;
	/** True when the preset pins providers that the base model no longer lists. */
	routeMissing?: boolean;
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

/** Convert an OpenRouter per-token price string to dollars per million tokens. */
function perMillion(value: string | number | null | undefined): number | undefined {
	const parsed =
		typeof value === "number" ? value : typeof value === "string" ? Number.parseFloat(value) : Number.NaN;
	return Number.isFinite(parsed) ? parsed * 1_000_000 : undefined;
}

/** The routing slug of an endpoint tag: `decart/fp4` -> `decart`. */
function endpointSlug(tag: string): string {
	return tag.split("/")[0].toLowerCase();
}

/** Cheapest by the sum of input and output price, used to pick between service tiers. */
function endpointCost(endpoint: OpenRouterEndpoint): number {
	return (perMillion(endpoint.pricing?.prompt) ?? 0) + (perMillion(endpoint.pricing?.completion) ?? 0);
}

function cheapestEndpoint(endpoints: OpenRouterEndpoint[]): OpenRouterEndpoint | undefined {
	return endpoints.reduce<OpenRouterEndpoint | undefined>(
		(best, endpoint) => (best === undefined || endpointCost(endpoint) < endpointCost(best) ? endpoint : best),
		undefined,
	);
}

/** The endpoint a preset routes to, matching `provider.only` against the tag prefix. */
function pinEndpoint(endpoints: OpenRouterEndpoint[], slugs: string[]): OpenRouterEndpoint | undefined {
	const wanted = new Set(slugs.map((slug) => slug.toLowerCase()));
	const matches = endpoints.filter((endpoint) => endpoint.tag && wanted.has(endpointSlug(endpoint.tag)));
	return cheapestEndpoint(matches);
}

function endpointSummary(endpoint: OpenRouterEndpoint): EndpointSummary {
	const pricing = endpoint.pricing ?? {};
	const summary: EndpointSummary = {
		tag: endpoint.tag ?? endpoint.name ?? "unknown",
		input: perMillion(pricing.prompt),
		output: perMillion(pricing.completion),
		cacheRead: perMillion(pricing.input_cache_read),
		cacheWrite: perMillion(pricing.input_cache_write),
	};
	if (endpoint.provider_name) summary.providerName = endpoint.provider_name;
	if (endpoint.quantization) summary.quantization = endpoint.quantization;
	if (typeof endpoint.uptime_last_1d === "number") summary.uptime1d = endpoint.uptime_last_1d;
	return summary;
}

/** Mean of the values between the 25th and 75th percentile, discarding outlier providers. */
function interquartileMean(values: number[]): number | undefined {
	if (values.length === 0) return undefined;
	if (values.length <= 3) return values.reduce((total, value) => total + value, 0) / values.length;
	const sorted = [...values].sort((left, right) => left - right);
	const start = Math.floor(sorted.length * 0.25);
	const end = Math.ceil(sorted.length * 0.75);
	const middle = sorted.slice(start, end);
	return middle.reduce((total, value) => total + value, 0) / middle.length;
}

/** Interquartile-mean price across every endpoint listed for a base model. */
function interquartileEndpointPrices(endpoints: OpenRouterEndpoint[]): EndpointAverage | undefined {
	if (endpoints.length === 0) return undefined;
	const trim = (pick: (endpoint: OpenRouterEndpoint) => number | undefined): number | undefined =>
		interquartileMean(
			endpoints.map(pick).filter((value): value is number => value !== undefined),
		);
	return {
		endpoints: endpoints.length,
		input: trim((endpoint) => perMillion(endpoint.pricing?.prompt)),
		output: trim((endpoint) => perMillion(endpoint.pricing?.completion)),
		cacheRead: trim((endpoint) => perMillion(endpoint.pricing?.input_cache_read)),
		cacheWrite: trim((endpoint) => perMillion(endpoint.pricing?.input_cache_write)),
	};
}

/** Provider slugs a preset pins with `provider.only`, if they are plain strings. */
function routeSlugsOf(detail: PresetDetail | undefined): string[] {
	const only = detail?.designated_version?.config?.provider?.only;
	if (typeof only === "string") return [only];
	if (!Array.isArray(only)) return [];
	return only.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
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

function infoFromDetail(
	preset: PresetSummary,
	detail: PresetDetail | undefined,
	modelId: string,
	endpointsByModel?: Map<string, OpenRouterEndpoint[]>,
): PresetInfo {
	const baseModelId = detail?.designated_version?.config?.model;
	const routeSlugs = routeSlugsOf(detail);
	const pinned = routeSlugs.length > 0;
	const endpoints = baseModelId ? endpointsByModel?.get(baseModelId) : undefined;
	const endpoint = endpoints?.length
		? pinned
			? pinEndpoint(endpoints, routeSlugs)
			: cheapestEndpoint(endpoints)
		: undefined;

	const info: PresetInfo = {
		slug: preset.slug,
		name: preset.name,
		baseModelId,
		status: preset.status ?? undefined,
		modelId,
	};
	if (pinned) info.routeSlugs = routeSlugs;
	if (endpoints?.length) info.modelAverage = interquartileEndpointPrices(endpoints);
	if (endpoint) {
		info.route = endpointSummary(endpoint);
		if (!pinned) info.routeAuto = true;
	} else if (pinned && endpoints && endpoints.length > 0) {
		info.routeMissing = true;
	}
	return info;
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

	// Live pricing: one endpoints request per distinct base model, best-effort. A
	// failure only drops prices from the listing, never the presets themselves.
	const baseIds = [
		...new Set(
			details
				.map((detail) => detail?.designated_version?.config?.model)
				.filter((id): id is string => typeof id === "string" && id.length > 0),
		),
	];
	const endpointsByModel = new Map<string, OpenRouterEndpoint[]>();
	await mapConcurrent(baseIds, DETAIL_CONCURRENCY, async (baseId) => {
		try {
			const body = await getJson<EndpointsResponse>(
				`${API_BASE_URL}/models/${baseId.split("/").map(encodeURIComponent).join("/")}/endpoints`,
				apiKey,
				signal,
			);
			endpointsByModel.set(baseId, body.data?.endpoints ?? []);
		} catch (error) {
			debug("endpoints failed", baseId, error);
		}
	});

	const models: Model<Api>[] = [];
	const info: PresetInfo[] = [];
	for (let index = 0; index < presets.length; index++) {
		const model = buildPresetModel(baseModels, presets[index], details[index]);
		models.push(model);
		info.push(infoFromDetail(presets[index], details[index], model.id, endpointsByModel));
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

/** Dollars per million tokens, trimmed to the precision a price actually needs. */
function money(value: number | undefined): string {
	if (value === undefined || !Number.isFinite(value)) return "?";
	if (value === 0) return "free";
	if (value < 1) return `$${value.toFixed(6).replace(/0+$/, "").replace(/\.$/, "")}`;
	return `$${value.toFixed(2)}`;
}

/** Same as `money`, but rounded — an average does not deserve six decimals. */
function moneyApprox(value: number | undefined): string {
	if (value === undefined || !Number.isFinite(value)) return "?";
	return money(Number(value.toFixed(value < 1 ? 4 : 2)));
}

/** The live price line shown under one preset, or undefined when no price is known. */
function formatPresetPrice(info: PresetInfo): string | undefined {
	if (!info.route) {
		if (info.routeMissing) {
			return `  price unavailable: ${info.baseModelId} lists no ${info.routeSlugs?.join("/")} endpoint`;
		}
		return undefined;
	}
	const route = info.route;
	const parts = [`in ${money(route.input)}`, `out ${money(route.output)}`];
	if (route.cacheRead !== undefined) parts.push(`cache-read ${money(route.cacheRead)}`);
	if (route.cacheWrite !== undefined) parts.push(`cache-write ${money(route.cacheWrite)}`);
	const meta = [info.routeAuto ? `cheapest ${route.tag}` : route.tag];
	if (route.quantization && route.quantization !== "unknown") meta.push(route.quantization);
	if (route.uptime1d !== undefined) meta.push(`${route.uptime1d.toFixed(2)}% up`);
	return `  price/M: ${parts.join(" · ")} | ${meta.join(" · ")}`;
}

/** The mean price across the base model's providers, shown under the routed price. */
function formatModelAverage(info: PresetInfo): string | undefined {
	const average = info.modelAverage;
	// A single provider means the average would just repeat the routed price.
	if (!average || average.endpoints <= 1) return undefined;
	const parts: string[] = [];
	if (average.input !== undefined) parts.push(`in ${moneyApprox(average.input)}`);
	if (average.output !== undefined) parts.push(`out ${moneyApprox(average.output)}`);
	if (average.cacheRead !== undefined) parts.push(`cache-read ${moneyApprox(average.cacheRead)}`);
	if (average.cacheWrite !== undefined) parts.push(`cache-write ${moneyApprox(average.cacheWrite)}`);
	if (parts.length === 0) return undefined;
	return `  model avg/M (${average.endpoints} endpoints, interquartile): ${parts.join(" · ")}`;
}

function formatPresets(): string {
	if (lastError) return `OpenRouter presets unavailable: ${lastError}`;
	if (presetInfo.length === 0) return "No OpenRouter presets found for this account.";
	const lines = presetInfo.map((entry) => {
		const base = entry.baseModelId ? ` -> ${entry.baseModelId}` : "";
		const status = entry.status && entry.status !== "active" ? ` [${entry.status}]` : "";
		const price = formatPresetPrice(entry);
		const average = formatModelAverage(entry);
		const detail = [price, average].filter((line): line is string => line !== undefined).join("\n");
		return `${PROVIDER_ID}/${entry.modelId}${base}${status}${detail ? `\n${detail}` : ""}`;
	});
	const fetched =
		presetInfo.some((entry) => entry.route) && lastFetchAt
			? new Date(lastFetchAt).toLocaleTimeString()
			: undefined;
	const header = fetched ? `Live OpenRouter prices (fetched ${fetched}, per million tokens):\n\n` : "";
	return `${header}${lines.join("\n")}`;
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
