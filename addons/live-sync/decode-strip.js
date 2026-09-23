#!/usr/bin/env node
/*
	Decode a wow.export Live Sync pixel strip from a PNG screenshot.

	  node decode-strip.js <screenshot.png>

	Reads the PNG here and hands the pixels to the app's own decoder, so this tool
	and the app can never disagree about the wire format. Useful for checking that
	the strip survives a real capture without running the app.
*/

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const { decode_frame, SLOT_IDS, FORMAT_VERSION } = require(path.join(__dirname, '..', '..', 'src', 'js', 'ui', 'strip-decoder'));

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

const file = process.argv[2];
if (!file) {
	console.error('usage: node decode-strip.js <screenshot.png>');
	process.exit(1);
}

const img = read_png(file);
console.log(`image ${img.width}x${img.height}, ${img.channels} channels`);

// the decoder wants RGBA; widen a 24 bit PNG to match
let pixels = img.pixels;
if (img.channels === 3) {
	pixels = Buffer.alloc(img.width * img.height * 4, 255);
	for (let i = 0, o = 0; i < img.pixels.length; i += 3, o += 4) {
		pixels[o] = img.pixels[i];
		pixels[o + 1] = img.pixels[i + 1];
		pixels[o + 2] = img.pixels[i + 2];
	}
}

const result = decode_frame(pixels, img.width, img.height);
if (!result) {
	console.error('no valid strip found: is the addon loaded, and is the capture lossless (PNG, not JPEG) and unscaled?');
	process.exit(2);
}

console.log(`strip at ${result.strip.x},${result.strip.y}, pitch ${result.strip.pitch.toFixed(4)}px`);
console.log(`format version ${result.version} (expected ${FORMAT_VERSION}), counter ${result.counter}`);
console.log(`character ${result.name ?? "(name did not fit)"}`);
for (const slot_id of SLOT_IDS)
	console.log(`  ${String(SLOT_NAMES[slot_id]).padEnd(10)} ${result.items.get(slot_id) || '-'}`);

if (result.customizations === null) {
	console.log('customizations: not known (the addon learns them from a barbershop visit)');
} else {
	console.log(`customizations: ${result.customizations.length}`);
	for (const { optionID, choiceID } of result.customizations)
		console.log(`  option ${String(optionID).padEnd(8)} choice ${choiceID}`);
}
