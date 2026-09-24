# Mountain map (Sphinx Mountain Grand Prix)

| File | What |
|---|---|
| `mountain_track.py` | Generates the whole map. Deletes everything and rebuilds from one centreline. |
| `Mountain_3.blend` | The map built by that script (the script is embedded as a Text block). |
| `check_mountain.py` | Measures a built `.blend` against the game team's acceptance criteria. |
| `../export_glb.py` | Exports the `.blend` to `assets/maps/MountainTrack.glb`, which `src/levels/mountain.js` loads. |

## Rebuild

In Blender: open `Mountain_3.blend`, go to **Scripting**, open `mountain_track.py`, **Run Script**, save.

Headless, with `pip install bpy` (Blender 5.0 as a Python module, Python 3.11):

```bash
python3 -c "import bpy; exec(open('mountain_track.py').read()); bpy.ops.wm.save_as_mainfile(filepath='Mountain_3.blend')"
python3 check_mountain.py Mountain_3.blend     # PASS/FAIL per criterion, exit code 1 on any FAIL
python3 ../export_glb.py Mountain_3.blend ../../assets/maps/MountainTrack.glb
```

The build takes about 7 minutes (mostly the 2,000+ tree and rock objects).

## For the game

- **Start/finish line:** Blender (23.9, −120.6, 8.7), which is road sample 0. Race direction
  is increasing sample index, heading (−0.276, −0.961) at the line. The grid lines up
  behind it (lower indices), on a straight with <1.5% grade.
- **Road mesh:** `Mountain Race Track`, 800 rows, 1.84 m apart. Vertex `2i` is the
  right-hand edge and `2i+1` the left-hand edge in the race direction. Faces point up.
  Smooth-shaded, so the .glb keeps exactly these 1600 vertices in this order.
- **Width:** 12 m. Rails 6.3 m from the centre along the banked surface.
- **Drivable (in `src/levels/mountain.js`):** `Mountain Race Track`, `Road Shoulder Left/Right`.
- **Solid:** `Guardrail Left`/`Guardrail Right` (one strip each, 0.15–0.8 m) and
  `Tunnel Wall` (both walls, one object, faces inward).
- **Visual only:** `Tunnel Roof`, `Red White Curb Left/Right`, `Tunnel Hillside`,
  `Tunnel Portal Entry/Exit`, posts, bridge pieces, scenery.

## Conventions in the script

- `road_rights` really is the driver's right. The previous script's `right` vector
  pointed left, which is why the banking came out inverted everywhere.
- Bank angle = 300 / radius (degrees), capped at 15°, never negative. On this lap every
  corner is a left-hander, so only the outside (right) edge is ever raised.
- Zones (tunnel, bridge) are given in control-point units, so they stay put if you move
  the start line (`START_BEFORE_CP0`).
