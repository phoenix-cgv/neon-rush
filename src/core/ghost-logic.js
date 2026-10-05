// The decisions behind the ghost's autopilot, free of three.js and Rapier
// so they can be unit-tested. See ghost.js.

/** Signed shortest distance from s0 to s1 around a closed track of length L. */
export function wrapDelta(s0, s1, L) {
  let d = s1 - s0;
  d = ((d % L) + L) % L;
  return d > L / 2 ? d - L : d;
}

/**
 * How far a recorded lap runs: from where the recording starts to where it
 * ended, going forward round the track. A lap recorded from the grid is one
 * full length; one that began mid-track on lap 2+ is just under that.
 */
export function lapDistance(startS, endS, L) {
  const d = (((endS - startS) % L) + L) % L;
  return d < L * 0.05 ? d + L : d; // never read a full lap as zero
}

/**
 * Should the ghost stop replaying and drive itself home?
 *  - it has stalled: barely moving for a while although the recording says
 *    it should be on the throttle (crashed, and the replay cannot help)
 *  - the recording has run out before the finish line
 */
export function shouldAutopilot({ stalledFor, replayDone, travelled, total }) {
  if (travelled >= total - 2) return false; // already home
  return stalledFor > 2 || replayDone;
}
