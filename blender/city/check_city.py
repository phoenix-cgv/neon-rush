"""Checks a City Track .blend or .glb for the problems fixed in citytrack.py.

Headless:  python3 check_city.py CityTrack.blend
           python3 check_city.py CityTrack_delivered.blend
           python3 check_city.py ../../assets/maps/CityTrack.glb
Prints one PASS/FAIL line per check and exits non-zero on any FAIL.
"""
import bpy
import math
import sys
import numpy as np
from mathutils import Vector
from mathutils.bvhtree import BVHTree

path = sys.argv[-1]
if path.endswith(".glb"):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=path)
elif path.endswith(".blend"):
    bpy.ops.wm.open_mainfile(filepath=path)
objs = bpy.data.objects
depsgraph = bpy.context.evaluated_depsgraph_get()

RESULTS = []
def check(name, ok, detail):
    RESULTS.append(bool(ok))
    print(f"{'PASS' if ok else 'FAIL'}  {name}: {detail}")

def wv(o):
    mw = np.array(o.matrix_world)
    co = np.array([v.co for v in o.data.vertices])
    return co @ mw[:3, :3].T + mw[:3, 3] if len(co) else np.zeros((0, 3))

def group(prefix):
    return [o for o in objs if o.type == 'MESH' and o.name.split(".")[0].rstrip("_0123456789") == prefix]

CLEAR = 10.0           # nothing that stands up within this of the centre line
SHIPPED_START = (-180.0, -30.0)

# ---- Road
road = wv(objs["Road"])
A, B = road[0::2], road[1::2]
C = (A + B) / 2
n = len(C)
seg = np.linalg.norm(np.roll(C, -1, 0)[:, :2] - C[:, :2], axis=1)
width = np.linalg.norm(B - A, axis=1)
check("Road ribbon", abs(width - 14).max() < 0.01 and np.linalg.norm(C[0, :2] - SHIPPED_START) < 0.01,
      f"{n} rings, {seg.sum():.0f} m, width {width.min():.2f}-{width.max():.2f} m, start ({C[0, 0]:.0f}, {C[0, 1]:.0f})")

L = seg.sum()
cum = np.concatenate([[0], np.cumsum(seg)])
dense = np.arange(0, L, 1.0)
closed = np.vstack([C[:, :2], C[:1, :2]])
P = np.stack([np.interp(dense, cum, closed[:, k]) for k in range(2)], 1)
h = 6
a, b, c = np.roll(P, h, 0), P, np.roll(P, -h, 0)
cross = (b - a)[:, 0] * (c - b)[:, 1] - (b - a)[:, 1] * (c - b)[:, 0]
den = np.linalg.norm(b - a, axis=1) * np.linalg.norm(c - b, axis=1) * np.linalg.norm(c - a, axis=1)
k = 2 * cross / den
check("Tightest corner >= 13.5 m", 1 / np.abs(k).max() >= 13.5,
      f"R{1 / np.abs(k).max():.1f} at {dense[np.abs(k).argmax()]:.0f} m ({P[np.abs(k).argmax(), 0]:.0f}, {P[np.abs(k).argmax(), 1]:.0f})")

tt = np.roll(P, -1, 0) - np.roll(P, 1, 0)
tt /= np.linalg.norm(tt, axis=1)[:, None]
left = np.stack([-tt[:, 1], tt[:, 0]], 1)
def lateral(xy):
    xy = np.atleast_2d(xy)
    idx = np.empty(len(xy), int)
    for a0 in range(0, len(xy), 2048):
        d2 = ((xy[a0:a0 + 2048, None, :] - P[None]) ** 2).sum(-1)
        idx[a0:a0 + 2048] = d2.argmin(1)
    return ((xy - P[idx]) * left[idx]).sum(1)

# ---- Street cross-section: kerb face from the road, kerb and pavement at one height
def band(name, lo, hi):
    """z of a surface's vertices whose |lateral| is within [lo, hi]."""
    V = wv(objs[name])
    la = np.abs(lateral(V[:, :2]))
    m = (la >= lo) & (la <= hi)
    return V[m, 2]
problems = []
for side in ("Left", "Right"):
    kerb = wv(objs[f"Kerb{side}"])
    kl = np.abs(lateral(kerb[:, :2]))
    inner = kerb[kl < 7.02, 2]
    top = kerb[kl > 7.05, 2]
    pave = band(f"Pavement{side}", 7.3, 12.0)
    pl = np.abs(lateral(wv(objs[f"Pavement{side}"])[:, :2]))
    if not len(inner) or np.abs(inner).max() > 0.005:
        problems.append(f"{side} kerb doesn't meet the road (inner edge z {inner.min() if len(inner) else 'none'})")
    if len(pave) == 0 or pl.min() > 7.4:
        problems.append(f"{side} pavement starts {pl.min():.2f} m out, kerb ends {kl.max():.2f} m: gap")
    elif abs(np.median(pave) - np.median(top)) > 0.005:
        problems.append(f"{side} pavement at {np.median(pave):.3f} m, kerb top at {np.median(top):.3f} m")
check("Kerb face meets the road; pavement continuous at kerb height", not problems,
      "; ".join(problems) or "kerb 0 -> 0.12 m, pavement 7.35-12 m at 0.12 m")

# Ground under the road and pavement band (after modifiers)
g = objs["CityGround"]
gtree = BVHTree.FromObject(g, depsgraph)
g_inv = g.matrix_world.inverted()
worst = (1e9, None)
for i in range(0, len(P), 3):
    for off in (-12, -9, -7.2, -3, 0, 3, 7.2, 9, 12):
        q = P[i] + left[i] * off
        top_z = 0.0 if abs(off) <= 7 else 0.12
        # BVHTree.FromObject works in the object's local space
        hit = gtree.ray_cast(g_inv @ Vector((q[0], q[1], 5.0)), g_inv.to_3x3() @ Vector((0, 0, -1)), 50.0)
        if hit[0] is not None:
            z = (g.matrix_world @ hit[0]).z
            if top_z - z < worst[0]:
                worst = (top_z - z, q)
check("Ground stays under the road and pavement (>= 5 cm)", worst[0] >= 0.05,
      f"min clearance {worst[0] * 100:.1f} cm at ({worst[1][0]:.0f}, {worst[1][1]:.0f})")

# ---- Paint on the road
paint = []
for prefix in ("Line", "CentreDash", "CrosswalkBar", "Manhole", "Puddle", "RoadPatch"):
    zs = np.concatenate([wv(o)[:, 2] for o in group(prefix)] or [np.zeros(0)])
    if len(zs):
        paint.append((prefix, zs.min(), zs.max()))
bad = [p for p in paint if p[1] < 0.001 or p[2] > 0.012]
check("Road markings are paint (1-12 mm above the asphalt)", not bad,
      ", ".join(f"{p} {lo * 1000:.0f}-{hi * 1000:.0f} mm" for p, lo, hi in (bad or paint)))

blocks = group("KerbBlock")
if blocks:
    zb = np.array([(wv(o)[:, 2].min(), wv(o)[:, 2].max()) for o in blocks])
    check("Kerb blocks seated on the kerb (bottom at 0.12 m, <= 4 cm proud)",
          np.abs(zb[:, 0] - 0.12).max() < 0.005 and zb[:, 1].max() <= 0.161,
          f"{len(blocks)} blocks, bottom {zb[:, 0].min():.3f}-{zb[:, 0].max():.3f} m, top {zb[:, 1].max():.3f} m")

# ---- Clearance
FLAT = ("Road", "Kerb", "Pavement", "CityGround", "Line", "CentreDash", "CrosswalkBar", "Manhole",
        "Puddle", "RoadPatch", "KerbBlock", "GreenIsland", "TreePit")
CARS = ("CarBody", "CarCabin", "Wheel", "Headlight", "Taillight")   # left out of the game
inside = []
for o in objs:
    if o.type != 'MESH' or o.name.startswith(FLAT):
        continue
    V = wv(o)
    la = np.abs(lateral(V[:, :2]))
    m = la < CLEAR
    if m.any() and V[m, 2].min() < 4.5:      # overhead lamp heads and the gantry beam are fine
        inside.append((o.name, la.min()))
check(f"Nothing standing within {CLEAR:.0f} m of the centre line", not inside,
      f"{len(inside)} objects" + (": " + ", ".join(f"{nm} {d:.1f} m" for nm, d in sorted(inside, key=lambda x: x[1])[:8]) if inside else ""))

legs = group("GantryLeg")
if legs:
    lat_legs = [lateral(np.array(o.matrix_world.translation[:2])[None])[0] for o in legs]
    s_leg = [np.linalg.norm(np.array(o.matrix_world.translation[:2]) - C[0, :2]) for o in legs]
    check("Start gantry spans the road at the start line",
          len(legs) == 2 and min(abs(x) for x in lat_legs) > 12 and max(s_leg) < 14,
          f"legs at {', '.join(f'{x:+.1f} m' for x in lat_legs)} lateral, {max(s_leg):.1f} m from ring 0")

# ---- Materials and file hygiene
bad_mat = []
for m in bpy.data.materials:
    if not m.node_tree or m.users == 0:
        continue
    bsdf = m.node_tree.nodes.get("Principled BSDF")
    if not bsdf:
        continue
    base = bsdf.inputs["Base Color"]
    if base.is_linked and not any(l.from_node.type == 'TEX_IMAGE' for l in base.links):
        bad_mat.append(f"{m.name} (colour from nodes)")
    elif not base.is_linked and tuple(base.default_value)[:3] == (1.0, 1.0, 1.0):
        bad_mat.append(f"{m.name} (default white)")
check("Every material has a Base Color", not bad_mat, ", ".join(bad_mat) or "ok")

if path.endswith(".blend"):
    dup = [c.name for c in bpy.data.collections if "." in c.name]
    check("No duplicate collections from re-runs", not dup, ", ".join(dup[:6]) or "ok")

print(f"\n{sum(RESULTS)}/{len(RESULTS)} checks passed")
if bpy.app.background:
    sys.exit(0 if all(RESULTS) else 1)
