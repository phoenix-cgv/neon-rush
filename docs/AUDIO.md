# Neon Rush audio — how it works

Everything you hear is **made in code** with the browser's Web Audio API.
There are no sound files, so nothing here needs an entry in
`assets/credits.json`. The code is `src/core/audio.js` (the `GameAudio`
class) plus a block of listeners in `src/main.js`.

## The big picture

Think of it as a small mixing desk:

```
 title theme ──► title bus ─┐
 race music ───► race bus ──┴─► music bus ───────────┐
 engine, squeal, whoosh, rumble ──► sound bus ───────┤
 level ambience ──► ambience bus ─► sound bus        │
 one-shot effects ───────────────► sound bus ────────┤
 sound bus ─► tunnel echo (only in the tunnel) ──────┤
 sound bus, music bus ─► reverb ─────────────────────┤
                                                     ▼
                       master ─► pause muffle ─► limiter ─► speakers
```

- **Music bus** carries the music. It has two sub-buses, one for the title
  theme and one for the race music, so they can cross-fade. The **Music**
  toggle turns it off.
- **Sound bus** carries every effect, the engine and the ambience. The
  **Sound** toggle turns it off.
- The **pause muffle** is a lowpass filter. It is wide open normally and closes
  to 380 Hz while the pause menu is open, so everything sounds muffled, like
  underwater, instead of cutting out.
- The **reverb** is one room shared by everything. Both buses send a little
  into it, so the Sound and Music toggles still silence it. Without it every
  sound sat flat against the speaker. Its tail is generated, not loaded —
  noise that fades out, which is what a room's tail is — so there is still
  no audio file anywhere. How much each level sends is set in `setLevel`:
  the mountain is open air, the city is a street with close walls.
- The **limiter** (a compressor) squashes loud pile-ups, such as a crash
  during a fanfare, so the sound never clips. It is deliberately gentle and
  a little slow, so the crack at the front of a kick or a crash gets
  through rather than being flattened.

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
also play any of them yourself from the console: `__dbg.audio.lapComplete()`,
`__dbg.audio.crash(0.8)`, and so on.

## Every sound and what triggers it

| Sound | Trigger | What it is |
|---|---|---|
| Button hover | Pointer moves onto any dashboard or pause-menu button | Tiny, quiet high tick |
| Button click | Any button press (and Enter on the dashboard) | Short 660 Hz triangle blip |
| Button back | Back and Resume buttons | Two falling notes |
| Start light 1–5 | `start-light` (race director lights a lamp) | Short flat square beep, same pitch each time, like F1 |
| GO | `race-started` (lights out) | Higher, longer square tone with a sawtooth fifth |
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
| Tyre squeal | every frame, from `driftFactor`, speed and slide direction | Layered, see "The drift squeal" below |
| Squeal chirp | The moment a drift starts | A short sawtooth bark that jumps upward |
| Engine rev | `race-started` (lights out) | The motor winds up hard and settles back, 1.3 s |
| Drift tier-up | `gameplayHud.onTierUp` | A rising major arpeggio. Each tier adds a note and starts higher |
| Boost full | The boost meter reaching full (on the way up only) | A bright bell-like ding |
| Landing | Wheels back on the ground after more than 0.3 s in the air | Low thud, heavier the longer you were up |
| Low-health beep | Damage at 70% or more | A double beep that repeats faster as damage gets worse |
| Respawn | `respawn` (the race puts your car back on the road) | A rising whoosh with a soft shimmer |
| Near miss | `near-miss` (a traffic car passes you close and fast) | A quick falling whoosh, louder the closer and faster |
| Crowd cheer | `car-finished`, you, on the Grand Prix only | Swelling crowd noise, scattered claps and two whoops. Smaller if you did not win |
| Grass rumble | Grand Prix, tyres on grass or gravel | Low chattering rumble, louder with speed and with more tyres off the road |
| Tunnel echo | Mountain, inside the tunnel | Adds a repeating echo to everything on the sound bus |
| New best lap | `new-best-lap` (a lap beats your saved best) | A bright two-step fanfare with a sparkle, just after the lap-complete arpeggio |
| Title theme | The home screen | Calm, slow triangle arpeggio over a low pad. Cross-fades into the race music on PULL OFF |
| Slipstream whoosh | every frame, from the slipstream value | Noise that swells and brightens as you tuck in behind a car |
| Rock landing | `rock-landed` | Deep rumble and thud, louder the closer it lands |
| Rock hit | `rock-hit-car` | Sharp stony crack on top of the normal crash |
| Result announcement | `car-finished`, you, Grand Prix only | A **spoken** line reading your finishing place back, and "mission accomplished" on the podium |

Passing a checkpoint makes no sound on purpose: it fires 19 times a lap on the
Grand Prix, and a ping that often nags rather than informs. Missing one still
sounds.

Only the **player's** events make sound. The AI cars fire the same
events, and without a filter the Grand Prix would chime constantly.

Scrapes along a wall report lots of tiny hits, so tiny ones are ignored and
crashes are limited to a few per second.

## The music

Synthwave, because that is what a neon street racer wants. Each track is a
**chord progression, one chord a bar**, played on a 16-step grid:

| | Grand Prix (`night`) | City (`day`) | Title |
|---|---|---|---|
| Tempo | 128 bpm | 112 bpm | 84 bpm |
| Chords | Am – F – C – G | C – G – Am – F | Am – F – C – G |
| Kit | kick on every beat, claps on 2 and 4, hats off the beat | kick on 1 and 3, lighter | none |
| Loop | ~15 s | ~17 s | ~23 s |

The progression runs **twice** before anything repeats, the second time with
the arpeggio an octave up, so the loop is eight bars. (It used to be eight
notes on a square wave — a 1.1-second loop on the Grand Prix.)

Every instrument is built from layers rather than one oscillator:

- **Kick** a sine dropped hard in pitch.
- **Clap / hats** short bursts of noise, each taking a different slice of the
  noise buffer so no two are identical.
- **Bass** two sawtooths a few cents apart through a resonant lowpass that
  closes as the note decays — the detuning gives it weight, the closing
  filter makes it move.
- **Arpeggio** the same idea higher up, alternating left and right.
- **Pad** the chord held under everything, spread across the stereo field and
  slow to arrive.

To change a track, edit `MUSIC` at the top of `audio.js`: the chords, the
tempo, and the one-bar drum rows are all plain arrays.

## The announcer

The result of the Grand Prix is read out loud by the browser's own speech
synthesis (`audio.say`), not by Web Audio. That means it does not pass
through the buses, the reverb, the pause muffle or the limiter, so the
Sound toggle is honoured by hand in `say()`. No voice ships with the
game and there is no audio file, so there is nothing to credit.

A browser with no voices installed simply stays quiet. Every line spoken
is also on the results board, so silence costs the player nothing. Voices
load asynchronously, which is why `getVoices()` can be empty for the
first second of a page's life — by the time a race finishes it is not.

## The drift squeal

The squeal is built from four layers, so it sounds like rubber and not like a
hiss:

1. **Tonal screech.** Three detuned sawtooth oscillators around 450 to 900 Hz plus a triangle an octave down for body
   through a bandpass filter. This is the sound you recognise as a squeal.
2. **Wobble.** Two slow oscillators (5 to 12 Hz, re-aimed at random rates every
   fraction of a second) bend the pitch and the volume, so it sounds like the
   tyre gripping and slipping.
3. **Grit.** A quiet layer of bandpass noise underneath.
4. **Stereo.** It is panned to the side the car is sliding toward.

The volume follows `driftFactor` and speed, and the pitch rises the more
sideways the car is. The voices run all the time and only their volume moves, so
it fades smoothly in and out and never clicks. A short chirp marks the start of a
drift. To hear it without driving, run `__dbg.audio.testDrift(0.7)` in the
console (the number is how hard the drift is, 0 to 1). It plays for 3 seconds
and pans left and then right.

## Design choices per level

**City Track (day).** Calm and bright. A soft traffic hum, a little air, and a
bird chirp every few seconds. Oncoming and passing traffic whooshes by when it
misses you narrowly.

**Mountain Track (day, exposed).** Inside the tunnel everything gets an echo, so
the engine and effects sound like they are in a concrete tube. The wind *is* the ambience. Its volume and
brightness follow the crosswind gust at your position (`Crosswind.intensityAt`)
and also your speed, so the exposed viaduct howls and the sheltered road
is a low breeze. Falling rocks are the big sound: a rumble when a boulder lands,
scaled by distance, so you hear one before you see where it fell.

**Grand Prix (night race).** More intense on purpose. The music switches to a
faster, harder cut of the same kit (see "The music"). Underneath is a slow,
breathing low drone and a distant crowd swell. Each of the five AI cars has its
own engine voice, louder the closer it is, so a car pulling alongside is heard
before it is seen. Tucking into a car's slipstream adds a whoosh. Driving onto the grass or gravel adds a low rumble, and crossing the line gives a crowd cheer.

On the dashboard the ambience, engine and squeal fade to silence and only the
title theme plays. In the pause menu everything keeps playing but muffled. Changing level fades the old ambience out while the new
one fades in, then frees the old one.

## Design choices that apply everywhere

- **Every effect is two voices, not one.** A single oscillator with a volume
  envelope is a beep. The effects helper plays two of them a few cents apart
  through a lowpass that closes as the sound decays, panned slightly, with a
  touch of random pitch on every trigger so repeats are never identical.
- **Nothing is created every frame.** The engine, squeal, whoosh, ambience and
  AI engine voices are built once and only have their volume and pitch nudged.
  One-shot sounds create a few short-lived nodes when they play, which is
  fine.
- **Crash detection does not touch the physics.** The vehicle already
  publishes each hit as `impactSeq` (a counter) and `impactForce` (0 to 1). `Race`
  only watches the counter and emits `crash`. Replays are unaffected.
- **Everything sits behind the toggles.** Sound and Music each have their own bus,
  so a toggle silences everything on it, including the new ambience, rumble and echo.
- **Effects sit above the music.** Measured, effects are several times louder
  than the music, and the worst case of everything at once stays under full scale.

## Adding a sound

1. Add a method to `GameAudio` that calls `this.#play("name", [notes])` for a
   blip-style sound. That handles the Sound toggle, logging and scheduling.
2. If something should trigger it, make that system `emit` an event, then add one
   `gameplayEvents.on(...)` line in `main.js`, next to the others.
3. Run it from the console with `__dbg.audio.yourSound()` to hear it.
