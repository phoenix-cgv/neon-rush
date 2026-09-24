"""Grand Prix map: fixes and the "make it the star" rebuild, applied to the map as delivered.

RaceTrack2.blend is the map as delivered (the base generator, Track2.py,
was not kept; Track.py is the realism pass that ran after it). This
script rebuilds it and leaves the result open. Headless:

    python3 -c "import bpy; exec(open('fix_grandprix.py').read()); \
        bpy.ops.wm.save_as_mainfile(filepath='GrandPrix.blend')"
    python3 check_grandprix.py GrandPrix.blend
    python3 ../export_glb.py GrandPrix.blend ../../assets/maps/GrandPrix.glb

In Blender: open RaceTrack2.blend, run this script in the Text Editor,
then File > Save As GrandPrix.blend (it works on the open file).

Layout (race direction anticlockwise, start line unchanged at -430, -170):
  - Turn 1 (A): the opening straight runs dead straight for 270 m into a
    left hairpin (~R18, 130 deg) with a braking zone and boards at 300,
    200 and 100 m, then an 80 deg right-hander (R45, banked 6 deg) and a
    left sweep onto the back straight.
  - Back straight (B): a blind crest at +10 m under a sponsor bridge.
  - The esses (C): the road swings north to the Esses stand (within 40 m)
    for a left-right-left of R40, 40 deg each.
  - Corner D: one R90 left, banked 8 deg, onto a long diagonal straight
    into the final corner.
  - The final corner (E): R30 left, banked 4.5 deg, finishing 70 m before
    the start line so the whole grid lines up on straight, level road.
Height: flat for the grid and the pit straight, down 4 m into Turn 1, up
to the +10 m crest, a dip to +3, climbing to +6 through the esses, and
down to 0 for the final corner. Grades under 7 %, crest radius > 1 km.

Everything beside the road is rebuilt or moved to match: the road,
verges, edge lines, racing line and kerbs are generated every 2 m from
the centreline, height and banking; the ground is a terrain mesh that
follows the road; scenery near a moved stretch moves with it and sits on
the new ground; gravel traps, continuous tyre walls, grandstand crowds,
flags, banners, a big screen, floodlight towers and the bridge are added.

Earlier fixes kept here: the final corner no longer zig-zags into a
folded 7.8 m hairpin, the ribbon is smooth (it was a polygon with 42 m
straights), scenery is cleared out of the drivable band, gravel no
longer runs under the road, and every material has a plain Base Color.
"""
import bpy
import math
import os
import random
import numpy as np
from mathutils import Matrix, Vector

random.seed(7)

HERE = os.path.dirname(os.path.abspath(bpy.context.space_data.text.filepath)) \
    if bpy.context.space_data and getattr(bpy.context.space_data, "text", None) else os.getcwd()
SOURCE = os.path.join(HERE, "RaceTrack2.blend")

# ---------------------------------------------------------------- cross-section
ROAD_Z = 0.06               # road surface above the height profile
ROAD_HALF = 7.0
VERGE_OUT = 23.0
VERGE_DZ = -0.03            # verge, relative to the (banked) road plane
EDGE_WIDTH = 1.1
EDGE_DZ = 0.01
RACING_HALF = 2.4
RACING_DZ = 0.006
KERB_IN, KERB_OUT, KERB_DZ = 7.0, 8.8, 0.02
KERB_BLOCK = 4.0            # metres per red or white block
SAMPLE = 2.0                # centreline spacing, metres
SMOOTH_HALF = 16            # smoothing half-width in 0.5 m samples (8 m)
DRIVABLE = 8.4 + 0.85       # level's wallLimit + half a car
CLEAR = 10.0                # nothing that stands up within this of the centre line
GRAVEL_INNER = 9.0          # gravel traps that aren't run-off start beyond the kerbs

# ---------------------------------------------------------------- layout
# Stretches of the delivered centreline (by ring index) that stay, and the
# new pieces between them, built from straights ('S', metres; None = solved
# so the piece rejoins the road) and arcs ('A', degrees, radius; + = left).
T1_FROM, T1_TO = 20, 62          # Turn 1 replaces rings 20..62
T1_HEADING = 15.0                # heading of the braking straight
T1_STRAIGHT = 270.0
T1_HAIRPIN = (130.0, 17.0)       # smoothing opens R17 to ~R18-19
T1_RIGHT = (-80.0, 45.0)
T1_SWEEP_R = 110.0
ES_FROM = 71                     # the esses replace ring 71 to the final corner
ES_HEADING = 170.0               # heading into the esses
ESSES = [(40.0, 40.0), (-40.0, 40.0), (40.0, 40.0)]
D_R = 90.0
FINAL_R = 30.0
EXIT_BEFORE_LINE = 70.0
APPROACH_HEADING = -123.0        # the diagonal into the final corner
APPROACH_LEAD = 40.0             # the diagonal ends this far before the corner

# Displacement fades out between these distances from the old road
MOVE_FULL, MOVE_NONE = 40.0, 200.0

# ---------------------------------------------------------------- height and banking
PIT_END = 760.0                  # the pit lane and garages stay level
T1_DROP = -4.0
CREST = (320.0, 203.0)           # B: the crest, on the back straight
CREST_H = 10.0
DIP_H, ESSES_H = 3.0, 6.0
BANK_T1_RIGHT, BANK_D, BANK_FINAL = 6.0, 8.0, 4.5     # degrees at the apex
TERRAIN_SPACING = 10.0
TERRAIN_BLEND = (23.0, 150.0)    # follows the road out to the verge, flat by 150 m
GROUND_DEEP = 21.0               # 0.33 m under the road plane this far out (the grid is 10 m)

NATURAL = ("GrassBlade", "TracksideTree", "TreeTrunk", "TreeRoot", "Crown", "PineLower",
           "PineUpper", "Bush", "TracksideBush", "Rock")
REGENERATED = ("Road", "Verge_L", "Verge_R", "EdgeLine_L", "EdgeLine_R", "RacingLine", "ApexKerbs",
               "GroundGrass", "TyreWall")
FIXED = ("Hill", "Lake", "LakeShore", "Stand")      # stands are placed explicitly
GROUND_DECALS = ("GravelTrap", "GrassPatch", "PitLane")
# Allowed inside the clearance: flat pieces, the pit wall and gantry legs
# the game makes solid, and parts well overhead.
FLAT_OK = ("Road", "Verge", "EdgeLine", "RacingLine", "ApexKerbs", "StartFinishLine", "PitLane",
           "GroundGrass", "GravelTrap", "GrassPatch", "PitWall", "GantryPillar", "Lake")


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


def smooth_closed(pts, half, passes):
    """Triangular moving average: eases straight-to-arc joins into gentle transitions."""
    w = np.concatenate([np.arange(1, half + 2), np.arange(half, 0, -1)]).astype(float)
    w /= w.sum()
    for _ in range(passes):
        pts = sum(np.roll(pts, k, 0) * wk for k, wk in zip(range(half, -half - 1, -1), w))
    return pts


def heading_of(a, b):
    return math.degrees(math.atan2(b[1] - a[1], b[0] - a[0]))


def turtle(p, h, segs, step=4.0):
    """Walk straights and arcs from point p, heading h (degrees). Returns points, end, heading."""
    p = np.array(p, float)
    pts = [p.copy()]
    for sg in segs:
        if sg[0] == 'S':
            L = sg[1]
            d = np.array([math.cos(math.radians(h)), math.sin(math.radians(h))])
            n = max(1, int(abs(L) / step))
            for k in range(1, n + 1):
                pts.append(p + d * L * k / n)
            p = p + d * L
        else:
            deg, R = sg[1], sg[2]
            sgn = 1 if deg > 0 else -1
            c = p + R * np.array([-math.sin(math.radians(h)), math.cos(math.radians(h))]) * sgn
            a0 = math.radians(h - 90 * sgn)
            n = max(2, int(abs(math.radians(deg)) * R / step))
            for k in range(1, n + 1):
                a = a0 + math.radians(deg) * k / n
                pts.append(c + R * np.array([math.cos(a), math.sin(a)]))
            h = h + deg
            p = pts[-1].copy()
    return np.array(pts), p, h


def solve_free(p0, h0, segs, target):
    """Fill in the two straights given as None so the piece ends at target."""
    free = [i for i, s in enumerate(segs) if s[0] == 'S' and s[1] is None]
    assert len(free) == 2
    def end(v):
        s = list(segs)
        for i, val in zip(free, v):
            s[i] = ('S', val)
        return turtle(p0, h0, s)[1]
    e0 = end([0, 0])
    A = np.stack([end([1, 0]) - e0, end([0, 1]) - e0], 1)
    sol = np.linalg.solve(A, np.asarray(target) - e0)
    s = list(segs)
    for i, val in zip(free, sol):
        s[i] = ('S', float(val))
    return s, sol


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
if os.path.basename(bpy.data.filepath) != "RaceTrack2.blend":
    bpy.ops.wm.open_mainfile(filepath=SOURCE)
objs = bpy.data.objects

def world_verts(o):
    mw = np.array(o.matrix_world)
    co = np.array([v.co for v in o.data.vertices]) if o.type == 'MESH' else np.zeros((0, 3))
    return co @ mw[:3, :3].T + mw[:3, 3] if len(co) else co

def set_world_verts(o, V):
    inv = np.array(o.matrix_world.inverted())
    local = V @ inv[:3, :3].T + inv[:3, 3]
    for v, co in zip(o.data.vertices, local):
        v.co = co
    o.data.update()

# Old centreline from the road ribbon: vertex pairs (left, right) along the lap
road_v = world_verts(objs["Road"])
old_left, old_right = road_v[0::2, :2], road_v[1::2, :2]
old_rings = (old_left + old_right) / 2
old = Centreline(old_rings, 0.5)
R = old_rings

# ---------------------------------------------------------------- new line
start = R[0]
u = R[1] - R[0]
u /= np.linalg.norm(u)
left_u = np.array([-u[1], u[0]])
exit_pt = start - u * EXIT_BEFORE_LINE
centre = exit_pt + left_u * FINAL_R
exit_angle = math.degrees(math.atan2(*(exit_pt - centre)[::-1]))
entry_angle = (APPROACH_HEADING - 90.0) % 360.0     # anticlockwise: position angle = heading - 90
arc = [centre + FINAL_R * np.array([math.cos(math.radians(a)), math.sin(math.radians(a))])
       for a in np.linspace(entry_angle, exit_angle % 360.0, 7)]
approach = np.array([math.cos(math.radians(APPROACH_HEADING)), math.sin(math.radians(APPROACH_HEADING))])
approach_end = arc[0] - approach * APPROACH_LEAD

# A: Turn 1
h_in = heading_of(R[T1_FROM], R[T1_FROM + 1])
h_out = heading_of(R[T1_TO], R[T1_TO + 1])
t1_segs, t1_free = solve_free(R[T1_FROM], h_in, [
    ('A', T1_HEADING - h_in, 450.0), ('S', T1_STRAIGHT),
    ('A', *T1_HAIRPIN), ('S', 22.0), ('A', *T1_RIGHT), ('S', None),
    ('A', h_out - (T1_HEADING + T1_HAIRPIN[0] + T1_RIGHT[0]), T1_SWEEP_R), ('S', None)], R[T1_TO])
t1_pts = turtle(R[T1_FROM], h_in, t1_segs)[0]

# C + D: the esses and corner D, ending on the diagonal into the final corner
h_es = heading_of(R[ES_FROM], R[ES_FROM + 1])
es_turn = sum(a for a, _ in ESSES)
es_segs, es_free = solve_free(R[ES_FROM], h_es, [
    ('S', None), ('A', -40.0, 150.0), ('S', 100.0), ('A', ES_HEADING - (h_es - 40.0), 150.0), ('S', 60.0),
    ('A', ESSES[0][0], ESSES[0][1]), ('S', 15.0), ('A', ESSES[1][0], ESSES[1][1]), ('S', 15.0),
    ('A', ESSES[2][0], ESSES[2][1]), ('S', 80.0),
    ('A', (APPROACH_HEADING % 360.0) - (ES_HEADING + es_turn), D_R), ('S', None)], approach_end)
es_pts = turtle(R[ES_FROM], h_es, es_segs)[0]
assert min(t1_free) > 5 and min(es_free) > 5, (t1_free, es_free)

tail = [approach_end + approach * APPROACH_LEAD / 2] + arc + \
       [exit_pt + u * d for d in np.arange(20.0, EXIT_BEFORE_LINE - 5.0, 20.0)]
control = np.array(list(R[:T1_FROM + 1]) + list(t1_pts[1:-1]) + list(R[T1_TO:ES_FROM + 1])
                   + list(es_pts[1:]) + tail)
dense = smooth_closed(centripetal_catmull_rom(control), SMOOTH_HALF, 2)
dense = np.roll(dense, -int(np.argmin(np.linalg.norm(dense - start, axis=1))), 0)
dense[0] = start                                    # ring 0 stays exactly on the start line
new = Centreline(dense, SAMPLE)
curv = new.curvature()
N = new.n

def new_s_of(p):
    return new.s[new.locate(np.asarray(p)[None])[0][0]]

def old_s_of(p):
    return old.s[old.locate(np.asarray(p)[None])[0][0]]

# Stretches that moved: (old s from, old s to, new s from, new s to)
WINDOWS = [
    (old_s_of(R[T1_FROM]), old_s_of(R[T1_TO]), new_s_of(R[T1_FROM]), new_s_of(R[T1_TO])),
    (old_s_of(R[ES_FROM]), old.length, new_s_of(R[ES_FROM]), new.length),
]

def displacement(xy):
    """Where each point should go so it keeps its place beside the road."""
    idx, lat, dist = old.locate(xy)
    s_old = old.s[idx]
    move = np.zeros((len(xy), 2))
    turn = np.zeros(len(xy))
    for oa, ob, na, nb in WINDOWS:
        inw = (s_old >= oa) & (s_old <= ob)
        if not inw.any():
            continue
        frac = (s_old - oa) / (ob - oa)
        s_new = na + frac * (nb - na)
        target, _ = new.at(s_new, lat)
        source, _ = old.at(s_old, lat)
        w = (1 - smoothstep(MOVE_FULL, MOVE_NONE, np.abs(lat))) * inw
        w *= smoothstep(0.0, 20.0, s_old - oa) * smoothstep(0.0, 20.0, ob - s_old + (20.0 if ob >= old.length else 0.0))
        dth = np.interp(s_new, new.s, np.unwrap(new.heading)) - np.interp(s_old, old.s, np.unwrap(old.heading))
        dth = (dth + np.pi) % (2 * np.pi) - np.pi
        move += (target - source) * w[:, None]
        turn += dth * w
    return move, turn

# ---------------------------------------------------------------- landmarks
def peak(mask, sign=1):
    k = np.where(mask, curv * sign, -1e9)
    return int(np.argmax(k))

win1 = (new.s >= WINDOWS[0][2]) & (new.s <= WINDOWS[0][3])
win2 = new.s >= WINDOWS[1][2]
i_hp = peak(win1)                                       # Turn 1 hairpin apex
i_rh = peak(win1 & (new.s > new.s[i_hp]), -1)           # Turn 1 right-hander
i_crest = int(np.argmin(np.linalg.norm(new.p - np.array(CREST), axis=1)))
i_final = peak(new.s > new.length - 200.0)              # final corner
es_peaks = [i for i in range(N) if win2[i] and abs(curv[i]) > 1 / 60.0
            and abs(curv[i]) >= abs(curv[i - 1]) and abs(curv[i]) >= abs(curv[(i + 1) % N])]
i_es0, i_es1 = es_peaks[0], es_peaks[2]                 # first and last of the esses
i_d = peak(win2 & (new.s > new.s[i_es1] + 30) & (new.s < new.s[i_final] - 150))
s_hp_in = new.s[i_hp] - 20.0
while curv[int(round(s_hp_in / new.length * N)) % N] > 1 / 150.0:
    s_hp_in -= SAMPLE                                   # back to where the hairpin starts to turn
L = new.length

# ---------------------------------------------------------------- height profile
def cosine_profile(knots):
    ks = np.array([k[0] for k in knots])
    kh = np.array([k[1] for k in knots])
    def h(s):
        s = np.asarray(s) % L
        i = np.clip(np.searchsorted(ks, s, side='right') - 1, 0, len(ks) - 2)
        t = np.clip((s - ks[i]) / (ks[i + 1] - ks[i]), 0, 1)
        return kh[i] + (kh[i + 1] - kh[i]) * (1 - np.cos(np.pi * t)) / 2
    return h

HEIGHT_KNOTS = [
    (0.0, 0.0), (PIT_END, 0.0),                          # grid, pit straight: level
    (new.s[i_hp] - 90.0, T1_DROP),                       # downhill braking into Turn 1
    (new.s[i_rh] + 60.0, T1_DROP),
    (new.s[i_crest], CREST_H),                           # B: blind crest under the bridge
    (new.s[i_crest] + 280.0, DIP_H),                     # dip before the esses
    (new.s[i_es0] - 40.0, DIP_H),
    (new.s[i_es1] + 40.0, ESSES_H),                      # climbing through the esses
    (new.s[i_final] - 120.0, 0.0),                       # down to the final corner
    (L, 0.0),
]
assert all(b[0] > a[0] for a, b in zip(HEIGHT_KNOTS, HEIGHT_KNOTS[1:])), HEIGHT_KNOTS
height = cosine_profile(HEIGHT_KNOTS)
H = height(new.s)

# ---------------------------------------------------------------- banking
def bank_zone(i_peak, amp):
    """Bank one corner, outside edge up: amp degrees at the apex, in proportion
    to the curvature elsewhere, so it eases in and out with the corner and can
    never lean the wrong way."""
    sign = np.sign(curv[i_peak])
    out = np.zeros(N)
    for step in (-1, 1):
        i = i_peak if step < 0 else i_peak + 1
        while np.sign(curv[i % N]) == sign and abs(curv[i % N]) > 1 / 2000.0:
            out[i % N] = sign * amp * min(1.0, abs(curv[i % N]) / abs(curv[i_peak]))
            i += step
    return out

bank_deg = bank_zone(i_rh, BANK_T1_RIGHT) + bank_zone(i_d, BANK_D) + bank_zone(i_final, BANK_FINAL)
TANB = np.tan(np.radians(bank_deg))                         # z rises by lat * TANB (right +)

def plane_z(i, lat):
    """Height of the (extended) road plane at ring i, lateral offset lat (right +)."""
    return ROAD_Z + H[i] + np.asarray(lat) * TANB[i]

# ---------------------------------------------------------------- ground
def ground_below(xy):
    """Terrain height: under the road plane near the road, blending to flat by 150 m."""
    xy = np.atleast_2d(xy)
    out = np.empty(len(xy))
    for a in range(0, len(xy), 1024):
        q = xy[a:a + 1024]
        rel = q[:, None, :] - new.p[None]
        d2 = (rel ** 2).sum(-1)
        j = d2.argmin(1)
        d = np.sqrt(d2[np.arange(len(q)), j])
        lat = (rel[np.arange(len(q)), j] * new.right[j]).sum(1)
        latc = np.clip(lat, -VERGE_OUT, VERGE_OUT)
        near = plane_z(j, latc) - np.where(np.abs(latc) <= GROUND_DEEP, 0.33, 0.12)
        w = 1 - smoothstep(*TERRAIN_BLEND, d)
        z = w * near
        # never above any stretch of road or verge within reach
        lat_all = (rel * new.right[None]).sum(-1)
        inband = (np.abs(lat_all) <= VERGE_OUT) & (d2 < 35.0 ** 2)
        cap = ROAD_Z + H[None] + lat_all * TANB[None] - np.where(np.abs(lat_all) <= GROUND_DEEP, 0.33, 0.12)
        cap = np.where(inband, cap, np.inf).min(1)
        out[a:a + 1024] = np.minimum(z, cap)
    return out

def surface_z(xy):
    """What something standing at xy stands on: road plane, verge, or ground."""
    xy = np.atleast_2d(xy)
    j, lat, d = new.locate(xy)
    on_band = np.abs(lat) <= VERGE_OUT
    band_z = plane_z(j, lat) + np.where(np.abs(lat) <= ROAD_HALF, 0.0, VERGE_DZ)
    return np.where(on_band, band_z, ground_below(xy))

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
        d, _ = displacement(V[:, :2])
        V[:, :2] += d
        # lie on whatever is underneath: road plane (pit lane), verge or ground
        base = 0.0 if o.name.startswith("PitLane") else 0.01
        V[:, 2] = surface_z(V[:, :2]) + base + (V[:, 2] - V[:, 2].min())
        set_world_verts(o, V)
        moved += 1
    else:
        pivot = (lo + hi) / 2
        d, dth = displacement(pivot[None])
        piv = Vector((pivot[0], pivot[1], 0.0))
        new_piv = pivot + d[0]
        dz = float(surface_z(new_piv[None])[0]) - (0.03 if o.name.startswith("PitWall") else 0.0)
        o.matrix_world = (Matrix.Translation(piv + Vector((d[0][0], d[0][1], dz)))
                          @ Matrix.Rotation(float(dth[0]), 4, 'Z')
                          @ Matrix.Translation(-piv) @ o.matrix_world)
        moved += 1
bpy.context.view_layer.update()

# ---------------------------------------------------------------- materials
def mat(name):
    return bpy.data.materials[name]

def make_mat(name, color, roughness=0.6, metallic=0.0, emit=0.0):
    m = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    m.use_nodes = True
    bsdf = m.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = (*color, 1.0)
    bsdf.inputs["Roughness"].default_value = roughness
    bsdf.inputs["Metallic"].default_value = metallic
    if emit:
        bsdf.inputs["Emission Color"].default_value = (*color, 1.0)
        bsdf.inputs["Emission Strength"].default_value = emit
    m.diffuse_color = (*color, 1.0)
    return m

def glow(m, strength):
    """Make an existing material glow in its own colour (exports as emissive)."""
    bsdf = m.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Emission Color"].default_value = bsdf.inputs["Base Color"].default_value
    bsdf.inputs["Emission Strength"].default_value = strength

grass = bpy.data.materials.get("Grass")
if grass and grass.node_tree:
    bsdf = grass.node_tree.nodes.get("Principled BSDF")
    if bsdf:
        for link in list(bsdf.inputs["Base Color"].links):
            grass.node_tree.links.remove(link)
        bsdf.inputs["Base Color"].default_value = (0.12, 0.3, 0.08, 1.0)
    grass.diffuse_color = (0.12, 0.3, 0.08, 1.0)

# ---------------------------------------------------------------- regenerate ribbons
def replace_mesh(name, verts, faces, materials, face_mats=None, smooth=True):
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
        poly.use_smooth = smooth   # one vertex per ribbon vertex in the export
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    return obj

def ribbon(lat_a, lat_b, dz, indices=None, closed=True):
    """Strip between two lateral offsets (numbers, or one per ring) on the banked
    road plane, vertices in (lat_a, lat_b) pairs."""
    idx = np.arange(N) if indices is None else np.asarray(indices)
    lat_a = np.broadcast_to(np.asarray(lat_a, float), (N,))[idx] if np.ndim(lat_a) else np.full(len(idx), lat_a)
    lat_b = np.broadcast_to(np.asarray(lat_b, float), (N,))[idx] if np.ndim(lat_b) else np.full(len(idx), lat_b)
    a, _ = new.at(new.s[idx], lat_a)
    b, _ = new.at(new.s[idx], lat_b)
    za = plane_z(idx, lat_a) + dz
    zb = plane_z(idx, lat_b) + dz
    verts = []
    for pa, pb, qa, qb in zip(a, b, za, zb):
        verts += [(pa[0], pa[1], qa), (pb[0], pb[1], qb)]
    count = len(idx)
    faces = []
    for r in range(count if closed else count - 1):
        r2 = (r + 1) % count
        faces.append((2 * r, 2 * r + 1, 2 * r2 + 1, 2 * r2))
    return verts, faces

# Road: pairs (left, right), ring 0 = start line, faces up
replace_mesh("Road", *ribbon(-ROAD_HALF, ROAD_HALF, 0.0), [mat("Asphalt")])
# On the inside of a tight corner a 23 m verge would reach past the centre of
# the turn and fold over itself: keep it within 80 % of the radius there.
k_env = np.max([np.abs(np.roll(curv, d)) for d in range(-8, 9)], axis=0)
inside_limit = np.clip(0.8 / np.maximum(k_env, 1e-9), ROAD_HALF + 2.0, VERGE_OUT)
verge_l = np.where(curv > 0, -inside_limit, -VERGE_OUT)     # left is the inside of a left-hander
verge_r = np.where(curv < 0, inside_limit, VERGE_OUT)
replace_mesh("Verge_L", *ribbon(verge_l, -ROAD_HALF, VERGE_DZ), [mat("GrassVerge")])
replace_mesh("Verge_R", *ribbon(ROAD_HALF, verge_r, VERGE_DZ), [mat("GrassVerge")])
replace_mesh("EdgeLine_L", *ribbon(-ROAD_HALF, -ROAD_HALF + EDGE_WIDTH, EDGE_DZ), [mat("LineWhite")])
replace_mesh("EdgeLine_R", *ribbon(ROAD_HALF - EDGE_WIDTH, ROAD_HALF, EDGE_DZ), [mat("LineWhite")])
replace_mesh("RacingLine", *ribbon(-RACING_HALF, RACING_HALF, RACING_DZ), [mat("AsphaltWorn")])

def runs_of(flags):
    """Contiguous runs of True (loop-aware) as lists of ring indices."""
    runs, cur = [], []
    for i in range(N):
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
    return runs

def grow(mask, samples):
    return np.convolve(np.concatenate([mask[-samples:], mask, mask[:samples]]).astype(int),
                       np.ones(2 * samples + 1, int), mode="same")[samples:-samples] > 0

# Kerbs: both sides through every corner, apex and exit, red and white
corner = np.abs(curv) > 1.0 / 250.0
kerb_flags = grow(corner, 10)
kerb_verts, kerb_faces, kerb_mats = [], [], []
for side in (-1, 1):
    for run in runs_of(kerb_flags):
        if len(run) < 5:
            continue
        lat_a, lat_b = (-KERB_OUT, -KERB_IN) if side < 0 else (KERB_IN, KERB_OUT)
        v, f = ribbon(lat_a, lat_b, KERB_DZ, run, closed=False)
        base = len(kerb_verts)
        kerb_verts += v
        kerb_faces += [tuple(x + base for x in face) for face in f]
        kerb_mats += [int(new.s[run[r]] // KERB_BLOCK) % 2 for r in range(len(run) - 1)]
replace_mesh("ApexKerbs", kerb_verts, kerb_faces, [mat("KerbRed"), mat("KerbWhite")], kerb_mats)

# ---------------------------------------------------------------- terrain
old_ground = objs.get("GroundGrass")
g_centre = np.array(old_ground.matrix_world.translation[:2]) if old_ground else np.array([0.0, 20.0])
g_size = max(old_ground.dimensions[:2]) if old_ground else 2200.0
steps = int(round(g_size / TERRAIN_SPACING))
gx = g_centre[0] - g_size / 2 + np.arange(steps + 1) * TERRAIN_SPACING
gy = g_centre[1] - g_size / 2 + np.arange(steps + 1) * TERRAIN_SPACING
GX, GY = np.meshgrid(gx, gy)
gxy = np.stack([GX.ravel(), GY.ravel()], 1)
# only points within reach of the road need the (slow) road test
j_all, _, d_all = new.locate(gxy)
gz = np.zeros(len(gxy))
reach = d_all < TERRAIN_BLEND[1] + 5
gz[reach] = ground_below(gxy[reach])
tverts = [(x, y, z) for (x, y), z in zip(gxy, gz)]
tfaces = []
W = steps + 1
for r in range(steps):
    for c in range(steps):
        a = r * W + c
        tfaces.append((a, a + 1, a + W + 1, a + W))
replace_mesh("GroundGrass", tverts, tfaces, [grass])

# ---------------------------------------------------------------- helpers for new objects
def add_box(name, centre_xyz, size, heading, material, collection=None):
    """Box of size (along, across, up) centred at centre_xyz, turned to heading (radians)."""
    hx, hy, hz = size[0] / 2, size[1] / 2, size[2] / 2
    corners = [(-hx, -hy, -hz), (hx, -hy, -hz), (hx, hy, -hz), (-hx, hy, -hz),
               (-hx, -hy, hz), (hx, -hy, hz), (hx, hy, hz), (-hx, hy, hz)]
    c, s = math.cos(heading), math.sin(heading)
    verts = [(centre_xyz[0] + x * c - y * s, centre_xyz[1] + x * s + y * c, centre_xyz[2] + z) for x, y, z in corners]
    faces = [(0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)]
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(verts, [], faces)
    mesh.materials.append(material)
    obj = bpy.data.objects.new(name, mesh)
    (collection or bpy.context.scene.collection).objects.link(obj)
    return obj

class MeshBuilder:
    """Many boxes in one object (one draw-friendly mesh), with per-box materials."""
    def __init__(self):
        self.v, self.f, self.m = [], [], []
    def box(self, centre_xyz, size, heading, mat_index):
        hx, hy, hz = size[0] / 2, size[1] / 2, size[2] / 2
        c, s = math.cos(heading), math.sin(heading)
        base = len(self.v)
        for x, y, z in [(-hx, -hy, -hz), (hx, -hy, -hz), (hx, hy, -hz), (-hx, hy, -hz),
                        (-hx, -hy, hz), (hx, -hy, hz), (hx, hy, hz), (-hx, hy, hz)]:
            self.v.append((centre_xyz[0] + x * c - y * s, centre_xyz[1] + x * s + y * c, centre_xyz[2] + z))
        for f in [(0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)]:
            self.f.append(tuple(base + k for k in f))
            self.m.append(mat_index)
    def build(self, name, materials):
        return replace_mesh(name, self.v, self.f, materials, self.m, smooth=False)

def frame(i):
    """Point, tangent angle (radians), right vector of ring i."""
    return new.p[i % N], float(new.heading[i % N]), new.right[i % N]

def ring_at(s):
    return int(round((s % L) / L * N)) % N

# ---------------------------------------------------------------- gravel run-off
GRAVEL_ZONES = []

def gravel(name, i0, i1, side, lat_in, lat_out):
    """Gravel in (s, lateral) on one side, from lat_in to lat_out, lying on verge/ground."""
    GRAVEL_ZONES.append((i0, i1, side, lat_in, lat_out))
    old_obj = objs.get(name)
    material = old_obj.data.materials[0] if old_obj else mat("GravelTrap")
    idx = [k % N for k in range(i0, i1 + 1)]
    lats = np.linspace(lat_in, lat_out, 7) * side
    verts = []
    for i in idx:
        for la in lats:
            p, _ = new.at(new.s[i], la)
            on_road_plane = abs(la) <= VERGE_OUT
            z = (plane_z(i, la) + VERGE_DZ + 0.01) if on_road_plane else float(ground_below(p[None])[0]) + 0.01
            verts.append((p[0], p[1], z))
    k = len(lats)
    faces = []
    for r in range(len(idx) - 1):
        for c in range(k - 1):
            a = r * k + c
            f = (a, a + 1, a + k + 1, a + k)
            faces.append(f if side < 0 else f[::-1])
    return replace_mesh(name, verts, faces, [material], smooth=False)

hp_zone = [i for i in range(N) if win1[i] and curv[i] > 1 / 60.0]
rh_zone = [i for i in range(N) if win1[i] and curv[i] < -1 / 100.0]
gravel("GravelTrap", min(hp_zone) - 5, max(hp_zone) + 15, 1, ROAD_HALF, 30.0)          # Turn 1: from the road edge
es_mid = [i for i in range(N) if win2[i] and curv[i] < -1 / 70.0 and new.s[i_es0] < new.s[i] < new.s[i_es1]]
gravel("GravelTrap.001", min(es_mid) - 8, max(es_mid) + 8, -1, ROAD_HALF, 28.0)      # outside of the middle ess
# the other trap keeps clear of the road and kerbs
for o in [o for o in objs if o.name.startswith("GravelTrap.002")]:
    V = world_verts(o)
    idx, lat, _ = new.locate(V[:, :2])
    side = np.sign(np.median(lat))
    inside = side * lat < GRAVEL_INNER
    if inside.any():
        V[inside, :2], _ = new.at(new.s[idx[inside]], np.full(inside.sum(), side * GRAVEL_INNER))
    V[:, 2] = surface_z(V[:, :2]) + 0.01
    set_world_verts(o, V)

# ---------------------------------------------------------------- tyre walls
tyre_mat = objs["TyreWall"].data.materials[0] if objs.get("TyreWall") else mat("KerbRed")
for o in [o for o in objs if o.name.startswith("TyreWall")]:
    bpy.data.objects.remove(o, do_unlink=True)
TYRE_LEN, TYRE_STEP, TYRE_DEPTH, TYRE_H = 4.0, 3.6, 1.2, 1.0   # blocks overlap 0.4 m: no gaps

def tyre_run(i0, i1, side, lat_face):
    """Continuous tyre wall on one side, inner face lat_face from the centre."""
    lat_c = side * (lat_face + TYRE_DEPTH / 2)
    ss = np.arange(i0 * L / N, i1 * L / N, 0.5)      # new.at wraps round the lap
    pts, _ = new.at(ss, np.full(len(ss), lat_c))
    arc_len = np.concatenate([[0], np.cumsum(np.linalg.norm(np.diff(pts, axis=0), axis=1))])
    count = 0
    for a in np.arange(0, max(arc_len[-1] - TYRE_LEN, 0) + TYRE_STEP, TYRE_STEP):
        m = min(a + TYRE_LEN / 2, arc_len[-1])
        k = int(np.searchsorted(arc_len, m))
        k = min(max(k, 1), len(pts) - 1)
        p = pts[k]
        head = math.atan2(*(pts[k] - pts[k - 1])[::-1])
        z = float(surface_z(p[None])[0])
        add_box("TyreWall", (p[0], p[1], z + TYRE_H / 2 - 0.05), (TYRE_LEN, TYRE_DEPTH, TYRE_H), head, tyre_mat)
        count += 1
    return count

def corner_span(i_peak, thresh=1 / 200.0):
    sign = np.sign(curv[i_peak])
    a = b = i_peak
    while abs(curv[(a - 1) % N]) > thresh and np.sign(curv[(a - 1) % N]) == sign:
        a -= 1
    while abs(curv[(b + 1) % N]) > thresh and np.sign(curv[(b + 1) % N]) == sign:
        b += 1
    return a, b, int(sign)

WALL_REQUESTS = {}
def outside_wall(i_peak, lat_face=10.4, before=10, after=25):
    """Ask for a wall on the outside of a corner; nearby requests are merged below."""
    a, b, sign = corner_span(i_peak)          # outside of a left is the right (+)
    mask = WALL_REQUESTS.setdefault((sign, lat_face), np.zeros(N, bool))
    for i in range(a - before, b + after + 1):
        mask[i % N] = True

outside_wall(i_hp, lat_face=31.0, before=15, after=20)        # behind the Turn 1 gravel
outside_wall(i_rh)
for i in es_peaks[:3]:
    outside_wall(i, lat_face=(29.0 if curv[i] < 0 else 10.4))
outside_wall(i_d)
outside_wall(i_final, after=15)
tyres = 0
for (sign, lat_face), mask in WALL_REQUESTS.items():
    mask = grow(mask, 8) & ~grow(~grow(mask, 8), 8) | mask     # bridge gaps under ~30 m
    for run in runs_of(mask):
        tyres += tyre_run(run[0], run[0] + len(run) - 1, sign, lat_face)

# ---------------------------------------------------------------- stands
def stand_parts(prefix):
    return [o for o in objs if o.name.startswith(prefix)]

def place_stand(prefix, apex_i, distance):
    """Move a whole grandstand so its centre is `distance` from the corner apex,
    on the outside, facing it."""
    parts = stand_parts(prefix)
    base = objs[prefix + "Base"]
    c_old = np.array(base.matrix_world.translation[:2])
    front_old = np.array(objs[prefix + "Row0"].matrix_world.translation[:2]) - \
        np.array(objs[prefix + "Row5"].matrix_world.translation[:2])
    p, _, right = frame(apex_i)
    out = right * np.sign(curv[apex_i])            # the outside of the corner
    c_new = p + out * distance
    face_new = -out
    rot = math.atan2(face_new[1], face_new[0]) - math.atan2(front_old[1], front_old[0])
    dz = float(surface_z(c_new[None])[0])
    Mx = (Matrix.Translation(Vector((c_new[0], c_new[1], dz))) @ Matrix.Rotation(rot, 4, 'Z')
          @ Matrix.Translation(Vector((-c_old[0], -c_old[1], 0.0))))
    for o in parts:
        o.matrix_world = Mx @ o.matrix_world
    return c_new

def seat_stand(prefix):
    """A stand that stays put sits on the new ground."""
    base = objs[prefix + "Base"]
    c = np.array(base.matrix_world.translation[:2])
    dz = float(surface_z(c[None])[0])
    for o in stand_parts(prefix):
        o.matrix_world = Matrix.Translation(Vector((0, 0, dz))) @ o.matrix_world

sweep_c = place_stand("StandSweep_", i_hp, 44.0)
stadium_c = place_stand("StandStadium_", i_final, 50.0)
seat_stand("StandMain_")
seat_stand("StandEsses_")
bpy.context.view_layer.update()

# ---------------------------------------------------------------- crowds
CLOTHES = [make_mat(f"CrowdShirt{k}", c, 0.8) for k, c in enumerate(
    [(0.75, 0.08, 0.08), (0.08, 0.2, 0.7), (0.9, 0.75, 0.1), (0.95, 0.95, 0.92),
     (0.1, 0.45, 0.2), (0.45, 0.15, 0.55), (0.9, 0.4, 0.05), (0.1, 0.1, 0.12)])]
SKIN = make_mat("CrowdSkin", (0.72, 0.52, 0.38), 0.7)
crowd_count = 0
for prefix in ("StandMain_", "StandSweep_", "StandEsses_", "StandStadium_"):
    mb = MeshBuilder()
    for r in range(6):
        row = objs[prefix + f"Row{r}"]
        mw = row.matrix_world
        bb = [mw @ Vector(c) for c in row.bound_box]
        top = max(v.z for v in bb)
        ax = (mw.to_3x3() @ Vector((1, 0, 0))).normalized()
        length = row.dimensions.x
        heading = math.atan2(ax.y, ax.x)
        centre = sum(bb, Vector()) / 8
        for k in np.arange(-length / 2 + 0.6, length / 2 - 0.6, 0.85):
            if random.random() < 0.15:
                continue
            p = centre + ax * float(k)
            shirt = random.randrange(len(CLOTHES))
            mb.box((p.x, p.y, top + 0.45), (0.45, 0.32, 0.9), heading, shirt)
            mb.box((p.x, p.y, top + 1.05), (0.24, 0.24, 0.26), heading, len(CLOTHES))
            crowd_count += 1
    mb.build(prefix + "Crowd", CLOTHES + [SKIN])

# ---------------------------------------------------------------- brake boards (Turn 1)
BOARD = make_mat("BrakeBoardWhite", (0.92, 0.92, 0.9), 0.5)
BOARD_TEXT = mat("CheckerBlack")
for dist in (300, 200, 100):
    i = ring_at(s_hp_in - dist)
    p, head, right = frame(i)
    q = p + right * 13.0                                        # outside of the straight, 13 m out
    z = float(surface_z(q[None])[0])
    add_box("BrakeBoardPost", (q[0], q[1], z + 1.2), (0.15, 0.15, 2.4), head, mat("Concrete"))
    add_box("BrakeBoard", (q[0], q[1], z + 2.6), (0.1, 1.8, 1.3), head, BOARD)
    curve = bpy.data.curves.new(f"BrakeText{dist}", 'FONT')
    curve.body = str(dist)
    curve.size = 0.8
    curve.align_x = 'CENTER'
    curve.align_y = 'CENTER'
    curve.extrude = 0.01
    tobj = bpy.data.objects.new("tmp", curve)
    bpy.context.scene.collection.objects.link(tobj)
    tobj.rotation_euler = (math.pi / 2, 0, head - math.pi / 2)  # facing the oncoming cars
    front = q - np.array([math.cos(head), math.sin(head)]) * 0.07
    tobj.location = (front[0], front[1], z + 2.6)
    bpy.context.view_layer.update()
    tmesh = bpy.data.meshes.new_from_object(tobj.evaluated_get(bpy.context.evaluated_depsgraph_get()))
    tmesh.materials.clear()
    tmesh.materials.append(BOARD_TEXT)
    text = bpy.data.objects.new(f"BrakeBoardText{dist}", tmesh)
    text.matrix_world = tobj.matrix_world
    bpy.context.scene.collection.objects.link(text)
    bpy.data.objects.remove(tobj, do_unlink=True)

# ---------------------------------------------------------------- flags, banners, screen, lights
TEAM = [make_mat(f"TeamFlag{k}", c, 0.6) for k, c in enumerate(
    [(0.8, 0.05, 0.05), (0.05, 0.25, 0.8), (0.95, 0.75, 0.05), (0.05, 0.55, 0.3),
     (0.95, 0.45, 0.05), (0.55, 0.1, 0.6)])]
for m in ("BannerRed", "BannerBlue", "BannerYellow"):
    glow(mat(m), 1.5)                                            # sponsor boards glow at dusk
BANNER = [mat("BannerRed"), mat("BannerBlue"), mat("BannerYellow")]
fl = MeshBuilder()
for k, s in enumerate(np.arange(60.0, PIT_END - 40.0, 35.0)):
    p, head, right = frame(ring_at(s))
    q = p + right * 14.0
    z = float(surface_z(q[None])[0])
    fl.box((q[0], q[1], z + 3.5), (0.12, 0.12, 7.0), head, len(TEAM))
    f = q + np.array([math.cos(head), math.sin(head)]) * 0.85
    fl.box((f[0], f[1], z + 6.3), (1.6, 0.04, 1.0), head, k % len(TEAM))
fl.build("TeamFlags", TEAM + [mat("Concrete")])
bn = MeshBuilder()
for k, s in enumerate(np.arange(78.0, PIT_END - 40.0, 35.0)):
    p, head, right = frame(ring_at(s))
    q = p + right * 12.5
    z = float(surface_z(q[None])[0])
    bn.box((q[0], q[1], z + 1.1), (10.0, 0.12, 1.4), head, k % 3)
bn.build("TrackBanners", BANNER)

# Big screen facing the main stand, across the pit straight
main_c = np.array(objs["StandMain_Base"].matrix_world.translation[:2])
i_ms = int(np.argmin(np.linalg.norm(new.p - main_c, axis=1)))
p, head, right = frame(i_ms)
side_of_stand = np.sign(np.dot(main_c - p, right))
q = p - right * side_of_stand * 48.0
z = float(surface_z(q[None])[0])
SCREEN = make_mat("BigScreen", (0.35, 0.55, 0.9), 0.3, emit=3.0)
FRAME = make_mat("ScreenFrame", (0.05, 0.05, 0.06), 0.5, 0.6)
add_box("BigScreenFrame", (q[0], q[1], z + 16.0), (19.0, 0.8, 11.0), head, FRAME)
fs = q + right * side_of_stand * 0.45
add_box("BigScreen", (fs[0], fs[1], z + 16.0), (18.0, 0.1, 10.0), head, SCREEN)
for off in (-6.0, 6.0):
    lq = q + np.array([math.cos(head), math.sin(head)]) * off
    add_box("BigScreenLeg", (lq[0], lq[1], z + 5.25), (0.8, 0.8, 10.5), head, FRAME)

# Floodlight towers along the straights (emissive panels, no lamps)
FLOOD = make_mat("FloodlightGlow", (1.0, 0.95, 0.82), 0.3, emit=12.0)
POLE = make_mat("FloodlightPole", (0.35, 0.36, 0.38), 0.4, 0.8)
lights = MeshBuilder()
tower_s = [120.0, 330.0, 540.0,
           new.s[i_crest] - 150.0, new.s[i_crest] + 150.0,
           new.s[i_d] + 150.0, new.s[i_d] + 330.0]
tower_count = 0
for k, s in enumerate(tower_s):
    for side in ((1,) if s < PIT_END else (1, -1)):
        p, head, right = frame(ring_at(s))
        q = p + right * side * 27.0
        z = float(surface_z(q[None])[0])
        lights.box((q[0], q[1], z + 12.0), (0.7, 0.7, 24.0), head, 1)
        facing = head + (0 if side < 0 else math.pi)
        lights.box((q[0], q[1], z + 24.5), (5.0, 0.6, 2.4), head, 1)
        inner = q - right * side * 0.35
        lights.box((inner[0], inner[1], z + 24.5), (4.6, 0.1, 2.0), head, 0)
        tower_count += 1
lights.build("FloodlightTowers", [FLOOD, POLE])

# ---------------------------------------------------------------- the bridge over the crest (B)
BRIDGE = make_mat("BridgeSteel", (0.2, 0.22, 0.25), 0.4, 0.7)
BRIDGE_BANNER = make_mat("BridgeBanner", (0.9, 0.2, 0.1), 0.4, emit=2.5)
p, head, right = frame(i_crest)
deck_bottom = plane_z(i_crest, 0.0) + 7.5
for side in (-1, 1):
    q = p + right * side * 14.0
    z = float(surface_z(q[None])[0])
    add_box("SponsorBridgeLeg", (q[0], q[1], (z + deck_bottom + 1.8) / 2), (1.4, 1.4, deck_bottom + 1.8 - z), head, BRIDGE)
add_box("SponsorBridgeDeck", (p[0], p[1], deck_bottom + 0.9), (3.0, 31.0, 1.8), head, BRIDGE)
for side in (-1, 1):
    b = p - np.array([math.cos(head), math.sin(head)]) * side * 1.55
    add_box("SponsorBridgeBanner", (b[0], b[1], deck_bottom + 0.9), (0.1, 28.0, 1.5), head, BRIDGE_BANNER)

# ---------------------------------------------------------------- clearance
removed = []
for o in list(objs):
    if o.type != 'MESH' or o.name.startswith(FLAT_OK):
        continue
    V = world_verts(o)
    j, lat, _ = new.locate(V[:, :2])
    inside = np.abs(lat) < CLEAR
    if not inside.any():
        continue
    rel = V[inside, 2] - (ROAD_Z + H[j[inside]])
    if rel.min() > 5.0:
        continue                           # overhead: gantry, bridge deck, lamps
    removed.append((o.name, np.array(o.matrix_world.translation[:2])))
    bpy.data.objects.remove(o, do_unlink=True)
# no trees or rocks standing in the gravel
for o in list(objs):
    if o.type != 'MESH' or not o.name.startswith(NATURAL):
        continue
    q = np.array(o.matrix_world.translation[:2])
    j, lat, _ = new.locate(q[None])
    for i0, i1, side, lat_in, lat_out in GRAVEL_ZONES:
        within = (j[0] - i0) % N <= (i1 - i0)
        if within and lat_in - 1.0 <= side * lat[0] <= lat_out + 3.0:
            removed.append((o.name, q))
            bpy.data.objects.remove(o, do_unlink=True)
            break
# the rest of a tree whose trunk or crown was removed
gone = np.array([p for n_, p in removed if n_.startswith(NATURAL)]) if removed else np.zeros((0, 2))
if len(gone):
    for o in list(objs):
        if o.type == 'MESH' and o.name.startswith(NATURAL):
            q = np.array(o.matrix_world.translation[:2])
            if (np.linalg.norm(gone - q, axis=1) < 1.5).any():
                removed.append((o.name, q))
                bpy.data.objects.remove(o, do_unlink=True)

# ---------------------------------------------------------------- report
k = new.curvature()
print("=" * 64)
print(" GRAND PRIX")
print(f" lap                 {L:.0f} m, {N} rings, start ({new.p[0][0]:.1f}, {new.p[0][1]:.1f})")
print(f" Turn 1 hairpin      R{1 / curv[i_hp]:.1f} at {new.s[i_hp]:.0f} m ({new.p[i_hp][0]:.0f}, {new.p[i_hp][1]:.0f}); "
      f"right-hander R{-1 / curv[i_rh]:.1f}")
print(f" esses               " + ", ".join(f"R{1 / curv[i]:+.0f} at {new.s[i]:.0f} m" for i in es_peaks[:3]))
print(f" corner D            R{1 / curv[i_d]:.0f} at {new.s[i_d]:.0f} m; final corner R{1 / curv[i_final]:.1f}")
print(f" crest               {H[i_crest]:.1f} m at {new.s[i_crest]:.0f} m; height {H.min():.1f} to {H.max():.1f} m")
print(f" banking             {bank_deg.min():.1f} to {bank_deg.max():.1f} deg")
print(f" furniture moved     {moved} objects; tyre wall blocks {tyres}; floodlight towers {tower_count}")
print(f" crowd               {crowd_count} spectators")
print(f" removed             {len(removed)} objects from the {CLEAR:.0f} m clearance: "
      + ", ".join(sorted(set(n_.split('.')[0] for n_, _ in removed))))
print("=" * 64)
