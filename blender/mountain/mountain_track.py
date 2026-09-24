import bpy
import math
import random
import numpy as np
from mathutils import Vector, Matrix, noise

# ============================================================
# SPHINX MOUNTAIN GRAND PRIX
# Closed mountain circuit, generated entirely by this script.
# Blender 4.x / 5.x - open in the Scripting workspace and Run Script.
# Every object is deleted and rebuilt from the same centreline, so the
# road, rails, lines, kerbs, tunnel and terrain always stay in line.
#
# Conventions (all derived from the centreline, index 0 = start line):
#   race direction  = increasing sample index (anticlockwise from above)
#   right           = right-hand side when driving in the race direction
#   bank angle > 0  = right-hand edge higher. Every corner on this lap is
#                     a left-hander, so the right edge is the outside and
#                     the bank is never allowed to go negative.
# ============================================================

# Clean scene
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)

for datablocks in (bpy.data.meshes, bpy.data.curves, bpy.data.materials,
                   bpy.data.cameras, bpy.data.lights):
    for datablock in list(datablocks):
        try:
            datablocks.remove(datablock)
        except:
            pass

random.seed(42)

# Config
ROAD_WIDTH = 12.0            # 12 m takes the same 6-car field as the Grand Prix
ROAD_SAMPLES = 800           # evenly spaced along the centreline (~1.85 m)
ROAD_SURFACE_OFFSET = 0.5
TERRAIN_SIZE = 520
TERRAIN_RES = 150
NUM_TREES = 420
NUM_ROCKS = 150
POST_SPACING = 7

# Banking: angle = BANK_GAIN / radius, only ever raising the outside
# (right-hand) edge. 300 gives ~3 deg at R100, ~10 deg at R30, and the
# cap of 15 deg in the two tight corners (R15-R20).
BANK_GAIN = 300.0
MAX_BANK_DEG = 15.0
CURVATURE_SMOOTH = 6         # samples either side
BANK_SMOOTH = 8              # samples either side

# Guardrails: face from 0.15 m to 0.8 m above the road plane, 0.3 m
# outside the asphalt (so 6.3 m from the centre with a 12 m road)
RAIL_GAP = 0.3
RAIL_HEIGHTS = (0.15, 0.475, 0.8)
SHOULDER_WIDTH = 0.8         # flat shoulder under the rails, then a skirt
SKIRT_OUT = 0.5
SKIRT_DROP = 1.3

# Terrain stays at least this far below the lowest shoulder point
TERRAIN_ROAD_DROP = 1.0
TERRAIN_CLAMP_RADIUS = 12.0  # every terrain vertex this close to the road is clamped
BRIDGE_CLEARANCE = 24.0

# Tunnel cross-section (metres, relative to the road centre)
TUNNEL_WALL_X = 7.5
TUNNEL_CUT = 13.0            # terrain inside this is kept low; outside it is the mountain
TUNNEL_MOUNTAIN = 10.0       # mountain height above the road beside the tunnel

# Control points. The lap runs through them in order.
CONTROL_POINTS = [
    (18, -140, 8),       # 0  under the bridge, 20 m after the start line
    (8, -178, 8),        # 1  first corner (opened from R6 to ~R19)
    (22, -200, 8.3),     # 2
    (55, -196, 9.5),     # 3
    (95, -155, 14),      # 4
    (135, -120, 18),
    (155, -70, 28),
    (150, -10, 38),
    (125, 50, 48),
    (85, 105, 58),
    (25, 145, 68),
    (-45, 160, 75),
    (-105, 145, 80),     # 12 tunnel entry
    (-150, 100, 82),     # 13 summit
    (-170, 40, 80),      # 14 tunnel exit
    (-155, -20, 72),
    (-120, -75, 62),
    (-65, -130, 48),     # 17 bridge start
    (0, -155, 35),       # 18 bridge over the start straight
    (70, -145, 25),
    (120, -115, 18),
    (135, -70, 14),
    (110, -25, 11),      # 22 second tight corner
    (50, -55, 9),        # 23 onto the start straight
]
# Where the start/finish line sits: this many metres before control point 0,
# on the flat start straight
START_BEFORE_CP0 = 20.0

# Zones in control-point units (1.0 = one control point)
TUNNEL_ZONES = [(11.9, 14.1)]
BRIDGE_ZONES = [(16.96, 18.94)]


# Helpers
def catmull_rom(p0, p1, p2, p3, t):
    t2 = t * t
    t3 = t2 * t
    return 0.5 * (
        (2.0 * p1)
        + (-p0 + p2) * t
        + (2.0 * p0 - 5.0 * p1 + 4.0 * p2 - p3) * t2
        + (-p0 + 3.0 * p1 - 3.0 * p2 + p3) * t3
    )

def sample_uniform_closed_path(points, samples, dense=20000):
    """Samples evenly spaced by distance, with each sample's control-point parameter."""
    n = len(points)
    fine = []
    for i in range(dense):
        scaled = i / dense * n
        seg = int(scaled) % n
        t = scaled - math.floor(scaled)
        fine.append(catmull_rom(points[(seg - 1) % n], points[seg],
                                points[(seg + 1) % n], points[(seg + 2) % n], t))
    dist = [0.0]
    for i in range(1, dense + 1):
        dist.append(dist[-1] + (fine[i % dense] - fine[i - 1]).length)
    length = dist[-1]
    pts, params = [], []
    j = 0
    for k in range(samples):
        s = k * length / samples
        while dist[j + 1] < s:
            j += 1
        t = (s - dist[j]) / (dist[j + 1] - dist[j])
        pts.append(fine[j].lerp(fine[(j + 1) % dense], t))
        params.append((j + t) / dense * n)
    return pts, params, length

def create_mesh_object(name, verts, faces, material=None):
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(verts, [], faces)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    if material:
        obj.data.materials.append(material)
    return obj

def make_material(name, color, metallic=0.0, roughness=0.8):
    # Base Color is always set directly on the Principled BSDF: the game's
    # export only carries plain colours.
    mat = bpy.data.materials.new(name)
    mat.diffuse_color = (*color, 1.0)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    if bsdf:
        bsdf.inputs["Base Color"].default_value = (*color, 1.0)
        if "Metallic" in bsdf.inputs:
            bsdf.inputs["Metallic"].default_value = metallic
        if "Roughness" in bsdf.inputs:
            bsdf.inputs["Roughness"].default_value = roughness
    return mat

def zone_contains(u, zones):
    for a, b in zones:
        if a <= u <= b:
            return True
    return False

def smoothstep(edge0, edge1, x):
    if edge1 == edge0:
        return 1.0 if x >= edge0 else 0.0
    t = max(0.0, min(1.0, (x - edge0) / (edge1 - edge0)))
    return t * t * (3.0 - 2.0 * t)

def fbm(v, octaves=4, persistence=0.5):
    val = 0.0
    amp = 1.0
    maxv = 0.0
    freq = 1.0
    for _ in range(octaves):
        val += noise.noise(v * freq) * amp
        maxv += amp
        amp *= persistence
        freq *= 2.0
    return val / maxv if maxv else 0.0

def smooth_loop(values, radius):
    """Triangular moving average over a closed loop."""
    n = len(values)
    weights = [radius + 1 - abs(k) for k in range(-radius, radius + 1)]
    total = sum(weights)
    return [sum(values[(i + k) % n] * w for k, w in zip(range(-radius, radius + 1), weights)) / total
            for i in range(n)]

def sweep(name, profile, indices, closed, material=None, face_material=None):
    """Loft a cross-section along the road.

    profile(i) returns the section's points at sample i. Faces run
    (i,k) -> (j,k) -> (j,k+1) -> (i,k+1), so a profile that runs from the
    driver's right to left gives faces pointing up, and one that runs up a
    left-hand wall gives faces pointing at the road.
    """
    verts, faces, mats = [], [], []
    rows = None
    for i in indices:
        section = profile(i)
        rows = len(section)
        verts.extend(section)
    count = len(indices)
    for r in range(count if closed else count - 1):
        r2 = (r + 1) % count
        for k in range(rows - 1):
            faces.append((r * rows + k, r2 * rows + k, r2 * rows + k + 1, r * rows + k + 1))
            if face_material:
                mats.append(face_material(indices[r], k))
    obj = create_mesh_object(name, verts, faces, material)
    if face_material:
        for poly, m in zip(obj.data.polygons, mats):
            poly.material_index = m
    return obj

def orient(obj, forward, up):
    forward = (forward - up * forward.dot(up)).normalized()
    left = up.cross(forward).normalized()
    obj.rotation_euler = Matrix((forward, left, up)).transposed().to_euler()

def add_box(name, location, forward, up, half_size, material):
    bpy.ops.mesh.primitive_cube_add(size=2, location=location)
    obj = bpy.context.object
    obj.name = name
    obj.scale = half_size
    orient(obj, forward, up)
    obj.data.materials.append(material)
    return obj


# Centreline
control = [Vector(p) for p in CONTROL_POINTS]
road_points, road_params, total_length = sample_uniform_closed_path(control, ROAD_SAMPLES)
n = ROAD_SAMPLES
ds = total_length / n

# Rotate so sample 0 is the start/finish line
shift = int(round((total_length - START_BEFORE_CP0) / ds)) % n
road_points = road_points[shift:] + road_points[:shift]
road_params = road_params[shift:] + road_params[:shift]
half_width = ROAD_WIDTH / 2
UP = Vector((0, 0, 1))

road_tangents = []
road_rights = []      # horizontal, pointing to the driver's right
headings = []
for i in range(n):
    tangent = (road_points[(i + 1) % n] - road_points[(i - 1) % n]).normalized()
    road_tangents.append(tangent)
    road_rights.append(Vector((tangent.y, -tangent.x, 0)).normalized())
    headings.append(math.atan2(tangent.y, tangent.x))

# Signed curvature, + = left-hand corner
curvature = []
for i in range(n):
    turn = headings[(i + 1) % n] - headings[(i - 1) % n]
    turn = (turn + math.pi) % (2 * math.pi) - math.pi
    curvature.append(turn / (2 * ds))
curvature = smooth_loop(curvature, CURVATURE_SMOOTH)

# Lean into the corner: raise the outside (right-hand) edge. Right-hand
# kinks stay flat so the right edge is never lower than the left.
bank_deg = [min(MAX_BANK_DEG, BANK_GAIN * max(0.0, k)) for k in curvature]
bank_deg = smooth_loop(bank_deg, BANK_SMOOTH)
road_banks = [math.radians(b) for b in bank_deg]

road_centres = []     # centre of the asphalt surface
road_across = []      # unit vector from left edge to right edge, along the banked surface
road_normals = []
for i in range(n):
    b = road_banks[i]
    across = (road_rights[i] * math.cos(b) + UP * math.sin(b)).normalized()
    normal = across.cross(road_tangents[i]).normalized()
    if normal.z < 0:
        normal = -normal
    road_centres.append(road_points[i] + Vector((0, 0, ROAD_SURFACE_OFFSET)))
    road_across.append(across)
    road_normals.append(normal)

def surface(i, lateral, lift=0.0):
    """Point on the (extended) banked road plane; lateral > 0 is the right."""
    return road_centres[i] + road_across[i] * lateral + road_normals[i] * lift

in_tunnel = [zone_contains(u, TUNNEL_ZONES) for u in road_params]
in_bridge = [zone_contains(u, BRIDGE_ZONES) for u in road_params]
all_indices = list(range(n))

def zone_runs(flags):
    """Contiguous runs of flagged samples as lists of indices (loop-aware)."""
    if all(flags):
        return [all_indices]
    start = flags.index(False)
    runs, cur = [], []
    for k in range(1, n + 1):
        i = (start + k) % n
        if flags[i]:
            cur.append(i)
        elif cur:
            runs.append(cur)
            cur = []
    if cur:
        runs.append(cur)
    return runs

# Materials
asphalt_mat = make_material("Fresh Dark Asphalt", (0.025, 0.03, 0.035), roughness=0.82)
asphalt_edge_mat = make_material("Asphalt Shoulder", (0.075, 0.08, 0.085), roughness=0.9)
white_mat = make_material("White Road Marking", (0.95, 0.95, 0.9), roughness=0.45)
yellow_mat = make_material("Yellow Centre Marking", (0.95, 0.62, 0.02), roughness=0.45)
red_mat = make_material("Racing Red", (0.8, 0.015, 0.01), metallic=0.15, roughness=0.35)
curb_white_mat = make_material("Curb White", (0.95, 0.95, 0.92), roughness=0.5)
steel_mat = make_material("Guardrail", (0.32, 0.35, 0.39), metallic=0.8, roughness=0.3)
post_mat = make_material("Guardrail Posts", (0.12, 0.13, 0.14), metallic=0.25, roughness=0.5)
grass_dark = make_material("Grass Dark", (0.018, 0.09, 0.018), roughness=0.98)
grass_mid = make_material("Grass Mid", (0.055, 0.20, 0.035), roughness=0.98)
grass_light = make_material("Grass Light", (0.13, 0.34, 0.055), roughness=0.95)
rock_mat = make_material("Mountain Rock", (0.25, 0.22, 0.19), roughness=1.0)
rock_light_mat = make_material("Rock Highlight", (0.40, 0.36, 0.31), roughness=0.95)
bark_mat = make_material("Tree Bark", (0.16, 0.075, 0.025), roughness=0.98)
pine_mat = make_material("Pine Green", (0.015, 0.16, 0.025), roughness=0.98)
pine_dark_mat = make_material("Pine Dark", (0.008, 0.075, 0.012), roughness=1.0)
tunnel_concrete = make_material("Tunnel Concrete", (0.34, 0.36, 0.38), roughness=0.8)
tunnel_dark = make_material("Tunnel Interior", (0.10, 0.105, 0.11), roughness=0.92)
bridge_concrete = make_material("Bridge Concrete", (0.36, 0.37, 0.38), roughness=0.78)
bridge_shadow = make_material("Bridge Underside", (0.12, 0.13, 0.14), roughness=0.9)
check_black = make_material("Start Finish Black", (0.01, 0.01, 0.01), roughness=0.6)
check_white = make_material("Start Finish White", (0.92, 0.92, 0.92), roughness=0.45)
sign_blue = make_material("Race Sign Blue", (0.02, 0.18, 0.8), metallic=0.15, roughness=0.3)

# Road: two vertices per sample, [right edge, left edge], faces up
sweep("Mountain Race Track",
      lambda i: [surface(i, half_width), surface(i, -half_width)],
      all_indices, True, asphalt_mat)

# Edge lines
LINE_LIFT = 0.02
def create_edge_line(side):
    offset = side * (half_width - 0.35)
    width = 0.28
    return sweep(f"White Edge {'Left' if side < 0 else 'Right'}",
                 lambda i: [surface(i, offset + width / 2, LINE_LIFT),
                            surface(i, offset - width / 2, LINE_LIFT)],
                 all_indices, True, white_mat)

create_edge_line(-1)
create_edge_line(1)

# Centre dashes
def frame_at(distance):
    distance %= total_length
    f = distance / ds
    a = int(f) % n
    b = (a + 1) % n
    t = f - int(f)
    centre = road_centres[a].lerp(road_centres[b], t)
    across = road_across[a].lerp(road_across[b], t).normalized()
    normal = road_normals[a].lerp(road_normals[b], t).normalized()
    return centre, across, normal

dash_length = 4.0
gap_length = 5.0
verts = []
faces = []
cur = 0.0
while cur + dash_length <= total_length:
    w = 0.16
    base = len(verts)
    for d in (cur, cur + dash_length):
        c, a, nrm = frame_at(d)
        verts.append(c + a * w + nrm * LINE_LIFT)
        verts.append(c - a * w + nrm * LINE_LIFT)
    faces.append((base, base + 2, base + 3, base + 1))
    cur += dash_length + gap_length
create_mesh_object("Yellow Centre Dashes", verts, faces, yellow_mat)

# Kerbs: one continuous red/white strip per side, only through the corners,
# seated on the banked surface (2-5 mm at the edges, 35 mm on top)
KERB_RADIUS = 70.0
KERB_EXTEND = 6
KERB_MIN_SAMPLES = 10
KERB_BLOCK = 2               # samples per red or white block
def create_kerbs():
    corner = [c > 1.0 / KERB_RADIUS for c in curvature]
    grown = [any(corner[(i + k) % n] for k in range(-KERB_EXTEND, KERB_EXTEND + 1)) for i in range(n)]
    # no kerbs on the start/finish straight or inside the tunnel
    for i in range(n):
        if in_tunnel[i]:
            grown[i] = False
    runs = [r for r in zone_runs(grown) if len(r) >= KERB_MIN_SAMPLES]
    outer_off = half_width - 0.55
    inner_off = half_width - 1.35
    bevel = 0.12
    for side in (-1, 1):
        name = f"Red White Curb {'Left' if side < 0 else 'Right'}"
        verts, faces, mats = [], [], []
        for run in runs:
            base = len(verts)
            for r, i in enumerate(run):
                top = 0.035 if 0 < r < len(run) - 1 else 0.005
                laterals = [(outer_off, 0.005), (outer_off - bevel, top),
                            (inner_off + bevel, top), (inner_off, 0.005)]
                pts = [surface(i, side * lat, lift) for lat, lift in laterals]
                if side < 0:
                    pts.reverse()      # always run right -> left so faces point up
                verts.extend(pts)
            for r in range(len(run) - 1):
                for k in range(3):
                    a = base + r * 4 + k
                    faces.append((a, a + 4, a + 5, a + 1))
                    mats.append((r // KERB_BLOCK) % 2)
        obj = create_mesh_object(name, verts, faces, red_mat)
        obj.data.materials.append(curb_white_mat)
        for poly, m in zip(obj.data.polygons, mats):
            poly.material_index = m
    return runs

kerb_runs = create_kerbs()

# Shoulders: asphalt from the road edge to beyond the rails, then a skirt
# down into the terrain so the road never reads as a floating ribbon
def create_shoulder(side):
    def profile(i):
        pts = [surface(i, side * half_width),
               surface(i, side * (half_width + SHOULDER_WIDTH)),
               surface(i, side * (half_width + SHOULDER_WIDTH + SKIRT_OUT)) - UP * SKIRT_DROP]
        return pts if side < 0 else list(reversed(pts))
    sweep(f"Road Shoulder {'Left' if side < 0 else 'Right'}", profile, all_indices, True, asphalt_edge_mat)

create_shoulder(-1)
create_shoulder(1)

# Guardrails: one continuous strip each side, 0.15-0.8 m, facing the road
RAIL_OFFSET = half_width + RAIL_GAP
def create_guardrail(side):
    def profile(i):
        base = surface(i, side * RAIL_OFFSET)
        pts = [base + UP * h for h in RAIL_HEIGHTS]
        return pts if side < 0 else list(reversed(pts))
    sweep(f"Guardrail {'Left' if side < 0 else 'Right'}", profile, all_indices, True, steel_mat)
    post_half_height = (RAIL_HEIGHTS[-1] + 0.6) / 2
    for i in range(0, n, POST_SPACING):
        if in_tunnel[i] or in_bridge[i]:
            continue
        base = surface(i, side * (RAIL_OFFSET + 0.12))
        add_box(f"Guardrail Post {side}_{i}",
                base + UP * (RAIL_HEIGHTS[-1] - post_half_height),
                road_tangents[i], UP, (0.06, 0.06, post_half_height), post_mat)

create_guardrail(-1)
create_guardrail(1)

# Terrain
terrain_verts = []
terrain_faces = []
grid = TERRAIN_RES
half_terrain = TERRAIN_SIZE / 2

road_xy = np.array([(p.x, p.y) for p in road_points])
road_z = np.array([c.z for c in road_centres])
shoulder_low = np.array([
    min(surface(i, -(half_width + SHOULDER_WIDTH)).z, surface(i, half_width + SHOULDER_WIDTH).z)
    for i in range(n)])
terrain_target = shoulder_low - TERRAIN_ROAD_DROP

def distance_to_zone(flags):
    """Along-road distance (m) from each sample to the nearest flagged sample."""
    out = [0.0 if f else 1e9 for f in flags]
    for _ in range(2):
        for i in range(n):
            out[i] = min(out[i], out[i - 1] + ds)
        for i in reversed(range(n)):
            out[i] = min(out[i], out[(i + 1) % n] + ds)
    return out

def bridge_factor(u):
    f = 0.0
    for a, b in BRIDGE_ZONES:
        margin = (b - a) * 0.45
        if u < a - margin or u > b + margin:
            continue
        if u < a:
            f = max(f, smoothstep(a - margin, a, u))
        elif u > b:
            f = max(f, smoothstep(b + margin, b, u))
        else:
            f = 1.0
    return f

bridge_f = [bridge_factor(u) for u in road_params]
tunnel_dist = distance_to_zone(in_tunnel)
tunnel_f = [1.0 - smoothstep(0.0, 30.0, d) for d in tunnel_dist]

def terrain_height(x, y):
    h = 0.0
    ridge1 = max(0.0, 1.0 - abs(x) / 220)
    ridge2 = max(0.0, 1.0 - abs(y + 50) / 260)
    h += ridge1 * 55
    h += ridge2 * 30
    h += fbm(Vector((x * 0.008, y * 0.008, 0.5))) * 24
    h += fbm(Vector((x * 0.02, y * 0.02, 1.5))) * 12
    h += fbm(Vector((x * 0.05, y * 0.05, 2.5))) * 5
    valley = math.exp(-((x + 20) ** 2 + (y + 80) ** 2) / 4000)
    h -= valley * 35
    return h

def final_terrain_height(x, y):
    """Natural terrain, shaped around the road, then clamped under it."""
    z = terrain_height(x, y)
    natural = z
    d2 = (road_xy[:, 0] - x) ** 2 + (road_xy[:, 1] - y) ** 2
    ri = int(np.argmin(d2))
    distance = math.sqrt(d2[ri])

    bf = bridge_f[ri]
    target = terrain_target[ri] * (1.0 - bf) + (road_z[ri] - BRIDGE_CLEARANCE) * bf
    edge_start = half_width + SHOULDER_WIDTH + SKIRT_OUT + 0.5
    edge_end = half_width + 10.0 + bf * 30.0
    if distance < edge_start:
        z = target
    elif distance < edge_end:
        t = smoothstep(edge_start, edge_end, distance)
        z = target * (1.0 - t) + z * t

    # The mountain the tunnel runs through
    tf = tunnel_f[ri]
    if tf > 0.0 and distance >= TUNNEL_CUT:
        top = road_z[ri] + TUNNEL_MOUNTAIN
        mountain = top + (natural - top) * smoothstep(18.0, 60.0, distance) if natural < top else natural
        z = max(z, z + (mountain - z) * tf)

    # Never above any stretch of road within reach (this also handles the
    # lower road passing under the bridge)
    near = d2 < TERRAIN_CLAMP_RADIUS ** 2
    if near.any():
        z = min(z, float(terrain_target[near].min()))
    return z

for iy in range(grid + 1):
    y = -half_terrain + iy / grid * TERRAIN_SIZE
    for ix in range(grid + 1):
        x = -half_terrain + ix / grid * TERRAIN_SIZE
        terrain_verts.append((x, y, final_terrain_height(x, y)))

for y in range(grid):
    for x in range(grid):
        a = y*(grid+1)+x
        b = a+1
        c = a+grid+2
        d = a+grid+1
        terrain_faces.append((a,b,c,d))

terrain_obj = create_mesh_object("Mountain Terrain", terrain_verts, terrain_faces)
bpy.context.view_layer.objects.active = terrain_obj
mod = terrain_obj.modifiers.new(name="Cliffs", type='DECIMATE')
mod.decimate_type = 'DISSOLVE'
mod.angle_limit = math.radians(2)
terrain_obj.data.materials.append(grass_dark)
terrain_obj.data.materials.append(grass_mid)
terrain_obj.data.materials.append(grass_light)
terrain_obj.data.materials.append(rock_mat)
terrain_obj.data.materials.append(rock_light_mat)
for poly in terrain_obj.data.polygons:
    z = poly.center.z
    if z > 52:
        poly.material_index = 4
    elif z > 38:
        poly.material_index = 3
    elif z > 22:
        poly.material_index = 2
    elif z > 8:
        poly.material_index = 1
    else:
        poly.material_index = 0

# Tunnel: walls and an arched roof facing inwards, a hillside cap over the
# top and a concrete portal at each end. The game makes "Tunnel Wall" solid.
TUNNEL_INNER = [(-TUNNEL_WALL_X, -1.5), (-TUNNEL_WALL_X, 4.2), (-6.0, 5.6), (-3.5, 6.4),
                (0.0, 6.7), (3.5, 6.4), (6.0, 5.6), (TUNNEL_WALL_X, 4.2), (TUNNEL_WALL_X, -1.5)]
TUNNEL_OUTER = [(-18.0, -1.5), (-18.0, 9.5), (-12.0, 10.2), (-6.0, 10.66), (0.0, 10.8),
                (6.0, 10.66), (12.0, 10.2), (18.0, 9.5), (18.0, -1.5)]

def tunnel_point(i, x, z):
    return road_centres[i] + road_rights[i] * x + UP * z

def create_tunnel(run):
    # Both walls in one object, so it is named exactly "Tunnel Wall"
    left_wall = sweep("Tunnel Wall", lambda i: [tunnel_point(i, x, z) for x, z in TUNNEL_INNER[:2]], run, False, tunnel_concrete)
    right_wall = sweep("Tunnel Wall R", lambda i: [tunnel_point(i, x, z) for x, z in TUNNEL_INNER[-2:]], run, False, tunnel_concrete)
    with bpy.context.temp_override(active_object=left_wall, selected_editable_objects=[left_wall, right_wall]):
        bpy.ops.object.join()
    left_wall.name = "Tunnel Wall"
    left_wall.data.name = "Tunnel Wall"
    sweep("Tunnel Roof", lambda i: [tunnel_point(i, x, z) for x, z in TUNNEL_INNER[1:-1]], run, False, tunnel_dark)
    # Hillside over the roof, faces up (profile runs right -> left)
    cap_x = [18.0, 12.0, 6.0, 0.0, -6.0, -12.0, -18.0]
    sweep("Tunnel Hillside", lambda i: [tunnel_point(i, x, 10.8 - 0.004 * x * x) for x in cap_x],
          run, False, rock_light_mat)
    # Portals: the ring between the inner arch and the outer outline
    for end, i in (("Entry", run[0]), ("Exit", run[-1])):
        verts = [tunnel_point(i, x, z) for x, z in TUNNEL_INNER] + \
                [tunnel_point(i, x, z) for x, z in TUNNEL_OUTER]
        k = len(TUNNEL_INNER)
        faces = []
        for s in range(k - 1):
            quad = (s, s + 1, k + s + 1, k + s)
            faces.append(quad if end == "Exit" else tuple(reversed(quad)))
        create_mesh_object(f"Tunnel Portal {end}", verts, faces, tunnel_concrete)
    for r in range(8, len(run) - 4, 16):
        i = run[r]
        bpy.ops.object.light_add(type='POINT', location=tunnel_point(i, 0.0, 5.6))
        lamp = bpy.context.object
        lamp.name = "Tunnel Interior Light"
        lamp.data.energy = 180
        lamp.data.color = (1.0, 0.42, 0.12)
        lamp.data.shadow_soft_size = 1.2

tunnel_runs = zone_runs(in_tunnel)
for run in tunnel_runs:
    create_tunnel(run)

# Bridges / viaducts
def road_below(p, radius, deck_z):
    d2 = (road_xy[:, 0] - p.x) ** 2 + (road_xy[:, 1] - p.y) ** 2
    mask = (d2 < radius ** 2) & (road_z < deck_z - 5.0)
    return bool(mask.any())

def create_bridge_section(run):
    count = max(3, len(run) // 12)
    for k in range(count):
        idx = run[int(k * (len(run) - 1) / (count - 1))]
        top = road_centres[idx]
        right = road_rights[idx]
        tangent = road_tangents[idx]
        for side in (-1, 1):
            pier_pos = top + right * side * (half_width - 2.0)
            if road_below(pier_pos, half_width + SHOULDER_WIDTH + 2.0, top.z):
                continue   # never stand a pier in the road underneath
            ground_z = final_terrain_height(pier_pos.x, pier_pos.y)
            pier_len = max(4.0, (top.z - ground_z) + 0.5)
            pier_pos.z = ground_z + pier_len / 2 - 0.5
            add_box("Bridge Support Pier", pier_pos, tangent, UP, (0.85, 0.85, pier_len / 2), bridge_concrete)
        add_box("Bridge Cross Beam", top + UP * -0.7, tangent, UP, (1.0, half_width + 2.0, 0.6), bridge_shadow)
    for side in (-1, 1):
        def profile(i):
            base = surface(i, side * (half_width + SHOULDER_WIDTH + 0.1))
            pts = [base + UP * -0.3, base + UP * 1.1]
            return pts if side < 0 else list(reversed(pts))
        sweep("Bridge Concrete Parapet", profile, run, False, bridge_concrete)

for run in zone_runs(in_bridge):
    create_bridge_section(run)

# Trees
def nearest_road_distance(x, y):
    d2 = (road_xy[:, 0] - x) ** 2 + (road_xy[:, 1] - y) ** 2
    ri = int(np.argmin(d2))
    return math.sqrt(d2[ri]), ri

tree_count = 0
attempts = 0
while tree_count < NUM_TREES and attempts < NUM_TREES*8:
    attempts += 1
    x = random.uniform(-TERRAIN_SIZE*0.45, TERRAIN_SIZE*0.45)
    y = random.uniform(-TERRAIN_SIZE*0.45, TERRAIN_SIZE*0.45)
    distance, ri = nearest_road_distance(x, y)
    if distance < ROAD_WIDTH + 8:
        continue
    if in_bridge[ri] or (tunnel_f[ri] > 0 and distance < 22):
        continue
    z = final_terrain_height(x, y)
    if z < 2 or z > 85:
        continue
    scale = random.uniform(0.65,1.9)
    bpy.ops.mesh.primitive_cylinder_add(
        vertices=8,
        radius=0.18*scale,
        depth=3.2*scale,
        location=(x,y,z+1.6*scale - 0.3)
    )
    trunk = bpy.context.object
    trunk.name = f"Tree Trunk {tree_count}"
    trunk.data.materials.append(bark_mat)
    for layer in range(3):
        radius = (2.3-layer*0.52)*scale
        height = (3.1-layer*0.3)*scale
        zoff = (2.4+layer*2.05)*scale
        bpy.ops.mesh.primitive_cone_add(
            vertices=9,
            radius1=radius,
            radius2=0,
            depth=height,
            location=(x,y,z+zoff)
        )
        foliage = bpy.context.object
        foliage.name = f"Tree Foliage {tree_count}_{layer}"
        foliage.data.materials.append(
            pine_mat if layer < 2 else pine_dark_mat
        )
    tree_count += 1

# Rocks
rock_count = 0
attempts = 0
while rock_count < NUM_ROCKS and attempts < NUM_ROCKS*8:
    attempts += 1
    x = random.uniform(-TERRAIN_SIZE*0.46,TERRAIN_SIZE*0.46)
    y = random.uniform(-TERRAIN_SIZE*0.46,TERRAIN_SIZE*0.46)
    distance, ri = nearest_road_distance(x, y)
    if distance < ROAD_WIDTH+5:
        continue
    if tunnel_f[ri] > 0 and distance < 20:
        continue
    z = final_terrain_height(x, y)
    if z < 0:
        continue
    sx = random.uniform(0.5,3.4)
    sy = random.uniform(0.5,3.4)
    sz = random.uniform(0.35,2.2)
    bpy.ops.mesh.primitive_ico_sphere_add(
        subdivisions=1,
        radius=1,
        location=(x,y,z+sz*0.25)
    )
    rock = bpy.context.object
    rock.name = f"Rock {rock_count}"
    rock.scale = (sx,sy,sz)
    rock.rotation_euler = (
        random.uniform(0,math.pi),
        random.uniform(0,math.pi),
        random.uniform(0,math.pi*2)
    )
    rock.data.materials.append(
        rock_mat if rock_count % 3 else rock_light_mat
    )
    rock_count += 1

# Start / finish at sample 0, on the flat start straight. Cars line up
# behind it (lower sample indices) in rows 9 m apart.
start = road_centres[0]
start_tangent = road_tangents[0]
start_normal = road_normals[0]
start_flat = Vector((start_tangent.x, start_tangent.y, 0)).normalized()
start_right = road_rights[0]
tile_w = ROAD_WIDTH/8
tile_l = 1.3
for row in range(2):
    for col in range(8):
        pos = surface(0, (col - 3.5) * tile_w, 0.035) + start_tangent * (row - 0.5) * tile_l
        add_box("Start Finish Checker", pos, start_tangent, start_normal,
                (tile_l / 2, tile_w / 2, 0.03),
                check_black if (row + col) % 2 == 0 else check_white)
for side in (-1,1):
    p = start + start_right * side * (half_width + SHOULDER_WIDTH + SKIRT_OUT + 1.2)
    bpy.ops.mesh.primitive_cylinder_add(
        vertices=16,
        radius=0.48,
        depth=12,
        location=p+Vector((0,0,4))
    )
    pillar = bpy.context.object
    pillar.name = "Start Finish Gantry Pillar"
    pillar.data.materials.append(red_mat)
gantry_half = half_width + SHOULDER_WIDTH + SKIRT_OUT + 2.0
add_box("START FINISH GANTRY", start + UP * 10, start_flat, UP, (0.65, gantry_half, 0.65), red_mat)
add_box("START FINISH SIGN", start + UP * 8.6, start_flat, UP, (0.10, gantry_half - 0.9, 0.8), check_black)

# Race direction arrows, painted flat on the road
verts, faces = [], []
for u in (0.08, 0.46, 0.73):
    idx = int(u * n) % n
    c = surface(idx, 0.0, LINE_LIFT)
    f = road_tangents[idx]
    a = road_across[idx]
    base = len(verts)
    verts.extend([c + f * 1.6, c - f * 0.8 - a * 0.9, c - f * 0.8 + a * 0.9])
    faces.append((base, base + 1, base + 2))
create_mesh_object("Race Direction Arrow", verts, faces, white_mat)

# Lighting
bpy.ops.object.light_add(type='SUN', location=(120,-100,180))
sun = bpy.context.object
sun.name = "Mountain Sun"
sun.data.energy = 4.5
sun.data.angle = math.radians(20)
sun.rotation_euler = (
    math.radians(28),
    math.radians(-22),
    math.radians(25)
)
bpy.ops.object.light_add(type='AREA', location=(-100,-80,130))
fill = bpy.context.object
fill.name = "Mountain Fill"
fill.data.energy = 700
fill.data.shape = 'DISK'
fill.data.size = 100
fill.rotation_euler = (math.radians(20),0,math.radians(-25))

# Camera
camera_position = Vector((205,-235,170))
bpy.ops.object.camera_add(location=camera_position)
camera = bpy.context.object
camera.name = "Grand Prix Overview Camera"
camera.data.lens = 31
camera.data.sensor_width = 36
bpy.context.scene.camera = camera
target = Vector((0,20,25))
direction = target-camera.location
camera.rotation_euler = direction.to_track_quat('-Z','Y').to_euler()

# World
world = bpy.data.worlds.get("World")
if world is None:
    world = bpy.data.worlds.new("World")
bpy.context.scene.world = world
world.use_nodes = True
background = world.node_tree.nodes.get("Background")
if background:
    background.inputs["Color"].default_value = (0.08,0.22,0.48,1)
    background.inputs["Strength"].default_value = 0.55

# Render
scene = bpy.context.scene
try:
    scene.render.engine = 'BLENDER_EEVEE_NEXT'
except TypeError:
    scene.render.engine = 'BLENDER_EEVEE'
scene.render.resolution_x = 1920
scene.render.resolution_y = 1080
scene.render.resolution_percentage = 100
try:
    scene.view_settings.look = 'AgX - Medium High Contrast'
except:
    pass

# Organisation
bpy.ops.object.select_all(action='DESELECT')
camera.select_set(True)
bpy.context.view_layer.objects.active = camera

tight = sorted((1.0 / k, i * ds) for i, k in enumerate(curvature)
               if k > 0 and k >= curvature[i - 1] and k >= curvature[(i + 1) % n] and 1.0 / k < 40)
print("="*70)
print(" SPHINX MOUNTAIN GRAND PRIX")
print("="*70)
print(f" LAP LENGTH               : {total_length:.1f} m")
print(f" ROAD WIDTH               : {ROAD_WIDTH:.1f} m, rails {RAIL_OFFSET:.2f} m from centre")
print(f" START / FINISH LINE      : ({start.x:.1f}, {start.y:.1f}, {start.z:.1f})  (road sample 0)")
print(f" RACE DIRECTION           : ({start_flat.x:.3f}, {start_flat.y:.3f}, 0)")
print(f" TIGHT CORNERS (<40 m)    : " + ", ".join(f"R{r:.0f} at {s:.0f} m" for r, s in tight))
print(f" BANKING                  : 0 to {max(bank_deg):.1f} deg, outside (right) edge up")
print(f" KERB SECTIONS            : {len(kerb_runs)} per side")
print(f" TUNNEL                   : {sum(len(r) for r in tunnel_runs) * ds:.0f} m")
print(f" TREES                    : {tree_count}")
print(f" ROCKS                    : {rock_count}")
print("="*70)
