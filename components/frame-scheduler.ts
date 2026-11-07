/**
 * One requestAnimationFrame slot that can be suspended. The graph renderer
 * schedules every frame through this: `request()` asks for the next frame
 * (deduplicated), `suspend()` cancels the pending one and holds every later
 * request, and `resume()` schedules a frame only if one was wanted while
 * suspended.
 *
 * The graph suspends while a navigation away from home is in flight, so its
 * draw loop and live physics stop competing with the destination's render
 * on the one JS thread. Nothing is dropped: a held request runs on resume.
 *
 * DOM-free (rAF is injected) so the scheduling contract is unit-tested.
 */

export type FrameApi = {
	request: (cb: () => void) => number;
	cancel: (id: number) => void;
};

export class FrameScheduler {
	private id: number | null = null;
	private held = false; // a request arrived (or was cancelled) while suspended
	private suspendedFlag = false;

	constructor(
		private readonly run: () => void,
		private readonly api: FrameApi = {
			request: (cb) => requestAnimationFrame(cb),
			cancel: (id) => cancelAnimationFrame(id),
		},
	) {}

	get suspended(): boolean {
		return this.suspendedFlag;
	}

	get pending(): boolean {
		return this.id !== null;
	}

	request(): void {
		if (this.suspendedFlag) {
			this.held = true;
			return;
		}
		if (this.id !== null) return;
		this.id = this.api.request(() => {
			this.id = null;
			this.run();
		});
	}

	suspend(): void {
		if (this.suspendedFlag) return;
		this.suspendedFlag = true;
		if (this.id !== null) {
			this.api.cancel(this.id);
			this.id = null;
			this.held = true;
		}
	}

	resume(): void {
		if (!this.suspendedFlag) return;
		this.suspendedFlag = false;
		if (this.held) {
			this.held = false;
			this.request();
		}
	}

	/** Teardown: cancel the pending frame and drop anything held. */
	cancel(): void {
		if (this.id !== null) this.api.cancel(this.id);
		this.id = null;
		this.held = false;
	}
}
