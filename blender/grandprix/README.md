# Grand Prix map

| File | What |
|---|---|
| `RaceTrack2.blend` | The map as delivered. Source for the fix script. (`Track2.py`, the base generator, was not kept.) |
| `Track.py` | The realism pass that ran after `Track2.py` (trees, bushes, grass clumps, materials). Fixed, see below. |
| `fix_grandprix.py` | Fixes `RaceTrack2.blend` (below) and leaves the scene open. |
| `GrandPrix.blend` | The fixed map. |
| `check_grandprix.py` | Checks a `.blend` or `.glb`: 11/11 on `GrandPrix.blend`, 4/11 on `RaceTrack2.blend`. |
| `../export_glb.py` | Exports the `.blend` to `assets/maps/GrandPrix.glb`, which `src/levels/grandprix.js` loads. |

## Rebuild

```bash
cd blender/grandprix
python3 -c "import bpy; exec(open('fix_grandprix.py').read()); bpy.ops.wm.save_as_mainfile(filepath='GrandPrix.blend')"
python3 check_grandprix.py GrandPrix.blend
python3 ../export_glb.py GrandPrix.blend ../../assets/maps/GrandPrix.glb
```

About 40 seconds; needs `pip install bpy` (Blender 5.0 as a Python module) outside Blender.
In Blender: open `RaceTrack2.blend`, run `fix_grandprix.py` from the Text Editor, then
**Save As** `GrandPrix.blend` and export glTF 2.0 (.glb) with the default settings.

## What was fixed

| | Before | After |
|---|---|---|
| Final corner | West straight jogged right, then a 7.8 m left hairpin whose inside edge folded; one segment turned 41° | Diagonal straight into one R29 left |
| Grid | Started 25 m after that hairpin, so all six grid slots (to 45 m back) sat in it | Corner ends 70 m before the line; tightest radius within 60 m of the line is R381 |
| Road ribbon | 160 rings, 4.6–42 m apart, 7–9° facets through the long left-hander | 1,349 rings every 2 m, smooth, max 0.8° off the local curve |
| Scenery in the drivable band (9.25 m) | 85 objects: grass blades on the asphalt, a 3.3 m bush 0.5 m from the centre, a rock on the verge | None |
| Gravel trap at ~1,100 m | Ran 0.4 m past the centreline, 2 cm under the asphalt | Starts 9 m out, beyond the kerbs |
| `Grass` material | Colour came from a noise → colour ramp node chain, which glTF can't carry, so it exported white (the level patched it in code) | Plain Base Color; the noise bump stays for Blender renders; the level override is gone |

The start line (−430, −170), race direction, gantry, pits and the rest of the lap are unchanged.
Everything within about 40 m of the moved west side (tyre walls, the gravel trap, fence posts,
the podium board, trees) moved with the road and keeps its distance from it; the effect fades out
by 200 m. Buildings move rigidly; only gravel traps and grass patches bend to follow the road.

## Why scenery was on the road, and the `Track.py` fix

`Track.py` kept trees 20 m, bushes 16 m and grass clumps 9 m from the track by measuring the
distance to the nearest **vertex** of the road's centreline. Those vertices were up to 42 m
apart on the straights, so a spot halfway between two of them could be on the asphalt and still
read as far from the track. `distance_to_track()` now measures the distance to the centreline
**segments**, and grass clumps keep 10 m from the centre (outside the 9.25 m the game lets a car
use). Checked by stripping `Track.py`'s scenery from `RaceTrack2.blend` and re-running it: none
of its 260 trees, 180 bushes or 450 grass clumps land in the drivable band (84 of its objects did
before). The one object left there is `Rock.011`, a 2.6 m rock on the verge from `Track2.py`,
which `fix_grandprix.py` removes.
