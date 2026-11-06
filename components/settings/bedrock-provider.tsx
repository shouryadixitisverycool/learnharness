"use client";
/**
 * Amazon Bedrock in Settings → Keys: a status row once configured and an
 * editor (region dropdown + Other, Bedrock API key, Save / Refresh models /
 * Cancel / Remove, discovered model list). API: /api/bedrock-provider.
 * No key characters ever come back from the server.
 */

import { useState } from "react";

const OTHER = "__other";
const API_KEY_DOCS = "https://docs.aws.amazon.com/bedrock/latest/userguide/api-keys.html";

/** GET /api/bedrock-provider. */
export interface BedrockStatus {
	region: string;
	models: { id: string; name: string; accessConfirmed: boolean }[];
	keyPresent: boolean;
	keySource: "env" | "file" | "none";
	regions: string[];
}

export async function readBedrockStatus(): Promise<BedrockStatus> {
	const response = await fetch("/api/bedrock-provider");
	if (!response.ok) throw new Error("Unable to load the Bedrock configuration.");
	const b = await response.json() as Partial<BedrockStatus>;
	return { region: b.region ?? "", models: b.models ?? [], keyPresent: Boolean(b.keyPresent), keySource: b.keySource ?? "none", regions: b.regions ?? [] };
}

/** "eu-north-1 · 48 models" (" · key missing" when the key is gone). Pure. */
export function bedrockStatusLine(status: BedrockStatus): string {
	const count = status.models.length;
	return `${status.region} · ${count} model${count === 1 ? "" : "s"}${status.keyPresent ? status.keySource === "env" ? " · env key" : "" : " · key missing"}`;
}

const inputClass = "h-7 min-w-0 rounded-sm border border-border bg-background px-1.5 font-mono text-xs text-foreground outline-none placeholder:text-muted-foreground/60 focus:border-muted-foreground/50";
const actionClass = "shrink-0 text-xs underline-offset-2 hover:underline disabled:text-muted-foreground/40 disabled:no-underline";

export function BedrockRow({ status, expanded, onToggle }: { status: BedrockStatus; expanded: boolean; onToggle: () => void }) {
	return (
		<div data-testid="bedrock-row">
			<button
				type="button"
				data-testid="bedrock-row-btn"
				aria-expanded={expanded}
				onClick={onToggle}
				className="flex w-full cursor-pointer items-center justify-between gap-3 rounded-sm px-1 py-1.5 text-left transition-colors hover:bg-accent/50"
			>
				<span className="shrink-0 font-ui text-xs text-foreground">Amazon Bedrock</span>
				<span data-testid="bedrock-status" className="min-w-0 truncate font-mono text-[11px] text-muted-foreground">{bedrockStatusLine(status)}</span>
			</button>
		</div>
	);
}

async function post(body: Record<string, unknown>, method = "POST"): Promise<string | null> {
	const res = await fetch("/api/bedrock-provider", { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
	if (!res) return "Request failed. Check your connection.";
	if (res.ok) return null;
	const b = await res.json().catch(() => ({})) as { error?: string };
	return b.error ?? `Request failed (${res.status})`;
}

export function BedrockEditor({ status, onSaved, onCancel }: { status: BedrockStatus | null; onSaved: () => void | Promise<void>; onCancel: () => void }) {
	const regions = status?.regions ?? [];
	const region0 = status?.region ?? "";
	const configured = Boolean(region0);
	const [choice, setChoice] = useState(region0 && !regions.includes(region0) ? OTHER : region0);
	const [other, setOther] = useState(region0 && !regions.includes(region0) ? region0 : "");
	const [key, setKey] = useState("");
	const [busy, setBusy] = useState<null | "save" | "refresh" | "remove">(null);
	const [error, setError] = useState<string | null>(null);
	const envOwned = status?.keySource === "env";
	const region = choice === OTHER ? other.trim() : choice;
	const canSave = !busy && Boolean(region) && (Boolean(key.trim()) || Boolean(status?.keyPresent));

	async function run(kind: "save" | "refresh" | "remove", body: Record<string, unknown>, method = "POST") {
		setBusy(kind);
		setError(null);
		const err = await post(body, method);
		if (err) { setError(err); setBusy(null); return; }
		setKey("");
		await onSaved();
		setBusy(null);
	}

	return (
		<div data-testid="bedrock-editor" className="flex flex-col gap-2 rounded-sm px-1 py-1.5">
			<div className="flex flex-col gap-2 sm:flex-row sm:items-center">
				<span className="shrink-0 font-ui text-xs text-foreground">Amazon Bedrock</span>
				<div className="flex min-w-0 flex-1 gap-2">
					<select
						aria-label="Bedrock region"
						data-testid="bedrock-region"
						value={choice}
						disabled={Boolean(busy)}
						onChange={(e) => setChoice(e.target.value)}
						className="h-7 min-w-0 flex-1 rounded-sm border border-border bg-background px-1 font-mono text-xs text-foreground outline-none focus:border-muted-foreground/50"
					>
						<option value="" disabled>Region…</option>
						{regions.map((r) => <option key={r} value={r}>{r}</option>)}
						<option value={OTHER}>Other…</option>
					</select>
					{choice === OTHER && (
						<input
							type="text"
							value={other}
							onChange={(e) => setOther(e.target.value)}
							placeholder="e.g. eu-north-1"
							aria-label="Other Bedrock region"
							data-testid="bedrock-region-other"
							disabled={Boolean(busy)}
							className={`${inputClass} flex-1`}
						/>
					)}
				</div>
			</div>
			{envOwned ? (
				<p className="text-[11px] text-muted-foreground" data-testid="bedrock-env-owned">Environment supplies the key (AWS_BEARER_TOKEN_BEDROCK). Change it there.</p>
			) : (
				<input
					type="password"
					value={key}
					onChange={(e) => setKey(e.target.value)}
					onKeyDown={(e) => { if (e.key === "Enter" && canSave) void run("save", { region, ...(key.trim() ? { key } : {}) }); }}
					placeholder={status?.keyPresent ? "Saved key. Paste a new one to replace it" : "Bedrock API key"}
					aria-label="Bedrock API key"
					data-testid="bedrock-key-input"
					autoComplete="off"
					disabled={Boolean(busy)}
					autoFocus={!configured}
					className={inputClass}
				/>
			)}
			<div className="flex flex-wrap items-center gap-x-3 gap-y-1">
				<button type="button" data-testid="bedrock-save" disabled={!canSave} onClick={() => void run("save", { region, ...(key.trim() ? { key } : {}) })} className={`${actionClass} text-foreground`}>
					{busy === "save" ? "Checking models…" : "Save"}
				</button>
				{configured && (
					<button type="button" data-testid="bedrock-refresh" disabled={Boolean(busy) || !status?.keyPresent} onClick={() => void run("refresh", { region: region0 })} className={`${actionClass} text-foreground`}>
						{busy === "refresh" ? "Refreshing…" : "Refresh models"}
					</button>
				)}
				<button type="button" data-testid="bedrock-cancel" disabled={Boolean(busy)} onClick={onCancel} className={`${actionClass} text-muted-foreground/70 hover:text-foreground`}>Cancel</button>
				{configured && (
					<button type="button" data-testid="bedrock-remove" disabled={Boolean(busy)} onClick={() => void run("remove", {}, "DELETE")} className={`${actionClass} text-muted-foreground/70 hover:text-red-500`}>
						{busy === "remove" ? "Removing…" : "Remove"}
					</button>
				)}
				<a href={API_KEY_DOCS} target="_blank" rel="noreferrer" className="ml-auto text-[11px] text-muted-foreground/70 underline-offset-2 hover:text-foreground hover:underline">Get a Bedrock API key ↗</a>
			</div>
			{error && <p role="alert" data-testid="bedrock-error" className="text-xs text-red-500">{error}</p>}
			{configured && status && status.models.length > 0 && (
				<div className="flex flex-col gap-1" data-testid="bedrock-models">
					<p className="text-[11px] text-muted-foreground">{status.models.length} models available in {region0}</p>
					<ul className="flex max-h-56 flex-col gap-1 overflow-y-auto pr-1">
						{status.models.map((m) => (
							<li key={m.id} className="flex min-w-0 items-baseline gap-2" data-testid="bedrock-model-row">
								<span className="min-w-0 flex-1">
									<span className="block truncate text-xs text-foreground">{m.name}</span>
									<span className="block truncate font-mono text-[10px] text-muted-foreground" title={m.id}>{m.id}</span>
								</span>
								{!m.accessConfirmed && <span className="shrink-0 text-[10px] text-amber-600 dark:text-amber-400" data-testid="bedrock-access-unconfirmed">access not confirmed</span>}
							</li>
						))}
					</ul>
					{status.models.some((m) => !m.accessConfirmed) && (
						<p className="text-[11px] text-muted-foreground" data-testid="bedrock-access-help">AWS has not confirmed access to the marked models. If a call fails, request access in the Bedrock console.</p>
					)}
				</div>
			)}
		</div>
	);
}
