import type { ChatRecord } from "./contracts.ts";
import type { ChatStore } from "./ports.ts";

/** A pure function of one chat record, remembered by the store while the
 *  record file is unchanged (ChatStore.derive). Stores without derive (test
 *  fakes) compute it from a fresh getChat, which is the same answer. */
export function deriveChat<T>(
	store: Pick<ChatStore, "getChat" | "derive">,
	id: string,
	key: string,
	compute: (record: Readonly<ChatRecord>) => T,
): T | null {
	if (store.derive) return store.derive(id, key, compute);
	const record = store.getChat(id);
	return record ? compute(record) : null;
}
