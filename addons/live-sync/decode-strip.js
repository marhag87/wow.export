#!/usr/bin/env node
/*
	Decode a wow.export Live Sync pixel strip from a PNG screenshot.

	  node decode-strip.js <screenshot.png> [pitch]

	`pitch` overrides the measured block pitch, for testing captures taken before the
	end marker existed.

	Finds the marker run (black, white, red, green, blue) anywhere in the image, then
	measures the exact block pitch from the white end marker, since at most UI scales
	the pitch is fractional and rounding it drifts by a whole block across the strip.
	Used to prove the channel survives a real capture before wiring it into the app;
	the app itself decodes the same layout from a canvas instead of a PNG file.
*/

const fs = require('fs');
const zlib = require('zlib');

const MARKER_COUNT = 5;
const DATA_BLOCKS = 48;
const END_MARKER_COUNT = 2;
const SLOT_BITS = 20;
const SLOT_IDS = [1, 3, 4, 5, 6, 7, 8, 9, 10, 15, 16, 17, 19];
const SLOT_NAMES = {
	1: 'head', 3: 'shoulders', 4: 'shirt', 5: 'chest', 6: 'waist', 7: 'legs',
	8: 'feet', 9: 'wrist', 10: 'hands', 15: 'back', 16: 'main hand',
	17: 'off hand', 19: 'tabard'
};

/** Minimal PNG reader: 8-bit RGB/RGBA, non-interlaced. Returns { width, height, pixels }. */
function read_png(file) {
	const buf = fs.readFileSync(file);
	if (buf.readUInt32BE(0) !== 0x89504e47)
		throw new Error('not a PNG file');

	let ofs = 8;
	let width = 0, height = 0, channels = 0, bit_depth = 0;
	const idat = [];

	while (ofs < buf.length) {
		const length = buf.readUInt32BE(ofs);
		const type = buf.toString('ascii', ofs + 4, ofs + 8);
		const data = buf.subarray(ofs + 8, ofs + 8 + length);

		if (type === 'IHDR') {
			width = data.readUInt32BE(0);
			height = data.readUInt32BE(4);
			bit_depth = data[8];
			const colour_type = data[9];
			if (bit_depth !== 8 || (colour_type !== 2 && colour_type !== 6))
				throw new Error(`unsupported PNG: bit depth ${bit_depth}, colour type ${colour_type}`);
			channels = colour_type === 2 ? 3 : 4;
			if (data[12] !== 0)
				throw new Error('interlaced PNG not supported');
		} else if (type === 'IDAT') {
			idat.push(data);
		} else if (type === 'IEND') {
			break;
		}

		ofs += 12 + length;
	}

	const raw = zlib.inflateSync(Buffer.concat(idat));
	const stride = width * channels;
	const pixels = Buffer.alloc(stride * height);

	// undo per-scanline filters
	for (let y = 0; y < height; y++) {
		const filter = raw[y * (stride + 1)];
		const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
		const out = pixels.subarray(y * stride, (y + 1) * stride);
		const prev = y > 0 ? pixels.subarray((y - 1) * stride, y * stride) : Buffer.alloc(stride);

		for (let x = 0; x < stride; x++) {
			const a = x >= channels ? out[x - channels] : 0;
			const b = prev[x];
			const c = x >= channels ? prev[x - channels] : 0;
			let value = line[x];

			switch (filter) {
				case 0: break;
				case 1: value += a; break;
				case 2: value += b; break;
				case 3: value += (a + b) >> 1; break;
				case 4: {
					const p = a + b - c;
					const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
					value += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
					break;
				}
				default: throw new Error(`unknown PNG filter ${filter}`);
			}

			out[x] = value & 0xff;
		}
	}

	return { width, height, channels, pixels };
}

const px = (img, x, y) => {
	const ofs = (y * img.width + x) * img.channels;
	return [img.pixels[ofs], img.pixels[ofs + 1], img.pixels[ofs + 2]];
};

const near = (pixel, r, g, b, tolerance = 40) =>
	Math.abs(pixel[0] - r) <= tolerance &&
	Math.abs(pixel[1] - g) <= tolerance &&
	Math.abs(pixel[2] - b) <= tolerance;

const MARKER_COLOURS = [
	[0, 0, 0], [255, 255, 255], [255, 0, 0], [0, 255, 0], [0, 0, 255]
];

/**
 * Measure the block pitch, which is fractional at most UI scales: the game rounds
 * each block's own width to whole pixels, so a rounded pitch drifts by a whole
 * block across the strip (e.g. blocks of 23 and 22 pixels for a pitch of 22.5).
 *
 * The blue marker is 4 blocks from the start, which fixes the pitch to a quarter
 * pixel. The white end marker, 53 blocks along, refines it further when found.
 */
function measure_pitch(img, x, y, run) {
	const row = y + (run >> 1);
	let pitch = run;

	// blue marker: the first blue pixel after the black, red and green markers
	for (let probe = x + 1; probe < Math.min(img.width, x + 8 * run); probe++) {
		if (near(px(img, probe, row), 0, 0, 255, 30)) {
			pitch = (probe - x) / 4;
			break;
		}
	}

	const END_OFFSET = MARKER_COUNT + DATA_BLOCKS;
	const expected = x + END_OFFSET * pitch;

	// white end marker, within a block of where the pitch so far puts it
	for (let probe = Math.max(0, Math.round(expected - pitch)); probe <= Math.min(img.width - 1, Math.round(expected + pitch)); probe++) {
		const here = near(px(img, probe, row), 255, 255, 255, 30);
		const before = probe > 0 && near(px(img, probe - 1, row), 255, 255, 255, 30);

		if (here && !before)
			return (probe - x) / END_OFFSET;
	}

	return pitch;
}

/** Locate the strip: returns { x, y, block } of the first marker block's top-left. */
function find_strip(img) {
	for (let y = 0; y < img.height; y++) {
		let x = 0;
		while (x < img.width) {
			if (!near(px(img, x, y), 0, 0, 0, 20)) {
				x++;
				continue;
			}

			// measure the black run, that is the block size
			let block = 0;
			while (x + block < img.width && near(px(img, x + block, y), 0, 0, 0, 20))
				block++;

			if (block >= 3 && block <= 64) {
				const total = MARKER_COUNT + DATA_BLOCKS;
				if (x + total * block <= img.width && y + block <= img.height) {
					let ok = true;
					for (let m = 1; m < MARKER_COUNT && ok; m++) {
						const sample = px(img, x + m * block + (block >> 1), y + (block >> 1));
						ok = near(sample, ...MARKER_COLOURS[m]);
					}

					if (ok)
						return { x, y, block, pitch: measure_pitch(img, x, y, block) };
				}
			}

			x += Math.max(block, 1);
		}
	}

	return null;
}

function decode(img, strip) {
	const { x, y, block, pitch } = strip;
	const half = block >> 1;
	const bits = [];

	for (let i = 0; i < DATA_BLOCKS; i++) {
		const bx = Math.round(x + (MARKER_COUNT + i + 0.5) * pitch);
		const pixel = px(img, Math.min(bx, img.width - 1), y + half);

		for (const channel of pixel) {
			// levels are 0, 85, 170, 255
			const value = Math.min(3, Math.max(0, Math.round(channel / 85)));
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
	const items = {};
	let ofs = 12;
	for (const slot_id of SLOT_IDS) {
		items[slot_id] = take(ofs, SLOT_BITS);
		ofs += SLOT_BITS;
	}

	// CRC over the payload bits, zero padded to whole bytes
	const bytes = [];
	for (let i = 0; i < ofs; i += 8) {
		let byte = 0;
		for (let j = 0; j < 8; j++)
			byte = byte * 2 + (bits[i + j] ?? 0);
		bytes.push(byte);
	}

	let crc = 0xffff;
	for (const byte of bytes) {
		crc ^= byte << 8;
		for (let i = 0; i < 8; i++)
			crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
	}

	return { version, counter, items, crc_ok: crc === take(ofs, 16) };
}

const file = process.argv[2];
if (!file) {
	console.error('usage: node decode-strip.js <screenshot.png>');
	process.exit(1);
}

const img = read_png(file);
console.log(`image ${img.width}x${img.height}, ${img.channels} channels`);

const strip = find_strip(img);
if (!strip) {
	console.error('no strip found: is the addon loaded, and is the capture lossless (PNG, not JPEG)?');
	process.exit(2);
}

if (process.argv[3])
	strip.pitch = Number(process.argv[3]);

console.log(`strip at ${strip.x},${strip.y}, block run ${strip.block}px, pitch ${strip.pitch.toFixed(4)}px`);

const result = decode(img, strip);
console.log(`format version ${result.version}, counter ${result.counter}, crc ${result.crc_ok ? 'ok' : 'FAILED'}`);
for (const slot_id of SLOT_IDS)
	console.log(`  ${String(SLOT_NAMES[slot_id]).padEnd(10)} ${result.items[slot_id] || '-'}`);
