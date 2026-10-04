import { afterEach, describe, expect, test, vi } from "bun:test";
import { ResourceWatchdog, type ResourceWatchdogConfig } from "@oh-my-pi/pi-coding-agent/modes/resource-watchdog";
import { logger } from "@oh-my-pi/pi-utils";

/**
 * Contract: the resource watchdog warns the user when an omp process holds
 * more memory than the configured threshold, or keeps burning CPU for several
 * consecutive samples while nothing is running (the stuck-idle-session failure
 * mode). Each condition warns once per episode, busy CPU never warns, and the
 * settings switch everything off.
 *
 * Time, memory, CPU, and the timer are injected; `sample()` advances one
 * interval and fires the armed tick by hand.
 */
const INTERVAL_MS = 60_000;
const MB = 1024 * 1024;

function harness(initial: Partial<ResourceWatchdogConfig> = {}) {
	const config: ResourceWatchdogConfig = { enabled: true, memoryMb: 8192, idleCpuPercent: 40, ...initial };
	let now = 0;
	let cpuMs = 0;
	let rss = 500 * MB;
	let idle = true;
	let scheduled: (() => void) | undefined;
	const warnings: string[] = [];
	const wd = new ResourceWatchdog({
		getConfig: () => config,
		isIdle: () => idle,
		notify: message => warnings.push(message),
		intervalMs: INTERVAL_MS,
		idleSamples: 3,
		memoryNow: () => rss,
		cpuNow: () => cpuMs,
		now: () => now,
		schedule: cb => {
			scheduled = cb;
			return {};
		},
	});
	return {
		wd,
		config,
		warnings,
		setRssMb(mb: number): void {
			rss = mb * MB;
		},
		setIdle(value: boolean): void {
			idle = value;
		},
		/** Advance one interval during which the process used `cpuPercent` of a core, then fire the tick. */
		sample(cpuPercent: number): void {
			now += INTERVAL_MS;
			cpuMs += (INTERVAL_MS * cpuPercent) / 100;
			const cb = scheduled;
			if (!cb) throw new Error("no tick was scheduled");
			cb();
		},
	};
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("ResourceWatchdog", () => {
	test("warns once when an idle session keeps spinning a CPU core", () => {
		vi.spyOn(logger, "warn").mockImplementation(() => {});
		const h = harness();
		h.wd.start();

		h.sample(55);
		h.sample(55);
		expect(h.warnings).toEqual([]);
		h.sample(55);
		expect(h.warnings).toHaveLength(1);
		expect(h.warnings[0]).toContain("55% CPU");
		expect(h.warnings[0]).toContain("while idle");

		// Still spinning: the same episode never repeats the warning.
		h.sample(55);
		h.sample(55);
		expect(h.warnings).toHaveLength(1);
	});

	test("never warns about CPU while the session is busy", () => {
		const h = harness();
		h.setIdle(false);
		h.wd.start();
		for (let i = 0; i < 6; i++) h.sample(100);
		expect(h.warnings).toEqual([]);
	});

	test("a busy or calm sample ends the idle-CPU episode and requires a fresh run", () => {
		vi.spyOn(logger, "warn").mockImplementation(() => {});
		const h = harness();
		h.wd.start();

		h.sample(55);
		h.sample(55);
		h.setIdle(false);
		h.sample(55); // busy: resets the streak
		h.setIdle(true);
		h.sample(55); // busy→idle interval: carries the finished turn's CPU, not counted
		h.sample(55);
		h.sample(55);
		expect(h.warnings).toEqual([]);
		h.sample(55); // third consecutive interval idle at both ends
		expect(h.warnings).toHaveLength(1);

		h.sample(5); // calm: the episode ends
		h.sample(55);
		h.sample(55);
		h.sample(55);
		expect(h.warnings).toHaveLength(2);
	});

	test("CPU from turns that end just before each sample never reads as idle burn", () => {
		// Back-to-back turns that each start and finish inside one interval leave
		// the session idle at every sample, yet each interval's CPU belongs to work.
		const h = harness();
		h.wd.start();
		for (let i = 0; i < 5; i++) {
			h.wd.noteActivity(); // a turn ran during this interval and finished before the sample
			h.sample(90);
		}
		expect(h.warnings).toEqual([]);
	});

	test("warns once on high memory and re-arms only after memory drops below 90% of the threshold", () => {
		vi.spyOn(logger, "warn").mockImplementation(() => {});
		const h = harness({ memoryMb: 1000 });
		h.wd.start();

		h.setRssMb(1200);
		h.sample(0);
		expect(h.warnings).toHaveLength(1);
		expect(h.warnings[0]).toContain("memory");

		h.sample(0);
		h.setRssMb(950); // below threshold but above the 900 MB re-arm line
		h.sample(0);
		h.setRssMb(1100);
		h.sample(0);
		expect(h.warnings).toHaveLength(1);

		h.setRssMb(800); // below 90%: re-armed
		h.sample(0);
		h.setRssMb(1100);
		h.sample(0);
		expect(h.warnings).toHaveLength(2);
	});

	test("memory is checked even while the session is busy", () => {
		vi.spyOn(logger, "warn").mockImplementation(() => {});
		const h = harness({ memoryMb: 1000 });
		h.setIdle(false);
		h.wd.start();
		h.setRssMb(2000);
		h.sample(100);
		expect(h.warnings).toHaveLength(1);
	});

	test("disabled settings and zero thresholds suppress each check", () => {
		const h = harness({ enabled: false, memoryMb: 1000 });
		h.wd.start();
		h.setRssMb(5000);
		for (let i = 0; i < 4; i++) h.sample(90);
		expect(h.warnings).toEqual([]);

		h.config.enabled = true;
		h.config.memoryMb = 0;
		h.config.idleCpuPercent = 0;
		for (let i = 0; i < 4; i++) h.sample(90);
		expect(h.warnings).toEqual([]);
	});

	test("logs a structured event alongside each warning", () => {
		const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const h = harness({ memoryMb: 1000 });
		h.wd.start();
		h.setRssMb(1500);
		h.sample(60);
		h.sample(60);
		h.sample(60);

		const events = warnSpy.mock.calls.map(call => call[0]);
		expect(events).toEqual(["resource.memory-high", "resource.idle-cpu"]);
	});

	test("a stopped watchdog ignores a tick that was already armed", () => {
		const h = harness({ memoryMb: 1000 });
		h.wd.start();
		h.setRssMb(5000);
		h.wd.stop();
		h.sample(90);
		expect(h.warnings).toEqual([]);
	});
});
