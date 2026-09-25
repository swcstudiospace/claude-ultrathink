// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { createHash, randomBytes } from "node:crypto";
import { PROVIDERS, USER_AGENT } from "./providers.ts";
import type { ProviderId } from "./providers.ts";
import { readStore, withStoreLock, writeStore } from "./store.ts";
import type { CredentialStore, OAuthClient, OAuthTokens } from "./store.ts";

export interface AuthDeps {
	fetch?: typeof fetch;
	now?: () => number;
	storePath: string;
	/** Lock tuning passed to withStoreLock (tests use small values). */
	lock?: { staleMs?: number; waitMs?: number; pollMs?: number };
}

export interface PendingLogin {
	provider: ProviderId;
	url: string;
	state: string;
	verifier: string;
	redirectUri: string;
	client: OAuthClient;
}

export interface ProviderStatus {
	provider: ProviderId;
	kind: "none" | "api_key" | "oauth";
	ready: boolean;
	detail: string;
}

const REFRESH_SKEW_MS = 60_000;
/** Bounds every request made while the store lock is held so a hung endpoint cannot outlive the lock. */
const LOCKED_FETCH_TIMEOUT_MS = 15_000;

class TokenEndpointError extends Error {
	constructor(
		readonly httpStatus: number,
		readonly code: string | undefined,
	) {
		super(`token endpoint failed: HTTP ${httpStatus}${code ? ` (${code})` : ""}`);
	}
	get terminal(): boolean {
		return this.code === "invalid_grant" || this.httpStatus === 400 || this.httpStatus === 401;
	}
}

async function getJson(url: string, deps: AuthDeps): Promise<Record<string, unknown> | undefined> {
	const response = await (deps.fetch ?? fetch)(url, {
		headers: { Accept: "application/json", "User-Agent": USER_AGENT },
		signal: AbortSignal.timeout(LOCKED_FETCH_TIMEOUT_MS),
	});
	if (!response.ok) return undefined;
	try {
		return (await response.json()) as Record<string, unknown>;
	} catch {
		return undefined;
	}
}

/** Store mutations always re-read inside the lock so a stale snapshot is never written. */
async function mutateStore<T>(deps: AuthDeps, fn: (store: CredentialStore) => Promise<T> | T): Promise<T> {
	return withStoreLock(
		deps.storePath,
		async () => {
			const store = readStore(deps.storePath);
			const result = await fn(store);
			writeStore(deps.storePath, store);
			return result;
		},
		deps.lock,
	);
}

async function tokenRequest(client: OAuthClient, params: Record<string, string>, deps: AuthDeps): Promise<OAuthTokens> {
	const body = new URLSearchParams({ ...params, client_id: client.clientId });
	if (client.clientSecret) body.set("client_secret", client.clientSecret);
	const response = await (deps.fetch ?? fetch)(client.tokenEndpoint, {
		method: "POST",
		headers: {
			Accept: "application/json",
			"Content-Type": "application/x-www-form-urlencoded",
			"User-Agent": USER_AGENT,
		},
		body: body.toString(),
		signal: AbortSignal.timeout(LOCKED_FETCH_TIMEOUT_MS),
	});
	let json: Record<string, unknown> = {};
	try {
		json = (await response.json()) as Record<string, unknown>;
	} catch {
		// non-JSON body; status alone decides
	}
	if (!response.ok || typeof json.access_token !== "string") {
		throw new TokenEndpointError(response.status, typeof json.error === "string" ? json.error : undefined);
	}
	const now = (deps.now ?? Date.now)();
	return {
		accessToken: json.access_token,
		refreshToken: typeof json.refresh_token === "string" ? json.refresh_token : params.refresh_token,
		expiresAt: typeof json.expires_in === "number" ? now + json.expires_in * 1000 : undefined,
		scope: typeof json.scope === "string" ? json.scope : undefined,
	};
}

/** Refresh inside an already-held lock; mutates `store` (caller persists). */
async function refreshLocked(provider: ProviderId, store: CredentialStore, deps: AuthDeps): Promise<string | undefined> {
	const credential = store.providers[provider];
	if (credential?.kind !== "oauth" || !credential.tokens?.refreshToken) return undefined;
	try {
		const tokens = await tokenRequest(
			credential.client,
			{
				grant_type: "refresh_token",
				refresh_token: credential.tokens.refreshToken,
				resource: PROVIDERS[provider].resource,
			},
			deps,
		);
		credential.tokens = tokens;
		credential.needsLogin = undefined;
		credential.updatedAt = (deps.now ?? Date.now)();
		return `Bearer ${tokens.accessToken}`;
	} catch (error) {
		if (error instanceof TokenEndpointError && error.terminal) {
			credential.needsLogin = error.code ?? `HTTP ${error.httpStatus}`;
			credential.updatedAt = (deps.now ?? Date.now)();
			return undefined;
		}
		throw error;
	}
}

export async function beginLogin(provider: ProviderId, deps: AuthDeps & { redirectUri: string }): Promise<PendingLogin> {
	const info = PROVIDERS[provider];
	if (!info.oauth) throw new Error(`${provider} does not support OAuth`);
	const prm = await getJson(info.protectedResourceMetadata, deps);
	const servers = prm?.authorization_servers;
	const issuer = (
		Array.isArray(servers) && typeof servers[0] === "string" ? servers[0] : new URL(info.resource).origin
	).replace(/\/$/, "");
	const scopes =
		Array.isArray(prm?.scopes_supported) && prm.scopes_supported.length > 0
			? (prm.scopes_supported as string[])
			: info.scopes;
	const asMeta =
		(await getJson(`${issuer}/.well-known/oauth-authorization-server`, deps)) ??
		(await getJson(`${issuer}/.well-known/openid-configuration`, deps));
	if (
		!asMeta ||
		typeof asMeta.authorization_endpoint !== "string" ||
		typeof asMeta.token_endpoint !== "string"
	) {
		throw new Error(`${provider}: authorization server metadata not found at ${issuer}`);
	}
	const authorizationEndpoint = asMeta.authorization_endpoint;
	const tokenEndpoint = asMeta.token_endpoint;
	const registrationEndpoint = asMeta.registration_endpoint;

	const client = await mutateStore(deps, async store => {
		const existing = store.providers[provider];
		if (
			existing?.kind === "oauth" &&
			existing.client.redirectUri === deps.redirectUri &&
			existing.client.authorizationEndpoint === authorizationEndpoint
		) {
			return existing.client;
		}
		if (typeof registrationEndpoint !== "string") {
			throw new Error(`${provider}: authorization server does not support dynamic client registration`);
		}
		const response = await (deps.fetch ?? fetch)(registrationEndpoint, {
			method: "POST",
			headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": USER_AGENT },
			body: JSON.stringify({
				client_name: "ultrathink",
				redirect_uris: [deps.redirectUri],
				grant_types: ["authorization_code", "refresh_token"],
				response_types: ["code"],
				token_endpoint_auth_method: "none",
			}),
			signal: AbortSignal.timeout(LOCKED_FETCH_TIMEOUT_MS),
		});
		const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
		if (!response.ok || typeof json.client_id !== "string") {
			throw new Error(
				`${provider}: client registration failed: HTTP ${response.status}${typeof json.error === "string" ? ` (${json.error})` : ""}`,
			);
		}
		const now = (deps.now ?? Date.now)();
		const registered: OAuthClient = {
			clientId: json.client_id,
			clientSecret: typeof json.client_secret === "string" ? json.client_secret : undefined,
			redirectUri: deps.redirectUri,
			issuer,
			authorizationEndpoint,
			tokenEndpoint,
			registeredAt: now,
		};
		if (!existing || (existing.kind === "oauth" && !existing.tokens)) {
			store.providers[provider] = { kind: "oauth", client: registered, updatedAt: now };
		}
		return registered;
	});

	const verifier = randomBytes(32).toString("base64url");
	const state = randomBytes(16).toString("base64url");
	const url = new URL(client.authorizationEndpoint);
	url.searchParams.set("response_type", "code");
	url.searchParams.set("client_id", client.clientId);
	url.searchParams.set("redirect_uri", deps.redirectUri);
	url.searchParams.set("code_challenge", createHash("sha256").update(verifier).digest("base64url"));
	url.searchParams.set("code_challenge_method", "S256");
	url.searchParams.set("state", state);
	url.searchParams.set("scope", scopes.join(" "));
	url.searchParams.set("resource", info.resource);
	return { provider, url: url.toString(), state, verifier, redirectUri: deps.redirectUri, client };
}

export function parseCallback(input: string): { code?: string; state?: string; error?: string; bare?: boolean } {
	const trimmed = input.trim();
	let query: string;
	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) query = new URL(trimmed).search;
	else if (trimmed.includes("=")) query = trimmed;
	else return trimmed ? { code: trimmed, bare: true } : {};
	const params = new URLSearchParams(query.replace(/^[?#]/, ""));
	return {
		code: params.get("code") ?? undefined,
		state: params.get("state") ?? undefined,
		error: params.get("error") ?? undefined,
	};
}

export async function completeLogin(pending: PendingLogin, input: string, deps: AuthDeps): Promise<void> {
	const parsed = parseCallback(input);
	if (parsed.error) throw new Error(`${pending.provider}: authorization denied (${parsed.error})`);
	if (!parsed.bare && parsed.state !== pending.state) {
		throw new Error(`${pending.provider}: state mismatch (missing or wrong); restart login`);
	}
	if (!parsed.code) throw new Error(`${pending.provider}: no authorization code in callback`);
	const tokens = await tokenRequest(
		pending.client,
		{
			grant_type: "authorization_code",
			code: parsed.code,
			redirect_uri: pending.redirectUri,
			code_verifier: pending.verifier,
			resource: PROVIDERS[pending.provider].resource,
		},
		deps,
	);
	await mutateStore(deps, store => {
		store.providers[pending.provider] = {
			kind: "oauth",
			client: pending.client,
			tokens,
			updatedAt: (deps.now ?? Date.now)(),
		};
	});
}

export async function setApiKey(provider: ProviderId, apiKey: string, deps: AuthDeps): Promise<void> {
	if (!PROVIDERS[provider].apiKey) throw new Error(`${provider} does not accept API keys; use OAuth login`);
	const key = apiKey.trim();
	if (!key) throw new Error("API key is empty");
	await mutateStore(deps, store => {
		store.providers[provider] = { kind: "api_key", apiKey: key, updatedAt: (deps.now ?? Date.now)() };
	});
}

export async function logout(provider: ProviderId, deps: AuthDeps): Promise<void> {
	await mutateStore(deps, store => {
		delete store.providers[provider];
	});
}

export async function resolveAuthHeader(provider: ProviderId, deps: AuthDeps): Promise<string | undefined> {
	const now = deps.now ?? Date.now;
	const credential = readStore(deps.storePath).providers[provider];
	if (!credential) return undefined;
	if (credential.kind === "api_key") return `Bearer ${credential.apiKey}`;
	if (credential.needsLogin || !credential.tokens) return undefined;
	const { tokens } = credential;
	if (tokens.expiresAt === undefined || tokens.expiresAt - now() > REFRESH_SKEW_MS) {
		return `Bearer ${tokens.accessToken}`;
	}
	return mutateStore(deps, async store => {
		const current = store.providers[provider];
		if (current?.kind !== "oauth" || current.needsLogin || !current.tokens) return undefined;
		const fresh = current.tokens;
		if (fresh.expiresAt === undefined || fresh.expiresAt - now() > REFRESH_SKEW_MS) {
			return `Bearer ${fresh.accessToken}`;
		}
		if (!fresh.refreshToken) return fresh.expiresAt > now() ? `Bearer ${fresh.accessToken}` : undefined;
		return refreshLocked(provider, store, deps);
	});
}

export async function recoverUnauthorized(
	provider: ProviderId,
	failedHeader: string | undefined,
	deps: AuthDeps,
): Promise<boolean> {
	const initial = readStore(deps.storePath).providers[provider];
	if (initial?.kind !== "oauth") return false;
	return mutateStore(deps, async store => {
		const credential = store.providers[provider];
		if (credential?.kind !== "oauth" || credential.needsLogin || !credential.tokens) return false;
		if (`Bearer ${credential.tokens.accessToken}` !== failedHeader) return true;
		if (!credential.tokens.refreshToken) {
			credential.needsLogin = "access token rejected";
			credential.updatedAt = (deps.now ?? Date.now)();
			return false;
		}
		return (await refreshLocked(provider, store, deps)) !== undefined;
	});
}

function formatDuration(ms: number): string {
	const minutes = Math.round(ms / 60_000);
	if (minutes < 60) return `${minutes}m`;
	return `${Math.round(minutes / 60)}h`;
}

export function status(deps: AuthDeps): ProviderStatus[] {
	const store = readStore(deps.storePath);
	const now = (deps.now ?? Date.now)();
	return (Object.keys(PROVIDERS) as ProviderId[]).map(provider => {
		const credential = store.providers[provider];
		if (!credential) return { provider, kind: "none", ready: false, detail: "not configured" };
		if (credential.kind === "api_key") {
			return { provider, kind: "api_key", ready: true, detail: `api key set (${credential.apiKey.length} chars)` };
		}
		if (credential.needsLogin) {
			return { provider, kind: "oauth", ready: false, detail: `login required: ${credential.needsLogin}` };
		}
		const tokens = credential.tokens;
		if (!tokens) return { provider, kind: "oauth", ready: false, detail: "client registered; login required" };
		if (tokens.expiresAt === undefined) return { provider, kind: "oauth", ready: true, detail: "oauth token (no expiry)" };
		const remaining = tokens.expiresAt - now;
		if (remaining > 0) {
			return { provider, kind: "oauth", ready: true, detail: `oauth token expires in ${formatDuration(remaining)}` };
		}
		return {
			provider,
			kind: "oauth",
			ready: Boolean(tokens.refreshToken),
			detail: tokens.refreshToken ? "oauth token expired; will refresh" : "oauth token expired; login required",
		};
	});
}
