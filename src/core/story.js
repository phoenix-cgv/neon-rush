// ---------------------------------------------------------------------
// The story, and every word of it.
//
// One driver, one family garage, and a repair bill they cannot pay. Each
// level is an act: the streets outside the garage, the mountain road that
// is the only way to the circuit, and the Grand Prix whose purse is the
// only prize big enough to settle the debt.
//
// EDITING THIS FILE IS THE WHOLE JOB. Every line the player reads lives
// here. Nothing below is parsed or formatted cleverly: a card is a title
// and some lines, and the lines are shown one under another. Rewrite them
// freely — the game reads whatever is here.
//
// The three purses add up to exactly BILL, so winning all three acts
// settles the debt and nothing else has to. Payouts land ONCE, the first
// time a level is won (see Save "earned"), so replaying a level cannot
// grind the bill down and the number on the title screen always means
// "how far through the story you are".
// ---------------------------------------------------------------------

/** The repair bill, in rand. The three purses below add up to it. */
export const BILL = 12000;

export const INTRO = {
  act: "Neon Rush",
  title: "The Last Invoice",
  lines: [
    "Lefophana & Daughter has fixed this street's cars for thirty years.",
    "Now the lift is broken, the parts are owed for, and the bill is R12 000.",
    "Dad says he'll sell the place. You have a faster idea.",
    "Three races. One purse big enough to end this. Start at home.",
  ],
};

export const CHAPTERS = {
  city: {
    act: "Act I",
    title: "Home Ground",
    purse: 1200,
    // Shown once, before the first run of this level.
    brief: [
      "The streets outside the garage, the ones you learned on.",
      "There's a purse for a clean lap through evening traffic.",
      "It won't pay the bill. It pays the entry to something that will.",
      "Keep off the bumpers and take every orb you see.",
    ],
    // Shown once, the first time this level is won.
    win: [
      "R1 200. Dad counts it twice and says nothing.",
      "The qualifier's across the mountain, and it runs at dusk tomorrow.",
      "One road goes there. It isn't a kind one.",
    ],
  },
  mountain: {
    act: "Act II",
    title: "The Only Road",
    purse: 1800,
    brief: [
      "No rivals up here. Just the pass, the weather and the clock.",
      "Make the summit before the window closes and the grid is yours.",
      "Rock comes off the slopes. Wind takes the viaduct. Fog sits near the top.",
      "Read the signs. They are the only warning you get.",
    ],
    win: [
      "R1 800 for the delivery, and a grid slot with your name spelled wrong.",
      "Below you the circuit is already lit — all that magenta against the dark.",
      "Everything the garage owes comes down to two laps.",
    ],
  },
  grandprix: {
    act: "Act III",
    title: "The Whole Bill",
    purse: 9000,
    brief: [
      "Six cars. Two laps. R9 000 to the winner and nothing to the rest.",
      "Hold a slide and the boost builds; spend it down the straights.",
      "If the car is hurt, the pit lane will mend it. The clock keeps running.",
      "Win it and the garage opens on Monday.",
    ],
    win: [], // the ending below is shown instead
  },
};

export const ENDING = {
  act: "Finish",
  title: "Monday Morning",
  lines: [
    "R12 000. Exactly, to the rand.",
    "The lift works. The invoice is stamped. The roller door goes up at seven.",
    "Dad hands you a coffee and a clipboard, and pretends he never doubted it.",
    "Lefophana & Daughter is still open.",
  ],
};

/** Shown when a level is lost: a nudge, not a new chapter. */
export const RETRY = {
  act: "Not this time",
  title: "Run It Again",
  lines: [
    "No purse. The bill hasn't moved.",
    "Nothing is lost but the afternoon — take it again.",
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

/** The purse for a level, or 0 if it has none. */
export function purseFor(level) {
  return CHAPTERS[level]?.purse ?? 0;
}

/** Everything banked so far, from Save's `earned` map. */
export function totalEarned(earned = {}) {
  return Object.values(earned).reduce((a, b) => a + (b || 0), 0);
}

/** "R1 200" — the one place money is formatted. */
export function money(n) {
  return `R${Math.round(n).toLocaleString("en-ZA").replace(/,/g, " ")}`;
}
