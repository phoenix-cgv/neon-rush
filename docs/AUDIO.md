# Neon Rush audio — how it works

Everything you hear is **made in code** with the browser's Web Audio API.
There are no sound files, so nothing here needs an entry in
`assets/credits.json`. The code is `src/core/audio.js` (the `GameAudio`
class) plus a block of listeners in `src/main.js`.

## The big picture

Think of it as a small mixing desk:

```
 music notes ──► music bus ───────────────┐
 engine, squeal, whoosh ──► sound bus ────┤
 level ambience ──► ambience bus ─► sound bus
 one-shot effects ───────────► sound bus ─┤
                                          ▼
                              master ─► limiter ─► speakers
```

- **Music bus** carries the looping arpeggio. The **Music** toggle turns it off.
- **Sound bus** carries every effect, the engine and the ambience. The
  **Sound** toggle turns it off.
- The **limiter** (a compressor) squashes loud pile-ups, such as a crash
  during a fanfare, so the sound never clips.

Browsers refuse to make sound until the player clicks something. So nothing is
built at start-up: the first click calls `audio.unlock()`, which builds the
mixing desk and starts the always-on voices (engine, squeal, whoosh).

## How a sound gets triggered

The game already has an event bus (`src/core/gameplay-events.js`). Systems say
*what happened* (`emit("checkpoint")`) without knowing about sound. `main.js`
listens and calls the matching `audio.something()`. All listeners are
registered once, at module level, so loading a new level never registers them
twice.

Two things happen every frame instead of via events: `audio.update()` steers
the engine, tyre squeal, whoosh, ambience and music, and `audio.updateOpponent()`
steers each AI car's engine.

Every sound prints a line starting `[audio]` to the browser console. You can
also play any of them yourself from the console: `__dbg.audio.checkpoint()`,
`__dbg.audio.crash(0.8)`, and so on.

## Every sound and what triggers it

| Sound | Trigger | What it is |
|---|---|---|
| Menu click | Dashboard button | Short 660 Hz triangle blip |
| Start light 1–5 | `start-light` (race director lights a lamp) | Short flat square beep, same pitch each time, like F1 |
| GO | `race-started` (lights out) | Higher, longer square tone with a sawtooth fifth |
| Checkpoint | `checkpoint` | Two quick rising triangle pings |
| Checkpoint missed | `checkpoint-missed` | Dull falling sawtooth buzz |
| Lap complete | `lap-complete` | Fast four-note rising arpeggio |
| Wrong way | `wrong-way` | Two harsh low beeps, like an alarm |
| Boost on | `boost-started` | Rising sawtooth sweep, like a turbo |
| Boost off | `boost-stopped` | Falling sweep, quieter |
| Pickup | `pickup-collected` | Sparkly chirp that jumps an octave |
| Win | `race-won` | Short fanfare ending on a held chord |
| Lose | `race-lost` | Slow descending minor figure |
| Crash | `crash`, sized by how hard the hit was | Noise crunch plus a low thud. Harder hit means longer, duller, louder |
| Engine | every frame, from speed | Two detuned saws plus a sub-octave triangle through a lowpass; pitch and brightness rise with speed |
| Tyre squeal | every frame, from `driftFactor` and speed | Looping noise through a bandpass. Needs a real slide, wheels on the ground and some speed |
| Slipstream whoosh | every frame, from the slipstream value | Noise that swells and brightens as you tuck in behind a car |
| Rock landing | `rock-landed` | Deep rumble and thud, louder the closer it lands |
| Rock hit | `rock-hit-car` | Sharp stony crack on top of the normal crash |

Only the **player's** events make sound. The AI cars fire the same
events, and without a filter the Grand Prix would chime constantly.

Scrapes along a wall report lots of tiny hits, so tiny ones are ignored and
crashes are limited to a few per second.

## Design choices per level

**City Track (day).** Calm and bright. A soft traffic hum, a little air, and a
bird chirp every few seconds. The music is the original gentle arpeggio.

**Mountain Track (day, exposed).** The wind *is* the ambience. Its volume and
brightness follow the crosswind gust at your position (`Crosswind.intensityAt`)
and also your speed, so the exposed viaduct howls and the sheltered road
is a low breeze. Falling rocks are the big sound: a rumble when a boulder lands,
scaled by distance, so you hear one before you see where it fell.

**Grand Prix (night race).** More intense on purpose. The music switches to a
lower, faster minor arpeggio with a driving bass pulse. Underneath is a slow,
breathing low drone and a distant crowd swell. Each of the five AI cars has its
own engine voice, louder the closer it is, so a car pulling alongside is heard
before it is seen. Tucking into a car's slipstream adds a whoosh.

On the dashboard and in the pause menu all ambience, the engine and the
squeal fade to silence. Changing level fades the old ambience out while the new
one fades in, then frees the old one.

## Design choices that apply everywhere

- **Nothing is created every frame.** The engine, squeal, whoosh, ambience and
  AI engine voices are built once and only have their volume and pitch nudged.
  One-shot sounds create a few short-lived nodes when they play, which is
  fine.
- **Crash detection does not touch the physics.** The vehicle already
  publishes each hit as `impactSeq` (a counter) and `impactForce` (0 to 1). `Race`
  only watches the counter and emits `crash`. Replays are unaffected.
- **Effects sit above the music.** Measured, effects are several times louder
  than the music, and the worst case of everything at once stays under full scale.

## Adding a sound

1. Add a method to `GameAudio` that calls `this.#play("name", [notes])` for a
   blip-style sound. That handles the Sound toggle, logging and scheduling.
2. If something should trigger it, make that system `emit` an event, then add one
   `gameplayEvents.on(...)` line in `main.js`, next to the others.
3. Run it from the console with `__dbg.audio.yourSound()` to hear it.
