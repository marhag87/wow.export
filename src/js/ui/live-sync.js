/*!
	wow.export (https://github.com/Kruithne/wow.export)
	License: MIT
 */

const util = require('util');
const log = require('../log');
const screencap = require('../screencap');
const { decode_frame, decode_frame_all, TOTAL_BLOCKS } = require('./strip-decoder');

// pixels kept around the strip when capturing just its region, so a small shift
// (a window moving, the game's UI scale changing) is still caught
const REGION_MARGIN = 32;

// consecutive failed reads of the tracked region before searching the screen again
const MISSES_BEFORE_RESCAN = 3;

/**
 * Whether a name read off the strip is the given character. Names compare without
 * case, and normalised so an accented letter matches however it was typed. A strip
 * without a name (the addon could not fit it) matches nothing.
 * @param {string} name
 * @param {string|null} strip_name
 * @returns {boolean}
 */
function is_same_character(name, strip_name) {
	if (!strip_name)
		return false;

	const normalise = name => name.normalize('NFC').toLocaleLowerCase();
	return normalise(name) === normalise(strip_name);
}

/**
 * "Hoom", "Hoom and Bernam", "Hoom, Bernam and Keegan".
 * @param {string[]} names
 * @returns {string}
 */
function list_names(names) {
	if (names.length < 2)
		return names.join('');

	return names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1];
}

/**
 * Reads the WoWExportLiveSync addon's pixel strip off the screen.
 *
 * Capture is a native GDI grab (see src/js/screencap.js), since the app's page has
 * no access to Chromium's capture APIs. The whole screen is searched once to find
 * the strip, then only its own region is grabbed, which keeps each check to about a
 * millisecond however often it runs.
 *
 * More than one game window can be on screen, each drawing its own strip. The
 * search reads all of them and follows the one playing the wanted character, so
 * the other window never dresses the loaded model.
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
		this.last_name = null;
		this.last_waiting = null;
		this.wanted = () => null;
	}

	get is_running() {
		return this.timer !== null;
	}

	/**
	 * Start sampling the screen.
	 * @param {number} interval_ms
	 * @param {function} on_payload - called with { counter, name, items, customizations } when the CRC passes
	 * @param {function} on_status - called with a human-readable status string
	 * @param {function} [wanted] - returns the name of the character to follow, or
	 * null to take any; asked on every sample, as the loaded character can change
	 */
	start(interval_ms, on_payload, on_status, wanted = () => null) {
		if (this.is_running)
			return;

		const error = screencap.getError();
		if (error !== null)
			throw new Error(error);

		this.region = null;
		this.hint = undefined;
		this.misses = 0;
		this.last_counter = null;
		this.last_name = null;
		this.last_waiting = null;
		this.logged_screen = false;
		this.wanted = wanted;

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

	/**
	 * @param {object} payload
	 * @param {string|null} wanted
	 * @returns {boolean}
	 */
	_follows(payload, wanted) {
		return wanted === null || is_same_character(wanted, payload.name);
	}

	_sample(on_payload, on_status) {
		const wanted = this.wanted();

		// tracked region first, then the whole screen when it stops working
		if (this.region !== null) {
			const payload = this._read(this.region);
			if (payload && this._follows(payload, wanted)) {
				this.misses = 0;
				this._report(payload, on_payload);
				return;
			}

			// a different character in that window will not change back by itself, so
			// search straight away rather than waiting out the misses that let a frame
			// caught mid-redraw pass
			if (!payload && ++this.misses < MISSES_BEFORE_RESCAN) {
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

		const frame = screencap.capture(screen.x, screen.y, screen.width, screen.height);
		const payloads = decode_frame_all(frame.data, frame.width, frame.height);
		this.misses = 0;

		if (payloads.length === 0) {
			on_status('strip not visible');
			return;
		}

		// any character will do for an unsaved one, so keep to the window already
		// followed rather than hopping to whichever the search happens to meet first
		const payload = wanted === null
			? payloads.find(p => p.name !== null && p.name === this.last_name) ?? payloads[0]
			: payloads.find(p => is_same_character(wanted, p.name));

		if (!payload) {
			// nothing to narrow to, so the next sample searches the whole screen
			// again, which is what notices the right character arriving
			const names = list_names(payloads.map(p => p.name ?? 'an unnamed character'));
			const status = util.format('waiting: the game is on %s, %s is loaded', names, wanted);

			if (status !== this.last_waiting) {
				log.write('Live sync waiting for %s: the game is on %s', wanted, names);
				this.last_waiting = status;
			}

			on_status(status);
			return;
		}

		this.last_waiting = null;

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

		this.hint = undefined;
		log.write('Live sync following %s at %d,%d (pitch %s, %d strip(s) on screen)', payload.name ?? 'an unnamed character', screen.x + strip.x, screen.y + strip.y, strip.pitch.toFixed(3), payloads.length);
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
		// the counter restarts at zero on every login, so a different character
		// can arrive with the counter the last one left off at
		if (payload.counter === this.last_counter && payload.name === this.last_name)
			return;

		this.last_counter = payload.counter;
		this.last_name = payload.name;
		on_payload(payload);
	}
}

module.exports = { LiveSync, is_same_character };
