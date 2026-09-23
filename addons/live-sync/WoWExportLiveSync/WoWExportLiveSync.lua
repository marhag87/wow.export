--[[
	wow.export Live Sync
	Draws the equipped item IDs as a strip of coloured blocks in a screen corner so
	wow.export can read them off the screen and re-export the character automatically.

	Wire format, left to right, one block each:

	  5 marker blocks : black, white, red, green, blue
	                    (locate the strip, and calibrate black/white levels)
	  129 data blocks : 6 bits each, 2 bits per channel, most significant first
	                    channel level = value * 85 (0, 85, 170, 255)
	  2 end markers   : white, black
	                    the distance from the first block to these gives the exact
	                    block pitch, which is fractional at most UI scales

	Data bits, most significant first:

	  4   format version (currently 3)
	  8   change counter, wraps at 256
	  234 13 slots x 18 bits, item ID or 0 for an empty slot
	  4   customization count, 0 when no barbershop visit has revealed them
	  504 14 customizations x (16 bit option ID + 20 bit choice ID), unused zero
	  16  CRC-16/CCITT-FALSE over the preceding bits, padded to whole bytes

	That is 770 bits in 774, so the last 4 bits are spare.

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

local FORMAT_VERSION = 3
local SLOT_BITS = 18
local SLOT_MAX = 2 ^ SLOT_BITS
local DATA_BLOCKS = 129

-- Customization choices are only known after a barbershop visit, so the count
-- doubles as a "not known" flag at zero. The slots are a fixed block whether
-- they are filled or not, which keeps the strip one width and the decoder
-- free of a variable length field. 14 covers every race on this client with
-- room to spare - the most seen so far is 7 - and fits the 4 bit count.
local CUST_SLOTS = 14
local CUST_COUNT_BITS = 4
local CUST_OPTION_BITS = 16
local CUST_CHOICE_BITS = 20
local CUST_OPTION_MAX = 2 ^ CUST_OPTION_BITS
local CUST_CHOICE_MAX = 2 ^ CUST_CHOICE_BITS

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

-- committed is the character's applied appearance and broadcast is what the
-- strip carries; they are the same except while a barbershop session is open,
-- when the strip holds still. Both are nil until a visit reveals them. See the
-- barbershop section further down.
local committed_customizations
local broadcast_customizations

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

	-- customization choices, when a barbershop visit has revealed them. a count
	-- of zero means not known, which wow.export leaves alone rather than reading
	-- as "this character has no customizations"
	local entries = broadcast_customizations or {}
	local count = #entries
	if count > CUST_SLOTS then
		count = CUST_SLOTS
	end

	push_bits(bits, count, CUST_COUNT_BITS)

	for i = 1, CUST_SLOTS do
		local entry = i <= count and entries[i] or nil
		local option_id, choice_id = 0, 0

		-- an id that does not fit is sent as zero rather than as its low bits,
		-- which would name a different option or choice
		if entry and entry.option_id < CUST_OPTION_MAX and entry.choice_id < CUST_CHOICE_MAX then
			option_id = entry.option_id
			choice_id = entry.choice_id
		end

		push_bits(bits, option_id, CUST_OPTION_BITS)
		push_bits(bits, choice_id, CUST_CHOICE_BITS)
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

-- The barbershop is the only place the client exposes which customization
-- choices a character currently has, and the data is live only for as long as
-- the session lasts. What is on the strip is therefore whatever the last visit
-- revealed, kept per character in saved variables so logging over does not
-- broadcast the previous one's appearance.
local capture_error
local session_ticker
local session_customizations
local session_has_changes

-- Only the appearance that is applied when the chair is left reaches the strip,
-- so what is on screen mid-session is tracked but not broadcast. The session has
-- to be polled to track it at all: there is no event for moving through options,
-- and the data is gone by the time the session closes.
local SESSION_POLL = 0.2

local function character_key()
	local name = UnitName('player')
	if not name or name == '' then
		return nil
	end

	local realm = GetRealmName and GetRealmName() or ''
	return name .. '-' .. (realm or '')
end

local function read_customizations()
	if type(C_BarberShop) ~= 'table' or type(C_BarberShop.GetAvailableCustomizations) ~= 'function' then
		return nil, 'this client has no C_BarberShop.GetAvailableCustomizations'
	end

	local ok, categories = pcall(C_BarberShop.GetAvailableCustomizations)
	if not ok then
		return nil, 'GetAvailableCustomizations errored: ' .. tostring(categories)
	end

	if type(categories) ~= 'table' or #categories == 0 then
		return nil, 'no customization data returned'
	end

	local entries = {}
	for _, category in ipairs(categories) do
		for _, option in ipairs(category.options or {}) do
			local choice = option.choices and option.choices[option.currentChoiceIndex]
			entries[#entries + 1] = {
				option_name = option.name or '?',
				option_id = option.id or 0,
				choice_name = choice and choice.name or '?',
				choice_id = choice and choice.id or 0,
			}
		end
	end

	if #entries == 0 then
		return nil, 'customization data contained no options'
	end

	-- a stable order keeps the strip from changing when the client reorders
	-- its categories, which would otherwise read as an appearance change
	table.sort(entries, function(a, b) return a.option_id < b.option_id end)

	return entries
end

local function same_customizations(a, b)
	if a == b then
		return true
	end

	if not a or not b or #a ~= #b then
		return false
	end

	for i = 1, #a do
		if a[i].option_id ~= b[i].option_id or a[i].choice_id ~= b[i].choice_id then
			return false
		end
	end

	return true
end

--- Put `entries` on the strip, bumping the counter when they differ.
local function broadcast_customizations_set(entries)
	if same_customizations(entries, broadcast_customizations) then
		return
	end

	broadcast_customizations = entries
	bump()
end

local function commit_customizations(entries)
	committed_customizations = entries

	local key = character_key()
	if not key then
		return
	end

	if type(WoWExportLiveSyncDB) ~= 'table' then
		WoWExportLiveSyncDB = {}
	end

	if type(WoWExportLiveSyncDB.characters) ~= 'table' then
		WoWExportLiveSyncDB.characters = {}
	end

	WoWExportLiveSyncDB.characters[key] = entries
end

--- Restore this character's last known appearance, if a visit ever revealed it.
local function load_committed_customizations()
	local key = character_key()
	if not key or type(WoWExportLiveSyncDB) ~= 'table' or type(WoWExportLiveSyncDB.characters) ~= 'table' then
		return
	end

	committed_customizations = WoWExportLiveSyncDB.characters[key]
	broadcast_customizations_set(committed_customizations)
end

--- Whether the chair holds changes that have not been paid for.
local function has_pending_changes()
	if type(C_BarberShop) ~= 'table' or type(C_BarberShop.HasAnyChanges) ~= 'function' then
		return false
	end

	local ok, pending = pcall(C_BarberShop.HasAnyChanges)
	return ok and pending or false
end

local function poll_session()
	local entries, err = read_customizations()
	if not entries then
		capture_error = err
		return
	end

	capture_error = nil
	session_customizations = entries
	session_has_changes = has_pending_changes()
end

local function start_session()
	session_customizations = nil
	session_has_changes = false
	poll_session()

	if type(C_Timer) ~= 'table' or type(C_Timer.NewTicker) ~= 'function' then
		return
	end

	if session_ticker then
		session_ticker:Cancel()
	end

	session_ticker = C_Timer.NewTicker(SESSION_POLL, poll_session)
end

local function end_session()
	if session_ticker then
		session_ticker:Cancel()
		session_ticker = nil
	end

	-- What is on screen with nothing pending has been paid for, so that is the
	-- character's appearance from here. Pending changes are discarded by leaving
	-- the chair, so those keep whatever was last committed - including the very
	-- first visit, which commits the appearance the character arrived with.
	if session_customizations and not session_has_changes then
		commit_customizations(session_customizations)
	end

	session_customizations = nil
	session_has_changes = false

	broadcast_customizations_set(committed_customizations)
end

local function report_customizations()
	local entries = broadcast_customizations

	if not entries then
		print('|cff33ff99wow.export live sync|r: no customizations known (' .. (capture_error or 'visit a barbershop') .. ')')
		return
	end

	print('|cff33ff99wow.export live sync|r: ' .. #entries .. ' customization choices')
	for _, entry in ipairs(entries) do
		print(string.format('  %s (%d) = %s (%d)', entry.option_name, entry.option_id, entry.choice_name, entry.choice_id))
	end
end

local events = CreateFrame('Frame')
events:RegisterEvent('PLAYER_ENTERING_WORLD')
events:RegisterEvent('PLAYER_EQUIPMENT_CHANGED')
events:RegisterEvent('DISPLAY_SIZE_CHANGED')
events:RegisterEvent('UI_SCALE_CHANGED')
events:RegisterUnitEvent('UNIT_INVENTORY_CHANGED', 'player')
events:RegisterEvent('BARBER_SHOP_OPEN')
events:RegisterEvent('BARBER_SHOP_CLOSE')

-- not every client build has this one, and registering an unknown event errors
pcall(events.RegisterEvent, events, 'BARBER_SHOP_APPEARANCE_APPLIED')
events:SetScript('OnEvent', function(_, event)
	if event == 'PLAYER_ENTERING_WORLD' then
		load_committed_customizations()
		redraw()
	elseif event == 'DISPLAY_SIZE_CHANGED' or event == 'UI_SCALE_CHANGED' then
		-- a unit is a different number of pixels now, so re-derive the scale
		if frame then
			apply_pixel_scale()
		end
	elseif event == 'BARBER_SHOP_OPEN' then
		start_session()
	elseif event == 'BARBER_SHOP_APPEARANCE_APPLIED' then
		-- catches a change that is paid for and then changed again and
		-- cancelled, which would otherwise revert past it on the way out
		if session_customizations then
			commit_customizations(session_customizations)
		end
	elseif event == 'BARBER_SHOP_CLOSE' then
		end_session()

		-- chat is reachable again now that the barbershop UI has gone away
		report_customizations()
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
	elseif msg == 'cust' then
		report_customizations()
	else
		bump()
		local parts = {}
		for _, slot_id in ipairs(SLOT_IDS) do
			parts[#parts + 1] = slot_id .. '=' .. (GetInventoryItemID('player', slot_id) or 0)
		end
		print('|cff33ff99wow.export live sync|r: counter ' .. counter .. ', ' .. table.concat(parts, ' '))
	end
end
