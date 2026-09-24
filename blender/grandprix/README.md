# Grand Prix map

| File | What |
|---|---|
| `GrandPrix_original.glb` | The map as first delivered (only a .glb existed). Source for the fix script. |
| `fix_grandprix.py` | Imports the original, fixes it (below) and leaves the scene open. |
| `GrandPrix.blend` | The fixed map. |
| `check_grandprix.py` | Checks a `.blend` or `.glb`: 11/11 on the fixed map, 4/11 on the original. |
| `../export_glb.py` | Exports the `.blend` to `assets/maps/GrandPrix.glb`, which `src/levels/grandprix.js` loads. |

## Rebuild

```bash
cd blender/grandprix
python3 -c "import bpy; exec(open('fix_grandprix.py').read()); bpy.ops.wm.save_as_mainfile(filepath='GrandPrix.blend')"
python3 check_grandprix.py GrandPrix.blend
python3 ../export_glb.py GrandPrix.blend ../../assets/maps/GrandPrix.glb
```

About 40 seconds. Needs `pip install bpy` (Blender 5.0 as a Python module) when run outside Blender.

## What was fixed

| | Before | After |
|---|---|---|
| Final corner | West straight jogged right, then a 7.8 m left hairpin whose inside edge folded; one segment turned 41° | Diagonal straight into one R29 left |
| Grid | Started 25 m after that hairpin, so all six grid slots (to 45 m back) sat in it | Corner ends 70 m before the line; tightest radius within 60 m of the line is R381 |
| Road ribbon | 160 rings, 4.6–42 m apart, 7–9° facets through the long left-hander | 1,349 rings every 2 m, smooth, max 0.8° off the local curve |
| Scenery in the drivable band (9.25 m) | 85 objects: grass blades on the asphalt, a 3.3 m bush 0.5 m from the centre, a rock on the verge | None |
| Gravel trap at ~1,100 m | Ran 0.4 m past the centreline, 2 cm under the asphalt | Starts 9 m out, beyond the kerbs |
| `Grass` material | No colour (exported white; the level patched it in code) | Base Color set; the level override is gone |

The start line (−430, −170), race direction, gantry, pits and the rest of the lap are unchanged.
Everything within about 40 m of the moved west side (tyre walls, the gravel trap, fence posts,
the podium board, trees) moved with the road and keeps its distance from it; the effect fades out
by 200 m. Buildings move rigidly; only gravel traps and grass patches bend to follow the road.
