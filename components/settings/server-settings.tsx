"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { SettingsRow } from "./controls.tsx";

type ServerChoice = { mode: "local" } | { mode: "remote"; url: string };

/** The desktop app's server choice (docs/self-hosting.md): the menu's
 *  Connect / Sign Out / Use This Computer, here so every platform can
 *  reach them (Linux and Windows hide the menu bar). Desktop only: the
 *  row is absent without the preload bridge. Each action ends in the
 *  main process (connect window, cookie clear, relaunch). */
export function ServerSettings() {
	const [choice, setChoice] = useState<ServerChoice | null>(null);
	const [failed, setFailed] = useState(false);
	useEffect(() => {
		const server = window.lh?.server;
		if (!server) return;
		let live = true;
		void server.current().then((c) => { if (live) setChoice(c); }).catch(() => { if (live) setFailed(true); });
		return () => { live = false; };
	}, []);
	if (!choice && !failed) return null;

	const server = window.lh?.server;
	const run = (action: (() => Promise<void>) | undefined) => {
		setFailed(false);
		void action?.().catch(() => setFailed(true));
	};
	const remote = choice?.mode === "remote" ? new URL(choice.url).host : null;
	const hint = failed
		? "That didn't work. Try again."
		: remote
			? "Sessions, the graph and settings live on this server. Sign in lasts 30 days."
			: "Sessions and settings live on this computer.";

	return (
		<SettingsRow label={remote ? `Server: ${remote}` : "Server: This computer"} hint={hint} testid="row-server">
			<span className="flex shrink-0 gap-2">
				{remote && (
					<>
						<Button type="button" size="xs" variant="outline" className="cursor-pointer" data-testid="server-sign-out" onClick={() => run(server?.signOut)}>Sign out</Button>
						<Button type="button" size="xs" variant="outline" className="cursor-pointer" data-testid="server-use-local" onClick={() => run(server?.useLocal)}>Use this computer</Button>
					</>
				)}
				<Button type="button" size="xs" variant="outline" className="cursor-pointer" data-testid="server-connect" onClick={() => run(server?.connect)}>Connect…</Button>
			</span>
		</SettingsRow>
	);
}
