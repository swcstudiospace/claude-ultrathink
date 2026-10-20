// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Development harness for the graph MCP App: a tiny MCP Apps host page plus the app, served on loopback so a real
 * browser can exercise the view without Claude. Nothing in the service imports this file.
 *
 *   bun services/ultrathink/ui/harness/serve.ts [--port 4173]
 *   open http://127.0.0.1:4173/?fixture=diamond&theme=dark&width=360
 *
 * `/app.html` carries the CSP a conforming host applies to a View with no declared origins (spec 2026-01-26,
 * default policy) as a header; the document itself also embeds it as a meta tag, which is what applies when the host
 * page frames it via `srcdoc`. Either way any network or inline-handler use by the app fails visibly here.
 */
import { FIXTURE_NAMES, FIXTURES } from "../fixtures.ts";
import { APP_CSP, graphAppHtml } from "../graph-app.ts";

const DEFAULT_PORT = 4173;
const HOST_PAGE = new URL("./host.html", import.meta.url);

function respond(body: ConstructorParameters<typeof Response>[0], type: string, extra: Record<string, string> = {}): Response {
	return new Response(body, { headers: { "content-type": type, "cache-control": "no-store", ...extra } });
}

export function harnessFetch(req: Request): Response | Promise<Response> {
	const url = new URL(req.url);
	if (req.method !== "GET" && req.method !== "HEAD") return new Response("method not allowed", { status: 405 });
	switch (url.pathname) {
		case "/":
		case "/index.html":
			// Read per request so edits to the host page show up on reload.
			return Bun.file(HOST_PAGE)
				.text()
				.then((html) => respond(html, "text/html; charset=utf-8"));
		case "/app.html":
			return respond(graphAppHtml(), "text/html; charset=utf-8", { "content-security-policy": APP_CSP });
		case "/fixtures.json":
			return respond(JSON.stringify({ names: FIXTURE_NAMES, fixtures: FIXTURES }), "application/json; charset=utf-8");
		default:
			return new Response("not found", { status: 404 });
	}
}

export interface HarnessServer {
	readonly port?: number;
	stop(closeActiveConnections?: boolean): unknown;
}

export function startHarness(port: number = DEFAULT_PORT): HarnessServer {
	return Bun.serve({ hostname: "127.0.0.1", port, fetch: harnessFetch });
}

function parsePort(argv: string[]): number {
	const at = argv.indexOf("--port");
	if (at < 0) return DEFAULT_PORT;
	const port = Number(argv[at + 1]);
	if (!Number.isInteger(port) || port < 0 || port > 65_535) {
		process.stderr.write("--port needs an integer between 0 and 65535\n");
		process.exit(2);
	}
	return port;
}

if (import.meta.main) {
	const server = startHarness(parsePort(process.argv.slice(2)));
	process.stdout.write(`graph app harness: http://127.0.0.1:${server.port}/?fixture=diamond\n`);
}
