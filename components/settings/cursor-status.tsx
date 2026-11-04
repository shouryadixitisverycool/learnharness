"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { CURSOR_MINIMUM_VERSION, type CursorStatus, type UserSettings } from "@/src/core";
import { notifySettingsSaved, useSettingsSaved } from "@/components/settings-signal";
import { Button } from "@/components/ui/button";
import { Toggle } from "./controls";

const STATES: readonly CursorStatus["state"][] = ["not-found", "signed-in", "signed-out", "update-required", "unchecked"];

export function cursorStatusLabel(status: CursorStatus | null): string {
	switch (status?.state) {
		case "not-found": return "Not found";
		case "signed-in": return `Version ${status.version} · signed in`;
		case "signed-out": return `Version ${status.version} · not signed in`;
		case "update-required": return `Version ${status.version} · update required`;
		default: return "Installation could not be checked";
	}
}

export function CursorInstallationStatus() {
	const [enabled, setEnabled] = useState(false);
	const [loaded, setLoaded] = useState(false);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [status, setStatus] = useState<CursorStatus | null>(null);
	const [busy, setBusy] = useState(false);
	const request = useRef<AbortController | null>(null);
	const settingsRead = useRef<AbortController | null>(null);
	const settingsWrite = useRef<AbortController | null>(null);

	const read = useCallback(async () => {
		settingsRead.current?.abort();
		const controller = new AbortController();
		settingsRead.current = controller;
		setLoaded(false);
		try {
			const response = await fetch("/api/settings", { cache: "no-store", signal: controller.signal });
			if (!response.ok) throw new Error("settings unavailable");
			const body = await response.json() as { settings: UserSettings | null };
			if (!controller.signal.aborted) {
				setEnabled(body.settings?.cursor?.enabled === true);
				setLoaded(true);
				setError(null);
			}
		} catch {
			if (!controller.signal.aborted) setError("Could not load Cursor settings.");
		}
	}, []);
	useEffect(() => {
		void read();
		return () => { settingsRead.current?.abort(); settingsWrite.current?.abort(); };
	}, [read]);
	useSettingsSaved((section) => { if (section === "cursor") void read(); });

	const save = async (next: boolean) => {
		const controller = new AbortController();
		settingsWrite.current = controller;
		settingsRead.current?.abort();
		setSaving(true);
		setError(null);
		try {
			const response = await fetch("/api/settings/cursor", { method: "PUT", headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ enabled: next }), signal: controller.signal });
			if (!response.ok) throw new Error("settings write failed");
			const body = await response.json() as { settings: UserSettings };
			if (typeof body.settings?.cursor?.enabled !== "boolean") throw new Error("invalid settings response");
			if (!controller.signal.aborted) {
				setEnabled(body.settings.cursor.enabled);
				notifySettingsSaved("cursor");
			}
		} catch {
			if (!controller.signal.aborted) setError("Could not save Cursor settings.");
		} finally {
			if (!controller.signal.aborted) setSaving(false);
		}
	};

	const refresh = useCallback(async () => {
		if (!enabled) return;
		request.current?.abort();
		const controller = new AbortController();
		request.current = controller;
		setBusy(true);
		try {
			const response = await fetch("/api/cursor", { cache: "no-store", signal: controller.signal, headers: { "x-learnharness-cursor": "1" } });
			if (!response.ok) throw new Error("status unavailable");
			const value = await response.json() as CursorStatus;
			if (!STATES.includes(value.state)
				|| value.minimumVersion !== CURSOR_MINIMUM_VERSION
				|| (value.version !== null && (typeof value.version !== "string" || !/^\d{4}\.\d{2}\.\d{2}-[0-9a-f]+$/.test(value.version)))) throw new Error("invalid status");
			if (!controller.signal.aborted) setStatus(value);
		} catch {
			if (!controller.signal.aborted) setStatus(null);
		} finally {
			if (!controller.signal.aborted) setBusy(false);
		}
	}, [enabled]);
	useEffect(() => {
		if (enabled) void refresh();
		else { request.current?.abort(); setStatus(null); setBusy(false); }
		return () => request.current?.abort();
	}, [enabled, refresh]);

	return <div className="space-y-2" data-testid="cursor-installation">
		<div className="flex items-center gap-3">
			<span className="font-prose text-(length:--lh-prose-size) text-foreground">Cursor</span>
			<Toggle label="Cursor" checked={enabled} disabled={!loaded || saving} onChange={(next) => void save(next)} />
		</div>
		{error && <p role="alert" className="text-xs text-red-400">{error}</p>}
		{enabled && <>
			<div className="flex flex-wrap items-center gap-3">
				<span role="status" className="text-xs text-muted-foreground">{busy ? "Checking…" : cursorStatusLabel(status)}</span>
				<Button type="button" size="xs" variant="outline" className="cursor-pointer disabled:cursor-not-allowed" disabled={busy} onClick={() => void refresh()} data-testid="cursor-check-again">Check again</Button>
			</div>
			<p className="text-xs leading-relaxed text-muted-foreground"><strong className="font-medium">Install cursor-agent on the server and run <code>cursor-agent login</code>, then select a Cursor model here.</strong> LearnHarness starts it when needed, with its own locked-down config: the tutor gets only LearnHarness tools, never shell, file, or web access.</p>
			<p className="text-xs leading-relaxed text-muted-foreground">Runs on your Cursor subscription; LearnHarness does not estimate cost. Requires a build from {CURSOR_MINIMUM_VERSION} or later. <a href="https://cursor.com/docs/cli/installation" target="_blank" rel="noreferrer" className="underline underline-offset-2 hover:text-foreground">Setup ↗</a></p>
			<p className="text-xs leading-relaxed text-muted-foreground">Verify AI claims independently—they may be inaccurate, incomplete, misleading, or outdated.</p>
		</>}
	</div>;
}
