const key = (chatId: string) => `lh:composer-draft:${chatId}`;

export function readComposerDraft(storage: Pick<Storage, "getItem">, chatId: string): string {
	try { return storage.getItem(key(chatId)) ?? ""; }
	catch { return ""; }
}

export function writeComposerDraft(storage: Pick<Storage, "setItem" | "removeItem">, chatId: string, value: string): void {
	try {
		if (value) storage.setItem(key(chatId), value);
		else storage.removeItem(key(chatId));
	} catch { /* unavailable storage must not block composing or sending */ }
}
