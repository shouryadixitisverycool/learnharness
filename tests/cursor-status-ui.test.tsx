import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { CursorInstallationStatus, cursorStatusLabel } from "../components/settings/cursor-status.tsx";
import { useModelCatalog } from "../components/model-catalog.ts";
import type { CursorStatus } from "../src/core/contracts/cursor.ts";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement,
	CustomEvent: dom.window.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true });
const originalFetch = globalThis.fetch;
let root: Root | undefined, host: HTMLDivElement | undefined;
const status = (state: CursorStatus["state"], version: string | null = null): CursorStatus => ({ state, version, minimumVersion: "2026.08.25" });
const button = () => document.querySelector<HTMLButtonElement>('[data-testid="cursor-check-again"]')!;
const toggle = () => document.querySelector<HTMLButtonElement>('[role="switch"]')!;
const label = () => document.querySelector('[role="status"]')?.textContent;
function fixture(probe: () => Promise<Response>, enabled = true) {
	const calls: string[] = [];
	let on = enabled;
	globalThis.fetch = (async (url, init) => {
		calls.push(`${init?.method ?? "GET"} ${url}`);
		if (url === "/api/settings") return Response.json({ settings: { version: 1, cursor: { enabled: on } } });
		if (url === "/api/settings/cursor") {
			on = JSON.parse(String(init?.body)).enabled;
			return Response.json({ settings: { version: 1, cursor: { enabled: on } } });
		}
		if (url === "/api/models") return Response.json({ models: on ? [{ provider: "cursor", id: "grok-4.7-fast" }] : [] });
		assert.equal(url, "/api/cursor");
		assert.equal(new Headers(init?.headers).get("x-learnharness-cursor"), "1");
		return probe();
	}) as typeof fetch;
	return calls;
}
async function mount(extra?: React.ReactNode) {
	host = document.createElement("div"); document.body.append(host); root = createRoot(host);
	await act(async () => root!.render(<><CursorInstallationStatus />{extra}</>));
}
afterEach(async () => {
	await act(async () => root?.unmount()); host?.remove(); root = undefined; host = undefined;
	globalThis.fetch = originalFetch;
});

test("initial render is off, with no setup prose or check action", () => {
	const html = renderToStaticMarkup(<CursorInstallationStatus />);
	assert.match(html, /Cursor/); assert.match(html, /aria-checked="false"/);
	assert(!html.includes("Check again")); assert(!html.includes("cursor-agent login"));
});

for (const [value, text] of [
	[status("not-found"), "Not found"],
	[status("signed-in", "2026.08.25-3e8eec8"), "Version 2026.08.25-3e8eec8 · signed in"],
	[status("signed-out", "2026.08.25-3e8eec8"), "Version 2026.08.25-3e8eec8 · not signed in"],
	[status("update-required", "2026.01.02-aaaa"), "Version 2026.01.02-aaaa · update required"],
	[status("unchecked"), "Installation could not be checked"],
] as const) test(`status display: ${text}`, () => assert.equal(cursorStatusLabel(value), text));

test("enabling persists before checking, shows the result, and says how to set it up", async () => {
	const calls = fixture(async () => Response.json(status("signed-in", "2026.08.25-3e8eec8")), false);
	await mount();
	assert.deepEqual(calls, ["GET /api/settings"]);
	await act(async () => toggle().click());
	assert.equal(label(), "Version 2026.08.25-3e8eec8 · signed in");
	assert(calls.indexOf("PUT /api/settings/cursor") < calls.indexOf("GET /api/cursor"));
	assert.match(document.body.textContent ?? "", /cursor-agent login/);
	assert.match(document.body.textContent ?? "", /never shell, file, or web access/);
});

test("a malformed status never shows as signed in", async () => {
	fixture(async () => Response.json({ state: "signed-in", version: "../../etc", minimumVersion: "2026.08.25" }));
	await mount();
	assert.equal(label(), "Installation could not be checked");
});

function CatalogReader() {
	const { catalog } = useModelCatalog();
	return <span data-testid="cli-catalog-models">{catalog?.models.map((m) => `${m.provider}:${m.id}`).join(",") ?? "loading"}</span>;
}
test("the toggle refreshes the shared model catalog", async () => {
	fixture(async () => Response.json(status("signed-in", "2026.08.25-3e8eec8")), false);
	await mount(<CatalogReader />);
	const models = () => document.querySelector('[data-testid="cli-catalog-models"]')?.textContent;
	assert.equal(models(), "");
	await act(async () => toggle().click()); assert.equal(models(), "cursor:grok-4.7-fast");
	await act(async () => toggle().click()); assert.equal(models(), "");
});
