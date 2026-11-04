/** Settings → General → Server with a fake preload bridge: no Electron. */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

import assert from "node:assert/strict";
import { describe, it, afterEach } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { ServerSettings } from "../components/settings/server-settings.tsx";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, CustomEvent: dom.window.CustomEvent });
const roots: { root: Root; host: HTMLElement }[] = [];
const q = (host: ParentNode, id: string) => host.querySelector<HTMLElement>(`[data-testid='${id}']`);

type Choice = { mode: "local" } | { mode: "remote"; url: string };

function bridge(choice: Choice, fail: Partial<Record<"connect" | "signOut" | "useLocal", boolean>> = {}, { local = true } = {}) {
	const calls: string[] = [];
	const op = (name: "connect" | "signOut" | "useLocal") => async () => {
		calls.push(name);
		if (fail[name]) throw new Error("raw diagnostics");
	};
	window.lh = {
		expandWindow() {},
		server: { current: async () => choice, connect: op("connect"), signOut: op("signOut"), ...(local ? { useLocal: op("useLocal") } : {}) },
	};
	return calls;
}

async function mount() {
	const host = document.createElement("div"); document.body.append(host);
	const root = createRoot(host); roots.push({ root, host });
	await act(async () => { root.render(<ServerSettings />); });
	return host;
}

async function click(element: HTMLElement | null) {
	assert.ok(element, "missing click target");
	await act(async () => { element.click(); });
}

afterEach(async () => {
	for (const { root, host } of roots.splice(0)) {
		await act(async () => { root.unmount(); }); host.remove();
	}
	delete window.lh;
});

describe("Settings server row", () => {
	it("is absent outside the desktop app", async () => {
		const host = await mount();
		assert.equal(q(host, "row-server"), null);
	});

	it("on this computer, offers only Connect", async () => {
		const calls = bridge({ mode: "local" });
		const host = await mount();
		assert.match(q(host, "row-server")!.textContent ?? "", /Server: This computer/);
		assert.equal(q(host, "server-sign-out"), null);
		assert.equal(q(host, "server-use-local"), null);
		await click(q(host, "server-connect"));
		assert.deepEqual(calls, ["connect"]);
	});

	it("on a server, names its host and offers sign out and switching back", async () => {
		const calls = bridge({ mode: "remote", url: "https://dixithome.example.ts.net:8446" });
		const host = await mount();
		assert.match(q(host, "row-server")!.textContent ?? "", /Server: dixithome\.example\.ts\.net:8446/);
		await click(q(host, "server-sign-out"));
		await click(q(host, "server-use-local"));
		await click(q(host, "server-connect"));
		assert.deepEqual(calls, ["signOut", "useLocal", "connect"]);
	});

	it("without a local server (the Android app), offers sign out and Connect but not switching back", async () => {
		const calls = bridge({ mode: "remote", url: "https://dixithome.example.ts.net:8446" }, {}, { local: false });
		const host = await mount();
		assert.match(q(host, "row-server")!.textContent ?? "", /Server: dixithome\.example\.ts\.net:8446/);
		assert.equal(q(host, "server-use-local"), null);
		await click(q(host, "server-sign-out"));
		await click(q(host, "server-connect"));
		assert.deepEqual(calls, ["signOut", "connect"]);
	});

	it("keeps a failure message generic", async () => {
		bridge({ mode: "remote", url: "https://dixithome.example.ts.net:8446" }, { signOut: true });
		const host = await mount();
		await click(q(host, "server-sign-out"));
		const text = q(host, "row-server")!.textContent ?? "";
		assert.match(text, /didn't work/);
		assert.doesNotMatch(text, /raw diagnostics/);
	});
});
