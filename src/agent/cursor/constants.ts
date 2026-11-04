export { CURSOR_PROVIDER } from "../../core/contracts/cursor.ts";

export const CURSOR_API = "cursor-cli";

export enum CursorError {
	CliNotFound = "cursor-agent CLI not found",
	NotSignedIn = "Cursor is not signed in. Run `cursor-agent login` on the server, then try again.",
}
