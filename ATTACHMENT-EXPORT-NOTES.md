# Character attachment export — findings

Session notes, 2026-09-16. Scope: why equipped pauldrons (and other attached
items) do not appear in the right place on exported character models, plus glTF
material alpha. Limited to WoW Classic. Target consumer is Unity via glTF.

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

An earlier claim in this session that bone scale tracks drive the per-race
difference was overstated — in rest pose it is the pivots and offsets.

## Bugs found

### 1. glTF: attachment link never written — FIXED

`tab_characters.js` calls `get_equipment_geometry(false)` for glTF, deliberately
leaving the pose to the armature. But attachment models carry no bone weights
(only collection models do), `M2Exporter` never set `attachment_bone`, and
`GLTFWriter` wrote `node.parent_bone = ...`, which is not a glTF property and is
ignored by every consumer. Net result: attached items exported at the origin,
unparented and unrigged.

Fixed in commit `58fe6333` (see "Changes applied" below).

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

### 5. glTF: texture alpha ignored, materials never double-sided — NOT FIXED

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

Workaround until fixed: Blender -> set material blend mode to Alpha Clip and
disable backface culling; Unity/glTFast -> switch the generated material's
surface type to Cutout. Both must be redone on every re-import.

Unverified: that Tauren hair specifically uses blendingMode 1. Confirm against a
real client before assuming MASK is the right mode for it.

### 6. Hand grip is viewer-only — BY DESIGN, WORTH KNOWING

`setHandGrip` swaps finger bones to HandsClosed at render time. glTF joint
animations are written from the raw M2 tracks, not sampled from the renderer, so
exported fingers stay open around a weapon.

## Changes applied (commit 58fe6333, pushed to origin/main)

| File | Change |
| --- | --- |
| `src/js/3D/renderers/M2RendererGL.js` | New `getAttachmentInfo(id)` returning the raw `{ bone, position }`, with the same `skelLoader` fallback as `getAttachmentTransform`. |
| `src/js/3D/exporters/CharacterExporter.js` | Adds `attachment_bone` and an axis-swapped `attachment_offset` to each non-collection result. |
| `src/js/modules/tab_characters.js` | Threads both fields through the glTF export branch. |
| `src/js/3D/exporters/M2Exporter.js` | Passes them to `addEquipmentModel`, suppressed for collection-style pieces. |
| `src/js/3D/writers/GLTFWriter.js` | Replaces the inert `node.parent_bone` with real parenting: the mesh node goes into the joint's `children` with `translation = offset - pivot`. Adds `joint_node_index_map`, populated in the bone loop, accounting for the `modelsExportWithBonePrefix` node offset. |

All five files pass `node --check`. **Nothing has been tested against a real
client.**

## Open assumption to verify first

`translation = attachment_offset - bone.pivot` assumes the attachment `position`
is in model space, the same frame as `pivot`. This follows from what the
renderer does (`bone_world * translate(position)`, where the bone world matrix
is built from pivots) but has not been confirmed against an export.

- Items doubled out from the joint -> the offset is bone-local, drop the
  subtraction.
- Items inside the torso -> the sign or axis swap is wrong.

Test with a one-handed weapon first. A misplaced pauldron near the shoulder
reads as a tuning problem; a sword offset from the hand is unmistakable.

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

## Repo / CI state

- `origin` -> `git@github.com:marhag87/wow.export.git` (fork)
- `upstream` -> `https://github.com/Kruithne/wow.export.git`
- `58fe6333` pushed to `origin/main`.
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

1. Build locally (`bun install && bun build.js win-x64-debug`), load a Classic
   client, equip a one-hander plus pauldrons, export glTF, check placement in
   Blender or Unity. Resolve the open assumption above.
2. Repeat across a few races with visibly different builds (Tauren, Gnome,
   Human) to confirm per-race placement, with `modelsExportWithBonePrefix` both
   on and off.
3. Fix glTF material alpha and double-sidedness (#5 above) — needed for hair,
   foliage and any alpha-keyed geometry.
4. Fix the OBJ/STL `model_matrix` bug (#2 above) if those formats matter.
5. Before upstreaming, test one retail race with a plain skeleton and one from
   the #526 list — see "Classic vs retail".
6. Consider upstreaming, referencing #521/#526.
