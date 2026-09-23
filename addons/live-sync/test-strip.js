#!/usr/bin/env node
/*
	Tests for the wow.export Live Sync strip format.

	  node test-strip.js

	The addon's build_payload is mirrored here in JS, rendered to a synthetic
	strip and read back through the app's own decoder, so the two sides are
	checked against each other without running the game. Also checks that the
	constants the addon and decoder share agree, and exercises the character
	name matcher and the frame reporting in the app.

	Run it after any change to the wire format. There is no Lua runtime here,
	so the mirror must be kept in step with WoWExportLiveSync.lua by hand; the
	constants check catches the sizes drifting, not the logic.
*/

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const { decode_frame, TOTAL_BLOCKS } = require(path.join(ROOT, 'src', 'js', 'ui', 'strip-decoder'));
// live-sync.js pulls in the app's log, which expects the nw.js runtime
global.BUILD_RELEASE = true;
global.nw = { App: { dataPath: fs.mkdtempSync(path.join(os.tmpdir(), 'wow-export-strip-test-')), manifest: {} } };
const { LiveSync } = require(path.join(ROOT, 'src', 'js', 'ui', 'live-sync'));

const FORMAT_VERSION = 4, SLOT_BITS = 18, DATA_BLOCKS = 162;
const NAME_LENGTH_BITS = 5, NAME_BYTES = 24;
const CUST_SLOTS = 14, CUST_COUNT_BITS = 4, CUST_OPTION_BITS = 16, CUST_CHOICE_BITS = 20;
const SLOT_IDS = [1, 3, 4, 5, 6, 7, 8, 9, 10, 15, 16, 17, 19];
const MARKERS = [[0,0,0],[1,1,1],[1,0,0],[0,1,0],[0,0,1]];
const END_MARKERS = [[1,1,1],[0,0,0]];

function push(bits, value, width) {
	for (let i = width - 1; i >= 0; i--) bits.push((Math.floor(value / 2 ** i)) & 1);
}

function build_payload(counter, name, items, customizations) {
	const bits = [];
	push(bits, FORMAT_VERSION, 4);
	push(bits, counter, 8);

	// Lua strings are bytes, so # is the UTF-8 length
	let name_bytes = [...Buffer.from(name ?? '', 'utf8')];
	if (name_bytes.length > NAME_BYTES) name_bytes = [];
	push(bits, name_bytes.length, NAME_LENGTH_BITS);
	for (let i = 0; i < NAME_BYTES; i++) push(bits, name_bytes[i] ?? 0, 8);

	for (const slot of SLOT_IDS) push(bits, items[slot] ?? 0, SLOT_BITS);

	const entries = customizations ?? [];
	const count = Math.min(entries.length, CUST_SLOTS);
	push(bits, count, CUST_COUNT_BITS);
	for (let i = 0; i < CUST_SLOTS; i++) {
		const e = i < count ? entries[i] : null;
		push(bits, e ? e.option_id : 0, CUST_OPTION_BITS);
		push(bits, e ? e.choice_id : 0, CUST_CHOICE_BITS);
	}

	let crc = 0xffff;
	for (let i = 0; i < bits.length; i += 8) {
		let byte = 0;
		for (let j = 0; j < 8; j++) byte = byte * 2 + (bits[i + j] ?? 0);
		crc ^= byte << 8;
		for (let b = 0; b < 8; b++) crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
	}
	push(bits, crc, 16);
	return bits;
}

function render(bits, pitch, height = 4) {
	const blocks = [];
	for (const m of MARKERS) blocks.push(m.map(c => c * 255));
	for (let i = 0; i < DATA_BLOCKS; i++) {
		const ch = [];
		for (let c = 0; c < 3; c++) {
			const o = i * 6 + c * 2;
			ch.push(((bits[o] ?? 0) * 2 + (bits[o + 1] ?? 0)) * 85);
		}
		blocks.push(ch);
	}
	for (const m of END_MARKERS) blocks.push(m.map(c => c * 255));

	const width = Math.ceil(blocks.length * pitch) + 10;
	const px = new Uint8ClampedArray(width * height * 4);
	for (let i = 0; i < px.length; i += 4) { px[i] = 20; px[i + 1] = 30; px[i + 2] = 40; px[i + 3] = 255; }
	for (let b = 0; b < blocks.length; b++) {
		for (let s = 0; s < Math.ceil(pitch); s++) {
			const x = Math.floor(b * pitch) + s;
			if (x >= width) continue;
			for (let y = 0; y < height; y++) {
				const i = (y * width + x) * 4;
				px[i] = blocks[b][0]; px[i + 1] = blocks[b][1]; px[i + 2] = blocks[b][2];
			}
		}
	}
	return { px, width, height };
}

const decode = bits => { const img = render(bits, 1); return decode_frame(img.px, img.width, img.height); };

let failures = 0;
const check = (name, cond, extra) => {
	console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra !== undefined ? '  ' + extra : ''));
	if (!cond) failures++;
};

const items = { 1: 12345, 3: 250000, 5: 99, 16: 262143 };
const cust = [
	{ option_id: 9399, choice_id: 78038 }, { option_id: 9400, choice_id: 78052 },
	{ option_id: 9401, choice_id: 78073 }, { option_id: 9458, choice_id: 78623 },
	{ option_id: 9459, choice_id: 78079 }, { option_id: 9480, choice_id: 78881 },
	{ option_id: 9481, choice_id: 78855 }
];

const bits = build_payload(42, 'Bernam', items, cust);
check('payload fits the data blocks', bits.length <= DATA_BLOCKS * 6, bits.length + ' bits in ' + DATA_BLOCKS * 6);
check('TOTAL_BLOCKS agrees', TOTAL_BLOCKS === 5 + DATA_BLOCKS + 2, TOTAL_BLOCKS);

for (const pitch of [1, 1.5, 3]) {
	const img = render(bits, pitch);
	const out = decode_frame(img.px, img.width, img.height);
	check(`pitch ${pitch}: decodes`, out !== null);
	if (!out) continue;
	check(`pitch ${pitch}: counter`, out.counter === 42, out.counter);
	check(`pitch ${pitch}: name`, out.name === 'Bernam', out.name);
	check(`pitch ${pitch}: items`, SLOT_IDS.every(s => out.items.get(s) === (items[s] ?? 0)));
	const got = out.customizations ?? [];
	check(`pitch ${pitch}: customizations`, got.length === cust.length &&
		got.every((g, i) => g.optionID === cust[i].option_id && g.choiceID === cust[i].choice_id), got.length);
}

// names: accented, the 24 byte limit exactly, and one byte over
for (const [label, name, expect] of [
	['accented', 'Hagström', 'Hagström'],
	['12 two-byte chars (24 bytes)', 'ÅÄÖåäöÅÄÖåäö', 'ÅÄÖåäöÅÄÖåäö'],
	['25 bytes does not fit', 'ÅÄÖåäöÅÄÖåäöx', null],
	['no name', '', null],
]) {
	const out = decode(build_payload(1, name, items, null));
	check(`name ${label}`, out && out.name === expect, out ? JSON.stringify(out.name) : 'no decode');
}

const unknown = decode(build_payload(7, 'Hoom', items, null));
check('unknown customizations are null', unknown && unknown.customizations === null);

// the real matcher, lifted out of tab_characters.js so the test runs the source
const tab = fs.readFileSync(path.join(ROOT, 'src', 'js', 'modules', 'tab_characters.js'), 'utf8');
const fn_src = tab.match(/function live_sync_is_loaded_character\([\s\S]*?\n}\n/)[0];
const is_loaded = new Function(fn_src + '; return live_sync_is_loaded_character;')();
check('matcher: same name', is_loaded('Bernam', 'Bernam') === true);
check('matcher: case differs', is_loaded('bernam', 'Bernam') === true);
check('matcher: decomposed accent', is_loaded('Bjo\u0308rn', 'Björn') === true);
check('matcher: other character', is_loaded('Bernam', 'Hoom') === false);
check('matcher: prefix is not a match', is_loaded('HoomFishing', 'Hoom') === false);
check('matcher: no name matches nothing', is_loaded('Bernam', null) === false);

// a relog restarts the counter, so the same counter on a new name must report
const sync = new LiveSync();
const seen = [];
const report = p => sync._report(p, x => seen.push(x.name + ':' + x.counter));
sync.last_counter = null;
report({ counter: 0, name: 'Hoom' });
report({ counter: 0, name: 'Hoom' });
report({ counter: 0, name: 'Bernam' });
report({ counter: 1, name: 'Bernam' });
check('report: dedupes same frame, reports relog', seen.join(' ') === 'Hoom:0 Bernam:0 Bernam:1', seen.join(' '));

// the sizes the addon and decoder must agree on
const lua = fs.readFileSync(path.join(__dirname, 'WoWExportLiveSync', 'WoWExportLiveSync.lua'), 'utf8');
const decoder_src = fs.readFileSync(path.join(ROOT, 'src', 'js', 'ui', 'strip-decoder.js'), 'utf8');
for (const name of ['FORMAT_VERSION', 'DATA_BLOCKS', 'SLOT_BITS', 'NAME_LENGTH_BITS', 'NAME_BYTES', 'CUST_SLOTS', 'CUST_COUNT_BITS', 'CUST_OPTION_BITS', 'CUST_CHOICE_BITS']) {
	const addon = (lua.match(new RegExp('local ' + name + ' = ([0-9]+)')) || [])[1];
	const app = (decoder_src.match(new RegExp('const ' + name + ' = ([0-9]+);')) || [])[1];
	check(`constant ${name}`, addon !== undefined && addon === app, `addon ${addon}, decoder ${app}`);
}

console.log(failures ? failures + ' FAILED' : 'all checks passed');
process.exit(failures ? 1 : 0);
