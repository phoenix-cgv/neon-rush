// ---------------------------------------------------------------------
// The story, and every word of it.
//
// A street-racing story in the genre's own shape: a driver nobody rates,
// three nights to make a name, and one rival at the top of the board to
// take it from. It is ORIGINAL — the beats are genre conventions (prove
// yourself, earn respect, beat the best), not any existing game's plot,
// characters or script. Keep it that way: this is marked work, and
// anything lifted from a published game would have to be credited and
// would read as copied.
//
// EDITING THIS FILE IS THE WHOLE JOB. Every line the player reads lives
// here. Nothing below is parsed or formatted cleverly: a card is a title
// and some lines, shown one under another. Rewrite them freely — the
// game reads whatever is here.
//
// The three rewards add up to exactly TARGET, so winning all three acts
// tops the board and nothing else has to. Reputation lands ONCE, the
// first time a level is won (see Save "earned"), so replaying cannot
// farm it and the number on the title screen always means "how far
// through the story you are".
// ---------------------------------------------------------------------

/** Reputation needed to top the board. The three rewards add up to it. */
export const TARGET = 100;

export const INTRO = {
  act: "Neon Rush",
  title: "Nobody Knows Your Name",
  lines: [
    "This city races after midnight, and every driver out there has a name.",
    "You have a car off the back lot at Phoenix and nothing anyone remembers.",
    "At the top of the board is Sable, who has never once had to learn yours.",
    "Three nights. That is how long you have to make them.",
  ],
};

export const CHAPTERS = {
  city: {
    act: "Act I",
    title: "First Name",
    reward: 15,
    // Shown once, before the first run of this level.
    brief: [
      "Nobody gives a nobody a real race, so you get these streets and the traffic on them.",
      "Beat the clock and the board has to write something down.",
      "It will not be much. It will be yours.",
      "Keep off the bumpers and take every orb you see.",
    ],
    // Shown once, the first time this level is won.
    win: [
      "A time nobody expected, on a road everybody uses.",
      "They still do not know your name. They know there is one.",
      "Word is the old guard run the mountain pass to see who is real.",
    ],
  },
  mountain: {
    act: "Act II",
    title: "The Old Road",
    reward: 25,
    brief: [
      "No rivals up here. The pass has always been raced alone — you against it.",
      "Rock comes off the slopes, wind takes the viaduct, fog sits near the top.",
      "Everyone at the top of that board has a time on this road.",
      "Read the signs. They are the only warning you get.",
    ],
    win: [
      "You come off the pass with a time that belongs near the top of the list.",
      "Now they know your name. Sable sends theirs back, and a place on the grid.",
      "Two laps, under the lights, in front of everybody.",
    ],
  },
  grandprix: {
    act: "Act III",
    title: "The One At The Top",
    reward: 60,
    brief: [
      "Six cars. Two laps. Sable on the grid beside you and the scene watching.",
      "Hold a slide and the boost builds; spend it down the straights.",
      "If the car is hurt, the pit lane will mend it. The clock keeps running.",
      "Finish on the podium and the board is yours to rewrite.",
    ],
    win: [], // the ending below is shown instead
  },
};

export const ENDING = {
  act: "Finish",
  title: "Top Of The Board",
  lines: [
    "Sable finds you in the pit lane, pulls off a glove, and offers a hand.",
    "\"Say it again,\" they tell you. \"Properly this time.\"",
    "So you do, and the whole lane hears it.",
    "Three nights ago nobody knew your name. They all do now.",
  ],
};

/** Shown when a level is lost: a nudge, not a new chapter. */
export const RETRY = {
  act: "Not tonight",
  title: "Run It Again",
  lines: [
    "No time worth writing down. The board has not moved.",
    "Nothing is lost but the night — take it again.",
  ],
};

/**
 * First-time teaching, shown once ever in the HUD's message slot at the
 * moment the thing becomes relevant. `when` is checked every frame in
 * main.js against the player's state; the text is what appears.
 */
export const TUTORIALS = {
  boost: {
    // boostCharge runs 0..CAR.boostCapacity (100), so this is a third of a
    // tank: enough that spending it is worth saying out loud.
    text: "BOOST READY — HOLD SHIFT",
    when: (s, level) => (s.boostCharge ?? 0) > 35 && !level?.pickups?.boostSeconds,
  },
  timeOrb: {
    text: "ORBS BUY YOU TIME — GO AND GET THEM",
    when: (s, level) => !!level?.pickups?.boostSeconds && (s.speed ?? 0) > 8,
  },
  drift: {
    text: "HOLD THE SLIDE — IT FILLS YOUR BOOST",
    when: (s, level) => level?.driftBoost === true && (s.driftFactor ?? 0) > 0.25,
  },
  damage: {
    text: "THE CAR IS HURT — FIND A REPAIR ORB",
    when: (s) => (s.damage ?? 0) > 0.45,
  },
};

/** The reputation a level is worth, or 0 if it has none. */
export function rewardFor(level) {
  return CHAPTERS[level]?.reward ?? 0;
}

/** Everything earned so far, from Save's `earned` map. */
export function totalEarned(earned = {}) {
  return Object.values(earned).reduce((a, b) => a + (b || 0), 0);
}

/** "45" — the one place reputation is formatted. */
export function points(n) {
  return String(Math.round(n));
}
