interface BlockState {
	trace: string;
	tokens: number;
	startedAt: number;
	lastRequestedAt?: number;
	lastRequestedTokens: number;
	settled: boolean;
	finalRequested: boolean;
	appliedSequence: number;
}

interface SchedulerOptions {
	summarize(trace: string, signal: AbortSignal): Promise<string>;
	onHeadline(key: string, headline: string | undefined): void;
	onFailure(reason: "error" | "timeout" | "length", message?: string): void;
	now?: () => number;
	timeoutMs?: number;
}

const TOKEN_INTERVAL = 400;
const TIME_INTERVAL_MS = 6_000;
const TRACE_CHARS = 1_500;

export class HeadlineLengthError extends Error {}

/** Requests short display headlines without holding up thinking events or rendering. */
export class HeadlineScheduler {
	private blocks = new Map<string, BlockState>();
	private now: () => number;
	private timeoutMs: number;
	private sequence = 0;
	private inFlight = false;
	private abort?: AbortController;
	private timer?: ReturnType<typeof setTimeout>;
	private disposed = false;
	private announcedFailure = false;
	private options: SchedulerOptions;

	constructor(options: SchedulerOptions) {
		this.options = options;
		this.now = options.now ?? Date.now;
		this.timeoutMs = options.timeoutMs ?? 8_000;
	}

	observe(key: string, trace: string): void {
		if (this.disposed || !trace) return;
		const previous = this.blocks.get(key);
		if (previous?.settled) return;
		const tokens = Math.ceil(trace.length / 4);
		if (previous) {
			previous.trace = trace;
			previous.tokens = tokens;
		} else {
			this.blocks.set(key, { trace, tokens, startedAt: this.now(), lastRequestedTokens: 0, settled: false, finalRequested: false, appliedSequence: 0 });
		}
		this.tick();
	}

	settle(key: string): void {
		const block = this.blocks.get(key);
		if (!block || block.settled || this.disposed) return;
		block.settled = true;
		this.tick();
	}

	tick(): void {
		if (this.disposed || this.inFlight) return;
		const at = this.now();
		for (const [key, block] of this.blocks) {
			if (block.settled ? !block.finalRequested :
				block.tokens - block.lastRequestedTokens >= TOKEN_INTERVAL || at - (block.lastRequestedAt ?? block.startedAt) >= TIME_INTERVAL_MS) {
				this.request(key, block, at);
				return;
			}
		}
	}

	private request(key: string, block: BlockState, at: number): void {
		this.inFlight = true;
		block.lastRequestedAt = at;
		block.lastRequestedTokens = block.tokens;
		if (block.settled) block.finalRequested = true;
		const sequence = ++this.sequence;
		const controller = new AbortController();
		this.abort = controller;
		const trace = block.trace.slice(-TRACE_CHARS);
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<never>((_resolve, reject) => {
			timer = setTimeout(() => { controller.abort(); reject(new Error("headline timeout")); }, this.timeoutMs);
			this.timer = timer;
		});
		const call = Promise.resolve().then(() => this.options.summarize(trace, controller.signal));
		void Promise.race([call, timeout]).then((text) => {
			if (this.disposed || sequence < block.appliedSequence) return;
			const words = text.trim().split(/\s+/).filter(Boolean).slice(0, 10);
			if (!words.length) throw new Error("empty headline");
			block.appliedSequence = sequence;
			this.options.onHeadline(key, `≈ ${words.join(" ")}`);
		}).catch((error) => {
			if (this.disposed || sequence < block.appliedSequence) return;
			block.appliedSequence = sequence;
			this.options.onHeadline(key, undefined);
			if (!this.announcedFailure) {
				this.announcedFailure = true;
				this.options.onFailure(
					error instanceof HeadlineLengthError ? "length" : controller.signal.aborted && error instanceof Error && error.message === "headline timeout" ? "timeout" : "error",
					error instanceof Error ? error.message : String(error),
				);
			}
		}).finally(() => {
			if (timer) clearTimeout(timer);
			if (this.timer === timer) this.timer = undefined;
			if (this.abort === controller) this.abort = undefined;
			this.inFlight = false;
			if (block.settled && block.finalRequested) this.blocks.delete(key);
			this.tick();
		});
	}

	dispose(): void {
		this.disposed = true;
		this.abort?.abort();
		if (this.timer) clearTimeout(this.timer);
		this.blocks.clear();
	}
}
