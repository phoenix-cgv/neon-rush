# citytrack.py (detailed)
# Procedural city street circuit for Blender 4.x/5.x — high-detail pass.
# Builds everything in assets/maps/CityTrack.glb; see blender/city/README.md.
#
# Fixes over the delivered version (CityTrack_delivered.blend):
#   - The lap uses the 14 control points of the shipped map, whose hairpins
#     were opened out to ~14 m radius (the 12-point original had 3.5-5.4 m).
#   - Street cross-section: road 0 m -> sloped kerb face to 0.12 m -> kerb and
#     pavement at 0.12 m from 7.0 to 12 m -> skirt to the ground. There used to
#     be a 1.6 m grass trench 12 cm below the road between kerb and pavement.
#   - Road markings are paint: 2-8 mm above the asphalt (dashes and crosswalks
#     floated 8-10 cm up, edge lines were coplanar and flickered).
#   - Kerb blocks are seated on the kerb/pavement instead of floating.
#   - Nothing that stands up is placed within 10 m of the centre line
#     (bollards, traffic lights, signs, grass tufts, pedestrians, buildings
#     and trees could all land closer, some on the road).
#   - The start gantry spans the road at the start line (s = 0).
#   - The ground relief stays below the road (it reached 15 cm above it);
#     re-running does not pile up
#     duplicate collections.
# Extends the original citytrack.py with: procedural bump materials, a Nishita
# sky + matching sun, lit streetlamps, traffic lights, crosswalks, bollards,
# street furniture (benches/bins/bus shelters), manholes/patches/puddles,
# multi-part cars with wheels and lights, layered pedestrians, richer
# buildings (balconies, water tanks, canopies, rooftop gardens), grass tufts,
# and gentle terrain displacement on the ground.

import bpy, math, random
from mathutils import Vector

CITY_SCALE=1.0
ROAD_WIDTH=14.0
BUILDING_COUNT=180
TREE_COUNT=80
CAR_COUNT=40
CROWD_COUNT=200
DETAIL_LEVEL=1.5          # >1 scales extra street-detail density (lamps, grass, furniture)
SEED=42
LIGHTING_MODE="SUNSET"    # "DAY" | "SUNSET" | "NIGHT"

random.seed(SEED)

# ---------- cleanup ----------
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)
for c in list(bpy.data.collections):
    bpy.data.collections.remove(c)
for block in (bpy.data.meshes, bpy.data.materials, bpy.data.lights,
              bpy.data.cameras, bpy.data.textures):
    for item in list(block):
        if item.users == 0:
            block.remove(item)

# ---------- collections ----------
names=["CITY_ROAD","ROAD_MARKINGS","BUILDINGS","SIDEWALKS","STREET_PROPS",
    "STREET_FURNITURE","SIGNAGE","VEHICLES","VEGETATION","LIGHTS","CAMERAS",
    "CROWD","GROUND"]
cols={}
for n in names:
    c=bpy.data.collections.new(n)
    bpy.context.scene.collection.children.link(c)
    cols[n]=c

def link(obj,col):
    cols[col].objects.link(obj)
    for c in list(obj.users_collection):
        if c!=cols[col]:
            c.objects.unlink(obj)

def box(name, location, dimensions, material, collection="STREET_PROPS", rotation=0):
    bpy.ops.mesh.primitive_cube_add(location=location)
    obj=bpy.context.object
    obj.name=name
    obj.scale=(dimensions[0]/2,dimensions[1]/2,dimensions[2]/2)
    obj.rotation_euler[2]=rotation
    obj.data.materials.append(material)
    link(obj,collection)
    return obj

def cyl(name, radius, depth, location, material, collection, rotation=(0,0,0), vertices=14):
    bpy.ops.mesh.primitive_cylinder_add(vertices=vertices, radius=radius, depth=depth, location=location)
    obj=bpy.context.object
    obj.name=name
    obj.rotation_euler=rotation
    obj.data.materials.append(material)
    link(obj,collection)
    return obj

def cone_obj(name, radius1, radius2, depth, location, material, collection, rotation=(0,0,0)):
    bpy.ops.mesh.primitive_cone_add(radius1=radius1, radius2=radius2, depth=depth, location=location)
    obj=bpy.context.object
    obj.name=name
    obj.rotation_euler=rotation
    obj.data.materials.append(material)
    link(obj,collection)
    return obj

def sphere_obj(name, radius, location, material, collection):
    bpy.ops.mesh.primitive_uv_sphere_add(radius=radius, location=location)
    obj=bpy.context.object
    obj.name=name
    obj.data.materials.append(material)
    link(obj,collection)
    return obj

# ---------- materials ----------
def mat(name,color,rough=.5,metal=0):
    m=bpy.data.materials.new(name)
    m.use_nodes=True
    b=m.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value=color
    b.inputs["Roughness"].default_value=rough
    b.inputs["Metallic"].default_value=metal
    return m

def mat_bump(name,color,rough=.5,metal=0,bump_strength=0.15,noise_scale=8.0):
    """Base material with a procedural noise bump for micro-surface detail."""
    m=bpy.data.materials.new(name)
    m.use_nodes=True
    nt=m.node_tree
    b=nt.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value=color
    b.inputs["Roughness"].default_value=rough
    b.inputs["Metallic"].default_value=metal
    noise=nt.nodes.new("ShaderNodeTexNoise")
    noise.inputs["Scale"].default_value=noise_scale
    bump=nt.nodes.new("ShaderNodeBump")
    bump.inputs["Strength"].default_value=bump_strength
    nt.links.new(noise.outputs["Fac"],bump.inputs["Height"])
    nt.links.new(bump.outputs["Normal"],b.inputs["Normal"])
    return m

def mat_emit(name,color,strength=4.0,rough=.3):
    m=bpy.data.materials.new(name)
    m.use_nodes=True
    b=m.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value=color
    b.inputs["Roughness"].default_value=rough
    b.inputs["Emission Color"].default_value=color
    b.inputs["Emission Strength"].default_value=strength
    return m

MAT_ASPHALT=mat_bump("Asphalt",(0.045,0.045,0.048,1),.92,0,.08,30)
MAT_LINE=mat("Line",(0.92,0.92,0.9,1),.2)   # not pure white: reads as "no colour" in the export
MAT_CONC=mat_bump("Concrete",(0.55,0.55,0.55,1),.8,0,.12,6)
MAT_GLASS=mat("Glass",(0.1,0.15,0.25,1),.05)
MAT_BUILD=mat("Building",(0.45,0.48,0.52,1),.7)
MAT_GREEN=mat("Green",(0.1,0.4,0.1,1),.9)
MAT_GRASS=mat_bump("Grass",(0.08,0.28,0.06,1),.95,0,.25,50)
MAT_GRASS_LIGHT=mat_bump("Grass Light",(0.18,0.42,0.08,1),.92,0,.2,45)
MAT_PAVEMENT=mat_bump("Pavement",(0.32,0.34,0.35,1),.88,0,.1,15)
MAT_PAVEMENT_LIGHT=mat("Pavement Light",(0.52,0.52,0.48,1),.9)
MAT_KERB=mat("Kerb",(0.82,0.84,0.82,1),.72)
MAT_KERB_RED=mat("Kerb Red",(0.65,0.03,0.025,1),.65)
MAT_TREE_TRUNK=mat_bump("Tree Trunk",(0.18,0.07,0.025,1),.95,0,.2,20)
MAT_TREE_DARK=mat("Tree Leaves Dark",(0.025,0.16,0.035,1),.92)
MAT_TREE_LIGHT=mat("Tree Leaves Light",(0.12,0.38,0.06,1),.9)
MAT_TREE_PINE=mat("Tree Leaves Pine",(0.04,0.12,0.05,1),.9)
MAT_GRASS_BLADE=mat("GrassBlade",(0.15,0.4,0.08,1),.85)
MAT_BUILDINGS=[
    mat("Facade Sandstone",(0.55,0.38,0.24,1),.78),
    mat("Facade Brick",(0.38,0.12,0.08,1),.82),
    mat("Facade Blue",(0.12,0.24,0.38,1),.62),
    mat("Facade Slate",(0.20,0.23,0.27,1),.72),
    mat("Facade White",(0.72,0.72,0.67,1),.8),
]
MAT_WINDOW_LIT=mat_emit("Warm Window Light",(1.0,0.55,0.15,1),1.8,.28)
MAT_WINDOW_COOL=mat("Cool Window Glass",(0.04,0.22,0.38,1),.18, .15)
MAT_AWNINGS=[
    mat("Awning Red",(0.65,0.035,0.025,1),.55),
    mat("Awning Teal",(0.02,0.38,0.34,1),.55),
    mat("Awning Yellow",(0.9,0.56,0.03,1),.55),
]
MAT_METAL_DARK=mat("MetalDark",(0.1,0.1,0.11,1),.35,.75)
MAT_PATCH=mat("RoadPatch",(0.03,0.03,0.03,1),.95)
MAT_PUDDLE=mat("Puddle",(0.03,0.05,0.07,1),.05)
MAT_SIGN_POLE=mat("SignPole",(0.6,0.6,0.62,1),.3,.8)
MAT_SIGN_FACE=mat("SignFace",(0.9,0.85,0.1,1),.3)
MAT_BILLBOARD=mat_emit("Billboard",(0.1,0.6,0.9,1),2.0)
MAT_LAMP_POLE=mat("LampPole",(0.08,0.08,0.09,1),.4,.6)
MAT_LAMP_GLOW=mat_emit("LampGlow",(1,0.9,0.65,1),5.0)
MAT_HEADLIGHT=mat_emit("Headlight",(1,1,0.9,1),6.0)
MAT_TAILLIGHT=mat_emit("Taillight",(1,0.05,0.05,1),5.0)
MAT_SIGNAL_RED=mat_emit("SignalRed",(1,0.05,0.05,1),5.0)
MAT_SIGNAL_YEL=mat_emit("SignalYellow",(1,0.75,0.05,1),5.0)
MAT_SIGNAL_GRN=mat_emit("SignalGreen",(0.05,1,0.15,1),5.0)
MAT_TIRE=mat("Tire",(0.02,0.02,0.02,1),.85)
MAT_BENCH_WOOD=mat_bump("BenchWood",(0.35,0.22,0.12,1),.6,0,.1,10)
MAT_BENCH_METAL=mat("BenchMetal",(0.15,0.15,0.16,1),.35,.7)
MAT_BIN=mat("Bin",(0.12,0.32,0.18,1),.5,.2)
MAT_SHELTER_GLASS=mat("ShelterGlass",(0.55,0.7,0.75,1),.1,0)
MAT_SHELTER_FRAME=mat("ShelterFrame",(0.2,0.2,0.22,1),.4,.6)
MAT_CAR_COLORS=[mat(f"CarColor{i}",c,.25,.55) for i,c in enumerate([
    (0.75,0.05,0.05,1),(0.05,0.15,0.55,1),(0.85,0.85,0.85,1),
    (0.05,0.05,0.05,1),(0.9,0.75,0.05,1),(0.15,0.45,0.15,1),(0.4,0.4,0.42,1)])]
MAT_SKIN_TONES=[mat(f"Skin{i}",c,.6) for i,c in enumerate([
    (0.87,0.68,0.53,1),(0.62,0.42,0.28,1),(0.94,0.8,0.65,1),(0.42,0.28,0.18,1)])]
MAT_CLOTHES=[mat(f"Clothes{i}",c,.7) for i,c in enumerate([
    (0.8,0.1,0.1,1),(0.1,0.2,0.6,1),(0.15,0.15,0.15,1),
    (0.9,0.9,0.85,1),(0.15,0.5,0.3,1),(0.6,0.3,0.6,1)])]

# ---------- catmull rom ----------
def crm(p0,p1,p2,p3,t):
    t2=t*t;t3=t2*t
    return ((2*p1)+(-p0+p2)*t+(2*p0-5*p1+4*p2-p3)*t2+(-p0+3*p1-3*p2+p3)*t3)*0.5

# The shipped lap. Compared with the first version, the hairpin at
# (-150, 60) became (-135, 75), the S-bend (-100, 10) became (-95, 20) and
# (-120, -5), and the hairpin at (-260, 120) became (-240, 125) and
# (-275, 125): about 14 m radius instead of 3.5-5.4 m.
pts=[Vector((-180,-30,0)),Vector((-60,-30,0)),Vector((80,-20,0)),
     Vector((110,40,0)),Vector((40,100,0)),Vector((-80,120,0)),
     Vector((-135,75,0)),Vector((-95,20,0)),Vector((-120,-5,0)),
     Vector((-220,40,0)),Vector((-240,125,0)),Vector((-275,125,0)),
     Vector((-300,20,0)),Vector((-250,-40,0))]

center=[]
for i in range(len(pts)):
    p0=pts[(i-1)%len(pts)]
    p1=pts[i]
    p2=pts[(i+1)%len(pts)]
    p3=pts[(i+2)%len(pts)]
    for j in range(80):
        center.append(crm(p0,p1,p2,p3,j/80))

# ---------- road ----------
verts=[]; faces=[]; hw=ROAD_WIDTH/2
for i,p in enumerate(center):
    n=center[(i+1)%len(center)]
    t=(n-p).normalized()
    r=Vector((-t.y,t.x,0))
    verts += [p-r*hw,p+r*hw]

for i in range(len(center)):
    a=i*2;b=a+1;c=((i+1)%len(center))*2;d=c+1
    faces.append((b,a,c,d))    # faces up; vertex pairs stay (right, left)

mesh=bpy.data.meshes.new("Road")
mesh.from_pydata(verts,[],faces)
road=bpy.data.objects.new("Road",mesh)
road.data.materials.append(MAT_ASPHALT)
cols["CITY_ROAD"].objects.link(road)

# ---------- ground and continuous pavement ----------
GROUND_Z=-.12   # with +-5 cm relief: 7-17 cm under the road; things built from z=0 sit slightly sunk
bpy.ops.mesh.primitive_plane_add(size=1000, location=(-90,0,GROUND_Z))
ground=bpy.context.object
ground.name="CityGround"
ground.data.materials.append(MAT_GRASS)
link(ground,"GROUND")

# Gentle terrain relief so the ground isn't perfectly flat.
mod_sub=ground.modifiers.new("Subdivide","SUBSURF")
mod_sub.levels=4; mod_sub.render_levels=5
terrain_tex=bpy.data.textures.new("TerrainNoise",type='CLOUDS')
terrain_tex.noise_scale=28
mod_disp=ground.modifiers.new("Terrain","DISPLACE")
mod_disp.texture=terrain_tex
mod_disp.strength=0.1    # +-5 cm about GROUND_Z (was 0.55: up to 15 cm ABOVE the road)
mod_disp.mid_level=0.5

def ribbon(name, profile, material, collection):
    """Sweep a cross-section along the lap. profile: [(offset, z), ...],
    offset measured to the left of the direction of travel. Horizontal
    faces are turned to face up."""
    rv=[]; rf=[]; k=len(profile)
    for i,p in enumerate(center):
        n=center[(i+1)%len(center)]
        t=(n-p).normalized()
        r=Vector((-t.y,t.x,0))
        rv += [p+r*o+Vector((0,0,z)) for o,z in profile]
    for i in range(len(center)):
        j=(i+1)%len(center)
        for q in range(k-1):
            rf.append((i*k+q, i*k+q+1, j*k+q+1, j*k+q))
    rm=bpy.data.meshes.new(name)
    rm.from_pydata(rv,[],rf)
    for poly in rm.polygons:
        if poly.normal.z < -0.5:
            poly.flip()
    rm.update()
    rm.materials.append(material)
    ro=bpy.data.objects.new(name,rm)
    cols[collection].objects.link(ro)
    return ro

# Street cross-section, from the road edge out: a kerb whose face slopes up
# 12 cm over 8 cm, kerb top to 0.35 m, then pavement at kerb height to 5 m,
# then a skirt down into the ground.
KERB_H=.12
ribbon("KerbLeft",[(hw,0),(hw+.08,KERB_H),(hw+.35,KERB_H)],MAT_KERB,"SIDEWALKS")
ribbon("KerbRight",[(-hw-.35,KERB_H),(-hw-.08,KERB_H),(-hw,0)],MAT_KERB,"SIDEWALKS")
ribbon("PavementLeft",[(hw+.35,KERB_H),(hw+5.0,KERB_H),(hw+5.0,GROUND_Z-.15)],MAT_PAVEMENT,"SIDEWALKS")
ribbon("PavementRight",[(-hw-5.0,GROUND_Z-.15),(-hw-5.0,KERB_H),(-hw-.35,KERB_H)],MAT_PAVEMENT,"SIDEWALKS")

# Small planted islands break up the otherwise continuous pavement.
for x,y,w,h in [(-320,-150,70,35),(-40,175,55,28),(125,-115,45,24),(85,125,38,22)]:
    box("GreenIsland",(x,y,.02),(w,h,.12),MAT_GRASS_LIGHT,"GROUND")

# ---------- markings ----------
for side in (-1,1):
    v=[];f=[]
    for i,p in enumerate(center):
        n=center[(i+1)%len(center)]
        t=(n-p).normalized()
        r=Vector((-t.y,t.x,0))
        q=p+r*(hw-0.5)*side+Vector((0,0,.004))   # paint, just above the asphalt
        v += [q-r*0.1,q+r*0.1]
    for i in range(len(center)):
        a=i*2;b=a+1;c=((i+1)%len(center))*2;d=c+1
        f.append((b,a,c,d))
    m=bpy.data.meshes.new("Line")
    m.from_pydata(v,[],f)
    o=bpy.data.objects.new("Line",m)
    o.data.materials.append(MAT_LINE)
    cols["ROAD_MARKINGS"].objects.link(o)

# Dashed centre line, lane arrows, and alternating kerb blocks make the road
# read as a maintained city circuit instead of a single dark ribbon.
for i in range(0,len(center),18):
    p=center[i]
    n=center[(i+2)%len(center)]
    direction=n-p
    if direction.length==0:
        continue
    angle=math.atan2(direction.y,direction.x)
    box("CentreDash",(p.x,p.y,.006),(5.5,.16,.004),MAT_LINE,"ROAD_MARKINGS",angle)

for i in range(0,len(center),10):
    p=center[i]
    n=center[(i+1)%len(center)]
    direction=n-p
    angle=math.atan2(direction.y,direction.x)
    side=-1 if (i//10)%2 else 1
    offset=hw+.45     # on the kerb top and pavement edge, 0.1-0.8 m out
    r=Vector((-math.sin(angle),math.cos(angle),0))
    box("KerbBlock",(p.x+r.x*offset*side,p.y+r.y*offset*side,KERB_H+.015),
        (3.0, .7, .03),MAT_KERB_RED if (i//10)%2 else MAT_KERB,
        "ROAD_MARKINGS",angle)

# ---------- manholes, road patches and puddles ----------
for i in range(0,len(center),33):
    p=center[i]
    n=center[(i+1)%len(center)]
    d=n-p
    if d.length==0: continue
    d=d.normalized(); rx,ry=-d.y,d.x
    off=random.uniform(-hw*.6,hw*.6)
    mx=p.x+rx*off; my=p.y+ry*off
    cyl("Manhole",.5,.006,(mx,my,.005),MAT_METAL_DARK,"CITY_ROAD")

for i in range(0,len(center),27):
    p=center[i]
    n=center[(i+1)%len(center)]
    d=n-p
    if d.length==0: continue
    d=d.normalized(); angle=math.atan2(d.y,d.x); rx,ry=-d.y,d.x
    off=random.uniform(-hw*.5,hw*.5)
    px=p.x+rx*off; py=p.y+ry*off
    if random.random()<0.5:
        box("RoadPatch",(px,py,.003),(random.uniform(2,4),random.uniform(1.5,3),.004),
            MAT_PATCH,"CITY_ROAD",angle)
    else:
        box("Puddle",(px,py,.004),(random.uniform(1.5,3),random.uniform(1,2),.004),
            MAT_PUDDLE,"CITY_ROAD",angle)

# ---------- crosswalks + traffic lights + pedestrian signage ----------
CROSSWALK_IDX=[int(len(center)*f) for f in (0.05,0.28,0.5,0.68,0.87)]

def make_crosswalk(idx):
    p=center[idx]; n=center[(idx+1)%len(center)]
    d=n-p
    if d.length==0: return
    d=d.normalized(); angle=math.atan2(d.y,d.x); rx,ry=-d.y,d.x
    for k in range(-3,4):
        ox=p.x+d.x*k*1.3; oy=p.y+d.y*k*1.3
        box("CrosswalkBar",(ox,oy,.006),(1.0,hw*1.7,.004),MAT_LINE,"ROAD_MARKINGS",angle+math.pi/2)
    sx=p.x+rx*(hw+3.6); sy=p.y+ry*(hw+3.6)
    cyl("SignPole",.06,2.2,(sx,sy,KERB_H+1.1),MAT_SIGN_POLE,"SIGNAGE")
    box("SignFace",(sx,sy,KERB_H+2.3),(.5,.06,.5),MAT_SIGN_FACE,"SIGNAGE",angle)

def make_traffic_light(idx):
    p=center[idx]; n=center[(idx+1)%len(center)]
    d=n-p
    if d.length==0: return
    d=d.normalized(); rx,ry=-d.y,d.x
    for side in (-1,1):
        px=p.x+rx*(hw+3.3)*side; py=p.y+ry*(hw+3.3)*side
        cyl("SignalPole",.09,3.6,(px,py,KERB_H+1.8),MAT_SIGN_POLE,"SIGNAGE")
        box("SignalHead",(px,py,KERB_H+3.7),(.35,.35,1.0),MAT_METAL_DARK,"SIGNAGE")
        for j,m in enumerate((MAT_SIGNAL_RED,MAT_SIGNAL_YEL,MAT_SIGNAL_GRN)):
            sphere_obj("SignalLamp",.11,(px+rx*.02,py+ry*.02,KERB_H+3.95-j*.32),m,"SIGNAGE")

for idx in CROSSWALK_IDX:
    make_crosswalk(idx)
    make_traffic_light(idx)

# ---------- start-finish gantry ----------
def make_gantry(idx):
    # Across the road at centre[idx], legs just outside the pavement.
    p=center[idx]; n=center[(idx+1)%len(center)]
    d=(n-p).normalized(); r=Vector((-d.y,d.x,0))
    angle=math.atan2(r.y,r.x)          # the beam runs across the road
    x,y=p.x,p.y
    for side in (-1,1):
        leg=p+r*(hw+5.6)*side
        cyl("GantryLeg",.4,7,(leg.x,leg.y,3.5),MAT_SIGN_POLE,"STREET_PROPS")
    box("GantryBeam",(x,y,7.2),(2*(hw+5.6)+1.0,1.0,1.0),MAT_SIGN_POLE,"STREET_PROPS",angle)
    front=p-d*.6
    box("GantrySign",(front.x,front.y,7.2),(2*(hw+5.6)-1.0,.15,.8),MAT_BILLBOARD,"STREET_PROPS",angle)
    for lx in (-10,0,10):
        lp=p+r*lx-d*1.0
        bpy.ops.object.light_add(type='SPOT', location=(lp.x,lp.y,7.6))
        sp=bpy.context.object
        sp.data.energy=3000
        sp.rotation_euler=(math.radians(150),0,0)
        sp.data.spot_size=math.radians(60)
        link(sp,"LIGHTS")

make_gantry(0)

# billboards near the track
for idx in (int(len(center)*0.4), int(len(center)*0.75)):
    p=center[idx]; n=center[(idx+1)%len(center)]
    d=n-p
    if d.length==0: continue
    d=d.normalized(); angle=math.atan2(d.y,d.x); rx,ry=-d.y,d.x
    bx=p.x+rx*(hw+22); by=p.y+ry*(hw+22)
    cyl("BillboardPole",.35,8,(bx,by,4),MAT_SIGN_POLE,"SIGNAGE")
    box("BillboardPanel",(bx,by,9),(8,.4,4),MAT_BILLBOARD,"SIGNAGE",angle)

# ---------- buildings ----------
track_pts=[Vector((p.x,p.y,0)) for p in center]

from mathutils.kdtree import KDTree
track_kd=KDTree(len(track_pts))
for k,t in enumerate(track_pts):
    track_kd.insert(t,k)
track_kd.balance()

def far_from_track(x,y,d=20):
    # Same test as before (nearest ring point), via a KD-tree: the loop over
    # all 1120 points made a build take over ten minutes.
    return track_kd.find((x,y,0))[2]>d

for i in range(BUILDING_COUNT):
    for _ in range(20):
        x=random.uniform(-380,180)
        y=random.uniform(-220,220)
        if far_from_track(x,y): break
    else:
        continue   # all 20 tries were too close to the track: skip this one

    style=random.randint(0,4)
    if style==0:
        sx,sy,sz=8,8,random.uniform(50,120)
    elif style==1:
        sx,sy,sz=10,14,random.uniform(20,50)
    elif style==2:
        sx,sy,sz=14,14,random.uniform(10,20)
    elif style==3:
        sx,sy,sz=8,18,random.uniform(15,35)
    else:
        sx,sy,sz=20,20,random.uniform(8,15)

    bpy.ops.mesh.primitive_cube_add(location=(x,y,sz/2))
    b=bpy.context.object
    b.scale=(sx/2,sy/2,sz/2)
    b.rotation_euler[2]=random.uniform(-0.12,0.12)
    b.data.materials.append(random.choice(MAT_BUILDINGS))
    link(b,"BUILDINGS")

    # Repeated window bands give towers a readable facade without creating a
    # separate object for every individual window.
    floors=max(2,min(12,int(sz/5)))
    for floor in range(floors):
        z=3.0+floor*max(3.0,sz/(floors+1))
        if z>sz-1.5:
            continue
        window_mat=MAT_WINDOW_LIT if random.random()<0.58 else MAT_WINDOW_COOL
        for side in (-1,1):
            bpy.ops.mesh.primitive_cube_add(location=(x+side*(sx/2+.035),y,z))
            window=bpy.context.object
            window.scale=(.035,max(.22,sy*.28),.55)
            window.rotation_euler[2]=b.rotation_euler[2]
            window.data.materials.append(window_mat)
            link(window,"BUILDINGS")

    # Rooftop mechanical equipment and a short antenna make the skyline less
    # uniform, especially on the taller buildings.
    if sz>35:
        for unit in range(1+random.randint(0,2)):
            bpy.ops.mesh.primitive_cube_add(
                location=(x+random.uniform(-sx*.25,sx*.25),
                          y+random.uniform(-sy*.25,sy*.25),sz+.8))
            roof_unit=bpy.context.object
            roof_unit.scale=(.8,.65,.8)
            roof_unit.data.materials.append(MAT_CONC)
            link(roof_unit,"BUILDINGS")
        bpy.ops.mesh.primitive_cylinder_add(radius=.08,depth=4,
                                            location=(x,y,sz+3))
        antenna=bpy.context.object
        antenna.data.materials.append(MAT_WINDOW_COOL)
        link(antenna,"BUILDINGS")

    # Rooftop water tank on the tallest towers.
    if style==0 and sz>80:
        cyl("WaterTank",1.4,2.2,(x,y,sz+1.1),MAT_CONC,"BUILDINGS")
        cone_obj("TankRoof",1.5,.05,.8,(x,y,sz+2.6),MAT_KERB,"BUILDINGS")

    # A small rooftop garden patch on some flat-roofed low-rises.
    if style==4 and random.random()<0.4:
        box("RoofGarden",(x,y,sz+.15),(sx*.6,sy*.6,.25),MAT_GRASS_LIGHT,"BUILDINGS")

    # Balconies on residential-proportioned mid-rises.
    if style in (1,3):
        for floor in range(1,floors,2):
            z=3.0+floor*max(3.0,sz/(floors+1))
            if z>sz-2:
                continue
            box("Balcony",(x,y+sy/2+.4,z-.3),(sx*.5,.8,.12),MAT_CONC,"BUILDINGS")
            box("BalconyRail",(x,y+sy/2+.75,z+.1),(sx*.5,.06,.55),MAT_SIGN_POLE,"BUILDINGS")

    # Entrance canopy and door on taller street-front buildings.
    if sz>=22:
        box("Canopy",(x,y-sy/2-.5,3.2),(3.2,1.0,.15),MAT_CONC,"BUILDINGS")
        box("Door",(x,y-sy/2-.05,1.4),(1.4,.06,2.4),MAT_WINDOW_COOL,"BUILDINGS")

    # Low-rise blocks become shops with colored awnings and a brighter base.
    if sz<22:
        awning=MAT_AWNINGS[i%len(MAT_AWNINGS)]
        bpy.ops.mesh.primitive_cube_add(location=(x,y-sy/2-.12,2.5))
        shop=bpy.context.object
        shop.scale=(sx*.38,.12,.65)
        shop.data.materials.append(awning)
        link(shop,"BUILDINGS")
        bpy.ops.mesh.primitive_cube_add(location=(x,y-sy/2-.04,.85))
        storefront=bpy.context.object
        storefront.scale=(sx*.42,.08,.55)
        storefront.data.materials.append(MAT_WINDOW_COOL)
        link(storefront,"BUILDINGS")

# ---------- sidewalks ----------
# (The pavement ribbons above are continuous. There used to be loose 6 x 4 m
# concrete slabs here, 10 m out and poking through the pavement.)

# ---------- trees ----------
for i in range(TREE_COUNT):
    for _ in range(20):
        x=random.uniform(-360,160)
        y=random.uniform(-200,200)
        if far_from_track(x,y,16): break
    else:
        continue
    box("TreePit",(x,y,.035),(3.2,3.2,.08),MAT_PAVEMENT_LIGHT,"GROUND")
    species=random.random()
    if species<0.65:
        # broadleaf: layered canopy cones
        bpy.ops.mesh.primitive_cylinder_add(vertices=10,radius=.28,depth=3.4,location=(x,y,1.7))
        trunk=bpy.context.object
        trunk.data.materials.append(MAT_TREE_TRUNK)
        link(trunk,"VEGETATION")
        for level,(z,radius,height) in enumerate(((3.2,2.2,2.8),(4.8,1.8,2.5),(6.2,1.25,2.2))):
            bpy.ops.mesh.primitive_cone_add(vertices=10,radius1=radius,
                                            radius2=.15,depth=height,
                                            location=(x+random.uniform(-.15,.15),
                                                      y+random.uniform(-.15,.15),z))
            leaf=bpy.context.object
            leaf.name="TreeFoliage"
            leaf.data.materials.append(MAT_TREE_DARK if level==0 else MAT_TREE_LIGHT)
            link(leaf,"VEGETATION")
    elif species<0.88:
        # tall narrow pine
        cyl("PineTrunk",.22,4.0,(x,y,2.0),MAT_TREE_TRUNK,"VEGETATION")
        cone_obj("PineCanopy",1.6,.1,7.0,(x,y,7.0),MAT_TREE_PINE,"VEGETATION")
    else:
        # leaning palm
        lean=random.uniform(-0.15,0.15)
        cyl("PalmTrunk",.22,6.5,(x,y,3.25),MAT_TREE_TRUNK,"VEGETATION",rotation=(lean,lean,0))
        top=(x+math.sin(lean)*3.2,y+math.sin(lean)*3.2,6.6)
        for a in range(6):
            ang=a*math.pi/3
            frond=(top[0]+math.cos(ang)*1.6,top[1]+math.sin(ang)*1.6,top[2]-.3)
            cone_obj("PalmFrond",.05,.8,2.2,frond,MAT_TREE_LIGHT,"VEGETATION",
                     rotation=(math.pi/2.4,0,ang))

# grass tufts fill the strip between sidewalk and buildings for extra ground detail
GRASS_TUFT_COUNT=int(150*DETAIL_LEVEL)
for i in range(GRASS_TUFT_COUNT):
    x=random.uniform(-380,180); y=random.uniform(-220,220)
    if far_from_track(x,y,hw+5.5) and not far_from_track(x,y,40):   # beyond the pavement
        for _ in range(2):
            ox=x+random.uniform(-.4,.4); oy=y+random.uniform(-.4,.4)
            cone_obj("GrassTuft",.05,.005,random.uniform(.25,.45),(ox,oy,GROUND_Z+.15),
                     MAT_GRASS_BLADE,"VEGETATION")

# ---------- streetlamps ----------
def make_streetlamp(loc, inward_angle):
    x,y,_=loc
    cyl("LampPole",.12,6.0,(x,y,KERB_H+3.0),MAT_LAMP_POLE,"STREET_FURNITURE")
    arm_len=1.8
    box("LampArm",(x+math.cos(inward_angle)*arm_len*.5,
                   y+math.sin(inward_angle)*arm_len*.5,6.15),
        (arm_len,.12,.12),MAT_LAMP_POLE,"STREET_FURNITURE",inward_angle)
    hx=x+math.cos(inward_angle)*arm_len
    hy=y+math.sin(inward_angle)*arm_len
    sphere_obj("LampHead",.28,(hx,hy,6.0),MAT_LAMP_GLOW,"STREET_FURNITURE")
    bpy.ops.object.light_add(type='POINT', location=(hx,hy,5.9))
    l=bpy.context.object
    l.data.energy=1200 if LIGHTING_MODE!="DAY" else 100
    l.data.color=(1,0.85,0.6)
    link(l,"LIGHTS")

lamp_step=max(10,int(26/DETAIL_LEVEL))
for i in range(0,len(center),lamp_step):
    p=center[i]; n=center[(i+1)%len(center)]
    d=n-p
    if d.length==0: continue
    d=d.normalized(); rx,ry=-d.y,d.x
    for side in (-1,1):
        lx=p.x+rx*(hw+4.2)*side; ly=p.y+ry*(hw+4.2)*side
        inward=math.atan2(-ry*side,-rx*side)
        make_streetlamp((lx,ly,0),inward)

# ---------- bollards ----------
for i in range(4,len(center),16):
    p=center[i]; n=center[(i+1)%len(center)]
    d=n-p
    if d.length==0: continue
    d=d.normalized(); rx,ry=-d.y,d.x
    for side in (-1,1):
        bx=p.x+rx*(hw+3.2)*side; by=p.y+ry*(hw+3.2)*side
        cyl("Bollard",.09,.75,(bx,by,KERB_H+.375),MAT_KERB_RED,"STREET_FURNITURE")

# ---------- benches, bins, bus shelters ----------
def make_bench(loc, angle):
    box("BenchSeat",loc,(1.6,.5,.12),MAT_BENCH_WOOD,"STREET_FURNITURE",angle)
    x,y,z=loc
    dx,dy=math.cos(angle),math.sin(angle)
    rx,ry=-dy,dx
    box("BenchBack",(x-rx*.22,y-ry*.22,z+.35),(1.6,.1,.7),MAT_BENCH_WOOD,"STREET_FURNITURE",angle)
    for lx in (-.65,.65):
        box("BenchLeg",(x+dx*lx,y+dy*lx,z-.2),(.08,.45,.35),MAT_BENCH_METAL,"STREET_FURNITURE",angle)

def make_bin(loc):
    cyl("TrashBin",.28,.7,(loc[0],loc[1],KERB_H+.35),MAT_BIN,"STREET_FURNITURE")

def make_bus_shelter(loc, angle):
    x,y,_=loc
    box("ShelterRoof",(x,y,KERB_H+2.35),(3.0,1.3,.08),MAT_SHELTER_FRAME,"STREET_FURNITURE",angle)
    dx,dy=math.cos(angle),math.sin(angle)
    rx,ry=-dy,dx
    box("ShelterBack",(x-rx*.6,y-ry*.6,KERB_H+1.1),(3.0,.06,2.1),MAT_SHELTER_GLASS,"STREET_FURNITURE",angle)
    for lx in (-1.35,1.35):
        box("ShelterSide",(x+dx*lx,y+dy*lx,KERB_H+1.1),(.06,1.2,2.1),MAT_SHELTER_GLASS,"STREET_FURNITURE",angle)
    make_bench((x,y,KERB_H+.4),angle)

furniture_step=max(20,int(40/DETAIL_LEVEL))
for i in range(6,len(center),furniture_step):
    p=center[i]; n=center[(i+1)%len(center)]
    d=n-p
    if d.length==0: continue
    d=d.normalized(); angle=math.atan2(d.y,d.x); rx,ry=-d.y,d.x
    side=random.choice([-1,1])
    # the shelter is 1.3 m deep and the bench 0.5 m: keep both >= 10 m out
    px=p.x+rx*(hw+4.0)*side; py=p.y+ry*(hw+4.0)*side
    choice=random.random()
    if choice<0.15:
        make_bus_shelter((px,py,0),angle)
    elif choice<0.55:
        make_bench((px,py,KERB_H+.4),angle)
    else:
        make_bin((px,py,0))

# ---------- vehicles ----------
def make_car(loc, angle, color_mat):
    x,y,z=loc
    dx,dy=math.cos(angle),math.sin(angle)
    box("CarBody",(x,y,z+.55),(2.1,.95,.5),color_mat,"VEHICLES",angle)
    box("CarCabin",(x-dx*.15,y-dy*.15,z+1.05),(1.15,.82,.38),MAT_GLASS,"VEHICLES",angle)
    for wx,wy in [(1.35,.85),(1.35,-.85),(-1.35,.85),(-1.35,-.85)]:
        ox=x+wx*dx+wy*(-dy); oy=y+wx*dy+wy*dx
        cyl("Wheel",.38,.28,(ox,oy,z+.38),MAT_TIRE,"VEHICLES",rotation=(math.pi/2,0,angle))
    fx=x+dx*2.05-dy*.7; fy=y+dy*2.05+dx*.7
    box("Headlight",(fx,fy,z+.55),(.15,.25,.15),MAT_HEADLIGHT,"VEHICLES",angle)
    bx=x-dx*2.05-dy*.7; by=y-dy*2.05+dx*.7
    box("Taillight",(bx,by,z+.55),(.15,.25,.15),MAT_TAILLIGHT,"VEHICLES",angle)

for i in range(CAR_COUNT):
    idx=(i*37)%len(center)
    p=center[idx]; n=center[(idx+1)%len(center)]
    d=n-p
    if d.length==0: continue
    d=d.normalized(); angle=math.atan2(d.y,d.x); rx,ry=-d.y,d.x
    parked=random.random()<0.5   # kept so the random sequence stays the same
    side=random.choice([-1,1])
    # All parked: the game runs live traffic in the lanes (core/traffic.js)
    # and leaves these props out, but a car in the lane is wrong in Blender too.
    lane_offset=hw+4.2   # inner wheels 10.2 m from the centre line
    loc=(p.x+rx*lane_offset*side, p.y+ry*lane_offset*side, KERB_H)
    make_car(loc, angle, random.choice(MAT_CAR_COLORS))

# ---------- crowd ----------
def make_pedestrian(loc, height_scale=1.0):
    x,y,z=loc
    h=1.65*height_scale
    cyl("PedestrianBody",.22*height_scale,h*.62,(x,y,z+h*.36),
        random.choice(MAT_CLOTHES),"CROWD")
    cyl("PedestrianLegs",.16*height_scale,h*.38,(x,y,z+h*.19),
        random.choice([MAT_CLOTHES[2],MAT_CLOTHES[5]]),"CROWD")
    sphere_obj("PedestrianHead",.14*height_scale,(x,y,z+h*.62+.16),
               random.choice(MAT_SKIN_TONES),"CROWD")

for i in range(CROWD_COUNT):
    idx=random.randint(0,len(center)-1)
    p=center[idx]
    off=random.choice([-1,1])*random.uniform(10.5,18)
    random.randint(0,len(center)-1)   # (was the bug below; keeps the sequence)
    # Across the road at this point. It used the direction to a RANDOM point
    # on the lap, which put pedestrians anywhere, including on the road.
    n=center[(idx+1)%len(center)]
    d=(n-p).normalized()
    r=Vector((-d.y,d.x,0))
    loc=p+r*off
    if not far_from_track(loc.x,loc.y,10.3):
        continue
    z=KERB_H if abs(off)<=hw+5.0 else 0
    make_pedestrian((loc.x,loc.y,z),height_scale=random.uniform(0.85,1.15))

# ---------- cameras ----------
cams=[("Overview",(0,-350,220)),
      ("StartFinish",(-130,-60,12)),
      ("Trackside",(20,90,3)),
      ("Downtown",(-40,180,30)),
      ("Bridge",(-240,120,15))]

for name,pos in cams:
    bpy.ops.object.camera_add(location=pos)
    c=bpy.context.object
    c.name=name
    c.rotation_euler=(1.1,0,0)
    if name=="Overview":
        c.data.dof.use_dof=True
        c.data.dof.focus_distance=280
        c.data.dof.aperture_fstop=4.0
    link(c,"CAMERAS")

bpy.context.scene.camera=bpy.data.objects["Overview"]

# ---------- world / sky ----------
scene=bpy.context.scene
engine_ids = {item.identifier for item in scene.render.bl_rna.properties["engine"].enum_items}
if "BLENDER_EEVEE_NEXT" in engine_ids:
    scene.render.engine = "BLENDER_EEVEE_NEXT"
elif "BLENDER_EEVEE" in engine_ids:
    scene.render.engine = "BLENDER_EEVEE"
else:
    scene.render.engine = next(iter(engine_ids))
scene.render.resolution_x=1920
scene.render.resolution_y=1080

def setup_sky():
    world=bpy.data.worlds["World"]
    world.use_nodes=True
    nt=world.node_tree
    bg=nt.nodes["Background"]
    sky=nt.nodes.new("ShaderNodeTexSky")
    sky.sky_type='NISHITA'
    if LIGHTING_MODE=="DAY":
        elevation=math.radians(55); rotation=math.radians(200)
        sky.sun_intensity=1.0; bg.inputs["Strength"].default_value=1.0
        sun_energy=4.0; sun_color=(1,1,0.97)
    elif LIGHTING_MODE=="SUNSET":
        elevation=math.radians(6); rotation=math.radians(250)
        sky.sun_intensity=1.2; bg.inputs["Strength"].default_value=1.0
        sun_energy=2.0; sun_color=(1.0,0.55,0.25)
    else:
        elevation=math.radians(-5); rotation=math.radians(120)
        sky.sun_intensity=0.15; bg.inputs["Strength"].default_value=0.15
        sun_energy=0.15; sun_color=(0.4,0.5,0.8)
    sky.sun_elevation=elevation
    sky.sun_rotation=rotation
    nt.links.new(sky.outputs["Color"],bg.inputs["Color"])

    bpy.ops.object.light_add(type='SUN', location=(0,0,150))
    sun=bpy.context.object
    sun.name="SunLight"
    sun.data.angle=math.radians(2.0)
    sun.rotation_euler=(math.pi/2-elevation,0,rotation+math.pi)
    sun.data.energy=sun_energy
    sun.data.color=sun_color
    link(sun,"LIGHTS")

setup_sky()

print("CityTrack (detailed) complete.")
print("Road objects:", len(cols["CITY_ROAD"].objects))
print("Buildings:", len(cols["BUILDINGS"].objects))
print("Street props:", len(cols["STREET_PROPS"].objects))
print("Street furniture:", len(cols["STREET_FURNITURE"].objects))
print("Signage:", len(cols["SIGNAGE"].objects))
print("Vehicles:", len(cols["VEHICLES"].objects))
print("Vegetation:", len(cols["VEGETATION"].objects))
print("Pedestrians:", len(cols["CROWD"].objects))
print("Cameras:", len(cols["CAMERAS"].objects))
print("Total objects:", len(bpy.data.objects))