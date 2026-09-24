# Grand Prix map

| File | What |
|---|---|
| `RaceTrack2.blend` | The map as delivered. Source for the build script. (`Track2.py`, the base generator, was not kept.) |
| `Track.py` | The realism pass that ran after `Track2.py` (trees, bushes, grass clumps, materials). Fixed, see below. |
| `fix_grandprix.py` | Rebuilds `RaceTrack2.blend` into the finished map (below) and leaves the scene open. |
| `GrandPrix.blend` | The finished map. |
| `check_grandprix.py` | Checks a `.blend` or `.glb`: 27/27 on `GrandPrix.blend`, 28/28 on the exported `.glb`. |
| `../export_glb.py` | Exports the `.blend` to `assets/maps/GrandPrix.glb`, which `src/levels/grandprix.js` loads. |

## Rebuild

```bash
cd blender/grandprix
python3 -c "import bpy; exec(open('fix_grandprix.py').read()); bpy.ops.wm.save_as_mainfile(filepath='GrandPrix.blend')"
python3 check_grandprix.py GrandPrix.blend
python3 ../export_glb.py GrandPrix.blend ../../assets/maps/GrandPrix.glb
python3 check_grandprix.py ../../assets/maps/GrandPrix.glb
```

About 15 seconds; needs `pip install bpy` (Blender 5.0 as a Python module) outside Blender.
In Blender: open `RaceTrack2.blend`, run `fix_grandprix.py` from the Text Editor, then
**Save As** `GrandPrix.blend` and export glTF 2.0 (.glb) with the default settings.

## The lap (2,821 m, anticlockwise, start line unchanged at −430, −170)

| | Where | What | Numbers |
|---|---|---|---|
| Grid | last 70 m + first 400 m | Level, straight | height 0, nothing under R301 within 60 m of the line |
| A · Turn 1 | 1,049 m (599, −85) | Downhill 1 km straight, then a hard stop | 257 m dead straight into an R16.2 left hairpin (130°), boards at 300/200/100 m, gravel from the road edge, Sweep stand 44 m from the apex |
| | 1,107 m | Right-hander back up | R44.6, 80°, banked 6° |
| B · crest | 1,556 m (320, 203) | Blind crest under a sponsor bridge | +10 m, crest radius ~1.9 km, bridge underside 7.5 m up, legs 13.3 m out |
| C · esses | 1,998–2,083 m | Left-right-left in front of the Esses stand | R40 each, 40° each; stand 38 m from the road; gravel outside the middle bend |
| D | 2,201 m | Fast left onto the diagonal | R90, banked 8° |
| E · final corner | 2,708 m (−513, −151) | Slow left onto the pit straight | R29.4, banked 4.5°, ends 70 m before the line; Stadium stand 50 m out |

Height: level to 760 m (the whole pit straight, so the pits and garages stay level), down to −4 m for
Turn 1, up to +10 m at the crest, a dip to +3 m, climbing to +6 m through the esses, down to 0 for the
final corner. Maximum grade 6 %. Banking only ever raises the outside edge, in proportion to the
corner's curvature (so it fades in and out with it), 1° or less on straights.

## How it's built

- **Layout.** The new stretches (Turn 1, the esses and D) are straights and arcs from the delivered
  centreline's rings; two straight lengths in each are solved so the piece rejoins the road exactly.
  Everything is then smoothed and resampled every 2 m. The final corner is built as before.
- **Road and ribbons.** Road, verges, edge lines, racing line and kerbs are generated on the banked
  road plane: `ROAD_Z + height(s) + lateral × tan(bank(s))`. Inside tight corners the verge is
  trimmed to 80 % of the radius so it can't fold over itself.
- **Ground.** `GroundGrass` is a 10 m terrain grid: 0.33 m under the road plane out to 21 m, 0.12 m
  under it to the verge edge, blending to flat by 150 m.
- **Moving scenery.** Anything near a moved stretch keeps its distance from the road
  (`displacement()`, fading out from 40 m to 200 m), then sits on the new ground or verge.
  Grandstands are placed explicitly. Buildings move rigidly; gravel and grass patches bend.
- **New pieces.** Continuous tyre walls (4 m blocks overlapping 0.4 m, one object per block so the
  game's box colliders stay small) on the outside of Turn 1, the esses, D and the final corner;
  red-and-white kerbs on both sides of every corner; spectators in all four stands (one mesh per
  stand); team flags and sponsor banners along the pit straight; a big screen facing the main stand;
  floodlight towers along the straights; the sponsor bridge. Everything that glows uses emissive
  materials, not lamps.
- **Clearance.** Nothing that stands up is left within 10 m of the centre line (the game lets a car
  reach 9.25 m), and no tree or rock stands in the gravel.

## Earlier fixes (still applied)

- The final corner no longer zig-zags into a folded 7.8 m hairpin 25 m before the line.
- The ribbon is smooth (it was a polygon with 42 m straights and 7–9° facets).
- Gravel never runs under the road; the `Grass` material has a plain Base Color (its colour came
  from a noise → colour ramp chain, which glTF can't carry, so it exported white).

## `Track.py`: why scenery was on the road

`Track.py` kept trees 20 m, bushes 16 m and grass clumps 9 m from the track by measuring the
distance to the nearest **vertex** of the road's centreline. Those vertices were up to 42 m
apart on the straights, so a spot halfway between two of them could be on the asphalt and still
read as far from the track. `distance_to_track()` now measures the distance to the centreline
**segments**, and grass clumps keep 10 m from the centre (outside the 9.25 m the game lets a car
use). Checked by stripping `Track.py`'s scenery from `RaceTrack2.blend` and re-running it: none
of its 260 trees, 180 bushes or 450 grass clumps land in the drivable band (84 of its objects did
before). The one object left there is `Rock.011`, a 2.6 m rock on the verge from `Track2.py`,
which `fix_grandprix.py` removes.
