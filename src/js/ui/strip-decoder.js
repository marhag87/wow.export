/*!
	wow.export (https://github.com/Kruithne/wow.export)
	License: MIT
 */

/**
 * Decoder for the pixel strip drawn by the WoWExportLiveSync addon, which encodes
 * the player's equipped item IDs so they can be read off the screen.
 *
 * Layout, left to right, one block each:
 *
 *   5 marker blocks : black, white, red, green, blue
 *   48 data blocks  : 6 bits each, 2 bits per channel, most significant first,
 *                     channel level = value * 85
 *   2 end markers   : white, black
 *
 * Payload bits, most significant first: 4 format version, 8 change counter,
 * 13 slots x 20 bits (game inventory slot IDs, 0 for empty), 16 CRC-16/CCITT-FALSE
 * over the preceding bits padded to whole bytes.
 *
 * See addons/live-sync/ for the addon and a standalone decoder for PNG files.
 */

const MARKER_COUNT = 5;
const DATA_BLOCKS = 48;
const SLOT_BITS = 20;
const FORMAT_VERSION = 1;

const MARKER_COLOURS = [
	[0, 0, 0], [255, 255, 255], [255, 0, 0], [0, 255, 0], [0, 0, 255]
];

// game inventory slot IDs, in payload order
const SLOT_IDS = [1, 3, 4, 5, 6, 7, 8, 9, 10, 15, 16, 17, 19];

class PixelView {
	/**
	 * @param {Uint8ClampedArray|Uint8Array} pixels - RGBA pixel data
	 * @param {number} width
	 * @param {number} height
	 */
	constructor(pixels, width, height) {
		this.pixels = pixels;
		this.width = width;
		this.height = height;
	}

	/**
	 * Test a pixel against a colour.
	 * @returns {boolean}
	 */
	near(x, y, colour, tolerance = 40) {
		const ofs = (y * this.width + x) * 4;
		return Math.abs(this.pixels[ofs] - colour[0]) <= tolerance &&
			Math.abs(this.pixels[ofs + 1] - colour[1]) <= tolerance &&
			Math.abs(this.pixels[ofs + 2] - colour[2]) <= tolerance;
	}
}

/**
 * Check the marker run at a candidate position.
 * @returns {boolean}
 */
function markers_match(view, x, y, pitch) {
	for (let m = 0; m < MARKER_COUNT; m++) {
		const bx = Math.round(x + (m + 0.5) * pitch);
		if (bx >= view.width || !view.near(bx, y, MARKER_COLOURS[m], 30))
			return false;
	}

	return true;
}

/**
 * Length of the run of `colour` starting at x, or 0 if it does not start there.
 * @returns {number}
 */
function run_length(view, x, y, colour, tolerance = 30) {
	let run = 0;
	while (x + run < view.width && view.near(x + run, y, colour, tolerance))
		run++;

	return run;
}

/**
 * Find the next run of `colour` at or after x, ignoring runs of a single pixel,
 * which are the blended edges a scaled capture leaves between blocks.
 * @returns {object|null} - { start, length, centre }
 */
function next_run(view, x, y, colour, limit) {
	for (let probe = x; probe < Math.min(view.width, limit); probe++) {
		if (!view.near(probe, y, colour, 30))
			continue;

		const length = run_length(view, probe, y, colour);
		if (length >= 2)
			return { start: probe, length, centre: probe + (length - 1) / 2 };

		probe += length;
	}

	return null;
}

/**
 * Refine the pitch against the white end marker, 53 blocks from the start.
 *
 * Marker centres give the pitch to about half a pixel, which is fine for locating
 * the strip but drifts by a whole block by the end of the data. Measuring across the
 * whole strip divides that error by 53. The end marker is white followed by black,
 * which is what separates it from a data block that happens to be white.
 * @returns {number}
 */
function refine_pitch(view, x, y, pitch) {
	const end_offset = MARKER_COUNT + DATA_BLOCKS;
	const expected = x + end_offset * pitch;
	const from = Math.max(0, Math.round(expected - 2.5 * pitch));
	const to = Math.min(view.width - 1, Math.round(expected + 2.5 * pitch));

	let best = null;
	for (let probe = from; probe <= to; probe++) {
		if (!view.near(probe, y, MARKER_COLOURS[1], 30) || (probe > 0 && view.near(probe - 1, y, MARKER_COLOURS[1], 30)))
			continue;

		const length = run_length(view, probe, y, MARKER_COLOURS[1]);
		if (length < pitch * 0.5 || length > pitch * 1.5)
			continue;

		// the final black marker follows it
		const after = Math.round(probe + 1.5 * pitch);
		if (after >= view.width || !view.near(after, y, MARKER_COLOURS[0], 30))
			continue;

		if (best === null || Math.abs(probe - expected) < Math.abs(best - expected))
			best = probe;
	}

	return best === null ? pitch : (best - x) / end_offset;
}

/**
 * Locate the strip in a frame.
 *
 * The search anchors on the red marker (the third block) rather than the black
 * first block: black is common on screen, and a black area running up to the strip
 * merges with that first block, hiding where it starts. Pure red is rare on screen.
 *
 * The pitch comes from the distance between the red and blue marker centres, which
 * are two blocks apart. Centres are used rather than edges because a scaled capture
 * blurs one pixel either side of every block.
 *
 * @param {PixelView} view
 * @param {object} [hint] - previously found { x, y, pitch }, checked first
 * @returns {object|null} - { x, y, pitch }
 */
function find_strip(view, hint) {
	if (hint && hint.x < view.width && hint.y < view.height && markers_match(view, hint.x, hint.y, hint.pitch))
		return hint;

	for (let y = 0; y < view.height; y += 2) {
		let x = 0;
		while (x < view.width) {
			const red = run_length(view, x, y, MARKER_COLOURS[2]);
			if (red < 3 || red > 64) {
				x += Math.max(red, 1);
				continue;
			}

			const red_centre = x + (red - 1) / 2;

			// green then blue follow, within a few blocks
			const green = next_run(view, x + red, y, MARKER_COLOURS[3], x + red + 3 * red);
			const blue = green && next_run(view, green.start + green.length, y, MARKER_COLOURS[4], green.start + 3 * red);

			if (blue) {
				const pitch = (blue.centre - red_centre) / 2;
				const start = Math.round(red_centre - 2.5 * pitch);

				if (pitch >= 3 && start >= -2 && start + (MARKER_COUNT + DATA_BLOCKS) * pitch <= view.width) {
					const from = Math.max(start, 0);
					const refined = refine_pitch(view, from, y, pitch);

					if (markers_match(view, from, y, refined))
						return { x: from, y, pitch: refined };
				}
			}

			x += red;
		}
	}

	return null;
}

/**
 * Read the payload from a located strip.
 * @returns {object} - { version, counter, items, crc_ok }
 */
function read_payload(view, strip) {
	const { x, y, pitch } = strip;
	const bits = [];

	for (let i = 0; i < DATA_BLOCKS; i++) {
		const bx = Math.min(Math.round(x + (MARKER_COUNT + i + 0.5) * pitch), view.width - 1);
		const ofs = (y * view.width + bx) * 4;

		for (let channel = 0; channel < 3; channel++) {
			const value = Math.min(3, Math.max(0, Math.round(view.pixels[ofs + channel] / 85)));
			bits.push((value >> 1) & 1, value & 1);
		}
	}

	const take = (ofs, width) => {
		let value = 0;
		for (let i = 0; i < width; i++)
			value = value * 2 + bits[ofs + i];

		return value;
	};

	const version = take(0, 4);
	const counter = take(4, 8);

	const items = new Map();
	let ofs = 12;
	for (const slot_id of SLOT_IDS) {
		items.set(slot_id, take(ofs, SLOT_BITS));
		ofs += SLOT_BITS;
	}

	// CRC over the payload bits, zero padded to whole bytes
	let crc = 0xffff;
	for (let i = 0; i < ofs; i += 8) {
		let byte = 0;
		for (let j = 0; j < 8; j++)
			byte = byte * 2 + (bits[i + j] ?? 0);

		crc ^= byte << 8;
		for (let b = 0; b < 8; b++)
			crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
	}

	return { version, counter, items, crc_ok: crc === take(ofs, 16) };
}

/**
 * Decode a frame. Returns null when no valid strip is present, so a frame where
 * the game is occluded or mid-redraw is simply skipped.
 * @param {Uint8ClampedArray|Uint8Array} pixels - RGBA pixel data
 * @param {number} width
 * @param {number} height
 * @param {object} [hint] - strip position from a previous frame
 * @returns {object|null} - { version, counter, items, strip }
 */
function decode_frame(pixels, width, height, hint) {
	const view = new PixelView(pixels, width, height);
	const strip = find_strip(view, hint);
	if (!strip)
		return null;

	const payload = read_payload(view, strip);
	if (!payload.crc_ok || payload.version !== FORMAT_VERSION)
		return null;

	return { version: payload.version, counter: payload.counter, items: payload.items, strip };
}

module.exports = {
	FORMAT_VERSION,
	SLOT_IDS,
	decode_frame,

	// exposed for the tests in addons/live-sync/
	_internal: { PixelView, find_strip, read_payload }
};
