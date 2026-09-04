import * as THREE from "three";

// ---------------------------------------------------------------------
// Checkpoints, laps, falling and respawn — all of it derived from s.
//
// This is the payoff for the track module. Every rule here is a
// comparison on one number, so none of it needs its own trigger volumes,
// its own collision callbacks, or its own bugs.
// ---------------------------------------------------------------------

export class Progress {
  constructor(
    track,
    {
      requireOrder = true,
      fallDelay = 0.8,
      offTrackLimit = 3,
      stuckLimit = 4,
      progressWindow = 6, // s allowed without advancing
      progressDistance = 18, // m of forward progress that counts as racing
    } = {}
  ) {
    this.track = track;
    this.requireOrder = requireOrder;
    this.fallDelay = fallDelay;
    this.offTrackLimit = offTrackLimit;
    this.stuckLimit = stuckLimit;
    this.progressWindow = progressWindow;
    this.progressDistance = progressDistance;
    this.reset();
  }

  reset() {
    this.lap = 1;
    this.lastCheckpoint = 0;
    this.visited = new Set([0]);
    this.lapTime = 0;
    this.bestLap = this.bestLap ?? null;
    this.lastLapTime = null;
    this.justCompletedLap = false;
    this.falling = 0;
    this.offTrack = 0;
    this.pinnedFor = 0;
    this.noProgress = 0;
    this.sMark = 0;
    this.sMarkAge = 0;
    this.respawns = 0;
    this.justRespawned = false;
    this.justCompletedLap = false;
  }

  /**
   * @returns {null | "respawn"} — the caller does the actual teleport, so
   *          this stays free of physics.
   */
  update(dt, vehicle) {
    this.justRespawned = false;
    this.lapTime += dt;

    const s = vehicle.s;
    const n = this.track.checkpoints.length;
    const idx = this.track.checkpointIndexAt(s);

    // Advancing one checkpoint at a time stops a player skipping half the
    // lap by cutting a corner, and stops a wobble at a boundary counting
    // twice.
    const next = (this.lastCheckpoint + 1) % n;
    if (idx === next) {
      this.lastCheckpoint = next;
      this.visited.add(next);
      if (next === 0 && this.visited.size >= n) {
        this.lap++;
        if (this.bestLap === null || this.lapTime < this.bestLap) {
          this.bestLap = this.lapTime;
        }
        // Published for one frame, because lapTime is about to be reset
        // and the caller has no other way to learn what the lap took.
        // This is what lets a lap be saved and a ghost recording closed.
        this.lastLapTime = this.lapTime;
        this.justCompletedLap = true;
        this.lapTime = 0;
        this.visited.clear();
        this.visited.add(0);
      }
    } else if (!this.requireOrder) {
      this.lastCheckpoint = idx;
    }

    // --- falling ------------------------------------------------------
    // A delay so the fall is visible before the world snaps back. An
    // instant respawn reads as a glitch rather than as a mistake.
    const y = vehicle.body.translation().y;
    if (y < this.track.killPlaneAt(s)) {
      this.falling += dt;
      if (this.falling >= this.fallDelay) {
        this.falling = 0;
        this.respawns++;
        this.justRespawned = true;
        return "respawn";
      }
    } else {
      this.falling = 0;
    }

    // --- off track ----------------------------------------------------
    // A kill plane only catches falling. It does not catch a car that has
    // flown over a barrier and come to rest on the grass, or one wedged
    // against scenery — and a player stranded there has no way back.
    // Being outside the runoff counts fast; crawling around off the road
    // counts slowly, so brushing the grass at speed costs nothing.
    const off = Math.abs(vehicle.lateralOffset);
    const beyondRunoff = off > this.track.runoffHalfWidth;
    const stranded = off > this.track.width * 0.5 + 2 && vehicle.speed < 3;

    // Beached on the chassis counts too: a car resting on its body has no
    // wheels on the ground, so no tyre forces, so no way to drive out of
    // it however long the player holds the throttle.
    const beached = (vehicle.beached ?? 0) > 1.2;

    // Pinned against a barrier: still on the road by lateral offset, all
    // four wheels down, but scraping a wall and going nowhere. None of
    // the tests above catch it, and the player has no way out.
    const pinned = vehicle.scrapingWall && vehicle.speed < 2.5;
    if (pinned) this.pinnedFor = (this.pinnedFor ?? 0) + dt;
    else this.pinnedFor = 0;

    if (beyondRunoff || beached || this.pinnedFor > 2.5) this.offTrack += dt * 3;
    else if (stranded) this.offTrack += dt;
    else this.offTrack = Math.max(0, this.offTrack - dt * 2);

    if (this.offTrack > this.offTrackLimit) {
      this.offTrack = 0;
      this.respawns++;
      this.justRespawned = true;
      return "respawn";
    }

    // --- the backstop -------------------------------------------------
    // Every test above covers one specific way of being stuck, and the
    // car keeps inventing new ones — high-centred on a barrier base with
    // two wheels in the air was none of them: on the road by offset,
    // grounded, not scraping, not beached. Rather than adding a fourth
    // special case, measure the thing that actually matters. If the car
    // has stopped going anywhere, it is stuck, whatever the reason.
    this.noProgress = vehicle.speed < 1.5 ? this.noProgress + dt : 0;
    if (this.noProgress > this.stuckLimit) {
      this.noProgress = 0;
      this.respawns++;
      this.justRespawned = true;
      return "respawn";
    }

    // Standing still is not the only way to stop racing. A car wedged
    // against a barrier facing backwards drives merrily ALONG the wall at
    // 47 km/h and never trips a speed test, while going nowhere useful —
    // and no lateral shove can free it, because tyre grip (up to 16 kN)
    // simply absorbs it. Progress along the track is the honest measure,
    // and it is the only test here that catches driving the wrong way.
    const L = this.track.length;
    let advanced = vehicle.s - this.sMark;
    while (advanced > L / 2) advanced -= L;
    while (advanced < -L / 2) advanced += L;

    if (advanced > this.progressDistance) {
      this.sMark = vehicle.s;
      this.sMarkAge = 0;
    } else {
      this.sMarkAge += dt;
      if (this.sMarkAge > this.progressWindow) {
        this.sMark = vehicle.s;
        this.sMarkAge = 0;
        this.respawns++;
        this.justRespawned = true;
        return "respawn";
      }
    }
    return null;
  }

  /** Call after teleporting the car, so progress is measured from there. */
  markProgressFrom(s) {
    this.sMark = s;
    this.sMarkAge = 0;
    this.noProgress = 0;
    this.offTrack = 0;
    this.pinnedFor = 0;

    // Move the checkpoint with the car.
    //
    // Without this the car is somewhere on the track while lastCheckpoint
    // still says 0, and the next respawn sends it to the START LINE
    // instead of to where it was. It bites hardest on the grid, which is
    // laid out at NEGATIVE s and therefore wraps to s ~ 1239 with the
    // checkpoint still reading 0 — so an incident in the opening seconds
    // teleports the whole field a full lap backwards, onto each other.
    //
    // The advance in update() is deliberately one-at-a-time so a corner
    // cannot be cut; that guard is about DRIVING, and a teleport is not
    // driving. Setting it directly here is the exception the guard needs.
    const idx = this.track.checkpointIndexAt(s);
    this.lastCheckpoint = idx;
    for (let i = 0; i <= idx; i++) this.visited.add(i);
  }

  /** Where a respawn puts you: the last checkpoint, upright, on the line. */
  respawnPose() {
    const cp = this.track.checkpoints[this.lastCheckpoint];
    return this.track.spawnAt(cp.s, 0);
  }
}
