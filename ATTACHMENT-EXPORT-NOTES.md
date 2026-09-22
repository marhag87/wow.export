# Character attachment export — findings

Session notes, 2026-09-16. Scope: why equipped pauldrons (and other attached
items) do not appear in the right place on exported character models, plus glTF
material alpha. Limited to WoW Classic. Target consumer is Unity via glTF.

Updated 2026-09-17: the attachment fix (#1) is verified against a real Classic
client, the glTF alpha/double-sided bug (#5) is fixed and verified, and the
project now builds locally (see "Building locally"). Also fixed: customization
choices that enable several geosets only applied one (#7), and attachment
bones lost their scale in most glTF animations (#8), boot textures covered
Tauren hooves (#9), and cloaks rendered untextured (#10). Added live sync, which
reads equipped gear off the running game and re-exports (see "Features added"). Added: an option to export
characters into a folder named after the character, saving updates the open
saved character in place, and glTF character exports can face +Z (see
"Features added"). Also fixed the Characters tab taking ~25s to open, which was
a quadratic DB2 row lookup rather than any download (see "Startup performance"),
and shrank the live sync strip from roughly 1240x22 pixels to 51x2 (see
"Shrinking the strip").

## How the viewer places attachments

1. `SLOT_TO_ATTACHMENT` in `src/js/wow/EquipmentSlots.js` maps an equipment slot
   to an M2 attachment ID. Shoulders are slot 3 -> `SHOULDER_LEFT` (6) and slot
   30 -> `SHOULDER_RIGHT` (5). Head -> `HELMET` (11), main-hand -> `HAND_RIGHT`
   (1), off-hand -> `HAND_LEFT` (2) / `SHIELD` (0), back -> `BACK` (12).
2. `update_equipment_models()` in `src/js/modules/tab_characters.js` loads one
   `M2RendererGL` per attached model, flagged `is_collection_style: false`.
   Models beyond the available attachment IDs become "collection" models, which
   share the character skeleton by bone remapping instead.
3. Every frame, `M2RendererGL.getAttachmentTransform(id)` resolves the
   attachment record, takes the character's animated bone world matrix,
   post-multiplies the attachment's local offset (with a WoW -> GL axis swap),
   and pre-multiplies the character's `model_matrix`. The result is pushed onto
   the item renderer via `setTransformMatrix`.

The attached mesh is never skinned. It is a rigid child of one bone. Item M2s
are authored in their own local space with the origin at the attachment point,
so no baking of the character pose into the item geometry is needed.

## Per-race scaling

There is no per-race scale field in the DBCs for Classic, and none in the
codebase. Two things produce the per-race differences:

- Each race/gender character M2 has its own bone pivots and attachment offsets.
  This is what makes a Tauren's pauldrons sit further out than a Gnome's, and it
  is the entire mechanism in a static (rest pose) export.
- `ComponentModelFileData.PositionIndex` selects different left/right shoulder
  models per race (`DBItemModels.js`).

M2 bones have no rest-pose scale, only animated scale tracks. Those tracks *are*
exported as glTF `scale` animation channels (`GLTFWriter.js`), so a mesh
parented to a joint inherits them for free when animations are exported.

Correction (2026-09-17): bone scale *is* a per-race size mechanism for
shoulders. The shoulder attachment bones carry a constant scale in the model's
first animation only: 1.7 on Orc male (`bone_106`/`107`, first animation
Stand) and 1.6 on Tauren male (`bone_116`/`117`, first animation Walk). The
renderer applies that scale to every animation (see #8). Pivots and offsets
still decide placement; this decides size. A rest-pose export with no
animation playing shows the pauldrons at 1x.

## Bugs found

### 1. glTF: attachment link never written — FIXED, VERIFIED

`tab_characters.js` calls `get_equipment_geometry(false)` for glTF, deliberately
leaving the pose to the armature. But attachment models carry no bone weights
(only collection models do), `M2Exporter` never set `attachment_bone`, and
`GLTFWriter` wrote `node.parent_bone = ...`, which is not a glTF property and is
ignored by every consumer. Net result: attached items exported at the origin,
unparented and unrigged.

Fixed in commit `58fe6333` (see "Changes applied" below).

Verified on a Classic Tauren with pauldrons, exported as glTF with
`modelsExportAnimations` on: the pauldrons sit on the shoulders, follow the
bones through animations, in both Blender and Unity (glTFast).

Correction: "the right size" held only for the Orc in Stand, which happens to
be the one animation carrying the shoulder bones' scale. Other animations and
the Tauren were too small until #8. The vtube project's manual `gearScale` of
1.8 was approximating that missing 1.6-1.7 bone scale.

### 2. OBJ/STL: wrong transform — NOT FIXED

- With *Apply Pose* off, equipment is written untransformed at the origin.
- With *Apply Pose* on, `getAttachmentTransform` includes the character's
  `model_matrix`, which in character mode carries the viewer's Y rotation
  (`model-viewer-gl.js`, `setTransform([0,0,0],[0,rotation_y,0],...)`). The
  body's baked geometry (`getBakedGeometry`) does not include it. Equipment
  therefore orbits the origin relative to the body by whatever angle the model
  was spun to. It lines up only at the default facing.

Fix: at export time use the attachment transform without the final
`model_matrix` multiply — a flag on `getAttachmentTransform`, or a variant that
stops before it. Baking is the only option for OBJ/STL; there is no node
hierarchy to parent into.

### 3. Creature tab: equipment geometry never exported — NOT FIXED

`tab_creatures.js` loads equipment models for the viewer but the export path
never builds a `CharacterExporter` or calls `setEquipmentModels`. NPC weapons
and shoulders are composited into the textures while the geometry is silently
dropped, in every format. Missing feature rather than a placement bug.

### 4. Shields likely attach to the wrong point — NOT INVESTIGATED

`SLOT_TO_ATTACHMENT[17]` is `[HAND_LEFT, SHIELD]` and models are paired to
attachments by index, so a single-model shield takes `attachment_ids[0]` =
`HAND_LEFT` rather than `SHIELD` (0, the forearm). The grip check in
`model-viewer-gl.js` tests for `attachment_id === SHIELD` and can never match.
Affects the viewer and the export equally. Needs confirming against a real
shield.

### 5. glTF: texture alpha ignored, materials never double-sided — FIXED, VERIFIED

Fixed in commit `42a67c4a` (see "Changes applied" below). Tauren hair renders
correctly in Blender and Unity. The analysis as originally written follows.

Symptom: Tauren hair (and any alpha-keyed geometry — foliage, tabard fringes,
eyebrows) exports as solid slabs.

`GLTFWriter.js` builds every material as name + `emissiveFactor` +
`pbrMetallicRoughness{ baseColorTexture, metallicFactor }`. There is no
`alphaMode`, so the glTF default `OPAQUE` applies and importers correctly ignore
the alpha channel — the PNG carries the transparency, the material says not to
look at it. There is no `doubleSided` either, so single-sided hair cards lose
their back faces to culling even once alpha works.

The data needed is already parsed: `M2Loader.js` reads
`materials[i] = { flags, blendingMode }`, and the exporter already resolves
`texUnit` per submesh, which carries `materialIndex`. Mapping:

- blendingMode 0 -> opaque (leave as is)
- blendingMode 1 (alpha key) -> `alphaMode: "MASK"` + `alphaCutoff`
- blendingMode 2 (alpha blend) -> `alphaMode: "BLEND"`
- `flags & 0x4` -> `doubleSided: true`

Structural snag: `GLTFWriter` keys materials by *texture* (`this.textures`,
fileDataID -> matName) while blend mode belongs to the M2 *material*, and the
two are not 1:1. A texture used by both an opaque and an alpha-keyed material
needs two glTF materials. Character hair does not hit this (its texture is its
own file), so threading blend info onto the `textureMap` entries in
`M2Exporter.exportTextures` and reading it in the writer's material loop would
fix the character case in ~30 lines. Doing it properly for arbitrary models
means keying materials by (texture, blendingMode, flags).

A stale TODO on the OBJ path already notes the double-sided half:
`M2Exporter.js:148`, "Use m2.materials[texUnit.materialIndex].flags & 0x4 to
determine if it's double sided".

Not tracked as an open upstream bug against the writer. Issue #392
("Transparent textures in blender", closed) is the same complaint, answered with
DCC-side workarounds rather than an export fix.

The fix went the "properly" route rather than the ~30-line character hack:
materials are keyed by (texture, alphaMode, doubleSided) and created on first
use. Blend modes 3-7 (additive, modulate) have no glTF equivalent and are
approximated as BLEND. The MASK cutoff is 0.501960814, the same threshold the
viewer's M2 shader uses. The OBJ TODO at `M2Exporter.js:148` is still open.

Which blend mode Tauren hair uses was not recorded; the result renders
correctly either way. Search the exported `.gltf` for `"alphaMode"` to see it.

### 6. Hand grip is viewer-only — BY DESIGN, WORTH KNOWING

`setHandGrip` swaps finger bones to HandsClosed at render time. glTF joint
animations are written from the raw M2 tracks, not sampled from the renderer, so
exported fingers stay open around a weapon.

### 7. Customization choices apply only one of their geosets — FIXED, VERIFIED

Symptom: a Classic Tauren's beard, nose rings and ears had to be ticked by hand
in Custom Geoset Control after every refresh, and saved characters lost them.
Geoset Control edits `chrCustGeosets` directly and is not recorded anywhere, so
`update_geosets` (run on any appearance change) resets it and the save format
(`get_current_character_data`) never stores it.

Root cause: `DBCharacterCustomization.js` loaded `ChrCustomizationElement` with
`choice_to_geoset.set(choiceID, geosetID)`. A choice with several geoset
elements kept only the last row, so the other geosets were never enabled.
Element rows can also carry `RelatedChrCustomizationChoiceID`, which was
ignored for geosets (it was already honoured for materials).

Fixed in commit `5b241122`:

| File | Change |
| --- | --- |
| `src/js/db/caches/DBCharacterCustomization.js` | `choice_to_geoset` holds a list of `{ ChrCustomizationGeosetID, RelatedChrCustomizationChoiceID }` per choice. New `get_choice_geosets(choice_id)` returns `{ geoset_id, related_choice_id }[]`. `get_choice_geoset_id` / `get_choice_geoset_raw` return the first entry for compatibility. |
| `src/js/ui/character-appearance.js` | `apply_customization_geosets` collects every geoset referenced by any choice of an active option into a hide set and the selected choices' geosets (related choice satisfied) into a show set, then applies hide before show. The old per-option loop let a later option's unselected choices hide a geoset an earlier option enabled. |

Shared with `tab_creatures.js`, so NPC customization geosets change too.
Verified in the viewer: the Tauren's beard, nose rings and ears appear from the
customization choices alone.

Not done: saving manual Geoset Control overrides. With this fix it was no longer
needed. If it ever is, record user toggles as `geoset_overrides` (id -> bool),
reapply them at the end of `update_geosets`, clear them on race/model change,
and pass them through `chrImport*` state on load (save format version 3).

### 8. glTF: attachment bones lose their scale outside animation 0 — FIXED, VERIFIED

Symptom: pauldrons looked right in the Orc's Stand but shrank in Wave and every
other animation; Tauren pauldrons were always too small.

The shoulder attachment bones have a scale track with keys only in animation 0
(the M2's first sequence, which is Stand for Orc male but Walk for Tauren
male). The M2 renderer handles this: `M2RendererGL.js` `has_scale_fallback`
samples animation 0's scale at time 0 for any animation without its own scale
data (upstream `eb5dbd17`, "fix item attachment scale"). `GLTFWriter` wrote
scale channels only where keys exist, so glTF consumers left the bone at scale
1 in every other animation.

Fixed in commit `e3294fbe`: `get_bone_scale_track(bone, anim_index)` returns the
animation's own scale keys, or a single key of animation 0's first value when
the animation has none, mirroring the renderer. Buffer sizing and channel
writing both use it. Applies to every bone, as in the renderer.

Pitfall hit while fixing: the scale loop iterated `bone.scale.timestamps.length`.
The outer track array length comes from the file, and a bone scaled only in
animation 0 can store a single-entry track, so the loop never reached the
animations needing the fallback. The first attempt passed a synthetic test
(one entry per animation) but changed nothing on real exports. The loop now
iterates `this.animations.length`. The renderer reads with optional chaining
(`timestamps?.[idx]`) and never had this problem. Translation and rotation
loops still iterate the track length, which is fine because they have no
fallback.

Verified in vtube: Orc pauldrons hold 1.7x and Tauren 1.6x across Stand, Wave
and other emotes.

Testing tip: `GLTFWriter` can be run under plain Node by stubbing `core`, `log`
and `generics` via `Module._load` and defining `global.nw.App.manifest`, then
feeding it synthetic bones and animations. That is how the single-entry track
case was reproduced without a client. Make synthetic tracks match what the
loader really produces.

### 9. Boot textures drawn over bare-feet races' feet — FIXED, VERIFIED

Symptom: with boots equipped, a Tauren's hooves were fully covered by the boot
texture; in game the hooves stay visible and only the leg part of the boot is
drawn.

`ChrRaces.Flags & 0x2` is "Bare Feet" (named `DoNotComponentFeet` in 10.1.7,
per wowdev.wiki DB/ChrRaces): the client does not composite item textures onto
the FOOT component section (`CharComponentTextureSections` type 7) for those
races. wow.export ignored the flag and drew every section of every item.

Fixed in commit `0913d9d2`:

| File | Change |
| --- | --- |
| `src/js/db/caches/DBCharacterCustomization.js` | Race map entries carry `bareFeet`; new `is_race_bare_feet(race_id)`. |
| `src/js/modules/tab_characters.js` | `update_textures` skips item textures with `section === COMPONENT_SECTION.FOOT` for bare-feet races. |
| `src/js/modules/tab_creatures.js` | Same skip for NPC equipment, using `DisplayRaceID`. |

Texture-only: the exported `data-*.png` skin textures come from the same
compositing, so exports pick it up. If a boot *geoset* ever replaces hoof
geometry, that is a separate geoset-side issue (not seen so far). Verified in
the viewer on the Tauren.

### 10. Cloaks untextured — FIXED, VERIFIED

Symptom: an equipped cloak showed the viewer's light-blue missing-texture
placeholder, in the preview and in exports.

Classic cloaks have no model of their own. The cloak is a character geoset
(group 15xx) textured through M2 replaceable texture type 2 (cape), and the
texture comes from the item's `ItemDisplayInfo.ModelMaterialResourcesID[0]`.
Three gaps:

1. `DBItemModels` skipped every display with no `ModelResourcesID`, so a
   cloak's material resources were never recorded.
2. Nothing in the character tab bound replaceable type 2 on the character
   model.
3. The character export built `M2Exporter(data, [], id)`, so type 2 had no
   variant texture (`variantTextures[textureType - 2]`) and no material.

Fixed in commit `e849d4f9`:

| File | Change |
| --- | --- |
| `src/js/db/caches/DBItemModels.js` | Keeps `ModelMaterialResourcesID` for every display (`display_to_model_material_res`), including model-less ones. New `getItemModelTexture(item_id, modifier_id, index = 0)` resolves through `DBTextureFileData.getTextureFDIDsByMatID`, falling back to `ItemDisplayInfoModelMatRes` (modern data). |
| `src/js/modules/tab_characters.js` | `update_textures` step 6: looks up slot 15's cape texture and calls `active_renderer.overrideTextureType(2, fdid)`; kept in `cape_texture_file_data_id` and passed as `variantTextures[0]` to `M2Exporter` for glTF/GLB and OBJ/STL. |

Verified in the viewer on the Troll with Flimsy Chain Cloak. Not covered: the
creatures tab, where NPC cloaks may still show the placeholder.

## Features added

### Export characters to a named folder (commit 1a452efe)

Character exports always went to `<Export Directory>/<listfile path>`, e.g.
`character/tauren/male/taurenmale.gltf`, so every Tauren male export landed in
the same folder. A new **Export to character folder** checkbox in the character
export panel (config `chrExportToNamedFolder`, default off) writes to
`<Export Directory>/<Character Name>/<model file>` instead.

- A **Character Name** text box appears when the checkbox is on. View state
  `chrExportName` follows the open saved character (see the next feature),
  is set to the typed name on a successful Armory import, and can be edited
  before each export. It is not persisted across restarts.
- Applies to glTF, GLB, OBJ and STL; the checkbox is hidden for PNG/Clipboard.
- `get_character_export_file(core, file_name, ext)` in `tab_characters.js`
  resolves the export-relative path used for both the export path and
  `helper.mark`, so "View in Explorer" opens the character folder. Characters
  Windows rejects (`<>:"/\|?*`, control characters) and trailing dots/spaces
  are stripped; an empty result aborts the export with a toast before the
  export helper starts. `removePathSpaces` applies as for any export path.
- With `enableSharedTextures` off, textures land in the character folder; with
  it on they still go to the shared game paths.
- Layout pitfall: the global `input[type=text]` rule in `app.css` sets
  `width: 300px` and `margin: 10px`, which widened the export panel. The name
  box uses class `chr-export-name` (`width: auto; min-width: 0; margin: 0;
  box-sizing: border-box`) plus `size="1"` so its intrinsic width cannot grow
  the panel.

Verified in the app.

### Save updates the open character (commit 2c00e8c2)

Before: every save went through the name prompt (emptied each time) and
`save_character` always generated a new random id, so re-saving a loaded
character after a gear change added a duplicate to My Characters. Saving was
also the only automatic way to fill the export folder name.

Now the viewer tracks which saved character is open:

- View state `chrCurrentCharacter` (`{ name, id }` or null), set through
  `set_current_character(core, character)` in `tab_characters.js`, which also
  sets `chrExportName` to the character's name (or clears it).
- Set on load from My Characters and on save / save-as-new. Cleared by
  `apply_import_data` (Armory, WMV, Wowhead) and by loading a JSON file
  straight into the viewer (which then uses the file's `name` for the export
  name if present). Deleting the open character clears the tracking but keeps
  the character in the viewer.
- `save_character(core, name, thumb, existing_id = null)` overwrites
  `<name>-<id>.json` and its thumbnail when given an id, otherwise creates a new
  entry. The toast says "updated" vs "saved".
- The viewer's quick-save button and the My Characters save button call
  `save_current_character`: overwrite without a prompt when a character is
  open ("Save Hoom" as label/tooltip), otherwise open the name prompt.
- **Save As New** (My Characters, only shown with a character open) opens the
  prompt pre-filled with the current name, titled "Save As New Character"; it
  always creates a new entry, which becomes the open character.
- The open character's card gets a highlighted thumbnail border
  (`.saved-character-card.current`).

Not done (considered): remembering the open character or export name across
restarts (config, or reopening the last character on startup), and a separate
per-character export folder name stored in the save file.

Verified in the app.

### Face forward (+Z) for glTF character exports (commit 63d03eef)

The M2 loader converts WoW coordinates to glTF as `(x, y, z) -> (x, z, -y)`
(`M2Loader.js` vertex read) without rotating, so models face +X. glTF's
convention is +Z forward, so exports looked sideways in Blender's front view and
vtube needed a `FacingCorrectionY = -90` fix in `AvatarSetup`.

New **Face forward (+Z)** checkbox in the character export panel (config
`chrExportFaceForward`, default off, shown for glTF/GLB only):

- `GLTFWriter.setRootRotation(quat)` sets `rotation` on the root node (node 0).
  Every other node is its descendant — the `<model>_skeleton` node, all mesh
  nodes (`add_scene_node` pushes to node 0) and attachment meshes under joints
  — so the whole character turns, while vertex, bone and animation data are
  unchanged. Animation channels target joints below the root, so they are
  unaffected. Unset, output is identical to before.
- `M2Exporter.setGLTFFaceForward(bool)` requests
  `[0, -SQRT1_2, 0, SQRT1_2]` (-90 degrees about Y), which maps +X onto +Z.
  Checked in the Node harness (+X -> (0, 0, 1)).
- Only the character tab uses it. A global change was rejected: it would
  change every glTF export for everyone, and the Blender add-on, existing
  scenes and map placement (world-positioned M2s) depend on the current axes.
  OBJ/STL have no root node and are not covered.

Verified: Blender front view (numpad 1) shows the character from the front.
vtube needed additional changes of its own to handle the rotated root
(done in the vtube repo).

### Live sync from the running game (commit 8e43c888)

Goal: a gear change in game reaches vtube in seconds with no action taken. vtube
already reloads an export when its files change, so only wow.export's side was
missing.

**Getting data out of the game.** Addons cannot write files on demand.
Considered and rejected: SavedVariables (needs `/reload`, i.e. a keypress); the
Armory API (only updates after logout, minutes late); reading client memory
(against Blizzard's terms). A screenshot-based channel was tried next - the
addon would call `Screenshot()` and wow.export would watch the folder - but
`Screenshot` is nil in the Classic client (`TakeScreenshot` was removed in
4.0.2), and it would clutter the screenshots folder anyway.

**The channel that works:** the addon keeps a strip of coloured blocks on screen
encoding the equipped item IDs, and wow.export reads it off the screen.

| Part | What it is |
| --- | --- |
| `addons/live-sync/WoWExportLiveSync/` | The addon. 5 marker blocks (black, white, red, green, blue), 44 data blocks (6 bits each, 2 bits per channel, levels 0/85/170/255), 2 end markers (white, black). Payload: 4-bit format version, 8-bit change counter, 13 slots x 18-bit item ID, CRC-16/CCITT-FALSE. Redraws on `PLAYER_EQUIPMENT_CHANGED`; `/wxls` prints what it is encoding. Format version 2; see "Shrinking the strip". |
| `addons/live-sync/decode-strip.js` | Reads a PNG screenshot and hands the pixels to `strip-decoder.js`, so the tool cannot drift from the app. Includes a minimal PNG reader. |
| `src/js/ui/strip-decoder.js` | The same decode against a captured frame. |
| `node_addons/screencap/` | Windows-only GDI screen grab (`capture(x, y, w, h)` -> RGBA, `virtualScreen()`). |
| `src/js/screencap.js` | Loads it like `mmap.js`; reports unavailable rather than throwing. |
| `src/js/ui/live-sync.js` | Finds the strip once across all displays, then grabs only its region each interval; rescans after 3 consecutive misses. |
| `src/js/modules/tab_characters.js` | "Live sync from game" checkbox and status line; applies the equipment and exports, queued so a burst of swaps cannot overlap. |

**Chromium capture is unavailable in this app.** `navigator.mediaDevices`,
`navigator.webkitGetUserMedia` and `navigator.getUserMedia` are all undefined on
the app's `chrome-extension://` page, even though it is a secure context;
`nw.Screen.chooseDesktopMedia` exists but there is nothing to turn its source id
into a stream. Hence the native addon. It needs `/std:c++17` in `binding.gyp`
(`AdditionalOptions`), because VS 2019 ignores the `/std:c++20` the nw.js
headers pass and `node-addon-api` 8.x uses `std::string_view`.

**Two decoding traps, both real and both fixed:**

1. *Fractional pitch.* The game rounds each block to whole pixels, so at the
   test UI scale blocks alternate 23 and 22 pixels for a pitch of 22.5. Rounding
   the pitch drifts a whole block a third of the way along - the first slots
   decode, the rest are garbage. The white end marker, 53 blocks along, gives
   the pitch to about 1/53 of a pixel; marker centres alone are only good to
   half a pixel, which is not enough. The end marker is only accepted if its run
   is about one block wide and is followed by the black block.
2. *Anchoring on black.* The first search anchored on the black first block. A
   second monitor whose top row is black ran straight into it, so the run looked
   thousands of pixels wide, was rejected as too large, and the scan skipped the
   strip. It now anchors on the red marker (rare on screen) and confirms green
   and blue after it.

Windows also handed the app scaled coordinates: a 4K panel at 125% was captured
as 3072x1728, so the strip arrived at 18 pixels per block. Verified decoding at
full size and at 0.8, 0.6 and 0.5 scale, and that a capture without a strip
decodes to nothing. Decode costs ~0.1ms per frame once the strip is located; the
default interval is 1s (`chrLiveSyncIntervalMs`). The scaling is gone as of
commit 27282234 - see "Shrinking the strip" below.

**Behaviour decisions:** the toggle is view state, not config, so live sync is
always off at launch. It switches itself off whenever the loaded model changes,
since the game's gear must not land on a different character. The last opened
saved character is remembered (`chrLastCharacter`) and reopened at startup, so
live sync has the right character to dress instead of the default model. Item
IDs only - appearance variants are rare in Classic, and the strip has spare
capacity if that changes.

Verified end to end: gear change in game -> export -> vtube reloads.

### Shrinking the strip (commit 27282234)

The strip started out about 1240x22 pixels, which is intrusive. It is now 255x5.
Three separate things made it large.

**The capture was needlessly lossy.** The app is only system-DPI-aware, so
Windows virtualises GDI for it: on a 4K display at 125% both `GetSystemMetrics`
and `BitBlt` return the scaled 3072x1728 desktop, and the captured image is a
resampled copy. That is what made the fractional pitch above a problem at all,
and it forced blocks big enough to survive resampling. `capture()` and
`virtualScreen()` now call `SetThreadDpiAwarenessContext` with
`PER_MONITOR_AWARE_V2` for the duration of the call, resolved through
`GetProcAddress` so the addon still builds and runs without it, and restored by
a destructor on the way out. Frames are now true pixels: the log reads
`searching 8320x2160 ... (dpi aware: true)` where it used to say 1728, and the
measured pitch is exactly the block size.

**The block size was never in pixels.** The addon called
`SetIgnoreParentScale(true)` and claimed to be drawing in physical pixels, but
that only drops the *parent's* scale - a unit is still `screen_height/768`
pixels, so on 4K an 8 unit block was 22.5 pixels. The frame is now scaled by
`768/physical_height` (from `GetPhysicalScreenSize`), so sizes mean what they
say, and it re-derives on `UI_SCALE_CHANGED` and `DISPLAY_SIZE_CHANGED`.

**The payload had slack.** Item IDs are 18 bits, not 20: 262143 covers every
live ID with room over retail's ~240k. 48 data blocks became 44.

Two bugs surfaced while verifying this with a simulation harness that renders the
strip, area-averages it down and runs the real decoder:

1. *CRC padding.* The addon pads the payload with zeroes to whole bytes; the
   decoder padded with whatever bits followed, which are the CRC itself. Harmless
   while the payload was 272 bits (34 bytes exactly), fatal at 246.
2. *The end marker search could miss.* The pitch estimate comes from two marker
   centres two blocks apart, so its error compounds over the 49 blocks to the end
   marker - further than the search window reached. `find_strips` is now a
   generator yielding every candidate position and `decode_frame` keeps the first
   whose CRC passes. This also made behaviour monotonic in block size: before it,
   7 pixel blocks failed at 0.6667 scale but worked at 0.5.

Measured floor at that point was about 3.5 pixels per block, and 5 was chosen so
the strip still read if a capture were scaled to 0.8. Going below that needed the
decoder changes below.

### One pixel per block (commit 78c1eb36)

The strip is now **51x2 pixels**. Since captures are no longer resampled, the
decoder's blur tolerance was dead weight:

- block centres are sampled with `Math.floor`, not `Math.round`. `round` lands in
  the *next* block once a block is one or two pixels wide, and `floor` is the
  correct pixel index for a centre coordinate at any size. This was costing
  margin at every size: a 5 pixel strip now decodes down to a capture scaled to
  0.5, where it previously gave up below 0.75.
- `next_run` no longer discards single pixel runs, which only existed as the
  blend edges of a scaled capture.
- the red anchor accepts a single pixel run, and the minimum pitch drops to 1.
- candidates are checked against the five markers *before* the pitch is measured
  across the whole strip. Far more candidates reach that point at this size, so
  this matters: a full sweep of the 8320x2160 desktop with no strip present takes
  74ms, which is well inside the 1s interval.

The strip is 2 pixels tall, not 1, because the search steps 2 rows at a time, so
a 2 pixel line is guaranteed to fall on a row it looks at.

**There is no margin left at this size.** Anything that resamples the capture or
shifts it by a pixel loses the strip, and it surfaces only as "strip not
visible", never as an error. `BLOCK_W = 3` in the addon buys the tolerance back,
and the decoder reads any block size, so it is a one line change. This is
acceptable here because the setup is a single known machine.

Verified in game: `found the strip at 0,0 (pitch 1.000)`, gear change applied and
exported.

### Per-slot filter (commit 18f70350)

Live sync dressed the model in everything the game reported. `chrLiveSyncSlots`
now lists the game slots it may drive; an unticked slot is never written, so it
stays empty on the model, and ticking it again brings the game's item back. The
alternative considered was leaving an unticked slot under manual control, which
would allow pinning a chosen item in a slot the game does not drive, but it has
no visible effect until the slot is also cleared by hand.

Changing the filter calls `LiveSync.resync()`, which clears the "already applied
this change counter" guard, so the filter takes effect on the next poll instead
of waiting for the next gear change in game.

The checkboxes sit in the customization column, above the Randomize
Customization links, not in the export panel: 13 of them there made the panel
tall enough to cover the equipment slots and Clear All Equipment behind it, and
collapsing the list behind a summary line still cost two lines of height.

### Reading customization choices from the barbershop (commit fdd95b0c)

Live sync covers equipment, but nothing reported which customization choices a
character actually has, so a saved character had to be matched to the real one
by eye. The client exposes this only through `C_BarberShop`, and only during a
barbershop session — there is no way to read it while standing around.

On Classic Forever the barbershop UI itself is broken: its category layout
reuses character-creation code and dies on `attempt to index global
'CharacterCreateFrame' (a nil value)` in `UpdateSmallButtons`. The stack shows
the error happening inside `SetCustomizations`, with the categories table
already passed in, which is what made this worth trying at all — the data
arrives, only the code drawing it fails. `GetAvailableCustomizations` is present
in `WowB.exe`, so the API is compiled in; only its UI is missing.

The addon captures on `BARBER_SHOP_OPEN`, retrying at 0.5s and 2s because the
data can land after the event, and prints on `BARBER_SHOP_CLOSE` — the
barbershop covers the chat frame, so nothing can be read or typed while seated,
and a `/run` one-liner is not usable here. The capture is kept in saved
variables, so `/wxls cust` reprints it and the file can be read from disk at
`WTF/Account/<account>/SavedVariables/WoWExportLiveSync.lua`. Saved variables
only flush on logout or `/reload`.

What comes out is one entry per option with both IDs, which are the same
`optionID`/`choiceID` pairs a saved character JSON stores, so the two can be
compared directly. Options that are colour swatches or numbered faces have an
empty `choice_name` in the client data — the IDs still identify them.

Verified against two characters. A Tauren matched its saved JSON on all seven
options. A Forsaken differed on exactly two, Face and Hair Color, by 8 and 9
choice IDs — both unnamed options, the ones that have to be matched by eye
rather than by reading a label, while every named option was correct. Worth
knowing when reading a mismatch: `currentChoiceIndex` tracks what is on screen,
so browsing in the chair during the first couple of seconds would be captured
as the character's appearance.

The store uses a single `customizations` key, so a second character's capture
overwrites the first. Keying by character name would be needed to hold several.

If this is ever wired into the tab, reading the saved variables file from disk
looks better than widening the strip: customization only changes at a
barbershop, seven ~17-bit choice IDs would not fit the 44-block budget
comfortably, and the tab already applies a full `{optionID, choiceID}` set
through `chrImportChoices`. The cost is that it only refreshes on reload.

## Standard and high definition models (commit 7b6b072f)

Clients that ship both model sets - Classic Forever (`wow_classic_beta`,
1.60.1.69913) does - point `ChrRaceXChrModel` only at the high definition
models. The tab therefore always loaded those: the log shows
`character/tauren/male/taurenmale_hd.m2` with no way to ask for the classic one.

The standard definition models are present as `ChrModel` rows nothing
references. Of 127 rows only 90 distinct ones are reachable through
`ChrRaceXChrModel`; 18 of the orphans share `CharComponentTextureLayoutID` 203
in nine male/female pairs, with the vanilla player display IDs (49/50 Human,
51/52 Orc, 53/54 Dwarf, 55/56 Night Elf, 57/58 Undead, 59/60 Tauren, 1563/1564
Gnome, 1478/1479 Troll, plus 146599/146600). Each carries its own texture
layout, its own `SkeletonFileDataID` and 5-7 customization options of its own -
SD Tauren male has Face, Horn Style, Facial Hair, Skin Color, Horn Color, Nose
Ring and Hair, where the HD model has Rune, Tattoo, Eye Color and the rest.

So these are complete definitions, not loose files, which is what makes the
feature worth having: **nothing** links a pair in the tables, so they are
matched through the model file itself - the high definition path is the standard
one with an `_hd` suffix, resolved via `DBCreatures.getFileDataIDByDisplayID`
and `listfile.getByID`. Picking SD swaps the selected `ChrModel` outright, so
its layout, geosets and options follow automatically. Swapping only the model
*file* was rejected: SD and HD share neither geoset numbering nor texture
layout, so the silhouette would have been right and the textures wrong.

The dropdown ("Character Model", HD/SD, matching the in-game option's wording)
sits below Body and appears only for races that have both, so other clients see
no change. `chrModelDefinition` persists it.

Two crashes found through this, neither specific to it:

1. `get_current_race_gender` worked out race and gender by matching the selected
   model against `ChrRaceXChrModel`, so an SD selection returned `null`.
   Everything keyed on race and gender then lost its input: item component
   textures resolved to `null` and threw
   (`fileDataID does not exist in root: null`), and helmet hide geosets, item
   display variants, shoulder positions and bare-feet detection would all have
   been wrong. It now matches an SD model through its pairing.
2. `get_textures_by_display_id` reported a component whose race/gender variant
   did not resolve as having a `null` file, so callers asked CASC for a null file
   and aborted the whole model. Those are skipped now, as is a customization
   material that resolves to no texture (a choice that clears one, or a material
   resource the client does not ship).

**Slowness found while testing this, fixed separately in commit 02dec3a8** - see
"Appearance refresh cost" below. It was not caused by SD: HD was slow too.

## Appearance refresh cost (commit 02dec3a8)

Changing one customization on the Classic Forever client took **18-36 seconds**.
It was never downloading: 6 CDN fetches against 132 cache hits in the session,
and none at all during a slow refresh. Three separate causes.

**One interaction ran 2-4 full refreshes at once.** Several pieces of watched
state move for a single action - choosing a customization touches the active
choices, the equipment and the skins - and each watcher started its own refresh:

```
17:57:50 Refreshing character appearance...
17:57:52 Refreshing character appearance...
17:58:07 Character appearance refresh complete
17:58:08 Character appearance refresh complete
```

They now go through `src/js/ui/coalescer.js`: requests close together share a
run, and requests arriving *during* a run queue exactly one follow-up however
many arrive, since only the last state needs drawing. Every request still gets a
promise resolved when a run covering it finishes, which is what lets live sync
wait for the model to be dressed before it exports. Unit tested in the scratch
harness, including the collapse case and that a failing task does not wedge it.

One caller stays direct: `load_character_model`'s post-load refresh. A refresh
can swap the model (`check_cond_model_swap`) and so re-enter that function, and
the scheduler would make the inner call wait on the outer refresh it is running
inside - a deadlock. There is a comment at the call site.

**A refresh reloaded every texture of the character.** Changing a face re-read
and re-decoded all 16, including every item texture, when one had changed.
Decoded pixels now live in an LRU cache (128MB) shared by the material
renderers, cleared on `casc-source-changed` since file data IDs are per build.
GL textures still cannot be shared, as each renderer owns its context, but
uploading pixels already in memory is cheap. The instrumentation left behind
logs anything over 50ms: a character texture costs 50-135ms to read and 9-145ms
to decode, which is where the quarter-second per texture went.

**Compositing was quadratic.** `update()` redraws every target it holds and
`setTextureTarget` called it per texture, so 16 textures meant 1+2+...+16 = 136
draws, each allocating GL buffers. The character paths pass `deferUpdate` and
composite once at the end, which `upload_textures_to_gpu` already did anyway.
The creatures tab is untouched, since its final update is not guaranteed the
same way. Two `console.log` calls also came out of the hot path - one per
texture, one per layer per composite, so ~150 per refresh, which is not free
with devtools open.

A refresh now finishes inside a second.

### What the per-phase timing showed next (commit 4c55c9f9)

Getting to the bottom of the rest took instrumentation rather than reasoning, and
the guesses along the way were wrong twice, so the numbers are worth keeping.
`refresh_character_appearance` logs each phase, and anything slow logs itself:

```
Character appearance refresh complete (geosets 2ms, textures 750ms, skinned 0ms, equipment 0ms)
Material 1 (1024x1024): 1ms composite, 36ms read back, 1ms upload to 1 slot(s)
Slow character texture 8284701: 98ms read, 127ms decode
```

All of it is in `update_textures`; geosets, skinned models and equipment are
0-2ms. Within that, the materials are *not* the cost - 1-3ms to composite, 9-36ms
to read back, 1-4ms to upload, and to one texture slot each, so the suspicion
that `overrideTextureTypeWithPixels` was uploading to several slots was wrong.

The cost was a level down: `loadTexture` created a fresh GL texture and uploaded
the source pixels **on every call**, so every refresh re-uploaded all ~16 of the
character's source textures - and nothing ever deleted the old ones. `reset()`
cleared the target list only, and `dispose()` relied on losing the context, so
that was also a leak growing for the life of the character. They are now kept per
material, keyed by file, and freed in `dispose()`.

Two smaller items in the same commit: a material whose composite has not changed
since it last went to the GPU is not read back and uploaded again (it is still
recomposited, because its canvas is what the texture preview and export read, and
`reset()` clears it); and `readPixels` is flipped a row at a time instead of a
pixel at a time, same output, 15ms to 6ms on a 2048x1024 material.

### Remaining: a hitch on a face not seen before

**Cosmetic, not breaking - left as is.** Each face option has its own baked
texture, so the first time one is viewed it is genuine new work: 60-100ms to read
out of CASC plus up to 127ms to decode the BLP, both on the thread that draws the
viewport, so the animation visibly pauses. Revisiting a face costs ~70ms, nearly
all of it the material read back.

| | per option change |
| --- | --- |
| originally | 18000-36000ms |
| after coalescing (02dec3a8) | 2000-4000ms |
| face already seen | ~70ms |
| face seen for the first time | ~150-260ms |

The next step, if it ever matters, is moving the BLP decode to a `worker_threads`
worker as `src/js/workers/cache-collector.js` already does: `blp.js` pulls in only
`BufferWrapper`, `PNGWriter` and `webp-wasm`, no app singletons, so the file bytes
can be transferred in and the pixels transferred back. That would take the ~127ms
decode off the main thread but not the 60-100ms CASC read, which would need the
archive indices and keys in the worker too. Half the remaining hitch for a worker
pool, a request queue and a fallback path - not worth it while the pause only
happens once per face.

## glTF export size and time (commit 03635cb3)

A dressed Tauren on Classic Forever exported an **83.8MB `.gltf` in 21 seconds**.

The model carries **347 animations**. The JSON is not the animation data - that is
31MB of `.bin` - it is the *index*: two accessors per bone track (timestamps and
values), 186392 of them, plus a sampler and a channel each, 93184 tracks in all,
~269 per animation. A track of 21 keyframes is 252 bytes of floats and was costing
~900 bytes of JSON to describe. The index was 2.7x the size of the data.

Three quarters of that was avoidable, and it is now 35.6MB in 10s:

| | |
| --- | --- |
| as written, tab indented | 83.8MB |
| minified | 58.7MB |
| minified, no names, min/max only where required | **35.6MB** |

- **`min`/`max` on every accessor.** glTF requires them only on POSITION
  attributes and animation sampler *inputs* - half of them. The other 93192 are
  sampler outputs carrying 6-8 full-precision doubles (`-0.7191197872161865` for
  a float32 that holds ~7 significant digits). The writer also *computed* min and
  max across every keyframe of every bone of all 347 animations to produce
  numbers it then did not write, which is where most of the time saving came
  from.
- **Tab indentation**: 25MB of whitespace over 5.3 million lines. The glb path
  already minified.
- **Names**: every animation accessor and its bufferView carried the same string
  (`TRANS_VALUES_1_241`), 186381 times.

Dropping the names broke a dependency worth knowing about: the glb path found
animation bufferViews by testing `bufferView.name` for `TRANS_`/`ROT_`/`SCALE_`
prefixes and parsing the animation index back out of the string. It now tracks
them by index as they are created.

### The bufferView collapse that broke the export

Every accessor had **its own** bufferView at `byteOffset: 0`, hence 186392 of
them and 14MB of JSON. Accessors can share a bufferView and index into it with
their own `byteOffset`, so collapsing them to one per animation buffer took the
file to 28.3MB - and produced a mangled model in Unity.

`GLTFWriter` has an unwritten invariant that **accessor index equals bufferView
index**:

- `writeData(index, ...)` indexes `root.accessors[index]` *and*
  `root.bufferViews[index]` with the one number;
- `add_buffered_accessor` stores a bufferView index into `primitive_attributes`,
  which glTF reads as an accessor reference;
- the UV loop passes a bufferView index into `writeData`.

That holds only while the two arrays stay in lockstep. With 186392 views
collapsed to 347, mesh primitives resolved to animation accessors, and UV data
was written into accessor 352. Reverted; the per-accessor bufferView is back,
with a comment at each site saying why it cannot be collapsed. The other savings
do not touch indices and stayed.

The remaining ~7MB is still available, but only after those three call sites
reference accessors and bufferViews explicitly. That is its own change with its
own verification, not a rider on this one.

**Checking the output.** A structural pass over the exported file catches this
class of bug immediately - it found the corruption before the model was even
looked at. Worth repeating after any change to the writer: every accessor fits
its bufferView and is aligned to its component size, every bufferView fits its
buffer, every `.bin` exists at its declared length, mesh primitives reference
accessors of the expected type, and min/max appear exactly where the spec
requires them.

## Repeat export cost, for live sync (commit c71e5f9c)

After 03635cb3 an export took 10s, which is too slow for live sync to feel
immediate. An export builds a **fresh model loader**, so nothing was reused
between exports even though a gear change touches neither the skeleton nor the
animations:

- all 347 `.anim` files were read out of CASC and parsed again, ~5s;
- all 347 animation `.bin` files were rewritten, 31MB, byte for byte identical.

Parsed `.anim` payloads are now cached by file id (256MB LRU, cleared on
`casc-source-changed`), shared by `M2Loader` and `SKELLoader` through one
function instead of the four copies of that logic they had between them. An
animation `.bin` already on disk at the expected length is left alone, and since
`requiredBufferSize` is known before any of it is produced, that check happens up
front and the buffer's cursor is **advanced instead of filled** - the accessors
need only offsets and lengths, and nothing ever reads the contents. Also
collapsed ~300 per-animation log lines per export into one summary line each.

**Warm export 10s to 3s.** Cold is 6s, the difference being the caches filling.

Skipping the float writes is the same index bookkeeping that broke the export in
the section above, so it was checked rather than trusted: each seek mirrors the
`byteLength` its own bufferView declares, and the output was compared field by
field against an export that filled the buffers. All 186384 bufferViews and
accessors identical, and buffers, animations, skins, nodes and meshes too. Keep a
known-good `.gltf` around and do this comparison after any change to the writer;
it is far stronger than "the model still looks right".

### Two things the measurement ruled out

Worth recording because both were plausible and both were wrong:

- **The 36MB of JSON is not the bottleneck**: 162ms to build, 158ms to write. So
  `.glb` output - one binary file, no JSON text - would buy essentially nothing.
- **The rest is not I/O.** With the `.anim` reads cached and the `.bin` writes
  skipped, what remains is CPU in the writer, building 186384 accessor objects.
  Not filling the buffers was worth ~1s of it, less than the ~2s guessed, so the
  object churn rather than the float writes is the bulk.

Rough split of the warm 3s: ~1s building the animation structure, ~1.5s textures
and mesh, ~0.3s JSON. Going further means not building 186384 accessors at all,
which needs either fewer animations (a filter - rejected, because vtube lets any
clip in the file be searched and assigned) or caching the built structure between
exports and re-indexing it, which is the invariant minefield again.

## Startup performance: DB2 row lookups (commit 56571141)

Opening the Characters tab took ~25s on a warm cache. Nothing was being
downloaded; the runtime log showed 22 of those seconds in a single gap with no
output, between `ChrCustomizationMaterial` being parsed and the next table
loading.

The cost was in `WDCReader._findSectionForRecord`, which walked a section
linearly on every lookup by ID:

- with an ID list, `section.idList.indexOf(recordID)`;
- **with no ID list, parsing records from the start of the section until the
  inline ID field matched**;
- plus `idList.every(id => id === 0)` to test for a zeroed ID map, re-run on
  every record read.

`DBCharacterCustomization` calls `db2.ChrCustomizationMaterial.getRow()` once per
`ChrCustomizationElement` row. `ChrCustomizationMaterial` has no ID list, so
6134 lookups each parsed an average of ~3600 of its 7186 records: roughly 22
million record parses.

The fix builds the id -> record index map once per section (`_getIDIndex` for ID
lists, `_getInlineIDIndex` for inline IDs) and caches the zeroed-ID-map result on
the section. Measured after: the gap is under a second and the tab loads in 3s.
Because it sits in `WDCReader`, every lookup by ID in the app benefits;
`ChrCustomizationMaterial` was just the one large enough to notice.

Note the first loading screen (installation -> home) is unrelated and unchanged:
listfile mapping, CDN pings and CASC index loading, ~2s each, no single hotspot.
The binary listfile itself is re-downloaded whenever `listfileCacheRefresh`
(default 3 days) expires, which is a genuine download and is configurable in
settings.

## Changes applied (commit 58fe6333, pushed to origin/main)

| File | Change |
| --- | --- |
| `src/js/3D/renderers/M2RendererGL.js` | New `getAttachmentInfo(id)` returning the raw `{ bone, position }`, with the same `skelLoader` fallback as `getAttachmentTransform`. |
| `src/js/3D/exporters/CharacterExporter.js` | Adds `attachment_bone` and an axis-swapped `attachment_offset` to each non-collection result. |
| `src/js/modules/tab_characters.js` | Threads both fields through the glTF export branch. |
| `src/js/3D/exporters/M2Exporter.js` | Passes them to `addEquipmentModel`, suppressed for collection-style pieces. |
| `src/js/3D/writers/GLTFWriter.js` | Replaces the inert `node.parent_bone` with real parenting: the mesh node goes into the joint's `children` with `translation = offset - pivot`. Adds `joint_node_index_map`, populated in the bone loop, accounting for the `modelsExportWithBonePrefix` node offset. |

Tested against a Classic client — see bug #1.

## Changes applied (commit 42a67c4a, pushed to origin/main)

| File | Change |
| --- | --- |
| `src/js/3D/writers/GLTFWriter.js` | `addMesh` and equipment meshes take `matProps` (`{ blendingMode, flags }`). Images and textures are still written per texture; materials are created on demand per (texture, alphaMode, doubleSided), with `alphaMode`, `alphaCutoff` and `doubleSided` set from the M2 material. A second variant of the same texture gets a suffixed name (e.g. `_mask_2s`). Meshes without props (WMO, M3) produce the same output as before. |
| `src/js/3D/exporters/M2Exporter.js` | Passes `m2.materials[texUnit.materialIndex]` for character submeshes and equipment submeshes. |

## Open assumption — RESOLVED

`translation = attachment_offset - bone.pivot` assumed the attachment
`position` is in model space, the same frame as `pivot`. Confirmed: pauldrons
land on the shoulders, neither pushed out from the joint nor inside the torso.
Only tested with `modelsExportWithBonePrefix` at one setting, and without a
weapon.

## Classic vs retail

The alpha/double-sided issue (#5) is flavour-independent: blend modes live in
the M2 material block and the writer ignores them regardless of client. Fixing
it once fixes both. Retail merely exercises more blend modes (3-6, additive and
modulated) that a Classic-only test will not reach.

The attachment fix (#1) has a retail-specific hazard: `.skel` indirection.
Classic character M2s carry their own bones and attachments, so
`attachment.bone` indexes the same array the writer exports — one array, indices
trivially agree. Retail models set `skeletonFileID` and move bones into a
`.skel`, sometimes with a parent skeleton behind it, and two independent paths
then resolve the skeleton:

- the renderer sets `skelLoader` to the parent skel if present, else the child
  (`M2RendererGL.js:700`); `getAttachmentInfo` reads the attachment from `m2`
  first and falls back to `skelLoader`.
- the exporter separately loads the skel and calls
  `setBonesArray(parent_skel.bones)` or `setBonesArray(skel.bones)`
  (`M2Exporter.js:331`).

The two selections look consistent but nothing enforces it. The case where the
attachment comes from `m2` while the bones come from a `.skel` is where a bone
index could mean different things on each side, placing items on the wrong bone
silently.

Failure modes split usefully:

- out-of-range index -> `joint_node_index_map.get()` returns undefined and the
  node falls back to origin placement (old behaviour), no crash.
- valid but wrong index -> item lands on an unrelated bone, obviously absurd.

So retail exports that look either unchanged-broken or wildly wrong indicate a
skel mismatch, not bad offset maths. Note that #526 lists exactly the races
using skel-based or parented skeletons (Dracthyr visage, Mechagnome, allied
races); if those already mis-attach in the viewer, the export can only inherit
that.

Independent of flavour, `modelsExportWithBonePrefix` must be tested both ways.
`joint_node_index_map` compensates for the prefix node offset, and getting that
wrong shifts every attachment by one joint.

Verification order: Classic first (target, and the simple path), then one retail
race with a plain skeleton and one from the #526 list before upstreaming.

## Unity notes

Unity cannot read M2 — no native support and no maintained importer. Export
remains the path. glTF imports via glTFast (`com.unity.cloud.gltfast`) or
UnityGLTF; both honour node parenting, so the fix above is what makes attached
items land correctly. Enable `modelsExportAnimations` or the joints come out in
rest pose with no clips and no scale channels to inherit. WoW skeletons do not
map to Unity's humanoid avatar without manual bone assignment; route through
Blender if humanoid retargeting is needed.

Exports look washed out in Blender and Unity compared to the wow.export preview.
This is lighting, not the export: materials are a plain base colour texture
with `metallicFactor: 0` and default roughness. The preview's M2 shader
(`m2.fragment.shader` `calc_lighting`, uniforms in `M2RendererGL.js`) is plain
Lambert with ambient 0.5 + diffuse 0.7 * N.L, no specular, no tone mapping and
no colour-space conversion, so lit faces reach 1.2x texture colour and clip,
reading as saturated. PBR adds a Fresnel sheen, environment ambient, and (in
Blender by default, in URP if a volume enables it) tone mapping. Checks:
Blender View Transform -> Standard; Unity tonemapping and environment lighting.
Options not taken yet: a `KHR_materials_unlit` export option, or a vtube shader
replicating the preview's lighting.

## Building locally

Much faster than the CI artifact: `win-x64-debug` builds in about 20s, and its
`src` is a junction to the repo, so source edits need only
`chrome.runtime.reload()` in DevTools (not F5), no rebuild.

Requirements (Windows): Bun >= 1.2, Node 22+ (Node 14 is too old for current
node-gyp), `node-gyp` installed globally, Python, and MSVC build tools for the
`mmap` native addon.

```
npm.cmd install -g node-gyp@latest
bun install
bun ./build.js win-x64-debug
bin\win-x64-debug\nw.exe
```

Gotchas hit:

- **Run the build from PowerShell or cmd, not Git Bash.** The addon script
  shells out to `tar` with a `C:\...` path; Git Bash's GNU tar reads `C:` as a
  remote host ("Cannot connect to C: resolve failed"). Windows'
  `System32\tar.exe` works.
- `npm install -g` in PowerShell fails under the default execution policy
  because it runs `npm.ps1`. Use `npm.cmd` instead.
- VS 2019 Build Tools ignores `/std:c++20` with warnings but the addon still
  compiles and works. If it ever fails, install VS 2022 Build Tools.
- `bun install` with Bun 1.4 rewrites `bun.lock` and `node_addons/mmap/bun.lock`.
  Keep those out of commits.

Export settings that give vtube a clean export: glTF format,
`modelsExportAnimations` on, `enableSharedTextures` **off** (otherwise texture
URIs point outside the export folder, e.g. `..\..\..\item\...`), and
optionally **Export to character folder** so each character gets its own folder
in the vtube avatars directory, and **Face forward (+Z)** (vtube now expects
it).

## Repo / CI state

- `origin` -> `git@github.com:marhag87/wow.export.git` (fork)
- `upstream` -> `https://github.com/Kruithne/wow.export.git`
- `58fe6333` (attachment parenting), `42a67c4a` (material alpha),
  `5b241122` (customization geosets), `e3294fbe` (attachment bone scale),
  `1a452efe` (export to character folder), `2c00e8c2` (save updates the open
  character), `63d03eef` (face forward +Z), `0913d9d2` (bare feet),
  `e849d4f9` (cloak textures), `8e43c888` (live sync), `56571141` (indexed
  DB2 row lookups), `27282234` (smaller live sync strip), `78c1eb36` (one pixel
  per block), `665f44a0` (bun lockfile refresh) and `18f70350` (live sync slot
  filter), `7b6b072f` (standard/high definition models), `02dec3a8` (appearance
  refresh cost), `4c55c9f9` (character source texture reuse), `03635cb3` (glTF
  export size and time) and `c71e5f9c` (repeat export cost) pushed to
  `origin/main`.
- Test build run 35071507928 triggered on the fork via `test_build.yml`
  (`workflow_dispatch`, no secrets, artifacts kept 7 days).
- Artifacts are ~1GB per platform because `publish/<platform>/*` holds three
  packagings of the same app (update pak, portable archive, installer archive).
  Not a debug build — CI builds the non-SDK `win-x64` target. Narrow the upload
  to `publish/<platform>/portable-*` for a lighter test artifact.

## Upstream context

The glTF equipment support landed in `998cc516` (2025-12-15), the same day as
the OBJ/STL version in `9ada19e3`. That commit introduced both the
`attachment_bone` doc comment and the dead `node.parent_bone` line, so the
design was intended and left unwired. Possibly related open issues: #521 (helmet
attachments), #526 (attachment issues on specific races), #437 (glTF bone
transforms missing scale). None of the issue bodies say whether they are viewer
or export side.

`CONTRIBUTING.md` has no AI policy, and neither do the README, LEGAL or LICENSE;
there are no issue/PR templates. It does require PRs to be complete, and says
large contributions should start with a tracking issue coordinated in the
#wow-export-dev Discord.

## Suggested next steps

Done: local build, Classic Tauren pauldron placement (#1), glTF material alpha
and double-sidedness (#5), customization geosets (#7), attachment bone scale in
animations (#8), export to character folder, save updates the open character,
face forward (+Z), bare-feet boot textures (#9), cloak textures (#10), live sync
from the running game, Characters tab load time, vtube cleanup (done in the
vtube repo).

1. Test a one-handed weapon on the same character — a sword offset from the
   hand is the clearest check of attachment placement. Note the fingers will
   stay open (#6).
2. Repeat across a few races with visibly different builds (Gnome, Human) to
   confirm per-race placement, with `modelsExportWithBonePrefix` both on and
   off.
3. Fix the OBJ/STL `model_matrix` bug (#2 above) if those formats matter.
4. Before upstreaming, test one retail race with a plain skeleton and one from
   the #526 list — see "Classic vs retail" — and an alpha-blended retail model
   to see how the BLEND approximation of modes 3-7 looks.
5. Consider upstreaming, referencing #521/#526 and #392. #7 is independent of
   the export changes and could go up as its own PR.
