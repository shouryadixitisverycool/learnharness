"use client";
/**
 * THE SETTINGS DIALOG (settings-app wave, 2026-09-20): the thin settings
 * page graduated into the designed surface — a centered modal over
 * everything, left section nav + one scrolling content column.
 *
 * Owner decisions this wave:
 * - Dialog, not a page: opens over whatever screen you're on (the payoff:
 *   appearance edits restyle the chat LIVE behind the dialog). Escape,
 *   backdrop, and ✕ all close. Modal-only — /settings redirects, so
 *   nothing links into a dead surface.
 * - Left section nav in the app's mono chrome (text-only, session-list
 *   language — active = bg-accent), no icons, matching the minimal-color
 *   doctrine.
 * - The dialog is surface-agnostic by construction: the sections talk to
 *   /api/settings* and localStorage only, so this shell can be re-mounted
 *   as a true OS window in the Electron round with near-zero churn.
 *
 * The record + the single `write` seam moved here from the thin page:
 * one record instance for the whole dialog, sections write through it,
 * switching sections never refetches.
 *
 * PERF SPLIT (2026-11-06): this file is only the provider + open/close
 * shell — it stays in the every-route bundle because the sidebar, the
 * mod+, chord and the native bridges need the context. The dialog BODY
 * (every section) lives in settings-dialog-body.tsx behind a dynamic
 * import, prewarmed right after mount, so first paint never pays for it
 * and opening the dialog does not wait on the network in practice.
 */

import { NATIVE_OPEN_SETTINGS_EVENT, postToNative } from "@/components/native-shell";
import {
	createContext,
	lazy,
	Suspense,
	useCallback,
	useContext,
	useEffect,
	useState,
} from "react";
import { ChatGPTUIProvider } from "./chatgpt-connection.tsx";
import { NativeSubscriptionUIProvider } from "./subscription-connections.tsx";
import type { SectionId } from "./settings-dialog-body.tsx";

/* React.lazy + Suspense (the documented alternative to next/dynamic):
 * the dialog only ever renders after a client-side open (show starts
 * false, SSR and hydration agree on nothing), and React.lazy — unlike
 * next/dynamic's ssr:false loadable — also resolves in the bare tsx test
 * environment. The dynamic import() is the same Turbopack split point. */
const LazySettingsDialog = lazy(() =>
	import("./settings-dialog-body.tsx").then((m) => ({ default: m.SettingsDialog })),
);

/** `open(section?, row?)` — the optional ROW deep-links into the Keys
 *  section with that row unfolded (zero-keys wave: the dictation error's
 *  click lands on the Deepgram row). `row` is the KEY ID (the env-var
 *  name, e.g. DEEPGRAM_API_KEY — KeysSection's openRow state), not the
 *  row's testid. */
const DialogContext = createContext<{ open: (section?: string, row?: string) => void }>({ open: () => {} });

/** AppShell-level mount: the sidebar row and the mod+, chord call this.
 *  `open(section)` lands the dialog on a specific section (the first-run
 *  setup flow deep-links to Keys when no provider key exists yet). */
export function SettingsDialogProvider({
	children,
}: {
	children: React.ReactNode;
}) {
	const [show, setShow] = useState(false);
	const [landOn, setLandOn] = useState<SectionId>("keys");
	const [landOnRow, setLandOnRow] = useState<string | null>(null);
	const open = useCallback((section?: string, row?: string) => {
		setLandOn(section ? section as SectionId : "keys");
		setLandOnRow(row ?? null);
		setShow(true);
	}, []);
	// Prewarm the dialog body chunk right after mount: by the time anyone
	// opens Settings the code is already here, so the lazy boundary is
	// invisible (the fallback never renders in practice).
	useEffect(() => {
		void import("./settings-dialog-body.tsx");
	}, []);
	useEffect(() => window.lh?.onOpenSettings?.((section) => open(section)), [open]);
	// The iPhone app's Settings tab opens a section directly (native-shell.ts);
	// a request made before this provider mounted waits on the window.
	useEffect(() => {
		const onNativeOpen = (e: Event) => open((e as CustomEvent<string | undefined>).detail);
		window.addEventListener(NATIVE_OPEN_SETTINGS_EVENT, onNativeOpen);
		const pendingSection = window.lhNativePendingSettings;
		if (pendingSection !== undefined) {
			window.lhNativePendingSettings = undefined;
			open(pendingSection || undefined);
		}
		return () => window.removeEventListener(NATIVE_OPEN_SETTINGS_EVENT, onNativeOpen);
	}, [open]);
	const close = useCallback(() => {
		setShow(false);
		postToNative({ type: "settingsClosed" });
	}, []);
	return (
		<ChatGPTUIProvider><NativeSubscriptionUIProvider><DialogContext.Provider value={{ open }}>
			{children}
			{show && (
				<Suspense fallback={null}>
					<LazySettingsDialog onClose={close} initialSection={landOn} initialRow={landOnRow} />
				</Suspense>
			)}
		</DialogContext.Provider></NativeSubscriptionUIProvider></ChatGPTUIProvider>
	);
}

export function useSettingsDialog() {
	return useContext(DialogContext);
}
