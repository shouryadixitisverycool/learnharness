"use client";
/**
 * Azure OpenAI in Settings → Keys: a status row once configured and an
 * editor (endpoint URL, API key, Save / Refresh models / Cancel / Remove,
 * discovered deployment list). API: /api/azure-provider.
 * No key characters ever come back from the server.
 */

import { useState } from "react";

const API_KEY_DOCS = "https://learn.microsoft.com/azure/ai-foundry/openai/api-version-lifecycle";

/** GET /api/azure-provider. */
export interface AzureStatus {
	endpoint: string;
	models: { id: string; name: string; model?: string }[];
	keyPresent: boolean;
	keySource: "env" | "file" | "none";
}

export async function readAzureStatus(): Promise<AzureStatus> {
	const response = await fetch("/api/azure-provider");
	if (!response.ok) throw new Error("Unable to load the Azure configuration.");
	const b = await response.json() as Partial<AzureStatus>;
	return { endpoint: b.endpoint ?? "", models: b.models ?? [], keyPresent: Boolean(b.keyPresent), keySource: b.keySource ?? "none" };
}

/** The endpoint's host, or the whole string when it does not parse. Pure. */
function endpointHost(endpoint: string): string {
	try { return new URL(endpoint).host; } catch { return endpoint; }
}

/** "x.openai.azure.com · 8 models" (" · key missing" when the key is gone). Pure. */
export function azureStatusLine(status: AzureStatus): string {
	const count = status.models.length;
	return `${endpointHost(status.endpoint)} · ${count} model${count === 1 ? "" : "s"}${status.keyPresent ? status.keySource === "env" ? " · env key" : "" : " · key missing"}`;
}

const inputClass = "h-7 min-w-0 rounded-sm border border-border bg-background px-1.5 font-mono text-xs text-foreground outline-none placeholder:text-muted-foreground/60 focus:border-muted-foreground/50";
const actionClass = "shrink-0 text-xs underline-offset-2 hover:underline disabled:text-muted-foreground/40 disabled:no-underline";

export function AzureRow({ status, expanded, onToggle }: { status: AzureStatus; expanded: boolean; onToggle: () => void }) {
	return (
		<div data-testid="azure-row">
			<button
				type="button"
				data-testid="azure-row-btn"
				aria-expanded={expanded}
				onClick={onToggle}
				className="flex w-full cursor-pointer items-center justify-between gap-3 rounded-sm px-1 py-1.5 text-left transition-colors hover:bg-accent/50"
			>
				<span className="shrink-0 font-ui text-xs text-foreground">Azure OpenAI</span>
				<span data-testid="azure-status" className="min-w-0 truncate font-mono text-[11px] text-muted-foreground">{azureStatusLine(status)}</span>
			</button>
		</div>
	);
}

async function post(body: Record<string, unknown>, method = "POST"): Promise<string | null> {
	const res = await fetch("/api/azure-provider", { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
	if (!res) return "Request failed. Check your connection.";
	if (res.ok) return null;
	const b = await res.json().catch(() => ({})) as { error?: string };
	return b.error ?? `Request failed (${res.status})`;
}

export function AzureEditor({ status, onSaved, onCancel }: { status: AzureStatus | null; onSaved: () => void | Promise<void>; onCancel: () => void }) {
	const endpoint0 = status?.endpoint ?? "";
	const configured = Boolean(endpoint0);
	const [endpoint, setEndpoint] = useState(endpoint0);
	const [key, setKey] = useState("");
	const [busy, setBusy] = useState<null | "save" | "refresh" | "remove">(null);
	const [error, setError] = useState<string | null>(null);
	const envOwned = status?.keySource === "env";
	const canSave = !busy && Boolean(endpoint.trim()) && (Boolean(key.trim()) || Boolean(status?.keyPresent));
	const saveBody = () => ({ endpoint: endpoint.trim(), ...(key.trim() ? { key } : {}) });

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
		<div data-testid="azure-editor" className="flex flex-col gap-2 rounded-sm px-1 py-1.5">
			<div className="flex flex-col gap-2 sm:flex-row sm:items-center">
				<span className="shrink-0 font-ui text-xs text-foreground">Azure OpenAI</span>
				<input
					type="url"
					value={endpoint}
					onChange={(e) => setEndpoint(e.target.value)}
					placeholder="https://<resource>.openai.azure.com/openai/v1"
					aria-label="Azure endpoint"
					data-testid="azure-endpoint"
					autoComplete="off"
					disabled={Boolean(busy)}
					autoFocus={!configured}
					className={`${inputClass} flex-1`}
				/>
			</div>
			{envOwned ? (
				<p className="text-[11px] text-muted-foreground" data-testid="azure-env-owned">Environment supplies the key (AZURE_OPENAI_API_KEY). Change it there.</p>
			) : (
				<input
					type="password"
					value={key}
					onChange={(e) => setKey(e.target.value)}
					onKeyDown={(e) => { if (e.key === "Enter" && canSave) void run("save", saveBody()); }}
					placeholder={status?.keyPresent ? "Saved key. Paste a new one to replace it" : "Azure API key"}
					aria-label="Azure API key"
					data-testid="azure-key-input"
					autoComplete="off"
					disabled={Boolean(busy)}
					className={inputClass}
				/>
			)}
			<div className="flex flex-wrap items-center gap-x-3 gap-y-1">
				<button type="button" data-testid="azure-save" disabled={!canSave} onClick={() => void run("save", saveBody())} className={`${actionClass} text-foreground`}>
					{busy === "save" ? "Checking deployments…" : "Save"}
				</button>
				{configured && (
					<button type="button" data-testid="azure-refresh" disabled={Boolean(busy) || !status?.keyPresent} onClick={() => void run("refresh", { endpoint: endpoint0 })} className={`${actionClass} text-foreground`}>
						{busy === "refresh" ? "Refreshing…" : "Refresh models"}
					</button>
				)}
				<button type="button" data-testid="azure-cancel" disabled={Boolean(busy)} onClick={onCancel} className={`${actionClass} text-muted-foreground/70 hover:text-foreground`}>Cancel</button>
				{configured && (
					<button type="button" data-testid="azure-remove" disabled={Boolean(busy)} onClick={() => void run("remove", {}, "DELETE")} className={`${actionClass} text-muted-foreground/70 hover:text-red-500`}>
						{busy === "remove" ? "Removing…" : "Remove"}
					</button>
				)}
				<a href={API_KEY_DOCS} target="_blank" rel="noreferrer" className="ml-auto text-[11px] text-muted-foreground/70 underline-offset-2 hover:text-foreground hover:underline">Azure endpoint and keys ↗</a>
			</div>
			{error && <p role="alert" data-testid="azure-error" className="text-xs text-red-500">{error}</p>}
			{configured && status && status.models.length > 0 && (
				<div className="flex flex-col gap-1" data-testid="azure-models">
					<p className="text-[11px] text-muted-foreground">{status.models.length} deployments on {endpointHost(endpoint0)}</p>
					<ul className="flex max-h-56 flex-col gap-1 overflow-y-auto pr-1">
						{status.models.map((m) => (
							<li key={m.id} className="flex min-w-0 items-baseline gap-2" data-testid="azure-model-row">
								<span className="min-w-0 flex-1">
									<span className="block truncate text-xs text-foreground">{m.name}</span>
									<span className="block truncate font-mono text-[10px] text-muted-foreground" title={m.id}>{m.model && m.model !== m.id ? `${m.id} · ${m.model}` : m.id}</span>
								</span>
							</li>
						))}
					</ul>
				</div>
			)}
		</div>
	);
}
