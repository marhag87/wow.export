/*!
	wow.export (https://github.com/Kruithne/wow.export)
	Authors: Kruithne <kruithne@gmail.com>, Marlamin <marlamin@marlamin.com>
	License: MIT
 */

const core = require('../../core');
const log = require('../../log');

const CHUNK_AFM2 = 0x324D4641;
const CHUNK_AFSA = 0x41534641;
const CHUNK_AFSB = 0x42534641;

// See: https://wowdev.wiki/M2#.anim_files
class ANIMLoader {
	/**
	 * Construct a new ANIMLoader instance.
	 * @param {BufferWrapper} data 
	 */
	constructor(data) {
		this.data = data;
		this.isLoaded = false;
	}

	/**
	 * Load the animation file.
	 */
	async load(isChunked = true) {
		// Prevent multiple loading of the same file.
		if (this.isLoaded === true)
			return;

		if (!isChunked) {
			this.animData = this.data.readUInt8(this.data.remainingBytes);
			this.isLoaded = true;
			return;
		}

		while (this.data.remainingBytes > 0) {
			const chunkID = this.data.readUInt32LE();
			const chunkSize = this.data.readUInt32LE();
			const nextChunkPos = this.data.offset + chunkSize;
	
			switch (chunkID) {
				case CHUNK_AFM2: this.parse_chunk_afm2(chunkSize); break; // AFM2 old animation data or ??? if AFSA/AFSB are present
				case CHUNK_AFSA: this.parse_chunk_afsa(chunkSize); break; // Skeleton Attachment animation data
				case CHUNK_AFSB: this.parse_chunk_afsb(chunkSize); break; // Skeleton Bone animation data
			}
	
			// Ensure that we start at the next chunk exactly.
			this.data.seek(nextChunkPos);
		}

		this.isLoaded = true;
	}

	parse_chunk_afm2(chunkSize) {
		this.animData = this.data.readUInt8(chunkSize);
	}

	parse_chunk_afsa(chunkSize) {
		this.skeletonAttachmentData = this.data.readUInt8(chunkSize);
	}

	parse_chunk_afsb(chunkSize) {
		this.skeletonBoneData = this.data.readUInt8(chunkSize);
	}
}

// Parsed .anim payloads by file, shared by every model loader.
//
// An export builds a fresh model loader, so the same .anim files are read out of
// CASC and parsed again for every export - 347 of them on a Classic Forever
// character, about five seconds, producing identical bytes each time. Gear changes
// do not touch animation data, so live sync paid that on every swap.
const PAYLOAD_CACHE_BUDGET = 256 * 1024 * 1024;

const payload_cache = new Map();
let payload_cache_bytes = 0;

/**
 * Load a .anim file's payload, or return the one parsed earlier.
 *
 * Returns the raw bytes. Callers wrap them with BufferWrapper.from(), which copies,
 * so each loader gets its own data and read position.
 *
 * @param {number} fileDataID
 * @param {boolean} chunked
 * @param {string} [label] - for the log line, written only when it is really loaded
 * @returns {Promise<Buffer>}
 */
async function load_anim_payload(fileDataID, chunked, label) {
	const key = fileDataID + (chunked ? '-c' : '-p');
	const cached = payload_cache.get(key);

	if (cached !== undefined) {
		// re-insert to keep the map in least-recently-used order
		payload_cache.delete(key);
		payload_cache.set(key, cached);
		return cached;
	}

	log.write('Loading .anim file %d%s', fileDataID, label ? ' (' + label + ')' : '');

	const loader = new ANIMLoader(await core.view.casc.getFile(fileDataID));
	await loader.load(chunked);

	const payload = loader.skeletonBoneData !== undefined ? loader.skeletonBoneData : loader.animData;
	const size = payload?.byteLength ?? payload?.length ?? 0;

	payload_cache.set(key, payload);
	payload_cache_bytes += size;

	for (const [old_key, old_payload] of payload_cache) {
		if (payload_cache_bytes <= PAYLOAD_CACHE_BUDGET || old_key === key)
			break;

		payload_cache.delete(old_key);
		payload_cache_bytes -= old_payload?.byteLength ?? old_payload?.length ?? 0;
	}

	return payload;
}

// file data IDs are per build, so nothing may outlive a change of source
core.events.on('casc-source-changed', () => {
	payload_cache.clear();
	payload_cache_bytes = 0;
	log.write('Cleared cached .anim payloads');
});

module.exports = ANIMLoader;
module.exports.load_anim_payload = load_anim_payload;