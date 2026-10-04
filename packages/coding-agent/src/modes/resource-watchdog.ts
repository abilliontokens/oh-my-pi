import { performance } from "node:perf_hooks";
import { formatBytes, logger } from "@oh-my-pi/pi-utils";

/** Thresholds read fresh on every sample, so live setting changes apply without re-arming. */
export interface ResourceWatchdogConfig {
	enabled: boolean;
	/** Resident memory (MB) at or above which a warning is raised. `0` disables the memory check. */
	memoryMb: number;
	/** Sustained process CPU (% of one core) while idle at or above which a warning is raised. `0` disables the CPU check. */
	idleCpuPercent: number;
}

export interface ResourceWatchdogOptions {
	getConfig: () => ResourceWatchdogConfig;
	/** True when no turn, tool, compaction, or background job is running, so any CPU burn is unexplained. */
	isIdle: () => boolean;
	/** Surface a warning to the user. */
	notify: (message: string) => void;
	/** Sampling period in ms. Default 60_000. */
	intervalMs?: number;
	/** Consecutive idle samples over the CPU threshold before warning. Default 3. */
	idleSamples?: number;
	/** Resident set size in bytes; injectable for tests. Default `process.memoryUsage().rss`. */
	memoryNow?: () => number;
	/** Process CPU time in ms; injectable for tests. Default `process.cpuUsage()`. */
	cpuNow?: () => number;
	/** Monotonic clock in ms; injectable for tests. Default `performance.now`. */
	now?: () => number;
	/** Timer source; injectable for tests. Default `setTimeout`. */
	schedule?: (cb: () => void, ms: number) => ResourceWatchdogTimer;
}

interface ResourceWatchdogTimer {
	unref?(): void;
	cancel?(): void;
}

const MB = 1024 * 1024;
/** Memory must fall below this fraction of the threshold before another memory warning can fire. */
const MEMORY_REARM_RATIO = 0.9;

/**
 * Catches a session that has run away with the machine's resources — the
 * failure mode where an omp process sits idle for hours while holding many GB
 * of memory or spinning a CPU core with nothing to show for it.
 *
 * Every `intervalMs` it samples resident memory and the process CPU spent
 * since the previous sample:
 * - **Memory** is checked in every state. Crossing `memoryMb` warns once; the
 *   check re-arms only after memory drops below 90% of the threshold.
 * - **CPU** is checked only for intervals with no session activity at all:
 *   idle when the interval began, idle at the sample, and no
 *   {@link ResourceWatchdog.noteActivity} call in between. A turn that ran
 *   inside the interval (its CPU still lands there) never reads as idle burn.
 *   `idleSamples` consecutive such intervals at or above `idleCpuPercent` warn
 *   once per idle episode; any active or calm sample ends the episode.
 *
 * Both warnings are also logged (`resource.memory-high`, `resource.idle-cpu`)
 * so a later look at the log explains a slow machine. The timer is `unref`'d
 * so the watchdog never keeps the process alive.
 */
export class ResourceWatchdog {
	readonly #getConfig: () => ResourceWatchdogConfig;
	readonly #isIdle: () => boolean;
	readonly #notify: (message: string) => void;
	readonly #intervalMs: number;
	readonly #idleSamples: number;
	readonly #memoryNow: () => number;
	readonly #cpuNow: () => number;
	readonly #now: () => number;
	readonly #schedule: (cb: () => void, ms: number) => ResourceWatchdogTimer;
	#running = false;
	#generation = 0;
	#handle: ResourceWatchdogTimer | undefined;
	#lastAt = 0;
	#lastCpu = 0;
	#memoryWarned = false;
	#hotIdleSamples = 0;
	/** Whether the session was idle at the previous sample, i.e. at the start of the current interval. */
	#wasIdle = false;
	/** Set by {@link noteActivity}; cleared at each sample. */
	#activitySinceSample = false;
	#idleCpuWarned = false;

	constructor(options: ResourceWatchdogOptions) {
		this.#getConfig = options.getConfig;
		this.#isIdle = options.isIdle;
		this.#notify = options.notify;
		this.#intervalMs = options.intervalMs ?? 60_000;
		this.#idleSamples = Math.max(1, options.idleSamples ?? 3);
		this.#memoryNow = options.memoryNow ?? (() => process.memoryUsage().rss);
		this.#cpuNow =
			options.cpuNow ??
			(() => {
				const usage = process.cpuUsage();
				return (usage.user + usage.system) / 1000;
			});
		this.#now = options.now ?? (() => performance.now());
		this.#schedule =
			options.schedule ??
			((cb, ms) => {
				const timer = setTimeout(cb, ms);
				return { unref: () => timer.unref?.(), cancel: () => clearTimeout(timer) };
			});
	}

	start(): void {
		if (this.#running) return;
		this.#running = true;
		this.#resetEpisode();
		this.#wasIdle = this.#isIdle();
		this.#activitySinceSample = false;
		this.#memoryWarned = false;
		this.#lastAt = this.#now();
		this.#lastCpu = this.#cpuNow();
		this.#arm();
	}

	/**
	 * Record session activity (a turn, tool, or job event). The interval it
	 * lands in is not counted as idle, even if the session is idle again by the
	 * time the sample runs.
	 */
	noteActivity(): void {
		this.#activitySinceSample = true;
	}

	stop(): void {
		this.#running = false;
		this.#generation++;
		this.#handle?.cancel?.();
		this.#handle = undefined;
	}

	#arm(): void {
		const generation = this.#generation;
		this.#handle = this.#schedule(() => this.#tick(generation), this.#intervalMs);
		this.#handle.unref?.();
	}

	#resetEpisode(): void {
		this.#hotIdleSamples = 0;
		this.#idleCpuWarned = false;
	}

	#tick(generation: number): void {
		if (!this.#running || generation !== this.#generation) return;
		const now = this.#now();
		const cpu = this.#cpuNow();
		const elapsedMs = now - this.#lastAt;
		const cpuMs = cpu - this.#lastCpu;
		this.#lastAt = now;
		this.#lastCpu = cpu;
		try {
			this.#sample(elapsedMs, cpuMs);
		} catch (error) {
			logger.debug("resource watchdog sample failed", { error: String(error) });
		}
		this.#arm();
	}

	#sample(elapsedMs: number, cpuMs: number): void {
		const idleNow = this.#isIdle();
		const idleThroughout = this.#wasIdle && idleNow && !this.#activitySinceSample;
		this.#wasIdle = idleNow;
		this.#activitySinceSample = false;
		const config = this.#getConfig();
		if (!config.enabled) {
			this.#memoryWarned = false;
			this.#resetEpisode();
			return;
		}

		if (config.memoryMb > 0) {
			const rss = this.#memoryNow();
			const thresholdBytes = config.memoryMb * MB;
			if (rss >= thresholdBytes) {
				if (!this.#memoryWarned) {
					this.#memoryWarned = true;
					logger.warn("resource.memory-high", { rssMb: Math.round(rss / MB), thresholdMb: config.memoryMb });
					this.#notify(
						`omp is using ${formatBytes(rss)} of memory (warning threshold ${formatBytes(thresholdBytes)}). ` +
							"Long sessions keep their history in memory; start a /new session or restart omp to free it.",
					);
				}
			} else if (rss < thresholdBytes * MEMORY_REARM_RATIO) {
				this.#memoryWarned = false;
			}
		} else {
			this.#memoryWarned = false;
		}

		if (config.idleCpuPercent <= 0 || elapsedMs <= 0 || !idleThroughout) {
			this.#resetEpisode();
			return;
		}
		const cpuPercent = (cpuMs / elapsedMs) * 100;
		if (cpuPercent < config.idleCpuPercent) {
			this.#resetEpisode();
			return;
		}
		this.#hotIdleSamples++;
		if (this.#hotIdleSamples < this.#idleSamples || this.#idleCpuWarned) return;
		this.#idleCpuWarned = true;
		const idleMinutes = Math.max(1, Math.round((this.#hotIdleSamples * this.#intervalMs) / 60_000));
		logger.warn("resource.idle-cpu", {
			cpuPercent: Math.round(cpuPercent),
			thresholdPercent: config.idleCpuPercent,
			idleSamples: this.#hotIdleSamples,
		});
		this.#notify(
			`omp has used ${Math.round(cpuPercent)}% CPU for ${idleMinutes} min while idle — something in this session may be stuck. ` +
				"Check /jobs, or restart omp if it stays high.",
		);
	}
}
