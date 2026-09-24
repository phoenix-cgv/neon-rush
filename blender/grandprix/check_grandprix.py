"""Checks a Grand Prix .blend or .glb against the map's acceptance criteria.

Headless:  python3 check_grandprix.py GrandPrix.blend
           python3 check_grandprix.py RaceTrack2.blend      (the map as delivered)
           python3 check_grandprix.py ../../assets/maps/GrandPrix.glb
Prints one PASS/FAIL line per check and exits non-zero on any FAIL.
"""
import bpy
import math
import os
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

def world_verts(o):
    mw = np.array(o.matrix_world)
    co = np.array([v.co for v in o.data.vertices])
    return co @ mw[:3, :3].T + mw[:3, 3] if len(co) else np.zeros((0, 3))

def centre_of(o):
    bb = [o.matrix_world @ Vector(c) for c in o.bound_box]
    return np.array((sum(bb, Vector()) / 8)[:])

CLEAR = 10.0

# ---- Names the game relies on
need = ["Road", "Verge_L", "Verge_R", "PitLane", "GroundGrass", "RacingLine", "EdgeLine_L", "EdgeLine_R",
        "StartFinishLine", "ApexKerbs", "StartLamp"] + [f"StartLamp.00{k}" for k in range(1, 5)]
prefixes = ["GravelTrap", "PitWall", "TyreWall", "GantryPillar"]
missing = [nm for nm in need if nm not in objs] + [p + "*" for p in prefixes if not any(o.name.startswith(p) for o in objs)]
check("Names the game relies on", not missing, ", ".join(missing) or "all present, StartLamp to StartLamp.004")

# ---- Road ribbon: vertex pairs (left, right), ring 0 = start line
road = world_verts(objs["Road"])
Lft, Rgt = road[0::2], road[1::2]
C = (Lft + Rgt) / 2
n = len(C)
seg = np.linalg.norm(np.roll(C, -1, 0)[:, :2] - C[:, :2], axis=1)
width = np.linalg.norm((Rgt - Lft)[:, :2], axis=1)
s = np.concatenate([[0], np.cumsum(seg)[:-1]])
length = seg.sum()
t = np.roll(C, -1, 0)[:, :2] - C[:, :2]
heading = np.arctan2(t[:, 1], t[:, 0])
turn = np.degrees((np.roll(heading, -1) - heading + np.pi) % (2 * np.pi) - np.pi)
area = 0.5 * np.sum(C[:, 0] * np.roll(C[:, 1], -1) - np.roll(C[:, 0], -1) * C[:, 1])
check("Ribbon (14 m wide across, measured flat)", np.abs(width - 14).max() < 0.05 and area > 0 and seg.max() < 2.5,
      f"{n} rings, {length:.0f} m, spacing {seg.min():.2f}-{seg.max():.2f} m, width {width.min():.2f}-{width.max():.2f} m, anticlockwise")
check("Start line unchanged", np.linalg.norm(C[0, :2] - (-430, -170)) < 0.5,
      f"ring 0 at ({C[0, 0]:.1f}, {C[0, 1]:.1f})")
local = np.array([np.median(turn[[(i + k) % n for k in range(-6, 7)]]) for i in range(n)])
spike = np.abs(turn - local)
check("No kinks (turn per ring within 1 deg of the local curve)", spike.max() <= 1.0,
      f"worst {spike.max():.1f} deg at {s[spike.argmax()]:.0f} m")
fold = sum(int((((np.roll(e, -1, 0) - e)[:, :2] * t).sum(1) <= 0).sum()) for e in (Lft, Rgt))
check("Road never folds over itself", fold == 0, f"{fold} backwards edge segments")

# Curvature from a 1 m resample
dense_s = np.arange(0, length, 1.0)
closed = np.vstack([C, C[:1]])
cum = np.concatenate([[0], np.cumsum(seg)])
P = np.stack([np.interp(dense_s, cum, closed[:, k]) for k in range(3)], 1)
M = len(P)
h = 6
a, b, c = np.roll(P[:, :2], h, 0), P[:, :2], np.roll(P[:, :2], -h, 0)
cross = (b - a)[:, 0] * (c - b)[:, 1] - (b - a)[:, 1] * (c - b)[:, 0]
den = np.linalg.norm(b - a, axis=1) * np.linalg.norm(c - b, axis=1) * np.linalg.norm(c - a, axis=1)
k = 2 * cross / den
peaks = [i for i in range(M) if abs(k[i]) > 1 / 250 and abs(k[i]) >= abs(k[i - 1]) and abs(k[i]) >= abs(k[(i + 1) % M])]
corners = []                                   # one peak per corner
for i in peaks:
    if corners and dense_s[i] - dense_s[corners[-1]] < 15 and np.sign(k[i]) == np.sign(k[corners[-1]]):
        if abs(k[i]) > abs(k[corners[-1]]):
            corners[-1] = i
    else:
        corners.append(i)
check("Tightest corner >= 15 m", 1 / np.abs(k).max() >= 15,
      f"R{1 / np.abs(k).max():.1f} at {dense_s[np.abs(k).argmax()]:.0f} m ({P[np.abs(k).argmax(), 0]:.0f}, {P[np.abs(k).argmax(), 1]:.0f}), "
      f"{math.sqrt(1.4 * 9.81 / np.abs(k).max()) * 3.6:.0f} km/h unbanked")
near = (dense_s <= 60) | (dense_s >= length - 60)
check("Grid and start straight: nothing under R30 within 60 m of the line", 1 / np.abs(k[near]).max() >= 30,
      f"tightest R{1 / np.abs(k[near]).max():.0f}")

# ---- 1. Turn 1
t1 = [i for i in corners if 700 < dense_s[i] < 1500 and k[i] > 0]
i_hp = max(t1, key=lambda i: k[i]) if t1 else int(np.abs(k).argmax())
r_hp = 1 / k[i_hp]
j = i_hp
while abs(k[j]) > 1 / 150:
    j -= 1                                     # where the hairpin starts to turn
turn_in = j
while abs(k[j]) >= 1 / 1000 and dense_s[turn_in] - dense_s[j] < 60:
    j -= 1                                     # the eased turn-in (the centreline is smoothed)
straight_end = j
while abs(k[j]) < 1 / 1000:
    j -= 1
straight_len = dense_s[straight_end] - dense_s[j]
check("1. Turn 1 hairpin R16-20 at the end of a straight >= 250 m", 16 <= r_hp <= 20 and straight_len >= 250,
      f"R{r_hp:.1f} at {dense_s[i_hp]:.0f} m ({P[i_hp, 0]:.0f}, {P[i_hp, 1]:.0f}); {straight_len:.0f} m straight (R > 1 km), "
      f"then {dense_s[i_hp] - dense_s[straight_end]:.0f} m to the apex")
right_after = [i for i in corners if dense_s[i_hp] < dense_s[i] < dense_s[i_hp] + 200 and k[i] < 0]
check("1. A right-hander R40-50 after the hairpin", bool(right_after) and 40 <= -1 / k[right_after[0]] <= 50,
      f"R{-1 / k[right_after[0]]:.1f} at {dense_s[right_after[0]]:.0f} m" if right_after else "none within 200 m")
sweep = objs.get("StandSweep_Base")
d_sweep = np.linalg.norm(centre_of(sweep)[:2] - P[i_hp, :2]) if sweep else 1e9
check("1. Sweep stand within 50 m of the hairpin apex", d_sweep <= 50, f"{d_sweep:.0f} m")
bd = []
for o in objs:
    if o.name.split(".")[0] == "BrakeBoard":
        q = centre_of(o)
        ii = int(np.argmin(np.linalg.norm(P[:, :2] - q[:2], axis=1)))
        bd.append((dense_s[turn_in] - dense_s[ii], np.linalg.norm(P[ii, :2] - q[:2])))
check("1. Brake boards at 300/200/100 m, >= 12 m out", len(bd) == 3 and min(x[1] for x in bd) >= 12,
      ", ".join(f"{x[0]:.0f} m before turn-in, {x[1]:.1f} m out" for x in sorted(bd, reverse=True)) or "none")

# ---- 2. Hills
z = P[:, 2]
grade = (np.roll(z, -5) - np.roll(z, 5)) / 10.0
check("2. Grade <= 7 %", np.abs(grade).max() <= 0.07,
      f"max {np.abs(grade).max() * 100:.1f} % at {dense_s[np.abs(grade).argmax()]:.0f} m")
zz = np.convolve(np.concatenate([z[-20:], z, z[:20]]), np.ones(9) / 9, mode="same")[20:-20]
d2 = (np.roll(zz, -15) - 2 * zz + np.roll(zz, 15)) / 15.0 ** 2
# The crest under the bridge is a deliberate jump: find it by its lip
bridge = objs.get("SponsorBridgeDeck")
i_lip = int(np.argmin(np.linalg.norm(P[:, :2] - centre_of(bridge)[:2], axis=1))) if bridge else -1
off_jump = np.abs(((dense_s - dense_s[i_lip] + length / 2) % length) - length / 2) > 40 if i_lip >= 0 else np.ones(M, bool)
crest_r = 1 / max(-d2[off_jump].min(), 1e-9)
check("2. Vertical radius >= 250 m at every crest (except the jump)", crest_r >= 250,
      f"tightest crest R{crest_r:.0f} m at {dense_s[off_jump][d2[off_jump].argmin()]:.0f} m; height {z.min() - z[0]:+.1f} to {z.max() - z[0]:+.1f} m")
if i_lip >= 0:
    g_up = (z[i_lip - 5] - z[i_lip - 45]) / 40.0
    g_dn = (z[(i_lip + 45) % M] - z[(i_lip + 5) % M]) / 40.0
    lip = np.array([(z[(i_lip + d + 1) % M] - 2 * z[(i_lip + d) % M] + z[(i_lip + d - 1) % M]) for d in range(-6, 7)])
    r_lip = 1 / max(-lip.min(), 1e-9)
    takeoff = math.sqrt(9.81 * r_lip) * 3.6
    under = min((world_verts(bridge)[:, 2] - z[i_lip]).min(), 99)
    check("B. Jump at the crest: ramp up, sharp lip, landing downslope, clear of the bridge",
          g_up > 0.02 and g_dn < -0.04 and takeoff < 120 and under >= 7,
          f"up {g_up * 100:.1f} %, down {g_dn * 100:.1f} %, lip R{r_lip:.0f} m: airborne above ~{takeoff:.0f} km/h; bridge {under:.1f} m above the lip")
flat = (dense_s <= 400) | (dense_s >= length - 70)
check("2. Last 70 m and first 400 m flat", np.abs(z[flat] - z[0]).max() <= 0.02,
      f"within {np.abs(z[flat] - z[0]).max() * 100:.1f} cm")
g = objs["GroundGrass"]
gtree = BVHTree.FromObject(g, depsgraph)
g_inv = g.matrix_world.inverted()
def ground_at(x, y):
    hit = gtree.ray_cast(g_inv @ Vector((x, y, 500.0)), g_inv.to_3x3() @ Vector((0, 0, -1)), 2000.0)
    return (g.matrix_world @ hit[0]).z if hit[0] is not None else None
worst_edge, worst_verge = (1e9, 0), (1e9, 0)
kr_all = np.array([k[min(int(round(sv)), M - 1)] for sv in s])
i_fc_ring = int(np.argmax(np.where(np.asarray(s) > length - 200, np.abs(kr_all), 0)))
near_final = np.abs(np.arange(len(s)) - i_fc_ring) < 60
for i in range(0, n, 2):
    across = (Rgt[i] - Lft[i]) / 14.0
    for f_, tag in ((-1.0, "edge"), (0.0, "edge"), (1.0, "edge"), (-2.1, "verge"), (2.1, "verge"), (-3.1, "verge"), (3.1, "verge")):
        q = C[i] + across * 7.0 * f_
        # inside the final corner the verge is level past the kerb (8.8 m)
        if abs(f_) > 8.8 / 7.0 and f_ * across[2] < 0 and near_final[i]:
            q = C[i] + across * 7.0 * f_
            q[2] = (C[i] + across * 8.8 * np.sign(f_))[2]
        if tag == "verge" and abs(kr_all[i]) > 1 / 40.0:
            continue                           # the verge is trimmed inside tight corners
        gz = ground_at(q[0], q[1])
        if gz is None:
            continue
        top = q[2] - (0.03 if tag == "verge" else 0.0)
        if tag == "edge" and top - gz < worst_edge[0]:
            worst_edge = (top - gz, s[i])
        if tag == "verge" and top - gz < worst_verge[0]:
            worst_verge = (top - gz, s[i])
check("2. Ground >= 0.3 m below the road, and under the verge", worst_edge[0] >= 0.3 and worst_verge[0] >= 0.0,
      f"road {worst_edge[0]:.2f} m at {worst_edge[1]:.0f} m; verge {worst_verge[0]:.2f} m at {worst_verge[1]:.0f} m")

# ---- 3. Esses
seq = None
for a_ in range(len(corners) - 2):
    trio = corners[a_:a_ + 3]
    rs = [1 / k[i] for i in trio]
    if [np.sign(r) for r in rs] == [1, -1, 1] and all(35 <= abs(r) <= 50 for r in rs) \
            and dense_s[trio[2]] - dense_s[trio[0]] < 250:
        seq = trio
        break
esses = objs.get("StandEsses_Base")
d_es = np.linalg.norm(P[:, :2] - centre_of(esses)[:2], axis=1).min() if esses else 1e9
check("3. Esses: three bends R35-50, left-right-left", seq is not None,
      ", ".join(f"R{1 / k[i]:+.0f} at {dense_s[i]:.0f} m" for i in seq) if seq else "not found")
check("3. Esses stand within 45 m of the road", d_es <= 45, f"{d_es:.0f} m")

# ---- 4. Banking: outside edge up, <= 10 deg, <= 2 deg on straights
bank = np.degrees(np.arcsin(np.clip((Rgt[:, 2] - Lft[:, 2]) / 14.0, -1, 1)))    # + = right edge higher
kr = np.array([k[min(int(round(sv)), M - 1)] for sv in s])
wrong = [(s[i], bank[i]) for i in range(n) if abs(bank[i]) > 0.5 and np.sign(bank[i]) != np.sign(kr[i])]
straight = np.abs(kr) < 1 / 500
check("4. Banked rings lean into the corner (outside edge higher)", not wrong,
      f"{len(wrong)} rings lean out" + (f", first at {wrong[0][0]:.0f} m" if wrong else ""))
check("4. Bank <= 10 deg, <= 2 deg on straights",
      np.abs(bank).max() <= 10 and (np.abs(bank[straight]).max() if straight.any() else 0) <= 2,
      f"max {np.abs(bank).max():.1f} deg; on straights {np.abs(bank[straight]).max():.1f} deg")
for i in corners:
    if abs(bank[int(np.searchsorted(s, dense_s[i]) % n)]) > 1:
        print(f"      banked: R{1 / k[i]:+.0f} at {dense_s[i]:.0f} m, {bank[int(np.searchsorted(s, dense_s[i]) % n)]:+.1f} deg")

# ---- 5. Final corner, stands, kerbs, tyre walls
fc = [i for i in corners if dense_s[i] > length - 250]
i_fc = max(fc, key=lambda i: abs(k[i])) if fc else M - 1
stadium = objs.get("StandStadium_Base")
d_st = np.linalg.norm(centre_of(stadium)[:2] - P[i_fc, :2]) if stadium else 1e9
check("5. Final corner ~R30; Stadium stand ~50 m out", 27 <= 1 / abs(k[i_fc]) <= 33 and d_st <= 60,
      f"R{1 / abs(k[i_fc]):.1f} at {dense_s[i_fc]:.0f} m; stand {d_st:.0f} m from the apex")

tt = np.roll(P[:, :2], -1, 0) - np.roll(P[:, :2], 1, 0)
tt /= np.linalg.norm(tt, axis=1)[:, None]
rightv = np.stack([tt[:, 1], -tt[:, 0]], 1)
def locate(xy):
    xy = np.atleast_2d(xy)
    idx = np.empty(len(xy), int)
    for a0 in range(0, len(xy), 2048):
        d2_ = ((xy[a0:a0 + 2048, None, :] - P[None, :, :2]) ** 2).sum(-1)
        idx[a0:a0 + 2048] = d2_.argmin(1)
    return idx, ((xy - P[idx, :2]) * rightv[idx]).sum(1)

kv = world_verts(objs["ApexKerbs"])
k_idx, k_lat = locate(kv[:, :2])
miss = []
for i in corners:
    for side in (-1, 1):
        m = (np.sign(k_lat) == side) & (np.abs(((dense_s[k_idx] - dense_s[i] + length / 2) % length) - length / 2) < 5)
        if not m.any():
            miss.append(f"{dense_s[i]:.0f} m {'L' if side < 0 else 'R'}")
check("5. Kerbs on both sides through every corner", not miss,
      f"{len(corners)} corners" + (": missing at " + ", ".join(miss[:6]) if miss else ""))

walls = [o for o in objs if o.name.startswith("TyreWall")]
spans = []
inner_min = 1e9
for o in walls:
    V = world_verts(o)
    idx, lat = locate(V[:, :2])
    inner_min = min(inner_min, np.abs(lat).min())
    ss = dense_s[idx]
    if ss.max() - ss.min() > length / 2:
        ss = np.where(ss > length / 2, ss - length, ss)
    spans.append((int(np.sign(np.median(lat))), ss.min(), ss.max()))
gaps = []
for side in (-1, 1):
    sp = sorted((a_, b_) for sd, a_, b_ in spans if sd == side)
    for (a0, b0), (a1, b1) in zip(sp, sp[1:]):
        if 0 < a1 - b0 < 12:                   # a real gap, not the space between two runs
            gaps.append(f"{side:+d} {b0:.0f}-{a1:.0f} m")
check("5. Tyre walls >= 10 m from the centre, no gaps between blocks", inner_min >= 10 and not gaps,
      f"{len(walls)} blocks, nearest {inner_min:.1f} m" + (", gaps " + ", ".join(gaps[:5]) if gaps else ""))

# ---- Tunnel
t_walls = [o for o in objs if o.name.startswith("TunnelWall")]
t_roof = objs.get("TunnelRoof")
if t_walls and t_roof:
    wl = min(np.abs(locate(world_verts(o)[:, :2])[1]).min() for o in t_walls)
    rv = world_verts(t_roof)
    idx, rlat = locate(rv[:, :2])
    over = np.abs(rlat) <= 4.5                 # over the road, not where the arch meets the walls
    roof_up = (rv[over, 2] - P[idx[over], 2]).min()
    span = dense_s[idx]
    t0, t1 = span.min(), span.max()
    shell = [BVHTree.FromObject(o, depsgraph) for o in t_walls + [t_roof]]
    shell_inv = [o.matrix_world.inverted() for o in t_walls + [t_roof]]
    open_rays = rays = 0
    for i in range(M):
        if not (t0 + 12 <= dense_s[i] <= t1 - 12) or i % 6:
            continue
        for ang in range(0, 360, 30):
            d = np.array([math.cos(math.radians(ang)), math.sin(math.radians(ang))])
            if abs(np.dot(d, tt[i])) > 0.5:
                continue                        # looking along the tunnel, out of the mouth
            for elev in (0.0, 0.6):
                rays += 1
                o_ = Vector((P[i, 0], P[i, 1], P[i, 2] + 1.5))
                dv = Vector((d[0], d[1], elev)).normalized()
                if all(tr.ray_cast(inv @ o_, (inv.to_3x3() @ dv).normalized(), 60.0)[0] is None
                       for tr, inv in zip(shell, shell_inv)):
                    open_rays += 1
    lights = objs.get("TunnelLights")
    check("Tunnel: walls >= 10 m out, roof >= 6.5 m over the road, closed, lit",
          wl >= 10 and roof_up >= 6.5 and open_rays == 0 and lights is not None,
          f"{t0:.0f}-{t1:.0f} m ({t1 - t0:.0f} m); walls {wl:.1f} m out; roof {roof_up:.1f} m up; "
          f"{open_rays}/{rays} side rays escape; lights {'yes' if lights else 'no'}")
else:
    check("Tunnel", False, "missing")

# ---- Clearance
ALLOWED = ("Road", "Verge_", "EdgeLine", "RacingLine", "ApexKerbs", "StartFinishLine", "PitLane",
           "GroundGrass", "PitWall", "GantryPillar", "GravelTrap", "GrassPatch", "Lake",
           "PitLine", "PitLimit", "PitBox", "PitApron")
intruders = []
for o in objs:
    if o.type != 'MESH' or o.name.startswith(ALLOWED):
        continue
    V = world_verts(o)
    idx, lat = locate(V[:, :2])
    inside = np.abs(lat) < CLEAR
    if not inside.any():
        continue
    if (V[inside, 2] - P[idx[inside], 2]).min() > 5.0:
        continue                               # overhead: gantry, bridge deck, lamps
    intruders.append(f"{o.name} ({np.abs(lat).min():.1f} m)")
check(f"Nothing standing within {CLEAR:.0f} m of the centre line", not intruders,
      f"{len(intruders)} objects" + (": " + ", ".join(intruders[:8]) if intruders else ""))

gravel = []
for o in objs:
    if o.name.startswith("GravelTrap"):
        idx, lat = locate(world_verts(o)[:, :2])
        gravel.append((o.name, np.abs(lat).min()))
check("Gravel never under the road", all(gv >= 6.99 for _, gv in gravel),
      ", ".join(f"{nm} from {gv:.1f} m" for nm, gv in gravel))

# ---- Pit road
def nearest(ref, xy):
    """Index of the nearest ref point (2D) for each of xy."""
    xy = np.atleast_2d(xy)
    out = np.empty(len(xy), int)
    for a_ in range(0, len(xy), 1024):
        out[a_:a_ + 1024] = ((xy[a_:a_ + 1024, None, :] - ref[None]) ** 2).sum(-1).argmin(1)
    return out

def road_lat_z(xy):
    """Lateral offset (right +) from the road centre and road-plane height there."""
    i = nearest(C[:, :2], xy)
    across = (Rgt[i] - Lft[i]) / 14.0
    lat = ((np.atleast_2d(xy) - C[i, :2]) * across[:, :2]).sum(1) / (across[:, :2] ** 2).sum(1)
    return i, lat, C[i, 2] + across[:, 2] * lat

pit = objs.get("PitLane")
if pit and len(pit.data.vertices) > 100:
    V = world_verts(pit)
    PL, PR = V[0::2], V[1::2]
    PC = (PL + PR) / 2
    pw = np.linalg.norm((PL - PR)[:, :2], axis=1)
    pseg = np.linalg.norm(np.diff(PC[:, :2], axis=0), axis=1)
    plen = pseg.sum()
    _, lat_in, _ = road_lat_z(PR[:, :2])
    _, lat_out, _ = road_lat_z(PL[:, :2])
    joined = []
    for k_ in (0, len(PC) - 1):
        _, _, zr = road_lat_z(PR[[k_], :2])
        joined.append((abs(lat_in[k_]), abs(lat_out[k_]), abs(PR[k_, 2] - zr[0])))
    check("Pit road joined to the track at both ends",
          all(li <= 6.0 and lo <= 9.3 and dz <= 0.02 for li, lo, dz in joined),
          "; ".join(f"{nm}: inner edge {li:.1f} m, outer {lo:.1f} m from the centre, {dz * 100:.1f} cm step"
                    for nm, (li, lo, dz) in zip(("entry", "exit"), joined)))
    pa, pb, pc_ = PC[:-12, :2], PC[6:-6, :2], PC[12:, :2]
    pcross = (pb - pa)[:, 0] * (pc_ - pb)[:, 1] - (pb - pa)[:, 1] * (pc_ - pb)[:, 0]
    pden = np.linalg.norm(pb - pa, axis=1) * np.linalg.norm(pc_ - pb, axis=1) * np.linalg.norm(pc_ - pa, axis=1)
    pk = np.abs(2 * pcross / pden)
    grade = np.abs(np.diff(PC[:, 2])) / np.maximum(pseg, 1e-6)
    low = [ground_at(*q[:2]) for q in PC[::5]]
    under = min(q[2] - gz for q, gz in zip(PC[::5], low) if gz is not None)
    lane = (np.abs(lat_in) > 8.5)
    check("Pit road: >= 6.5 m wide off the track, curves >= R40, grade <= 4 %, ground below",
          pw[lane].min() >= 6.5 and 1 / pk.max() >= 40 and grade.max() <= 0.04 and under >= 0.05,
          f"{plen:.0f} m; {pw[lane].min():.1f} m wide; tightest R{1 / pk.max():.0f}; "
          f"grade {grade.max() * 100:.1f} %; ground {under:.2f} m below")

    walls = [o for o in objs if o.name.startswith("PitWall")]
    wc = np.array([centre_of(o)[:2] for o in walls])
    wi, wlat, _ = road_lat_z(wc)
    # the pit lane proper: beside the track, off it
    beside = (np.abs(lat_in) >= 8.9) & (np.abs((lat_in + lat_out) / 2) <= 13.0)
    pi_, _, _ = road_lat_z(PC[beside, :2])
    si = s[pi_]
    wall_s = s[wi]
    def covered(sv):
        d_ = np.abs((wall_s - sv + length / 2) % length - length / 2)
        return d_.min() <= 3.0
    uncovered = [sv for sv in si[::3] if not covered(sv)]
    # open ends: no wall where the pit road overlaps the track
    merging = np.abs(lat_in) < 8.3
    mi, _, _ = road_lat_z(PC[merging, :2])
    blocked = [sv for sv in s[mi] if covered(sv)]
    check("Pit wall: continuous beside the pit lane, open where the pit road meets the track",
          len(walls) > 50 and not uncovered and not blocked and np.abs(wlat).max() < 8.4,
          f"{len(walls)} blocks {np.abs(wlat).min():.1f}-{np.abs(wlat).max():.1f} m out; "
          f"{len(uncovered)} lane samples unwalled; {len(blocked)} merge samples walled"
          + (f" (unwalled at {', '.join(f'{u_:.0f}' for u_ in uncovered[:6])} m)" if uncovered else ""))

    boxes = [o for o in objs if o.name.startswith("PitBox")]
    doors = [centre_of(o)[:2] for o in objs if o.name.startswith("GarageDoor")]
    limits = [o for o in objs if o.name.startswith("PitLimit")]
    box_ok = all(min(np.linalg.norm(centre_of(b_)[:2] - d_) for d_ in doors) < 8.0 for b_ in boxes)
    check("Garage boxes in front of every garage; speed-limit lines",
          len(boxes) == len(doors) and box_ok and len(limits) == 2,
          f"{len(boxes)} boxes for {len(doors)} garages; {len(limits)} limit lines")

    PIT_OK = ALLOWED + ("Garage", "TeamFlags", "TrackBanners", "FloodlightTowers")
    on_pit = []
    for o in objs:
        if o.type != 'MESH' or o.name.startswith(PIT_OK):
            continue
        Vo = world_verts(o)
        lo_, hi_ = Vo[:, :2].min(0) - 12, Vo[:, :2].max(0) + 12
        if not ((PC[:, :2] >= lo_) & (PC[:, :2] <= hi_)).all(1).any():
            continue
        k_ = nearest(PC[:, :2], Vo[:, :2])
        d_ = np.linalg.norm(Vo[:, :2] - PC[k_, :2], axis=1)
        near_ = d_ < pw[k_] / 2 + 1.0
        if near_.any() and (Vo[near_, 2] - PC[k_[near_], 2]).min() < 5.0:
            on_pit.append(o.name)
    check("Nothing standing on the pit road", not on_pit,
          f"{len(on_pit)} objects" + (": " + ", ".join(on_pit[:8]) if on_pit else ""))
else:
    check("Pit road", False, "PitLane is not a pit road ribbon")

# ---- 6 / 7. Atmosphere
crowds = [p for p in ("StandMain_", "StandSweep_", "StandEsses_", "StandStadium_") if (p + "Crowd") in objs]
def emissive(m):
    if not m.node_tree or not m.node_tree.nodes.get("Principled BSDF"):
        return False
    b_ = m.node_tree.nodes["Principled BSDF"]
    return b_.inputs["Emission Strength"].default_value > 0 and \
        max(tuple(b_.inputs["Emission Color"].default_value)[:3]) > 0 and m.users > 0
glow = sorted(m.name for m in bpy.data.materials if emissive(m))
check("6. Spectators in all four stands; glowing boards, screen and floodlights",
      len(crowds) == 4 and "BigScreen" in objs and any(o.name.startswith("FloodlightTowers") for o in objs) and glow,
      f"crowds in {len(crowds)} stands; emissive: {', '.join(glow)}")
legs = [o for o in objs if o.name.startswith("SponsorBridgeLeg")]
deck = objs.get("SponsorBridgeDeck")
if legs and deck:
    leg_lat = min(np.abs(locate(world_verts(o)[:, :2])[1]).min() for o in legs)
    dv = world_verts(deck)
    idx, _ = locate(dv[:, :2])
    under = (dv[:, 2] - P[idx, 2]).min()
    check("7. Bridge over the crest: legs >= 10 m out, underside >= 7 m up", leg_lat >= 10 and under >= 7,
          f"legs {leg_lat:.1f} m out, underside {under:.1f} m above the road")
else:
    check("7. Bridge over the crest", False, "missing")

# ---- Materials and export hygiene
bad = []
for m in bpy.data.materials:
    if not m.node_tree or m.users == 0:
        continue
    bsdf = m.node_tree.nodes.get("Principled BSDF")
    if not bsdf:
        continue
    base = bsdf.inputs["Base Color"]
    if base.is_linked and not any(l.from_node.type == 'TEX_IMAGE' for l in base.links):
        bad.append(f"{m.name} (colour from nodes: exports white)")
    elif not base.is_linked and tuple(base.default_value)[:3] == (1.0, 1.0, 1.0):
        bad.append(m.name)
check("Every material has a Base Color", not bad, ", ".join(bad) or "ok")
if path.endswith(".glb"):
    size = os.path.getsize(path) / 1e6
    extra = [o.name for o in objs if o.type in ('LIGHT', 'CAMERA')]
    check("Export: no lights or cameras, under 20 MB", not extra and size < 20, f"{size:.1f} MB, {len(extra)} lights/cameras")

print(f"\n{sum(RESULTS)}/{len(RESULTS)} checks passed")
if bpy.app.background:
    sys.exit(0 if all(RESULTS) else 1)
