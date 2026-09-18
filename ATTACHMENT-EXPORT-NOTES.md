# Character attachment export — findings

Session notes, 2026-09-16. Scope: why equipped pauldrons (and other attached
items) do not appear in the right place on exported character models, plus glTF
material alpha. Limited to WoW Classic. Target consumer is Unity via glTF.

Updated 2026-09-17: the attachment fix (#1) is verified against a real Classic
client, the glTF alpha/double-sided bug (#5) is fixed and verified, and the
project now builds locally (see "Building locally"). Also fixed: customization
choices that enable several geosets only applied one (#7), and attachment
bones lost their scale in most glTF animations (#8), and boot textures covered
Tauren hooves (#9). Added: an option to export
characters into a folder named after the character, saving updates the open
saved character in place, and glTF character exports can face +Z (see
"Features added").

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
  character), `63d03eef` (face forward +Z) and `0913d9d2` (bare feet) pushed to
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
face forward (+Z), bare-feet boot textures (#9), vtube cleanup (done in the
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
