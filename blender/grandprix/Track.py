# =============================================================================
# GRAND PRIX REALISM UPGRADE
# Run AFTER Track2.py, and before blender/grandprix/fix_grandprix.py
# Blender 4.x / Eevee
# =============================================================================

import bpy
import math
import random
from mathutils import Vector

random.seed(42)

# =============================================================================
# SETTINGS
# =============================================================================

ROAD_WIDTH = 14.0

# How close trees can get to the road edge
TREE_MIN_DIST = 20.0
TREE_MAX_DIST = 65.0

# Number of additional trees
TRACK_TREES = 260

# Grass clumps
GRASS_CLUMPS = 450

# =============================================================================
# HELPERS
# =============================================================================

def get_mat(name):
    return bpy.data.materials.get(name)

def make_mat(name, color, roughness=0.8):
    m = bpy.data.materials.get(name)

    if m is None:
        m = bpy.data.materials.new(name)

    m.use_nodes = True

    bsdf = m.node_tree.nodes.get("Principled BSDF")

    if bsdf:
        bsdf.inputs["Base Color"].default_value = (
            color[0], color[1], color[2], 1
        )
        bsdf.inputs["Roughness"].default_value = roughness

    return m


def assign_mat(obj, material):
    if not obj or not hasattr(obj.data, "materials"):
        return

    obj.data.materials.clear()
    obj.data.materials.append(material)


def cube(name, location, scale, material, rotation=0):
    bpy.ops.mesh.primitive_cube_add(
        size=1,
        location=location
    )

    obj = bpy.context.object
    obj.name = name
    obj.scale = scale
    obj.rotation_euler[2] = rotation

    assign_mat(obj, material)

    return obj


def cylinder(name, location, radius, depth, material, rotation=0):
    bpy.ops.mesh.primitive_cylinder_add(
        vertices=12,
        radius=radius,
        depth=depth,
        location=location
    )

    obj = bpy.context.object
    obj.name = name
    obj.rotation_euler[2] = rotation

    assign_mat(obj, material)

    return obj


def cone(name, location, r1, r2, depth, material):
    bpy.ops.mesh.primitive_cone_add(
        vertices=10,
        radius1=r1,
        radius2=r2,
        depth=depth,
        location=location
    )

    obj = bpy.context.object
    obj.name = name

    assign_mat(obj, material)

    return obj


def bevel(obj, amount=0.3, segments=3):

    if not obj:
        return

    mod = obj.modifiers.new(
        name="Realistic_Bevel",
        type='BEVEL'
    )

    mod.width = amount
    mod.segments = segments

    mod.limit_method = 'ANGLE'


# =============================================================================
# REALISTIC MATERIALS
# =============================================================================

# -----------------------------------------------------------------------------
# GRASS
# -----------------------------------------------------------------------------

grass = bpy.data.materials.get("Grass")

if grass is None:
    grass = make_mat(
        "RealisticGrass",
        (0.16, 0.36, 0.08),
        0.95
    )

grass.use_nodes = True

nodes = grass.node_tree.nodes
links = grass.node_tree.links

nodes.clear()

out = nodes.new("ShaderNodeOutputMaterial")
bsdf = nodes.new("ShaderNodeBsdfPrincipled")

noise = nodes.new("ShaderNodeTexNoise")
noise.inputs["Scale"].default_value = 3.5
noise.inputs["Detail"].default_value = 7.0
noise.inputs["Roughness"].default_value = 0.8

noise2 = nodes.new("ShaderNodeTexNoise")
noise2.inputs["Scale"].default_value = 18.0
noise2.inputs["Detail"].default_value = 4.0

ramp = nodes.new("ShaderNodeValToRGB")

ramp.color_ramp.elements[0].position = 0.28
ramp.color_ramp.elements[0].color = (
    0.035, 0.10, 0.018, 1
)

ramp.color_ramp.elements[1].position = 0.75
ramp.color_ramp.elements[1].color = (
    0.24, 0.48, 0.075, 1
)

bump = nodes.new("ShaderNodeBump")
bump.inputs["Strength"].default_value = 0.25
bump.inputs["Distance"].default_value = 0.25

links.new(noise.outputs["Fac"], ramp.inputs["Fac"])
links.new(ramp.outputs["Color"], bsdf.inputs["Base Color"])

links.new(noise2.outputs["Fac"], bump.inputs["Height"])
links.new(bump.outputs["Normal"], bsdf.inputs["Normal"])

bsdf.inputs["Roughness"].default_value = 0.92

links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])


# -----------------------------------------------------------------------------
# ASPHALT
# -----------------------------------------------------------------------------

asphalt = bpy.data.materials.get("Asphalt")

if asphalt:

    asphalt.use_nodes = True

    nodes = asphalt.node_tree.nodes
    links = asphalt.node_tree.links

    bsdf = nodes.get("Principled BSDF")

    noise = nodes.new("ShaderNodeTexNoise")
    noise.inputs["Scale"].default_value = 22
    noise.inputs["Detail"].default_value = 5
    noise.inputs["Roughness"].default_value = 0.75

    bump = nodes.new("ShaderNodeBump")
    bump.inputs["Strength"].default_value = 0.12
    bump.inputs["Distance"].default_value = 0.08

    links.new(
        noise.outputs["Fac"],
        bump.inputs["Height"]
    )

    links.new(
        bump.outputs["Normal"],
        bsdf.inputs["Normal"]
    )

    bsdf.inputs["Roughness"].default_value = 0.88


# =============================================================================
# GROUND MATERIAL
# =============================================================================

ground = bpy.data.objects.get("GroundGrass")

if ground:

    assign_mat(ground, grass)

    # Slight bevel is not useful on huge ground plane
    # so instead add subtle displacement modifier
    disp = ground.modifiers.new(
        "Very_Soft_Ground",
        "DISPLACE"
    )

    tex = bpy.data.textures.new(
        "GroundNaturalVariation",
        type='CLOUDS'
    )

    tex.noise_scale = 80
    tex.noise_depth = 2

    disp.texture = tex
    disp.strength = 0.35
    disp.texture_coords = 'GLOBAL'


# =============================================================================
# REALISTIC BUILDING MATERIALS
# =============================================================================

CONCRETE = make_mat(
    "RealisticConcrete",
    (0.42, 0.44, 0.43),
    0.82
)

CONCRETE_DARK = make_mat(
    "ConcreteDark",
    (0.18, 0.20, 0.21),
    0.75
)

GLASS = make_mat(
    "DarkReflectiveGlass",
    (0.015, 0.08, 0.12),
    0.18
)

METAL = make_mat(
    "BuildingMetal",
    (0.12, 0.14, 0.16),
    0.35
)

ROOF_MAT = make_mat(
    "ModernRoof",
    (0.035, 0.045, 0.065),
    0.55
)

DOOR_RED = make_mat(
    "GarageDoorRed",
    (0.55, 0.025, 0.025),
    0.5
)

DOOR_BLUE = make_mat(
    "GarageDoorBlue",
    (0.025, 0.10, 0.45),
    0.5
)

DOOR_YELLOW = make_mat(
    "GarageDoorYellow",
    (0.85, 0.58, 0.025),
    0.5
)


# =============================================================================
# IMPROVE EXISTING BUILDINGS
# =============================================================================

for obj in list(bpy.context.scene.objects):

    if obj.name.startswith("Garage"):
        bevel(obj, 0.35, 3)

    elif obj.name.startswith("TimingTower"):
        bevel(obj, 0.45, 4)

    elif obj.name.endswith("_Base"):
        bevel(obj, 0.45, 4)

    elif obj.name.endswith("_Roof"):
        bevel(obj, 0.25, 3)

    elif obj.name == "PitWall":
        bevel(obj, 0.12, 2)


# =============================================================================
# GARAGE WINDOWS + ARCHITECTURAL DETAILS
# =============================================================================

# Blender appends .001, .002, ... when Track2 creates repeated Garage objects.
garages = [
    obj for obj in bpy.context.scene.objects
    if obj.name == "Garage" or obj.name.startswith("Garage.")
]

for i, garage in enumerate(garages):

    pos = garage.location
    rot = garage.rotation_euler[2]

    # Windows on rear/upper side
    for j in range(3):

        local_x = -3.5 + j * 3.5
        local_y = 4.08

        c = math.cos(rot)
        s = math.sin(rot)

        x = pos.x + local_x * c - local_y * s
        y = pos.y + local_x * s + local_y * c

        window = cube(
            "Garage_Window",
            (x, y, 5.2),
            (1.25, 0.12, 1.0),
            GLASS,
            rot
        )

        bevel(window, 0.06, 2)

    # Garage roof trim
    c = math.cos(rot)
    s = math.sin(rot)

    roof_x = pos.x
    roof_y = pos.y

    roof = cube(
        "Garage_RoofTrim",
        (roof_x, roof_y, 7.15),
        (5.9, 4.15, 0.25),
        ROOF_MAT,
        rot
    )

    bevel(roof, 0.12, 2)


# =============================================================================
# PIT BUILDING WINDOWS
# =============================================================================

pit_buildings = [
    obj for obj in bpy.context.scene.objects
    if obj.name == "TimingTower"
]

for tower in pit_buildings:

    pos = tower.location
    rot = tower.rotation_euler[2]

    # Front glass wall
    for row in range(3):

        for col in range(4):

            lx = -6 + col * 4
            z = 11 + row * 2.3

            c = math.cos(rot)
            s = math.sin(rot)

            x = pos.x + lx * c - (-5.05) * s
            y = pos.y + lx * s + (-5.05) * c

            window = cube(
                "Tower_Window",
                (x, y, z),
                (1.5, 0.12, 0.75),
                GLASS,
                rot
            )

            bevel(window, 0.05, 2)


# =============================================================================
# GRANDSTAND DETAILS
# =============================================================================

for obj in list(bpy.context.scene.objects):

    if "_Base" in obj.name:
        bevel(obj, 0.35, 3)

    if "_Wall" in obj.name:
        bevel(obj, 0.18, 2)

    if "_Roof" in obj.name:
        bevel(obj, 0.25, 3)


# =============================================================================
# TREE MATERIALS
# =============================================================================

TRUNK = make_mat(
    "NaturalTreeTrunk",
    (0.18, 0.075, 0.025),
    0.95
)

BARK_DARK = make_mat(
    "DarkBark",
    (0.07, 0.025, 0.012),
    0.98
)

LEAF_DARK = make_mat(
    "RealisticLeavesDark",
    (0.025, 0.16, 0.025),
    0.9
)

LEAF_MID = make_mat(
    "RealisticLeaves",
    (0.055, 0.29, 0.045),
    0.88
)

LEAF_LIGHT = make_mat(
    "RealisticLeavesLight",
    (0.13, 0.42, 0.065),
    0.86
)


# =============================================================================
# GET TRACK CENTERLINE
# =============================================================================
# The original Track2 Road mesh contains pairs of vertices.
# Average each pair to recover the centreline.

road = bpy.data.objects.get("Road")

if road is None:
    raise RuntimeError(
        "track3.py must be run after Track2.py. "
        "The required object 'Road' was not found."
    )

track_points = []

verts = road.data.vertices

for i in range(0, len(verts), 2):

    if i + 1 >= len(verts):
        break

    a = road.matrix_world @ verts[i].co
    b = road.matrix_world @ verts[i + 1].co

    centre = (a + b) / 2

    track_points.append(
        Vector((centre.x, centre.y, 0))
    )


# =============================================================================
# DISTANCE TO TRACK
# =============================================================================

def distance_to_track(x, y):
    # Distance to the road's centreline SEGMENTS, not its vertices: the
    # Road ring vertices are up to 42 m apart on the straights, so a point
    # halfway between two of them can be on the asphalt and still read as
    # 20 m from the nearest vertex. That is how grass clumps, bushes and
    # trees ended up on the track.

    if not track_points:
        return 9999

    best = 9999
    n = len(track_points)

    for i in range(n):

        a = track_points[i]
        b = track_points[(i + 1) % n]

        abx = b.x - a.x
        aby = b.y - a.y
        length2 = abx * abx + aby * aby

        t = 0.0 if length2 == 0 else ((x - a.x) * abx + (y - a.y) * aby) / length2
        t = max(0.0, min(1.0, t))

        d = math.hypot(a.x + abx * t - x, a.y + aby * t - y)

        if d < best:
            best = d

    return best


# =============================================================================
# TREE CREATION
# =============================================================================

def make_realistic_tree(x, y, scale):

    # Trunk
    trunk = cylinder(
        "TracksideTree_Trunk",
        (x, y, 3.0 * scale),
        0.65 * scale,
        6.0 * scale,
        TRUNK
    )

    # Slight random lean
    trunk.rotation_euler[0] = random.uniform(-0.08, 0.08)
    trunk.rotation_euler[1] = random.uniform(-0.08, 0.08)

    # Root flare
    root = cone(
        "TreeRoot",
        (x, y, 0.7 * scale),
        1.5 * scale,
        0.65 * scale,
        1.5 * scale,
        BARK_DARK
    )

    # Three foliage levels
    for j in range(3):

        z = (5.0 + j * 2.8) * scale

        radius = (4.5 - j * 0.7) * scale

        material = random.choice([
            LEAF_DARK,
            LEAF_MID,
            LEAF_MID,
            LEAF_LIGHT
        ])

        crown = cone(
            "TracksideTree_Crown",
            (
                x + random.uniform(-0.4, 0.4) * scale,
                y + random.uniform(-0.4, 0.4) * scale,
                z
            ),
            radius,
            radius * 0.18,
            5.0 * scale,
            material
        )

        crown.rotation_euler[2] = random.uniform(
            0,
            math.pi * 2
        )

    return trunk


# =============================================================================
# TREES CLOSE TO THE TRACK
# =============================================================================

created = 0
attempts = 0

while created < TRACK_TREES and attempts < TRACK_TREES * 30:

    attempts += 1

    if not track_points:
        break

    p = random.choice(track_points)

    # Pick a random angle around track
    angle = random.uniform(
        0,
        math.pi * 2
    )

    distance = random.uniform(
        TREE_MIN_DIST,
        TREE_MAX_DIST
    )

    x = p.x + math.cos(angle) * distance
    y = p.y + math.sin(angle) * distance

    # Must remain reasonably close to the track
    actual_dist = distance_to_track(x, y)

    if actual_dist < TREE_MIN_DIST:
        continue

    if actual_dist > TREE_MAX_DIST + 8:
        continue

    # Don't put trees on buildings/stands
    blocked = False

    for obj in bpy.context.scene.objects:

        if obj.type != 'MESH':
            continue

        if not (
            obj.name.startswith("Garage")
            or obj.name.startswith("Stand")
            or obj.name.startswith("TimingTower")
            or obj.name.startswith("Gantry")
        ):
            continue

        dx = obj.location.x - x
        dy = obj.location.y - y

        if dx * dx + dy * dy < 45 * 45:
            blocked = True
            break

    if blocked:
        continue

    size = random.uniform(
        0.75,
        1.45
    )

    make_realistic_tree(
        x,
        y,
        size
    )

    created += 1


# =============================================================================
# SMALL BUSHES ALONG THE TRACK
# =============================================================================

BUSH_MAT = make_mat(
    "RealisticBush",
    (0.025, 0.20, 0.035),
    0.92
)

for i in range(180):

    if not track_points:
        break

    p = random.choice(track_points)

    angle = random.uniform(
        0,
        math.pi * 2
    )

    distance = random.uniform(
        16,
        38
    )

    x = p.x + math.cos(angle) * distance
    y = p.y + math.sin(angle) * distance

    if distance_to_track(x, y) < 16:
        continue

    r = random.uniform(
        1.0,
        2.8
    )

    bpy.ops.mesh.primitive_ico_sphere_add(
        subdivisions=1,
        radius=r,
        location=(x, y, r * 0.55)
    )

    bush = bpy.context.object
    bush.name = "TracksideBush"

    bush.scale = (
        1.2,
        1.0,
        random.uniform(0.5, 0.8)
    )

    assign_mat(
        bush,
        BUSH_MAT
    )


# =============================================================================
# GRASS CLUMPS
# =============================================================================

GRASS_MAT = make_mat(
    "GrassBlade",
    (0.09, 0.30, 0.025),
    0.95
)

for i in range(GRASS_CLUMPS):

    if not track_points:
        break

    p = random.choice(track_points)

    angle = random.uniform(
        0,
        math.pi * 2
    )

    distance = random.uniform(
        ROAD_WIDTH / 2 + 3,
        70
    )

    x = p.x + math.cos(angle) * distance
    y = p.y + math.sin(angle) * distance

    # Grass close to track, but outside the drivable band (the game lets
    # cars run 8.4 m from the centre, plus half a car)
    if distance_to_track(x, y) < ROAD_WIDTH / 2 + 3:
        continue

    h = random.uniform(
        0.25,
        0.8
    )

    r = random.uniform(
        0.15,
        0.35
    )

    for j in range(3):

        dx = random.uniform(
            -0.25,
            0.25
        )

        dy = random.uniform(
            -0.25,
            0.25
        )

        blade = cone(
            "GrassBlade",
            (
                x + dx,
                y + dy,
                h / 2
            ),
            r,
            0.015,
            h,
            GRASS_MAT
        )

        blade.rotation_euler[1] = random.uniform(
            -0.25,
            0.25
        )

        blade.rotation_euler[0] = random.uniform(
            -0.25,
            0.25
        )


# =============================================================================
# TRACKSIDE SAFETY FENCING
# =============================================================================

FENCE_METAL = make_mat(
    "SafetyFenceMetal",
    (0.07, 0.075, 0.07),
    0.55,
    )

# Fence on selected sections
fence_sections = []

if track_points:

    # Use every ~12th point for posts
    for i in range(0, len(track_points), 12):

        p = track_points[i]

        # Determine approximate direction
        p2 = track_points[
            (i + 1) % len(track_points)
        ]

        direction = p2 - p

        if direction.length < 0.1:
            continue

        direction.normalize()

        # Normal
        normal = Vector(
            (-direction.y, direction.x, 0)
        )

        side = random.choice([-1, 1])

        offset = ROAD_WIDTH / 2 + 8

        x = p.x + normal.x * offset * side
        y = p.y + normal.y * offset * side

        post = cylinder(
            "SafetyFencePost",
            (x, y, 2.5),
            0.08,
            5,
            FENCE_METAL,
            math.atan2(
                direction.y,
                direction.x
            )
        )


# =============================================================================
# ADD BUILDING AIR-CONDITIONING / ROOFTOP EQUIPMENT
# =============================================================================

AC_MAT = make_mat(
    "ACUnit",
    (0.22, 0.24, 0.25),
    0.65
)

for garage in garages:

    pos = garage.location

    rot = garage.rotation_euler[2]

    for j in range(2):

        local_x = -3 + j * 6

        c = math.cos(rot)
        s = math.sin(rot)

        x = pos.x + local_x * c
        y = pos.y + local_x * s

        unit = cube(
            "RoofACUnit",
            (x, y, 7.7),
            (1.2, 1.0, 0.55),
            AC_MAT,
            rot
        )

        bevel(
            unit,
            0.15,
            2
        )


# =============================================================================
# IMPROVE WORLD LIGHTING
# =============================================================================

world = bpy.context.scene.world

if world:

    world.use_nodes = True

    bg = world.node_tree.nodes.get(
        "Background"
    )

    if bg:

        bg.inputs["Color"].default_value = (
            0.32,
            0.52,
            0.78,
            1
        )

        bg.inputs["Strength"].default_value = 0.35


# =============================================================================
# SUN
# =============================================================================

sun = bpy.data.objects.get("Sun")

if sun:

    sun.data.energy = 3.0

    sun.data.angle = math.radians(8)

    sun.rotation_euler = (
        math.radians(35),
        math.radians(-20),
        math.radians(-35)
    )


# =============================================================================
# ATMOSPHERIC VOLUME / WORLD SETTINGS
# =============================================================================

scene = bpy.context.scene

try:
    scene.view_settings.look = "AgX - Medium High Contrast"
except:
    pass

try:
    scene.view_settings.exposure = 0.25
except:
    pass


# =============================================================================
# CAMERA IMPROVEMENT
# =============================================================================

camera = bpy.context.scene.camera

if camera:

    camera.data.lens = 38

    camera.data.dof.use_dof = False


# =============================================================================
# MATERIAL PREVIEW
# =============================================================================

if bpy.context.screen:
    for area in bpy.context.screen.areas:

        if area.type == 'VIEW_3D':

            area.spaces.active.shading.type = 'MATERIAL'


# =============================================================================
# FINAL REPORT
# =============================================================================

print("")
print("=" * 70)
print(" GRAND PRIX REALISM UPGRADE COMPLETE")
print("=" * 70)
print(" Ground       : procedural natural grass")
print(" Asphalt      : textured/bumped")
print(" Trees        : %d additional trackside trees" % created)
print(" Bushes       : 180")
print(" Grass        : %d clumps" % GRASS_CLUMPS)
print(" Buildings    : bevels + windows + roof details")
print(" Grandstands  : improved geometry")
print(" Safety fence : added")
print("=" * 70)
print("")
