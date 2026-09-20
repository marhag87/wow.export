/*!
	wow.export (https://github.com/Kruithne/wow.export)
	License: MIT
 */

const log = require('../log');
const screencap = require('../screencap');
const { decode_frame, TOTAL_BLOCKS } = require('./strip-decoder');

// pixels kept around the strip when capturing just its region, so a small shift
// (a window moving, the game's UI scale changing) is still caught
const REGION_MARGIN = 32;

// consecutive failed reads of the tracked region before searching the screen again
const MISSES_BEFORE_RESCAN = 3;

/**
 * Reads the WoWExportLiveSync addon's pixel strip off the screen.
 *
 * Capture is a native GDI grab (see src/js/screencap.js), since the app's page has
 * no access to Chromium's capture APIs. The whole screen is searched once to find
 * the strip, then only its own region is grabbed, which keeps each check to about a
 * millisecond however often it runs.
 *
 * Only payloads whose CRC passes are reported, so a frame where the game is covered,
 * minimised or mid-redraw is skipped rather than producing nonsense.
 */
class LiveSync {
	constructor() {
		this.timer = null;
		this.region = null;
		this.hint = undefined;
		this.misses = 0;
		this.last_counter = null;
	}

	get is_running() {
		return this.timer !== null;
	}

	/**
	 * Start sampling the screen.
	 * @param {number} interval_ms
	 * @param {function} on_payload - called with { counter, items } when the CRC passes
	 * @param {function} on_status - called with a human-readable status string
	 */
	start(interval_ms, on_payload, on_status) {
		if (this.is_running)
			return;

		const error = screencap.getError();
		if (error !== null)
			throw new Error(error);

		this.region = null;
		this.hint = undefined;
		this.misses = 0;
		this.last_counter = null;
		this.logged_screen = false;

		this.timer = setInterval(() => {
			try {
				this._sample(on_payload, on_status);
			} catch (e) {
				log.write('live sync capture failed: %s', e.message);
				on_status('capture failed: ' + e.message);
			}
		}, interval_ms);

		log.write('Live sync capture started');
		on_status('looking for the addon strip...');
	}

	/**
	 * Apply the next frame even if the game has not changed anything, for when the
	 * app's own settings change what a payload means.
	 */
	resync() {
		this.last_counter = null;
	}

	stop() {
		if (this.timer !== null) {
			clearInterval(this.timer);
			this.timer = null;
		}

		this.region = null;
		this.hint = undefined;
		this.last_counter = null;
	}

	_sample(on_payload, on_status) {
		// tracked region first, then the whole screen when it stops working
		if (this.region !== null) {
			const payload = this._read(this.region);
			if (payload) {
				this.misses = 0;
				this._report(payload, on_payload);
				return;
			}

			if (++this.misses < MISSES_BEFORE_RESCAN) {
				on_status('strip not visible');
				return;
			}

			this.region = null;
			this.hint = undefined;
		}

		const screen = screencap.virtualScreen();
		if (!this.logged_screen) {
			// a capture that is not DPI aware arrives scaled down, which shrinks the
			// strip; worth knowing if the strip ever stops being found
			log.write('Live sync searching %dx%d at %d,%d (dpi aware: %s)', screen.width, screen.height, screen.x, screen.y, screen.dpiAware !== false);
			this.logged_screen = true;
		}

		const payload = this._read(screen);
		if (!payload) {
			this.misses = 0;
			on_status('strip not visible');
			return;
		}

		// narrow to the strip's own region for subsequent reads
		const strip = payload.strip;
		const width = Math.ceil((strip.pitch * TOTAL_BLOCKS) + REGION_MARGIN * 2);
		const height = Math.ceil(strip.pitch + REGION_MARGIN * 2);

		this.region = {
			x: Math.max(screen.x, screen.x + strip.x - REGION_MARGIN),
			y: Math.max(screen.y, screen.y + strip.y - REGION_MARGIN),
			width: Math.min(width, screen.width),
			height: Math.min(height, screen.height)
		};

		this.misses = 0;
		this.hint = undefined;
		log.write('Live sync found the strip at %d,%d (pitch %s)', screen.x + strip.x, screen.y + strip.y, strip.pitch.toFixed(3));
		this._report(payload, on_payload);
	}

	/**
	 * Grab a region and decode it.
	 * @returns {object|null}
	 */
	_read(region) {
		const frame = screencap.capture(region.x, region.y, region.width, region.height);
		const payload = decode_frame(frame.data, frame.width, frame.height, this.hint);

		if (payload)
			this.hint = payload.strip;

		return payload;
	}

	_report(payload, on_payload) {
		if (payload.counter === this.last_counter)
			return;

		this.last_counter = payload.counter;
		on_payload(payload);
	}
}

module.exports = { LiveSync };
