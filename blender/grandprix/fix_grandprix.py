"""Grand Prix map fixes, applied to the original export.

The Grand Prix was delivered as a .glb only (GrandPrix_original.glb, kept
next to this script as the source). This script imports it, fixes it and
leaves the fixed scene open; build it with

    python3 -c "import bpy; exec(open('fix_grandprix.py').read()); \
        bpy.ops.wm.save_as_mainfile(filepath='GrandPrix.blend')"
    python3 check_grandprix.py GrandPrix.blend
    python3 ../export_glb.py GrandPrix.blend ../../assets/maps/GrandPrix.glb

What it changes:
  1. The final corner. The west straight used to jog right and then turn
     left through a 7.8 m hairpin whose inside edge folded over itself,
     25 m before the start line, so the whole grid lined up inside it.
     The end of the west side is now a straight run south-west into one
     R30 left that finishes 70 m before the (unchanged) start line.
  2. Everything within reach of the moved road (tyre walls, the gravel
     trap, fence posts, the podium board, trees) moves with it, keeping
     its distance from the road; things further out stay put.
  3. The road, verges, edge lines, racing line and kerbs are regenerated
     from a smooth centreline sampled every 2 m, instead of a polygon with
     42 m straights and 7-9 degree facets through the long left-hander.
  4. Scenery standing in the drivable band (grass blades, a 3.3 m bush,
     a rock, trees on the moved section) is removed.
  5. Gravel traps no longer run under the road (one reached 0.4 m past
     the centreline, 2 cm below the asphalt).
  6. The Grass material gets a real Base Color (it exported as white).

Race direction, start line (ring 0 at -430, -170), gantry, pits and the
rest of the lap are unchanged.
"""
import bpy
import math
import os
import numpy as np
from mathutils import Matrix, Vector

HERE = os.path.dirname(os.path.abspath(bpy.context.space_data.text.filepath)) \
    if bpy.context.space_data and getattr(bpy.context.space_data, "text", None) else os.getcwd()
SOURCE = os.path.join(HERE, "GrandPrix_original.glb")

ROAD_Z = 0.06
ROAD_HALF = 7.0
VERGE_OUT = 23.0
VERGE_Z = 0.03
EDGE_WIDTH = 1.1
EDGE_Z = 0.07
RACING_HALF = 2.4
RACING_Z = 0.066
KERB_IN, KERB_OUT, KERB_Z = 7.0, 8.8, 0.08
KERB_BLOCK = 4.0            # metres per red or white block
SAMPLE = 2.0                # centreline spacing, metres
SMOOTH_HALF = 16            # smoothing half-width in 0.5 m samples (8 m)
DRIVABLE = 8.4 + 0.85       # level's wallLimit + half a car
GRAVEL_INNER = 9.0          # gravel starts beyond the kerbs

# Keep the old centreline up to this ring, then follow the new tail
KEEP_RINGS = 125
FINAL_R = 30.0
EXIT_BEFORE_LINE = 70.0
APPROACH_HEADING = -123.0   # degrees; the new west straight, tangent into the final corner
APPROACH_POINTS = (200.0, 160.0, 120.0, 80.0, 40.0)   # metres back from the corner entry

# Displacement fades out between these distances from the old road
MOVE_FULL, MOVE_NONE = 40.0, 200.0

NATURAL = ("GrassBlade", "TracksideTree", "TreeTrunk", "TreeRoot", "Crown", "PineLower",
           "PineUpper", "Bush", "TracksideBush", "Rock")
REGENERATED = ("Road", "Verge_L", "Verge_R", "EdgeLine_L", "EdgeLine_R", "RacingLine", "ApexKerbs")
FIXED = ("GroundGrass", "Hill", "Lake", "LakeShore")
GROUND_DECALS = ("GravelTrap", "GrassPatch")


def smoothstep(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0.0, 1.0)
    return t * t * (3 - 2 * t)


def centripetal_catmull_rom(P, step=0.5):
    n = len(P)
    out = []
    for i in range(n):
        p0, p1, p2, p3 = P[i - 1], P[i], P[(i + 1) % n], P[(i + 2) % n]
        t0 = 0.0
        t1 = t0 + np.linalg.norm(p1 - p0) ** 0.5
        t2 = t1 + np.linalg.norm(p2 - p1) ** 0.5
        t3 = t2 + np.linalg.norm(p3 - p2) ** 0.5
        m = max(2, int(np.linalg.norm(p2 - p1) / step))
        for t in np.linspace(t1, t2, m, endpoint=False):
            a1 = (t1 - t) / (t1 - t0) * p0 + (t - t0) / (t1 - t0) * p1
            a2 = (t2 - t) / (t2 - t1) * p1 + (t - t1) / (t2 - t1) * p2
            a3 = (t3 - t) / (t3 - t2) * p2 + (t - t2) / (t3 - t2) * p3
            b1 = (t2 - t) / (t2 - t0) * a1 + (t - t0) / (t2 - t0) * a2
            b2 = (t3 - t) / (t3 - t1) * a2 + (t - t1) / (t3 - t1) * a3
            out.append((t2 - t) / (t2 - t1) * b1 + (t - t1) / (t2 - t1) * b2)
    return np.array(out)


class Centreline:
    """Closed 2D centreline, evenly resampled, with arc length and frames."""

    def __init__(self, pts, spacing):
        seg = np.linalg.norm(np.roll(pts, -1, 0) - pts, axis=1)
        cum = np.concatenate([[0], np.cumsum(seg)])
        self.length = cum[-1]
        n = int(round(self.length / spacing))
        self.s = np.arange(n) * self.length / n
        closed = np.vstack([pts, pts[:1]])
        self.p = np.stack([np.interp(self.s, cum, closed[:, k]) for k in range(2)], 1)
        t = np.roll(self.p, -1, 0) - np.roll(self.p, 1, 0)
        self.t = t / np.linalg.norm(t, axis=1)[:, None]
        self.right = np.stack([self.t[:, 1], -self.t[:, 0]], 1)   # driver's right
        self.heading = np.arctan2(self.t[:, 1], self.t[:, 0])
        self.n = n

    def locate(self, xy):
        """Nearest sample index, signed lateral offset (right +) and distance, for many points."""
        xy = np.atleast_2d(xy)
        idx = np.empty(len(xy), int)
        for a in range(0, len(xy), 2048):
            d2 = ((xy[a:a + 2048, None, :] - self.p[None]) ** 2).sum(-1)
            idx[a:a + 2048] = d2.argmin(1)
        rel = xy - self.p[idx]
        return idx, (rel * self.right[idx]).sum(1), np.linalg.norm(rel, axis=1)

    def at(self, s, lateral=0.0):
        f = (np.asarray(s) % self.length) / self.length * self.n
        i0 = np.floor(f).astype(int) % self.n
        i1 = (i0 + 1) % self.n
        u = (f - np.floor(f))[..., None]
        p = self.p[i0] * (1 - u) + self.p[i1] * u
        r = self.right[i0] * (1 - u) + self.right[i1] * u
        r /= np.linalg.norm(r, axis=-1, keepdims=True)
        return p + r * np.asarray(lateral)[..., None], r

    def curvature(self, h=3):
        a, b, c = np.roll(self.p, h, 0), self.p, np.roll(self.p, -h, 0)
        ab, bc, ac = b - a, c - b, c - a
        cross = ab[:, 0] * bc[:, 1] - ab[:, 1] * bc[:, 0]
        den = np.linalg.norm(ab, axis=1) * np.linalg.norm(bc, axis=1) * np.linalg.norm(ac, axis=1)
        return 2 * cross / den          # + = left-hand corner


# ---------------------------------------------------------------- import
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=SOURCE)
objs = bpy.data.objects

def world_verts(o):
    mw = np.array(o.matrix_world)
    co = np.array([v.co for v in o.data.vertices]) if o.type == 'MESH' else np.zeros((0, 3))
    return co @ mw[:3, :3].T + mw[:3, 3] if len(co) else co

# Old centreline from the road ribbon: vertex pairs (left, right) along the lap
road_v = world_verts(objs["Road"])
old_left, old_right = road_v[0::2, :2], road_v[1::2, :2]
old_rings = (old_left + old_right) / 2
old = Centreline(old_rings, 0.5)

# ---------------------------------------------------------------- new line
start = old_rings[0]
u = old_rings[1] - old_rings[0]
u /= np.linalg.norm(u)
left_u = np.array([-u[1], u[0]])
exit_pt = start - u * EXIT_BEFORE_LINE
centre = exit_pt + left_u * FINAL_R
exit_angle = math.degrees(math.atan2(*(exit_pt - centre)[::-1]))
# Travelling anticlockwise round the centre, position angle = heading - 90
entry_angle = (APPROACH_HEADING - 90.0) % 360.0
arc = [centre + FINAL_R * np.array([math.cos(math.radians(a)), math.sin(math.radians(a))])
       for a in np.linspace(entry_angle, exit_angle % 360.0, 7)]
approach = np.array([math.cos(math.radians(APPROACH_HEADING)), math.sin(math.radians(APPROACH_HEADING))])
tail = [arc[0] - approach * d for d in APPROACH_POINTS] + arc + \
       [exit_pt + u * d for d in np.arange(20.0, EXIT_BEFORE_LINE - 5.0, 20.0)]
control = np.array(list(old_rings[:KEEP_RINGS]) + tail)
def smooth_closed(pts, half, passes):
    """Triangular moving average: eases straight-to-arc joins into gentle transitions."""
    w = np.concatenate([np.arange(1, half + 2), np.arange(half, 0, -1)]).astype(float)
    w /= w.sum()
    for _ in range(passes):
        pts = sum(np.roll(pts, k, 0) * wk for k, wk in zip(range(half, -half - 1, -1), w))
    return pts

dense = smooth_closed(centripetal_catmull_rom(control), SMOOTH_HALF, 2)
dense = np.roll(dense, -int(np.argmin(np.linalg.norm(dense - start, axis=1))), 0)
dense[0] = start                                    # ring 0 stays exactly on the start line
new = Centreline(dense, SAMPLE)

# Window of old arc length that moved, and its new counterpart
old_a = old.s[old.locate(old_rings[KEEP_RINGS - 2])[0][0]]
new_a = new.s[new.locate(old_rings[KEEP_RINGS - 2])[0][0]]

def displacement(xy):
    """Where each point should go so it keeps its place beside the road."""
    idx, lat, dist = old.locate(xy)
    s_old = old.s[idx]
    in_win = s_old >= old_a
    frac = (s_old - old_a) / (old.length - old_a)
    s_new = new_a + frac * (new.length - new_a)
    target, _ = new.at(s_new, lat)
    source, _ = old.at(s_old, lat)
    w = (1 - smoothstep(MOVE_FULL, MOVE_NONE, np.abs(lat))) * in_win
    w *= smoothstep(0.0, 20.0, s_old - old_a)          # fade in at the join
    dtheta = np.interp(s_new, new.s, np.unwrap(new.heading)) - np.interp(s_old, old.s, np.unwrap(old.heading))
    dtheta = (dtheta + np.pi) % (2 * np.pi) - np.pi
    return (target - source) * w[:, None], dtheta * w

# ---------------------------------------------------------------- move furniture
moved = 0
for o in list(objs):
    if o.type != 'MESH' or o.parent or o.name.startswith(REGENERATED + FIXED):
        continue
    V = world_verts(o)
    if not len(V):
        continue
    lo, hi = V[:, :2].min(0), V[:, :2].max(0)
    if o.name.startswith(GROUND_DECALS):
        # Flat ground pieces bend with the road; anything built stays rigid
        d, _ = displacement(V[:, :2])
        if np.abs(d).max() < 0.01:
            continue
        inv = np.array(o.matrix_world.inverted())
        V[:, :2] += d
        local = V @ inv[:3, :3].T + inv[:3, 3]
        for v, co in zip(o.data.vertices, local):
            v.co = co
        moved += 1
    else:
        pivot = (lo + hi) / 2
        d, dth = displacement(pivot[None])
        if abs(d[0]).max() < 0.01:
            continue
        piv = Vector((pivot[0], pivot[1], 0.0))
        o.matrix_world = (Matrix.Translation(piv + Vector((d[0][0], d[0][1], 0.0)))
                          @ Matrix.Rotation(float(dth[0]), 4, 'Z')
                          @ Matrix.Translation(-piv) @ o.matrix_world)
        moved += 1
bpy.context.view_layer.update()

# ---------------------------------------------------------------- regenerate ribbons
def mat(name):
    return bpy.data.materials[name]

def replace_mesh(name, verts, faces, materials, face_mats=None):
    old_obj = objs.get(name)
    if old_obj:
        bpy.data.objects.remove(old_obj, do_unlink=True)
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata([tuple(v) for v in verts], [], faces)
    for m in materials:
        mesh.materials.append(m)
    if face_mats is not None:
        for poly, k in zip(mesh.polygons, face_mats):
            poly.material_index = k
    for poly in mesh.polygons:
        poly.use_smooth = True     # one vertex per ribbon vertex in the export
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    return obj

def ribbon(name, lat_a, lat_b, z, material, indices=None, closed=True):
    """Strip between two lateral offsets, vertices in (lat_a, lat_b) pairs."""
    idx = np.arange(new.n) if indices is None else np.asarray(indices)
    a, _ = new.at(new.s[idx], np.full(len(idx), lat_a))
    b, _ = new.at(new.s[idx], np.full(len(idx), lat_b))
    verts = []
    for pa, pb in zip(a, b):
        verts += [(pa[0], pa[1], z), (pb[0], pb[1], z)]
    count = len(idx)
    faces = []
    for r in range(count if closed else count - 1):
        r2 = (r + 1) % count
        faces.append((2 * r, 2 * r + 1, 2 * r2 + 1, 2 * r2) if lat_b > lat_a
                     else (2 * r + 1, 2 * r, 2 * r2, 2 * r2 + 1))
    return verts, faces

# Road: pairs (left, right), ring 0 = start line, faces up
v, f = ribbon("Road", -ROAD_HALF, ROAD_HALF, ROAD_Z, None)
replace_mesh("Road", v, f, [mat("Asphalt")])
v, f = ribbon("Verge_L", -VERGE_OUT, -ROAD_HALF, VERGE_Z, None)
replace_mesh("Verge_L", v, f, [mat("GrassVerge")])
v, f = ribbon("Verge_R", ROAD_HALF, VERGE_OUT, VERGE_Z, None)
replace_mesh("Verge_R", v, f, [mat("GrassVerge")])
v, f = ribbon("EdgeLine_L", -ROAD_HALF, -ROAD_HALF + EDGE_WIDTH, EDGE_Z, None)
replace_mesh("EdgeLine_L", v, f, [mat("LineWhite")])
v, f = ribbon("EdgeLine_R", ROAD_HALF - EDGE_WIDTH, ROAD_HALF, EDGE_Z, None)
replace_mesh("EdgeLine_R", v, f, [mat("LineWhite")])
v, f = ribbon("RacingLine", -RACING_HALF, RACING_HALF, RACING_Z, None)
replace_mesh("RacingLine", v, f, [mat("AsphaltWorn")])

# Kerbs: same stretches as before on the unchanged part of the lap, and
# both sides of the new final corner
kerb_obj = objs["ApexKerbs"]
kv = world_verts(kerb_obj)
k_idx, k_lat, _ = old.locate(kv[:, :2])
kerb_s = old.s[k_idx]
curv = new.curvature()
kerb_runs = {-1: np.zeros(new.n, bool), 1: np.zeros(new.n, bool)}
for side in (-1, 1):
    s_side = np.sort(kerb_s[np.sign(k_lat) == side])
    s_side = s_side[s_side < old_a]                     # the moved stretch is redone below
    if len(s_side):
        breaks = np.where(np.diff(s_side) > 30.0)[0]
        starts = np.concatenate([[s_side[0]], s_side[breaks + 1]])
        ends = np.concatenate([s_side[breaks], [s_side[-1]]])
        for a, b in zip(starts, ends):
            ia = new.locate(old.at(a)[0][None])[0][0]
            ib = new.locate(old.at(b)[0][None])[0][0]
            kerb_runs[side][ia:ib + 1] = True
    corner = (new.s >= new_a) & (np.abs(curv) > 1.0 / 60.0)
    grown = np.convolve(corner.astype(int), np.ones(11, int), mode="same") > 0
    kerb_runs[side] |= grown
kerb_verts, kerb_faces, kerb_mats = [], [], []
for side in (-1, 1):
    flags = kerb_runs[side]
    runs, cur = [], []
    for i in range(new.n):
        if flags[i]:
            cur.append(i)
        elif cur:
            runs.append(cur)
            cur = []
    if cur:
        if runs and flags[0]:
            runs[0] = cur + runs[0]
        else:
            runs.append(cur)
    for run in runs:
        if len(run) < 3:
            continue
        lat_a, lat_b = (-KERB_OUT, -KERB_IN) if side < 0 else (KERB_IN, KERB_OUT)
        v, f = ribbon("k", lat_a, lat_b, KERB_Z, None, run, closed=False)
        base = len(kerb_verts)
        kerb_verts += v
        kerb_faces += [tuple(x + base for x in face) for face in f]
        kerb_mats += [int(new.s[run[r]] // KERB_BLOCK) % 2 for r in range(len(run) - 1)]
replace_mesh("ApexKerbs", kerb_verts, kerb_faces, [mat("KerbRed"), mat("KerbWhite")], kerb_mats)

# ---------------------------------------------------------------- gravel off the road
for o in [o for o in objs if o.name.startswith("GravelTrap")]:
    V = world_verts(o)
    idx, lat, _ = new.locate(V[:, :2])
    side = np.sign(np.median(lat))
    inside = side * lat < GRAVEL_INNER
    if not inside.any():
        continue
    V[inside, :2], _ = new.at(new.s[idx[inside]], np.full(inside.sum(), side * GRAVEL_INNER))
    inv = np.array(o.matrix_world.inverted())
    local = V @ inv[:3, :3].T + inv[:3, 3]
    for vtx, co in zip(o.data.vertices, local):
        vtx.co = co

# ---------------------------------------------------------------- scenery off the road
removed = []
for o in list(objs):
    if o.type != 'MESH' or not o.name.startswith(NATURAL):
        continue
    V = world_verts(o)
    _, lat, _ = new.locate(V[:, :2])
    if (np.abs(lat) < DRIVABLE).any():
        removed.append(np.array(o.matrix_world.translation[:2]))
        bpy.data.objects.remove(o, do_unlink=True)
# the rest of a tree whose trunk or crown was removed
if removed:
    gone = np.array(removed)
    for o in list(objs):
        if o.type == 'MESH' and o.name.startswith(NATURAL):
            p = np.array(o.matrix_world.translation[:2])
            if (np.linalg.norm(gone - p, axis=1) < 1.5).any():
                bpy.data.objects.remove(o, do_unlink=True)

# ---------------------------------------------------------------- materials
grass = bpy.data.materials.get("Grass")
if grass and grass.node_tree:
    bsdf = grass.node_tree.nodes.get("Principled BSDF")
    if bsdf:
        for link in list(bsdf.inputs["Base Color"].links):
            grass.node_tree.links.remove(link)
        bsdf.inputs["Base Color"].default_value = (0.12, 0.3, 0.08, 1.0)
    grass.diffuse_color = (0.12, 0.3, 0.08, 1.0)

k = new.curvature()
peaks = [i for i in range(new.n) if abs(k[i]) > 1 / 40 and abs(k[i]) >= abs(k[i - 1]) and abs(k[i]) >= abs(k[(i + 1) % new.n])]
print("=" * 60)
print(" GRAND PRIX FIXED")
print(f" lap                 {new.length:.0f} m, {new.n} rings, start ({new.p[0][0]:.1f}, {new.p[0][1]:.1f})")
print(f" tightest corner     R{1 / np.abs(k).max():.1f} m at {new.s[np.abs(k).argmax()]:.0f} m")
print(f" final corner exit   {EXIT_BEFORE_LINE:.0f} m before the line")
print(f" furniture moved     {moved} objects")
print(f" scenery removed     {len(removed)} objects in the drivable band")
print("=" * 60)
