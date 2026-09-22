/*!
wow.export (https://github.com/Kruithne/wow.export)
Authors: Kruithne <kruithne@gmail.com>, Marlamin <marlamin@marlamin.com>
License: MIT
*/
const BLPFile = require('../../casc/blp');
const core = require('../../core');
const log = require('../../log');
const listfile = require('../../casc/listfile');
const overlay = require('../../ui/char-texture-overlay');
const PNGWriter = require('../../png-writer');
const Shaders = require('../Shaders');

// Decoded character textures, shared by every material renderer.
//
// Recomposing a character reloads every texture that makes it up, so changing one
// customization re-read and re-decoded all of them - about 16 files for a dressed
// character, at a quarter of a second each, when only one had changed. The decoded
// pixels are kept here instead. GL textures cannot be shared, since each renderer
// owns its own context, but uploading pixels already in memory is cheap.
const TEXTURE_CACHE_BUDGET = 128 * 1024 * 1024;

const texture_cache = new Map();
let texture_cache_bytes = 0;

/**
 * Decode a texture, or return the pixels decoded earlier.
 * @param {number} fileDataID
 * @param {boolean} useAlpha
 * @returns {Promise<{width: number, height: number, data: Uint8Array}>}
 */
async function get_decoded_texture(fileDataID, useAlpha) {
	const key = fileDataID + (useAlpha ? '-a' : '-o');
	const cached = texture_cache.get(key);

	if (cached !== undefined) {
		// re-insert so the map stays in least-recently-used order
		texture_cache.delete(key);
		texture_cache.set(key, cached);
		return cached;
	}

	const started = performance.now();
	const file = await core.view.casc.getFile(fileDataID);
	const read_ms = performance.now() - started;

	const blp = new BLPFile(file);
	const entry = {
		width: blp.width,
		height: blp.height,
		data: blp.toUInt8Array(0, useAlpha ? 0b1111 : 0b0111)
	};

	const total_ms = performance.now() - started;
	if (total_ms > 50)
		log.write('Slow character texture %d: %dms read, %dms decode', fileDataID, Math.round(read_ms), Math.round(total_ms - read_ms));

	texture_cache.set(key, entry);
	texture_cache_bytes += entry.data.byteLength;

	// drop the least recently used entries once over budget
	for (const [old_key, old_entry] of texture_cache) {
		if (texture_cache_bytes <= TEXTURE_CACHE_BUDGET || old_key === key)
			break;

		texture_cache.delete(old_key);
		texture_cache_bytes -= old_entry.data.byteLength;
	}

	return entry;
}

// file data IDs are per build, so nothing may outlive a change of source
core.events.on('casc-source-changed', () => {
	texture_cache.clear();
	texture_cache_bytes = 0;
});

const UV_BUFFER_DATA = new Float32Array([
	0, 1,
	1, 1,
	0, 0,
	0, 0,
	1, 1,
	1, 0
]);

class CharMaterialRenderer {

	/**
	 * Construct a new CharMaterialRenderer instance.
	 */
	constructor(textureLayer, width, height) {
		this.textureTargets = [];

		// what this material last handed to the GPU, and to which renderer
		this.uploaded_signature = null;
		this.uploaded_renderer = null;

		// source textures bound into this context, by file. A refresh re-adds the
		// same ones, and they used to be uploaded again every time and never
		// deleted - a cost per refresh and a leak until the context went away.
		this.source_textures = new Map();
		this.override_textures = [];

		const canvas = document.createElement('canvas');
		canvas.id = 'charMaterialCanvas-' + textureLayer;

		overlay.add(canvas);

		canvas.width = width;
		canvas.height = height;

		this.gl = canvas.getContext('webgl', { preserveDrawingBuffer: true });
		this.glCanvas = canvas;

		if (!this.gl)
			log.write('Failed to create WebGL context for CharMaterialRenderer layer %d', textureLayer);
	}

	/**
	 * Initialize the CharMaterialRenderer.
	 */
	async init() {
		await this.compileShaders();
		await this.reset();
	}

	/**
	 * Get canvas.
	 */
	getCanvas() {
		return this.glCanvas;
	}

	/**
	 * A key describing what this material composites to, used to tell whether the
	 * result needs handing to the GPU again. Reading 8MB back off the GPU and
	 * uploading it is the bulk of a character refresh, and most materials are
	 * untouched by any one change - picking a face leaves the rest alone.
	 *
	 * Returns null when the answer cannot be known, which counts as changed: a baked
	 * NPC texture is supplied as raw pixels, so nothing here identifies its content.
	 * @returns {string|null}
	 */
	getCompositeSignature() {
		const parts = [];

		for (const layer of this.textureTargets) {
			if (layer.custMaterial.FileDataID === 0)
				return null;

			parts.push([
				layer.id, layer.custMaterial.FileDataID, layer.textureLayer.BlendMode,
				layer.section.X, layer.section.Y, layer.section.Width, layer.section.Height
			].join(':'));
		}

		// added in whatever order the caller found them, so sort for a stable key
		parts.sort();

		// update() drops the base clothing layers when this is off
		parts.push('clothing=' + (core.view.config.chrIncludeBaseClothing ? 1 : 0));
		return parts.join(',');
	}

	/**
	 * Get raw pixel data from WebGL framebuffer.
	 * Returns Uint8Array of RGBA pixels, avoiding canvas alpha premultiplication.
	 */
	getRawPixels() {
		const width = this.glCanvas.width;
		const height = this.glCanvas.height;
		const pixels = new Uint8Array(width * height * 4);

		this.gl.readPixels(0, 0, width, height, this.gl.RGBA, this.gl.UNSIGNED_BYTE, pixels);

		// flip y-axis since gl.readPixels returns bottom-up. A row at a time, not a
		// pixel at a time: these materials run to 2048 square, so a per-pixel loop is
		// millions of iterations on the thread the animation is drawn on.
		const flipped = new Uint8Array(width * height * 4);
		const stride = width * 4;
		for (let y = 0; y < height; y++)
			flipped.set(pixels.subarray(y * stride, (y + 1) * stride), (height - y - 1) * stride);

		return flipped;
	}

	/**
	 * Get URI from raw pixels, avoiding canvas alpha premultiplication.
	 */
	getURI() {
		const pixels = this.getRawPixels();
		const png = new PNGWriter(this.glCanvas.width, this.glCanvas.height);
		const pixel_data = png.getPixelData();
		pixel_data.set(pixels);
		
		const buffer = png.getBuffer();
		const base64 = buffer.toBase64();
		return 'data:image/png;base64,' + base64;
	}

	/**
	 * Reset canvas.
	 */
	async reset() {
		this.unbindAllTextures();
		this.textureTargets = [];
		this.clearCanvas();
	}

	/**
	 * Loads a specific texture to a target.
	 */
	async setTextureTarget(chrCustomizationMaterial, charComponentTextureSection, chrModelMaterial, chrModelTextureLayer, useAlpha = true, blpOverride = null, deferUpdate = false) {

		// CharComponentTextureSection: SectionType, X, Y, Width, Height, OverlapSectionMask
		// ChrModelTextureLayer: TextureType, Layer, Flags, BlendMode, TextureSectionTypeBitMask, TextureSectionTypeBitMask2, ChrModelTextureTargetID[2]
		// ChrModelMaterial: TextureType, Width, Height, Flags, Unk
		// ChrCustomizationMaterial: ChrModelTextureTargetID, FileDataID (this is actually MaterialResourceID but we translate it before here)

		// kept for the texture overlay, which names each layer
		let filename = listfile.getByID(chrCustomizationMaterial.FileDataID);

		let textureID;
		if (blpOverride) {
			textureID = await this.loadTextureFromBLP(blpOverride, useAlpha);
			filename = 'baked npc texture (override)';
		} else {
			textureID = await this.loadTexture(chrCustomizationMaterial.FileDataID, useAlpha);
		}

		this.textureTargets.push({
			id: chrCustomizationMaterial.ChrModelTextureTargetID,
			section: charComponentTextureSection,
			material: chrModelMaterial,
			textureLayer: chrModelTextureLayer,
			custMaterial: chrCustomizationMaterial,
			textureID: textureID,
			filename: filename
		});

		// update() redraws every target it has been given, so calling it per texture
		// makes composing a character quadratic. A caller adding several in a row
		// passes deferUpdate and composites once at the end.
		if (!deferUpdate)
			await this.update();
	}

	/**
	 * Disposes of all the things
	 */
	dispose() {
		this.unbindAllTextures();

		for (const texture of this.source_textures.values())
			this.gl.deleteTexture(texture);

		for (const texture of this.override_textures)
			this.gl.deleteTexture(texture);

		this.source_textures.clear();
		this.override_textures = [];

		if (this.glShaderProg) {
			this.gl.deleteProgram(this.glShaderProg);
			this.glShaderProg = null;
		}

		this.clearCanvas();
		overlay.remove(this.glCanvas);

		this.gl.getExtension('WEBGL_lose_context').loseContext();
		this.glCanvas = null;
		this.gl = null;		
	}

	/**
	 * Load a texture from CASC and bind it to the GL context.
	 * @param {number} fileDataID 
	 * @param {boolean} useAlpha
	 */
	async loadTexture(fileDataID, useAlpha = true) {
		const key = fileDataID + (useAlpha ? '-a' : '-o');
		const existing = this.source_textures.get(key);
		if (existing !== undefined)
			return existing;

		const texture = this.gl.createTexture();

		// TODO: DXT(1/3/5) support
		const blp = await get_decoded_texture(fileDataID, useAlpha);
		const blpData = blp.data;

		this.source_textures.set(key, texture);

		this.gl.activeTexture(this.gl.TEXTURE0);
		this.gl.bindTexture(this.gl.TEXTURE_2D, texture);
		this.gl.texImage2D(this.gl.TEXTURE_2D, 0, this.gl.RGBA, blp.width, blp.height, 0, this.gl.RGBA, this.gl.UNSIGNED_BYTE, blpData);
		this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_WRAP_S, this.gl.REPEAT);
		this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_WRAP_T, this.gl.REPEAT);
		this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MIN_FILTER, this.gl.NEAREST);
		return texture;
	}

	async loadTextureFromBLP(blp, useAlpha = true) {
		const texture = this.gl.createTexture();
		const blpData = blp.toUInt8Array(0, useAlpha? 0b1111 : 0b0111);

		// cannot be keyed by file, so it is tracked only so dispose() can free it
		this.override_textures.push(texture);

		this.gl.activeTexture(this.gl.TEXTURE0);
		this.gl.bindTexture(this.gl.TEXTURE_2D, texture);
		this.gl.texImage2D(this.gl.TEXTURE_2D, 0, this.gl.RGBA, blp.width, blp.height, 0, this.gl.RGBA, this.gl.UNSIGNED_BYTE, blpData);
		this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_WRAP_S, this.gl.REPEAT);
		this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_WRAP_T, this.gl.REPEAT);
		this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MIN_FILTER, this.gl.NEAREST);
		return texture;
	}

	/**
	 * Unbind all textures from the GL context.
	 */
	unbindAllTextures() {
		// Unbind textures.
		for (let i = 0, n = this.gl.getParameter(this.gl.MAX_TEXTURE_IMAGE_UNITS); i < n; i++) {
			this.gl.activeTexture(this.gl.TEXTURE0 + i);
			this.gl.bindTexture(this.gl.TEXTURE_2D, null);
		}
	}

	/**
	 * Clear the canvas, resetting it to black.
	 */
	clearCanvas() {
		if (!this.gl)
			return;

		this.gl.viewport(0, 0, this.glCanvas.width, this.glCanvas.height);
		this.gl.clearColor(0, 0, 0, 1);
		this.gl.clear(this.gl.COLOR_BUFFER_BIT);
	}

	/**
	 * Compile the vertex and fragment shaders used for baking.
	 * Will be attached to the current GL context.
	 */
	async compileShaders() {
		if (!this.gl)
			return;

		const sources = Shaders.get_source('char');

		this.glShaderProg = this.gl.createProgram();

		// Compile vertex shader.
		const vertShader = this.gl.createShader(this.gl.VERTEX_SHADER);
		this.gl.shaderSource(vertShader, sources.vert);
		this.gl.compileShader(vertShader);

		if (!this.gl.getShaderParameter(vertShader, this.gl.COMPILE_STATUS)) {
			log.write('Vertex shader failed to compile: %s', this.gl.getShaderInfoLog(vertShader));
			throw new Error('Failed to compile vertex shader');
		}

		// Compile fragment shader.
		const fragShader = this.gl.createShader(this.gl.FRAGMENT_SHADER);
		this.gl.shaderSource(fragShader, sources.frag);
		this.gl.compileShader(fragShader);

		if (!this.gl.getShaderParameter(fragShader, this.gl.COMPILE_STATUS)) {
			log.write('Fragment shader failed to compile: %s', this.gl.getShaderInfoLog(fragShader));
			throw new Error('Failed to compile fragment shader');
		}

		// Attach shaders.
		this.gl.attachShader(this.glShaderProg, vertShader);
		this.gl.attachShader(this.glShaderProg, fragShader);

		// Link program.
		this.gl.linkProgram(this.glShaderProg);	
		if (!this.gl.getProgramParameter(this.glShaderProg, this.gl.LINK_STATUS)) {
			log.write('Unable to link shader program: %s', this.gl.getProgramInfoLog(this.glShaderProg));
			throw new Error('Failed to link shader program');
		}

		this.gl.useProgram(this.glShaderProg);

		this.uvPositionAttribute = this.gl.getAttribLocation(this.glShaderProg, "a_texCoord");
		this.textureLocation = this.gl.getUniformLocation(this.glShaderProg, "u_texture");
		this.baseTextureLocation = this.gl.getUniformLocation(this.glShaderProg, "u_baseTexture");
		this.blendModeLocation = this.gl.getUniformLocation(this.glShaderProg, "u_blendMode");
		this.vertexPositionAttribute = this.gl.getAttribLocation(this.glShaderProg, "a_position");
	}

	/**
	 * Update 3D data.
	 */
	async update() {
		if (!this.gl)
			return;

		this.clearCanvas();

		this.gl.clearColor(0.5, 0.5, 0.5, 1);
		this.gl.disable(this.gl.DEPTH_TEST);

		// order this.textureTargets by key
		this.textureTargets.sort((a, b) => a.id - b.id);
		
		for (const layer of this.textureTargets) {
			// hide underwear based on settings (target IDs 13/14 are upper/lower body base clothing)
			if (!core.view.config.chrIncludeBaseClothing && (layer.id == 13 || layer.id == 14))
				continue;

			const materialMiddleX = layer.material.Width / 2;
			const materialMiddleY = layer.material.Height / 2;

			const sectionTopLeftX = (layer.section.X - materialMiddleX) / materialMiddleX;
			const sectionTopLeftY = (layer.section.Y + layer.section.Height - materialMiddleY) / materialMiddleY * -1;
			
			const sectionBottomRightX = (layer.section.X + layer.section.Width - materialMiddleX) / materialMiddleX;
			const sectionBottomRightY = (layer.section.Y - materialMiddleY) / materialMiddleY * -1;

			// Vertex buffer
			const vBuffer = this.gl.createBuffer();
			const vBufferData = new Float32Array([
				sectionTopLeftX, sectionTopLeftY, 0.0,
				sectionBottomRightX, sectionTopLeftY, 0.0,
				sectionTopLeftX, sectionBottomRightY, 0.0,
				sectionTopLeftX, sectionBottomRightY, 0.0,
				sectionBottomRightX, sectionTopLeftY, 0.0,
				sectionBottomRightX, sectionBottomRightY, 0.0
			]);

			this.gl.bindBuffer(this.gl.ARRAY_BUFFER, vBuffer);
			this.gl.bufferData(this.gl.ARRAY_BUFFER, vBufferData, this.gl.STATIC_DRAW);

			this.gl.vertexAttribPointer(this.vertexPositionAttribute, 3, this.gl.FLOAT, false, 0, 0);
			this.gl.enableVertexAttribArray(this.vertexPositionAttribute);

			// TexCoord buffer
			const uvBuffer = this.gl.createBuffer();

			this.gl.bindBuffer(this.gl.ARRAY_BUFFER, uvBuffer);
			this.gl.bufferData(this.gl.ARRAY_BUFFER, UV_BUFFER_DATA, this.gl.STATIC_DRAW);

			this.gl.vertexAttribPointer(this.uvPositionAttribute, 2, this.gl.FLOAT, false, 0, 0);
			this.gl.enableVertexAttribArray(this.uvPositionAttribute);

			this.gl.uniform1i(this.textureLocation, 0); // Bind materials
			this.gl.uniform1f(this.blendModeLocation, layer.textureLayer.BlendMode); // Bind blend mode

			this.gl.activeTexture(this.gl.TEXTURE0);
			this.gl.bindTexture(this.gl.TEXTURE_2D, layer.textureID);

			this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_WRAP_S, this.gl.CLAMP_TO_EDGE);
			this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_WRAP_T, this.gl.CLAMP_TO_EDGE);

			switch (layer.textureLayer.BlendMode) {
				case 0: // None
				case 1: // Blit - straight copy, preserves albedo rgb + alpha mask (no premultiply over black)
					this.gl.disable(this.gl.BLEND);
					this.gl.blendFunc(this.gl.ONE, this.gl.ZERO);
					break;
				case 4: // Multiply
				case 6: // Overlay
				case 7: // Screen
				case 15: // Infer alpha blend
					this.gl.enable(this.gl.BLEND);
					this.gl.blendFunc(this.gl.SRC_ALPHA, this.gl.ONE_MINUS_SRC_ALPHA);
					break;
				case 9: // Alpha Straight
					this.gl.enable(this.gl.BLEND);
					this.gl.blendFuncSeparate(this.gl.SRC_ALPHA, this.gl.ONE_MINUS_SRC_ALPHA, this.gl.ONE, this.gl.ONE_MINUS_SRC_ALPHA);
					break;
				// The following blend modes are not used in character customization
				case 2: // Blit Alphamask 
				case 3: // Add 
				case 5: // Mod2x 
				case 8: // Hardlight
				case 10: // Blend black
				case 11: // Mask greyscale
				case 12: // Mask greyscale using color as alpha
				case 13: // Generate greyscale
				case 14: // Colorize
					log.write("Warning: encountered previously unused blendmode " + layer.textureLayer.BlendMode + " during character texture baking, poke a dev");
					break;
				// These are used but we don't know if they need blending enabled -- so just turn it on anyways
				case 16: // Unknown, only used for TaunkaMale.m2, probably experimental/unused
				default:
					this.gl.enable(this.gl.BLEND);
					this.gl.blendFunc(this.gl.SRC_ALPHA, this.gl.ONE_MINUS_SRC_ALPHA);
					break;
			}

			if (layer.textureLayer.BlendMode == 4 || layer.textureLayer.BlendMode == 6 || layer.textureLayer.BlendMode == 7) {
				// Create new texture of current canvas
				const canvasTexture = this.gl.createTexture();
				this.gl.activeTexture(this.gl.TEXTURE1);
				this.gl.bindTexture(this.gl.TEXTURE_2D, canvasTexture)

				if (layer.material.Width == layer.section.Width && layer.material.Height == layer.section.Height) {
					// Just copy the canvas
					this.gl.texImage2D(this.gl.TEXTURE_2D, 0, this.gl.RGBA, this.gl.RGBA, this.gl.UNSIGNED_BYTE, this.glCanvas);
				} else {
					// Get pixels of relevant section
					const pixelBuffer = new Uint8Array(layer.section.Width * layer.section.Height * 4);
					this.gl.readPixels(layer.section.X, layer.section.Y, layer.section.Width, layer.section.Height, this.gl.RGBA, this.gl.UNSIGNED_BYTE, pixelBuffer);

					// Flip pixelbuffer on its y-axis
					const flippedPixelBuffer = new Uint8Array(layer.section.Width * layer.section.Height * 4);
					for (let y = 0; y < layer.section.Height; y++) {
						for (let x = 0; x < layer.section.Width; x++) {
							const index = (y * layer.section.Width + x) * 4;
							const flippedIndex = ((layer.section.Height - y - 1) * layer.section.Width + x) * 4;
							flippedPixelBuffer[flippedIndex] = pixelBuffer[index];
							flippedPixelBuffer[flippedIndex + 1] = pixelBuffer[index + 1];
							flippedPixelBuffer[flippedIndex + 2] = pixelBuffer[index + 2];
							flippedPixelBuffer[flippedIndex + 3] = pixelBuffer[index + 3];
						}
					}

					this.gl.texImage2D(this.gl.TEXTURE_2D, 0, this.gl.RGBA, layer.section.Width, layer.section.Height, 0, this.gl.RGBA, this.gl.UNSIGNED_BYTE, flippedPixelBuffer);
				}
				
				this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MIN_FILTER, this.gl.LINEAR);
				this.gl.uniform1i(this.baseTextureLocation, 1);
			}

			// Draw
			this.gl.drawArrays(this.gl.TRIANGLES, 0, 6);
		}
	}
}

module.exports = CharMaterialRenderer;