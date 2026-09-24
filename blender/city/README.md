# City Track map

| File | What |
|---|---|
| `citytrack.py` | Generates the whole map (the detailed version). Deletes everything and rebuilds. |
| `CityTrack.blend` | The map built by that script (the script is embedded as a Text block). |
| `CityTrack_delivered.blend` | The map as delivered, for comparison. Built by an older `citytrack.py`. |
| `check_city.py` | Checks a `.blend` or `.glb`; see the results below. |
| `../export_glb.py` | Exports the `.blend` to `assets/maps/CityTrack.glb`, which `src/levels/city.js` loads. |

## Rebuild

```bash
cd blender/city
python3 -c "import bpy; exec(open('citytrack.py').read()); bpy.ops.wm.save_as_mainfile(filepath='CityTrack.blend')"
python3 check_city.py CityTrack.blend
python3 ../export_glb.py CityTrack.blend ../../assets/maps/CityTrack.glb
```

In Blender: open `citytrack.py` in the Scripting workspace, **Run Script**, save, then export
glTF 2.0 (.glb) with the default settings. Needs `pip install bpy` when run outside Blender.

## Which version is which

The uploaded `citytrack.py` (the short "condensed" one) and the script embedded in the delivered
`.blend` (the detailed one) are both older than the map the game shipped, whose hairpins had been
opened out to ~14 m. That version's script wasn't kept, but its lap is fully recoverable: the
generator samples 80 rings per control point, so every 80th ring of the shipped road is a control
point. `citytrack.py` here is the detailed script with those 14 control points (it reproduces the
shipped centreline to 0.0000 m) plus the fixes below.

## What was fixed

| | Before (shipped `.glb`) | After |
|---|---|---|
| Street cross-section | Kerb a flat strip 12 cm up with no face; 1.6 m grass gutter 12 cm **below** the road between kerb and pavement; pavement 2 cm up | Kerb face slopes from the road to 12 cm; kerb top and pavement continuous at 12 cm from 7.35 to 12 m; skirt down to the ground |
| Ground relief | ±27 cm on ground 12 cm below the road (measured clear of it, but only by chance) | ±5 cm: 7.8–14.9 cm below the road |
| Road markings | Centre dashes and crosswalks floating 8–10 cm up; manholes 4 cm lumps; edge lines exactly coplanar (flicker) | Paint, 2–8 mm above the asphalt |
| Kerb blocks | 18 cm slabs floating over the gutter | 3 cm, seated on the kerb and pavement edge |
| Within 10 m of the centre | 157 objects (loose sidewalk slabs 8 m out; in the delivered file also bollards 7.9 m, traffic lights 8.2 m, signs 9.5 m, grass tufts from 6 m, pedestrians anywhere) | None standing below 4.5 m (lamp arms and the gantry beam pass overhead) |
| Start gantry | (Delivered: laid along the road at (−120, −30), legs on the centre line) | Across the road at the start line, legs outside the pavement |
| `Line` material | Default white (reads as "no colour") | Off-white |
| Re-running | Piled up `BUILDINGS.001`…`.003` collections | Cleans up collections and orphan data first |

Other generator bugs fixed on the way: buildings and trees used their 20th rejected position
anyway when no position passed the clearance test; pedestrians were offset from the road towards
a **random** point on the lap instead of across the road.

**No parked cars.** The generator used to add 40 (half of them standing in the lanes), which the
game had to filter out. It adds none now; the city's cars are the live traffic in
`src/core/traffic.js`.
