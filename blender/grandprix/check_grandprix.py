"""Checks a Grand Prix .blend (or the original .glb) for the problems fixed by fix_grandprix.py.

Headless:  python3 check_grandprix.py GrandPrix.blend
           python3 check_grandprix.py GrandPrix_original.glb      (the "before")
Prints one PASS/FAIL line per check and exits non-zero on any FAIL.
"""
import bpy
import math
import sys
import numpy as np

path = sys.argv[-1]
if path.endswith(".glb"):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=path)
elif path.endswith(".blend"):
    bpy.ops.wm.open_mainfile(filepath=path)
objs = bpy.data.objects

RESULTS = []
def check(name, ok, detail):
    RESULTS.append(bool(ok))
    print(f"{'PASS' if ok else 'FAIL'}  {name}: {detail}")

def world_verts(o):
    mw = np.array(o.matrix_world)
    co = np.array([v.co for v in o.data.vertices])
    return co @ mw[:3, :3].T + mw[:3, 3] if len(co) else np.zeros((0, 3))

WALL_LIMIT = 8.4
DRIVABLE = WALL_LIMIT + 0.85

# ---- Road ribbon: vertex pairs (left, right), ring 0 = start line
road = world_verts(objs["Road"])
L, R = road[0::2], road[1::2]
C = (L + R) / 2
n = len(C)
seg = np.linalg.norm(np.roll(C, -1, 0)[:, :2] - C[:, :2], axis=1)
width = np.linalg.norm(R - L, axis=1)
s = np.concatenate([[0], np.cumsum(seg)[:-1]])
length = seg.sum()
t = np.roll(C, -1, 0)[:, :2] - C[:, :2]
heading = np.arctan2(t[:, 1], t[:, 0])
turn = np.degrees((np.roll(heading, -1) - heading + np.pi) % (2 * np.pi) - np.pi)
area = 0.5 * np.sum(C[:, 0] * np.roll(C[:, 1], -1) - np.roll(C[:, 0], -1) * C[:, 1])
check("Ribbon", abs(width - 14).max() < 0.01 and area > 0,
      f"{n} rings, {length:.0f} m, spacing {seg.min():.2f}-{seg.max():.2f} m, width {width.min():.2f}-{width.max():.2f} m, anticlockwise")
check("Start line unchanged", np.linalg.norm(C[0, :2] - (-430, -170)) < 0.5,
      f"ring 0 at ({C[0, 0]:.1f}, {C[0, 1]:.1f})")
# A kink is a turn much sharper than the road either side of it (a facet
# or a badly joined section), as opposed to a steady corner.
local = np.array([np.median(turn[[(i + k) % n for k in range(-6, 7)]]) for i in range(n)])
spike = np.abs(turn - local)
check("No kinks (turn per ring within 1 deg of the local curve)", spike.max() <= 1.0,
      f"worst {spike.max():.1f} deg at {s[spike.argmax()]:.0f} m ({C[spike.argmax(), 0]:.0f}, {C[spike.argmax(), 1]:.0f})")

# Folded road: the inside edge must always move forwards
fold = 0
for edge in (L, R):
    e = np.roll(edge, -1, 0)[:, :2] - edge[:, :2]
    fold += int(((e * t).sum(1) <= 0).sum())
check("Road never folds over itself", fold == 0, f"{fold} backwards edge segments")

# Radius from a smooth resample
dense_s = np.arange(0, length, 1.0)
closed = np.vstack([C[:, :2], C[:1, :2]])
cum = np.concatenate([[0], np.cumsum(seg)])
P = np.stack([np.interp(dense_s, cum, closed[:, k]) for k in range(2)], 1)
h = 6
a, b, c = np.roll(P, h, 0), P, np.roll(P, -h, 0)
cross = (b - a)[:, 0] * (c - b)[:, 1] - (b - a)[:, 1] * (c - b)[:, 0]
den = np.linalg.norm(b - a, axis=1) * np.linalg.norm(c - b, axis=1) * np.linalg.norm(c - a, axis=1)
k = 2 * cross / den
tight = np.abs(k).argmax()
check("Tightest corner >= 25 m", 1 / np.abs(k).max() >= 25,
      f"R{1 / np.abs(k).max():.1f} at {dense_s[tight]:.0f} m ({P[tight, 0]:.0f}, {P[tight, 1]:.0f}), "
      f"{math.sqrt(1.4 * 9.81 / np.abs(k).max()) * 3.6:.0f} km/h")
near = (dense_s <= 60) | (dense_s >= length - 60)
r_near = 1 / np.abs(k[near]).max()
check("Grid and start straight: nothing under R30 within 60 m of the line", r_near >= 30,
      f"tightest R{r_near:.0f} (grid rows reach 45 m back)")

# ---- Lateral position of everything relative to the road
def locate(xy):
    idx = np.empty(len(xy), int)
    for a0 in range(0, len(xy), 2048):
        d2 = ((xy[a0:a0 + 2048, None, :] - P[None]) ** 2).sum(-1)
        idx[a0:a0 + 2048] = d2.argmin(1)
    tt = np.roll(P, -1, 0) - np.roll(P, 1, 0)
    tt /= np.linalg.norm(tt, axis=1)[:, None]
    right = np.stack([tt[:, 1], -tt[:, 0]], 1)
    rel = xy - P[idx]
    return (rel * right[idx]).sum(1), dense_s[idx]

ALLOWED = ("Road", "Verge_", "EdgeLine", "RacingLine", "ApexKerbs", "StartFinishLine", "PitLane",
           "GroundGrass", "PitWall", "GantryPillar", "GravelTrap", "Lake")
intruders, overhead_ok = [], 0
for o in objs:
    if o.type != 'MESH' or o.name.startswith(ALLOWED):
        continue
    V = world_verts(o)
    lat, _ = locate(V[:, :2])
    inside = np.abs(lat) < DRIVABLE
    if not inside.any():
        continue
    if V[inside, 2].min() > 5.0:       # gantry banner, lights: overhead
        overhead_ok += 1
        continue
    intruders.append(f"{o.name} ({np.abs(lat).min():.1f} m, {V[inside, 2].max():.1f} m tall)")
check("Nothing standing in the drivable band", not intruders,
      f"{len(intruders)} objects within {DRIVABLE:.2f} m of the centre"
      + (": " + ", ".join(intruders[:8]) + (" ..." if len(intruders) > 8 else "") if intruders else
         f" ({overhead_ok} overhead gantry parts are above 5 m)"))

gravel = []
for o in objs:
    if o.name.startswith("GravelTrap"):
        lat, _ = locate(world_verts(o)[:, :2])
        gravel.append((o.name, np.abs(lat).min()))
check("Gravel traps clear of the road and kerbs (>= 9 m)", all(g >= 8.99 for _, g in gravel),
      ", ".join(f"{nm} {g:.1f} m" for nm, g in gravel))

walls = []
for o in objs:
    if o.name.startswith(("TyreWall", "PitWall", "GantryPillar")):
        lat, _ = locate(world_verts(o)[:, :2])
        walls.append((o.name, np.abs(lat).min(), np.abs(lat).max()))
bad = [w for w in walls if w[1] < 7.2 or w[2] > 25]
check("Tyre walls, pit wall and gantry legs beside the road (7.2-25 m)", not bad,
      f"{len(walls)} checked" + (": " + ", ".join(f"{nm} {a:.1f}-{b:.1f} m" for nm, a, b in bad) if bad else
                                 f", tyre walls {min(w[1] for w in walls if w[0].startswith('TyreWall')):.1f}-"
                                 f"{max(w[2] for w in walls if w[0].startswith('TyreWall')):.1f} m"))

kerb = world_verts(objs["ApexKerbs"])
klat, _ = locate(kerb[:, :2])
check("Kerbs on the verge edge (7-8.8 m)", np.abs(klat).min() > 6.9 and np.abs(klat).max() < 8.9,
      f"{np.abs(klat).min():.2f}-{np.abs(klat).max():.2f} m")

# ---- Materials
white = []
for m in bpy.data.materials:
    if not m.node_tree:
        continue
    bsdf = m.node_tree.nodes.get("Principled BSDF")
    if bsdf and not bsdf.inputs["Base Color"].is_linked and \
            tuple(bsdf.inputs["Base Color"].default_value)[:3] == (1.0, 1.0, 1.0):
        white.append(m.name)
check("Every material has a Base Color", not white, ", ".join(white) or f"{len(bpy.data.materials)} materials")

print(f"\n{sum(RESULTS)}/{len(RESULTS)} checks passed")
if bpy.app.background:
    sys.exit(0 if all(RESULTS) else 1)
