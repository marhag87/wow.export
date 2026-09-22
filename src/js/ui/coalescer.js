/*!
	wow.export (https://github.com/Kruithne/wow.export)
	License: MIT
 */

/**
 * Runs an expensive async task no more often than it is worth running.
 *
 * Several pieces of watched state usually move for one user action, and a watcher
 * per piece means the same expensive task is started several times over, in
 * parallel, for one change. This collapses that: requests made close together
 * share a run, and requests made while a run is in progress cause exactly one more
 * run afterwards, however many arrive, since only the final state needs drawing.
 *
 * Every request gets a promise that resolves when a run covering it has finished,
 * so a caller that needs the result (an export, say) can wait for it.
 */
class Coalescer {
	/**
	 * @param {function} task - called with the most recent request's payload
	 * @param {number} [delay_ms] - window in which requests share a run
	 */
	constructor(task, delay_ms = 30) {
		this.task = task;
		this.delay_ms = delay_ms;

		this.timer = null;
		this.running = null;
		this.repeat = false;
		this.waiters = [];
		this.payload = undefined;
	}

	get is_running() {
		return this.running !== null;
	}

	/**
	 * @param {*} [payload] - passed to the task; the most recent one wins
	 * @param {boolean} [immediate] - skip the delay, for a caller about to act on the result
	 * @returns {Promise} resolves once a run covering this request has finished
	 */
	request(payload, immediate = false) {
		this.payload = payload;

		return new Promise((resolve, reject) => {
			this.waiters.push({ resolve, reject });

			if (this.timer !== null)
				clearTimeout(this.timer);

			this.timer = setTimeout(() => {
				this.timer = null;
				this._run();
			}, immediate ? 0 : this.delay_ms);
		});
	}

	/**
	 * Drop a scheduled run. Anything waiting is resolved rather than left hanging,
	 * since the state it was waiting to see is being discarded.
	 */
	cancel() {
		if (this.timer !== null) {
			clearTimeout(this.timer);
			this.timer = null;
		}

		this.repeat = false;

		const waiters = this.waiters;
		this.waiters = [];
		for (const waiter of waiters)
			waiter.resolve();
	}

	async _run() {
		// already running: the state has moved on, so queue a single follow-up run.
		// waiters stay queued and are settled by that run.
		if (this.running !== null) {
			this.repeat = true;
			return;
		}

		const waiters = this.waiters;
		this.waiters = [];

		this.running = (async () => {
			try {
				await this.task(this.payload);
				for (const waiter of waiters)
					waiter.resolve();
			} catch (e) {
				for (const waiter of waiters)
					waiter.reject(e);
			}
		})();

		await this.running;
		this.running = null;

		if (this.repeat) {
			this.repeat = false;
			this._run();
		}
	}
}

module.exports = { Coalescer };
