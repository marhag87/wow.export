--[[
	wow.export Live Sync
	Draws the equipped item IDs as a strip of coloured blocks in a screen corner so
	wow.export can read them off the screen and re-export the character automatically.

	Wire format, left to right, one block each:

	  5 marker blocks : black, white, red, green, blue
	                    (locate the strip, and calibrate black/white levels)
	  44 data blocks  : 6 bits each, 2 bits per channel, most significant first
	                    channel level = value * 85 (0, 85, 170, 255)
	  2 end markers   : white, black
	                    the distance from the first block to these gives the exact
	                    block pitch, which is fractional at most UI scales

	Data bits, most significant first:

	  4   format version (currently 2)
	  8   change counter, wraps at 256
	  234 13 slots x 18 bits, item ID or 0 for an empty slot
	  16  CRC-16/CCITT-FALSE over the preceding bits, padded to whole bytes

	That is 262 bits in 264, so the last 2 bits are spare.

	Slots are in SLOT_IDS order below, matching the game's inventory slot IDs.

	Blocks are sized in real screen pixels (see apply_pixel_scale), which keeps the
	strip as small as the decoder can read regardless of resolution or UI scale.
]]

-- Block size in real screen pixels. wow.export captures the screen at its true
-- resolution, so a block arrives exactly this wide and one pixel is enough.
--
-- There is no margin left at this size: anything that resamples the capture, or
-- shifts it by a pixel, loses the strip entirely, and the app just reports it as
-- not visible. Raising these to 3 restores some tolerance if that ever happens.
--
-- The height is 2 because the app's search steps two rows at a time, so a two
-- pixel line is guaranteed to fall on a row it looks at.
local BLOCK_W = 1
local BLOCK_H = 2

local MARKERS = {
	{ 0, 0, 0 },
	{ 1, 1, 1 },
	{ 1, 0, 0 },
	{ 0, 1, 0 },
	{ 0, 0, 1 },
}

local END_MARKERS = {
	{ 1, 1, 1 },
	{ 0, 0, 0 },
}

local FORMAT_VERSION = 2
local SLOT_BITS = 18
local SLOT_MAX = 2 ^ SLOT_BITS
local DATA_BLOCKS = 44

-- game inventory slot IDs, in the order they are packed into the payload
local SLOT_IDS = {
	1,  -- head
	3,  -- shoulders
	4,  -- shirt
	5,  -- chest
	6,  -- waist
	7,  -- legs
	8,  -- feet
	9,  -- wrist
	10, -- hands
	15, -- back
	16, -- main hand
	17, -- off hand
	19, -- tabard
}

local counter = 0
local blocks = {}
local frame

--- CRC-16/CCITT-FALSE over a byte array.
local function crc16(bytes)
	local crc = 0xFFFF
	for i = 1, #bytes do
		crc = bit.bxor(crc, bit.lshift(bytes[i], 8))
		for _ = 1, 8 do
			if bit.band(crc, 0x8000) ~= 0 then
				crc = bit.band(bit.bxor(bit.lshift(crc, 1), 0x1021), 0xFFFF)
			else
				crc = bit.band(bit.lshift(crc, 1), 0xFFFF)
			end
		end
	end
	return crc
end

--- Append the low `width` bits of `value`, most significant first.
local function push_bits(bits, value, width)
	for i = width - 1, 0, -1 do
		bits[#bits + 1] = bit.band(bit.rshift(value, i), 1)
	end
end

local function build_payload()
	local bits = {}
	push_bits(bits, FORMAT_VERSION, 4)
	push_bits(bits, counter, 8)

	for _, slot_id in ipairs(SLOT_IDS) do
		local item_id = GetInventoryItemID('player', slot_id) or 0

		-- 18 bits covers every live item ID; report an out-of-range one as empty
		-- rather than sending its low bits, which would name a different item
		if item_id >= SLOT_MAX then
			item_id = 0
		end

		push_bits(bits, item_id, SLOT_BITS)
	end

	-- CRC over the bits so far, zero padded to whole bytes
	local bytes = {}
	for i = 1, #bits, 8 do
		local byte = 0
		for j = 0, 7 do
			byte = byte * 2 + (bits[i + j] or 0)
		end
		bytes[#bytes + 1] = byte
	end

	push_bits(bits, crc16(bytes), 16)
	return bits
end

--- Scale the frame so one of its units is one real screen pixel.
--
-- A unit at scale 1 is screen_height/768 pixels, so on a 4K display an 8 unit
-- block is 22.5 pixels wide. Scaling by the inverse makes the sizes below mean
-- what they say. SetIgnoreParentScale keeps UIParent's own scale out of it.
local function apply_pixel_scale()
	local physical_height
	if GetPhysicalScreenSize then
		local _, height = GetPhysicalScreenSize()
		physical_height = height
	end

	if not physical_height or physical_height <= 0 then
		physical_height = GetScreenHeight() * UIParent:GetEffectiveScale()
	end

	frame:SetScale(768 / physical_height)
end

local function create_frame()
	frame = CreateFrame('Frame', 'WoWExportLiveSyncStrip', UIParent)

	if frame.SetIgnoreParentScale then
		frame:SetIgnoreParentScale(true)
	end

	apply_pixel_scale()
	frame:SetFrameStrata('TOOLTIP')
	frame:SetSize((#MARKERS + DATA_BLOCKS + #END_MARKERS) * BLOCK_W, BLOCK_H)
	frame:ClearAllPoints()
	frame:SetPoint('TOPLEFT', UIParent, 'TOPLEFT', 0, 0)

	for i = 1, #MARKERS + DATA_BLOCKS + #END_MARKERS do
		local tex = frame:CreateTexture(nil, 'OVERLAY')
		tex:SetSize(BLOCK_W, BLOCK_H)
		tex:SetPoint('TOPLEFT', frame, 'TOPLEFT', (i - 1) * BLOCK_W, 0)
		blocks[i] = tex
	end

	for i, colour in ipairs(MARKERS) do
		blocks[i]:SetColorTexture(colour[1], colour[2], colour[3], 1)
	end

	for i, colour in ipairs(END_MARKERS) do
		blocks[#MARKERS + DATA_BLOCKS + i]:SetColorTexture(colour[1], colour[2], colour[3], 1)
	end
end

local function redraw()
	if not frame then
		create_frame()
	end

	local bits = build_payload()

	for i = 1, DATA_BLOCKS do
		local base = (i - 1) * 6
		local channels = {}

		for c = 0, 2 do
			local hi = bits[base + c * 2 + 1] or 0
			local lo = bits[base + c * 2 + 2] or 0
			channels[c + 1] = (hi * 2 + lo) / 3
		end

		blocks[#MARKERS + i]:SetColorTexture(channels[1], channels[2], channels[3], 1)
	end
end

local function bump()
	counter = (counter + 1) % 256
	redraw()
end

local events = CreateFrame('Frame')
events:RegisterEvent('PLAYER_ENTERING_WORLD')
events:RegisterEvent('PLAYER_EQUIPMENT_CHANGED')
events:RegisterEvent('DISPLAY_SIZE_CHANGED')
events:RegisterEvent('UI_SCALE_CHANGED')
events:RegisterUnitEvent('UNIT_INVENTORY_CHANGED', 'player')
events:SetScript('OnEvent', function(_, event)
	if event == 'PLAYER_ENTERING_WORLD' then
		redraw()
	elseif event == 'DISPLAY_SIZE_CHANGED' or event == 'UI_SCALE_CHANGED' then
		-- a unit is a different number of pixels now, so re-derive the scale
		if frame then
			apply_pixel_scale()
		end
	else
		bump()
	end
end)

SLASH_WOWEXPORTLIVESYNC1 = '/wxls'
SlashCmdList.WOWEXPORTLIVESYNC = function(msg)
	if msg == 'hide' then
		if frame then frame:Hide() end
		print('|cff33ff99wow.export live sync|r: strip hidden')
	elseif msg == 'show' then
		if frame then frame:Show() end
		print('|cff33ff99wow.export live sync|r: strip shown')
	else
		bump()
		local parts = {}
		for _, slot_id in ipairs(SLOT_IDS) do
			parts[#parts + 1] = slot_id .. '=' .. (GetInventoryItemID('player', slot_id) or 0)
		end
		print('|cff33ff99wow.export live sync|r: counter ' .. counter .. ', ' .. table.concat(parts, ' '))
	end
end
