/*!
	wow.export (https://github.com/Kruithne/wow.export)
	License: MIT
 */
const path = require('path');
const log = require('./log');
const constants = require('./constants');

/**
 * Screen region capture, used by the character tab's live sync to read the
 * WoWExportLiveSync addon's pixel strip off the running game.
 *
 * Windows only: the app's chrome-extension:// page exposes none of Chromium's
 * capture APIs (navigator.mediaDevices and the legacy calls are all absent), so
 * frames come from a small GDI-based native addon instead. Everything here is
 * optional - if the addon is missing, live sync reports itself unavailable rather
 * than breaking the app.
 */

let native = null;
let load_error = null;

try {
	native = require(path.join(constants.INSTALL_PATH, 'screencap.node'));
} catch (e) {
	load_error = e.message;
	log.write('screen capture addon unavailable: %s', e.message);
}

/**
 * @returns {boolean} true if screen capture can be used on this platform/build
 */
const is_supported = () => native !== null && native.isSupported();

/**
 * @returns {string|null} why capture is unavailable, or null if it is
 */
const get_error = () => {
	if (native === null)
		return load_error ?? 'the screen capture addon is not installed';

	if (!native.isSupported())
		return 'screen capture is only implemented on windows';

	return null;
};

/**
 * Capture a screen region.
 * @param {number} x
 * @param {number} y
 * @param {number} width
 * @param {number} height
 * @returns {{ width: number, height: number, data: Buffer }} RGBA pixels, top-down
 */
const capture = (x, y, width, height) => native.capture(x, y, width, height);

/**
 * Bounds covering every display, which is the area to search for the strip.
 * @returns {{ x: number, y: number, width: number, height: number }}
 */
const virtual_screen = () => native.virtualScreen();

module.exports = {
	isSupported: is_supported,
	getError: get_error,
	capture,
	virtualScreen: virtual_screen
};
