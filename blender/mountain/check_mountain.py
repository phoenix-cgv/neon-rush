"""Checks a built Mountain .blend against the game team's acceptance criteria.

Headless:  python3 check_mountain.py Mountain.blend   (with `pip install bpy`)
In Blender: open the .blend, paste this into the Text Editor and Run Script.
Prints one PASS/FAIL line per criterion and exits non-zero on any FAIL.
"""
import bpy
import math
import sys
from mathutils import Vector
from mathutils.bvhtree import BVHTree

if bpy.app.background and len(sys.argv) > 1 and sys.argv[-1].endswith(".blend"):
    bpy.ops.wm.open_mainfile(filepath=sys.argv[-1])

RESULTS = []
def check(name, ok, detail):
    RESULTS.append(ok)
    print(f"{'PASS' if ok else 'FAIL'}  {name}: {detail}")

objs = bpy.data.objects
depsgraph = bpy.context.evaluated_depsgraph_get()

def world_verts(name):
    o = objs[name]
    return [o.matrix_world @ v.co for v in o.data.vertices]

def bvh(name):
    return BVHTree.FromObject(objs[name], depsgraph)

# ---- Road rows: vertex 2i = right edge, 2i+1 = left edge (race direction)
road = world_verts("Mountain Race Track")
n = len(road) // 2
right = [road[2 * i] for i in range(n)]
left = [road[2 * i + 1] for i in range(n)]
centre = [(r + l) / 2 for r, l in zip(right, left)]
seg = [(centre[(i + 1) % n] - centre[i]).length for i in range(n)]
ds = sum(seg) / n
dist = [0.0]
for s in seg[:-1]:
    dist.append(dist[-1] + s)
length = sum(seg)

def tangent(i):
    return (centre[(i + 1) % n] - centre[i - 1]).normalized()

def lean(i):
    """Degrees; > 0 means the right-hand edge is higher."""
    across = right[i] - left[i]
    return math.degrees(math.asin(max(-1, min(1, across.z / across.length))))

def radius(i, h=3):
    a, b, c = [Vector((p.x, p.y)) for p in (centre[i - h], centre[i], centre[(i + h) % n])]
    cross = (b - a).x * (c - b).y - (b - a).y * (c - b).x
    den = (b - a).length * (c - b).length * (c - a).length
    k = 2 * cross / den if den else 0.0
    return 1.0 / k if abs(k) > 1e-9 else float("inf")

area = sum(centre[i].x * centre[(i + 1) % n].y - centre[(i + 1) % n].x * centre[i].y for i in range(n)) / 2
t0 = tangent(0)
side0 = t0.x * (right[0] - centre[0]).y - t0.y * (right[0] - centre[0]).x
check("Lap direction", area > 0 and side0 < 0,
      f"anticlockwise from above, vertex 2i is the right-hand edge ({length:.0f} m, {n} rows, {ds:.2f} m apart)")

# ---- 1. Banking
worst = min(range(n), key=lambda i: (right[i] - left[i]).z)
check("1. Right edge never lower than left", (right[worst] - left[worst]).z >= -0.005,
      f"lowest right-minus-left height {(right[worst] - left[worst]).z:+.3f} m at {dist[worst]:.0f} m")
straight = [i for i in range(n) if abs(radius(i, 8)) > 150]
max_straight = max(abs(lean(i)) for i in straight)
check("1. Straights within 3 deg of flat", max_straight <= 3.0,
      f"max {max_straight:.1f} deg over {len(straight)} rows with R>150 m")
max_lean = max(lean(i) for i in range(n))
check("1. Lean modest (<= 15 deg)", max_lean <= 15.0, f"max {max_lean:.1f} deg")
print("      Report table rows (nearest row to each old location):")
for label, loc in [("Start line / first corner", (0, -180, 9)), ("100 m", (89, -158, 14)),
                   ("250 m", (155, -37, 34)), ("400 m", (94, 96, 57)), ("600 m", (-87, 153, 79)),
                   ("800 m (summit)", (-159, -9, 74)), ("1000 m", (-27, -149, 41)),
                   ("1200 m", (135, -79, 15)), ("1260 m (second tight)", (113, -26, 12))]:
    loc = Vector(loc)
    i = min(range(n), key=lambda k: (centre[k] - loc).length)
    dz = (right[i] - left[i]).z
    print(f"      {label:26s} row {i:3d} ({centre[i].x:6.1f},{centre[i].y:7.1f},{centre[i].z:5.1f})"
          f"  {abs(dz):.2f} m  {abs(lean(i)):4.1f} deg  higher: {'outside (right)' if dz >= 0 else 'INSIDE (left)'}"
          f"  R={radius(i):.0f}")

# ---- 2. Start / finish
gantry = objs["START FINISH GANTRY"].matrix_world.translation
gi = min(range(n), key=lambda k: (Vector((centre[k].x, centre[k].y)) - Vector((gantry.x, gantry.y))).length)
window = [(gi + k) % n for k in range(-int(60 / ds), int(60 / ds) + 1)]
min_r = min((radius(i) for i in window if radius(i) > 0), default=float("inf"))
min_r_right = max((radius(i) for i in window if radius(i) < 0), default=-float("inf"))
check("2. No corner tighter than 30 m within 60 m of the gantry", min_r >= 30 and min_r_right <= -30,
      f"tightest left R={min_r:.0f} m, right R={-min_r_right:.0f} m")
grade = max(abs(centre[window[k + 1]].z - centre[window[k]].z) / ds for k in range(len(window) - 1))
check("2. Start area nearly flat", grade <= 0.03 and abs(lean(gi)) <= 3.0,
      f"max grade {grade * 100:.1f}%, lean at line {lean(gi):.1f} deg")
checker = [o.matrix_world.translation for o in objs if o.name.startswith("Start Finish Checker")]
cmean = sum(checker, Vector()) / len(checker)
check("2. Line, gantry and road sample agree", (cmean - centre[gi]).length < 1.5 and gi in (0, 1, n - 1),
      f"start line at ({centre[gi].x:.1f}, {centre[gi].y:.1f}, {centre[gi].z:.1f}), road row {gi}")
all_pos = [r for r in (radius(i) for i in range(n)) if r > 0]
check("2. Tightest corner on the lap >= 12 m", min(all_pos) >= 12, f"R={min(all_pos):.1f} m")

# ---- 3. Kerbs sit on the road
road_tree = bvh("Mountain Race Track")
old_blocks = [o.name for o in objs if o.name.startswith("Red White Curb") and o.name[-1].isdigit()]
kerb_heights = []
for name in ("Red White Curb Left", "Red White Curb Right"):
    if name not in objs:
        kerb_heights.append(float("nan"))
        continue
    for v in world_verts(name):
        loc, nrm, _, d = road_tree.find_nearest(v)
        kerb_heights.append((v - loc).dot(nrm))
check("3. Kerbs are continuous strips, no loose blocks", not old_blocks, f"{len(old_blocks)} old blocks")
check("3. Kerbs seated (0 to 5 cm above the asphalt)",
      all(0.0 <= h <= 0.05 for h in kerb_heights),
      f"vertex heights {min(kerb_heights) * 100:.1f} to {max(kerb_heights) * 100:.1f} cm")

# ---- 4. Guardrails
for name, edge in (("Guardrail Left", left), ("Guardrail Right", right)):
    rail = world_verts(name)
    rows = len(rail) // n
    gaps, tops, offs = [], [], []
    for i in range(n):
        col = sorted(rail[i * rows:(i + 1) * rows], key=lambda v: v.z)
        e = edge[i]
        outward = (e - centre[i]).normalized()
        slope = outward.z / max(1e-6, Vector((outward.x, outward.y)).length)
        lateral = Vector((col[0].x - centre[i].x, col[0].y - centre[i].y)).length
        edge_lat = Vector((e.x - centre[i].x, e.y - centre[i].y)).length
        plane_z = e.z + slope * (lateral - edge_lat)
        gaps.append(col[0].z - plane_z)
        tops.append(col[-1].z - plane_z)
        offs.append(lateral)
    check(f"4. {name} bottom <= 0.2 m, top ~0.8 m",
          max(gaps) <= 0.2 and 0.7 <= min(tops) and max(tops) <= 0.9,
          f"bottom {min(gaps):.2f}-{max(gaps):.2f} m, top {min(tops):.2f}-{max(tops):.2f} m")
    check(f"4. {name} >= 5.4 m from centre", min(offs) >= 5.4, f"{min(offs):.2f} m")
shoulder_ok = all(n_ in objs for n_ in ("Road Shoulder Left", "Road Shoulder Right"))
check("4. Asphalt continues to the rails (shoulders)", shoulder_ok, "Road Shoulder Left/Right")

# ---- 5. Tunnel
leftovers = [o.name for o in objs if o.name.startswith(("Tunnel Dark Mouth", "Tunnel Portal Pillar",
                                                         "Tunnel Portal Header", "Tunnel Ceiling Beam"))]
check("5. Old floating tunnel pieces removed", not leftovers, f"{len(leftovers)} left")
walls = [o for o in objs if o.name == "Tunnel Wall"]      # the game matches these names exactly
roofs = [o for o in objs if o.name == "Tunnel Roof"]
inward = True
wall_min = float("inf")
def nearest_row(p):
    return min(range(n), key=lambda k: (Vector((centre[k].x, centre[k].y)) - Vector((p.x, p.y))).length_squared)
tunnel_rows = set()
for o in walls + roofs:
    mw = o.matrix_world
    for poly in o.data.polygons:
        c = mw @ poly.center
        i = nearest_row(c)
        tunnel_rows.add(i)
        to_axis = centre[i] + Vector((0, 0, 3)) - c
        to_axis -= tangent(i) * to_axis.dot(tangent(i))
        if (mw.to_3x3() @ poly.normal).dot(to_axis) <= 0:
            inward = False
        if o in walls:
            wall_min = min(wall_min, Vector((c.x - centre[i].x, c.y - centre[i].y)).length)
dupes = [o.name for o in objs if o.name.startswith(("Tunnel Wall.", "Tunnel Roof."))]
check("5. Exactly one Tunnel Wall and one Tunnel Roof", len(walls) == 1 and len(roofs) == 1 and not dupes,
      f"{len(walls)} wall, {len(roofs)} roof, {len(dupes)} duplicates")
check("5. Tunnel faces point inwards", inward, "every wall and roof face")
check("5. Walls >= 6 m from the road centre", wall_min >= 6.0, f"{wall_min:.2f} m")
lowest_roof, open_rays, rays = float("inf"), 0, 0
shell = [bvh(o.name) for o in walls + roofs]
tr = sorted(tunnel_rows)[6:-6]  # an angled ray within ~10 m of a mouth sees out of it
for i in tr:
    for f in (-1.0, -0.5, 0.0, 0.5, 1.0):
        p = centre[i] + (right[i] - centre[i]) * f + Vector((0, 0, 0.05))
        hits = [t.ray_cast(p, Vector((0, 0, 1)), 50.0) for t in shell]
        d = min((h[3] for h in hits if h[0] is not None), default=float("inf"))
        lowest_roof = min(lowest_roof, d)
    p = centre[i] + Vector((0, 0, 1.5))
    for ang in range(0, 360, 30):
        a = math.radians(ang)
        for elev in (0.0, 0.5, 1.2):
            dvec = Vector((math.cos(a), math.sin(a), elev)).normalized()
            if abs(dvec.dot(tangent(i))) > 0.5:
                continue   # looking along the tunnel, not at its sides
            rays += 1
            if all(t.ray_cast(p, dvec, 60.0)[0] is None for t in shell):
                open_rays += 1
                print(f"      escape: row {i} of {tr[0]}-{tr[-1]}, heading {ang}, elevation {elev}")
check("5. Roof >= 5 m above the road", lowest_roof >= 5.0, f"lowest clearance {lowest_roof:.2f} m")
check("5. Tunnel closed from the inside", open_rays == 0, f"{open_rays}/{rays} side/up rays escape")

# ---- 6. Terrain below the road (evaluated, i.e. after the Decimate modifier)
terrain_tree = bvh("Mountain Terrain")
worst = (float("inf"), None)
for i in range(n):
    for f in (-7 / 6, -1.0, -0.5, 0.0, 0.5, 1.0, 7 / 6):
        p = centre[i] + (right[i] - centre[i]) * f
        road_z = centre[i].z + (right[i].z - centre[i].z) * max(-1.0, min(1.0, f))
        hit = terrain_tree.ray_cast(Vector((p.x, p.y, p.z + 300)), Vector((0, 0, -1)), 1000.0)
        if hit[0] is not None:
            clearance = road_z - hit[0].z
            if clearance < worst[0]:
                worst = (clearance, p)
check("6. Terrain >= 0.3 m below the road (full width + 1 m)", worst[0] >= 0.3,
      f"min clearance {worst[0]:.2f} m at ({worst[1].x:.1f}, {worst[1].y:.1f})")

# ---- 7. Width
widths = [(right[i] - left[i]).length for i in range(n)]
check("7. Road 12 m wide", min(widths) >= 11.99, f"{min(widths):.2f}-{max(widths):.2f} m")

# ---- 8. Materials
bad = []
for m in bpy.data.materials:
    if not m.use_nodes:
        continue
    nodes = m.node_tree.nodes
    if any(nd.type == 'TEX_IMAGE' and not (nd.image and nd.image.packed_file) for nd in nodes):
        bad.append(f"{m.name} (unpacked image)")
    bsdf = nodes.get("Principled BSDF")
    if bsdf is None:
        bad.append(f"{m.name} (no Principled BSDF)")
        continue
    inp = bsdf.inputs["Base Color"]
    if inp.is_linked and not any(l.from_node.type == 'TEX_IMAGE' for l in inp.links):
        bad.append(f"{m.name} (Base Color driven by nodes)")
    elif not inp.is_linked and tuple(inp.default_value)[:3] == (1.0, 1.0, 1.0):
        bad.append(f"{m.name} (default white)")
check("8. Every material has a real Base Color", not bad, ", ".join(bad) or f"{len(bpy.data.materials)} materials")

print(f"\n{sum(RESULTS)}/{len(RESULTS)} checks passed")
if bpy.app.background:
    sys.exit(0 if all(RESULTS) else 1)
