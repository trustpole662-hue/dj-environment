# DJ TooLai's DJ Environment

A small, no-frills two-deck DJ app for macOS with built-in support for the **Numark DJ2GO2 Touch**.
Intel and Apple Silicon Macs.

## Features

- Two decks: play/pause, CUE (CDJ-style), SYNC (tempo match), 4 hot-cue pads, tempo slider (±16%), BPM detection (with ½ / 2× fix)
- **Filter** per deck: one knob, low-pass to the left, high-pass to the right, centre = off
- 3-band EQ (HI / MID / LOW, LOW-end kill), channel faders + level meters, crossfader, master + headphone level
- Scratch on the jog wheel (touch to hold, turn to scratch); pitch-bend while playing
- Headphone cue (HP button) routed to outputs 3-4 of the DJ2GO2 Touch's sound card
- Track library: drop files/folders in; load with the deck's LOAD button; browse with the controller's BROWSE knob
- Formats: MP3, WAV, AAC/M4A, FLAC, OGG

## Install with one command (Homebrew)

```bash
brew install --cask trustpole662-hue/tap/dj-environment
```
Works on Intel and Apple Silicon. One-time setup and releasing: see [packaging/homebrew/README.md](packaging/homebrew/README.md).

## Getting the installers

You need **two DMGs**: `…-Intel.dmg` and `…-AppleSilicon.dmg`. DMGs can only be built on macOS, so use either:

**A. GitHub Actions (no Mac needed).** Push this folder to a GitHub repo, open the *Actions* tab → *Build macOS installers* → *Run workflow*.
Both DMGs appear as a downloadable artifact (or attached to a Release if you push a tag like `v1.0.0`).

**B. On a Mac.**
```bash
npm install
npm run dist          # both;  or: npm run dist:intel / npm run dist:arm
```
Output is in `output/`:
- `DJ-TooLais-DJ-Environment-1.0.0-Intel.dmg`
- `DJ-TooLais-DJ-Environment-1.0.0-AppleSilicon.dmg`

Which one do I use? Apple menu → *About This Mac*: "Chip: Apple M…" = Apple Silicon, "Processor: Intel…" = Intel.

### First launch (unsigned app)
The app is ad-hoc signed but **not notarized** (that needs a paid Apple Developer account). The first time, right-click the app → **Open** → **Open**.
If macOS says it's damaged: `xattr -cr "/Applications/DJ TooLai's DJ Environment.app"`.

## Using the DJ2GO2 Touch

1. Plug it in. macOS: *System Settings → Sound → Output* → **DJ2GO2 Touch** (gives you master on 1-2 and headphones on 3-4). Then start the app.
2. The app detects the controller and offers to **Map controller**. Press/move each control when asked (about a minute; **Skip** anything you don't need).
   The mapping is saved. Re-run any time from *Map controller*, or fix a single control with *MIDI Learn* (click the on-screen control, then move the hardware one).
3. Settings: *Level knobs control* → **Filter** turns each deck's LEVEL knob into the filter knob (handy on this small controller).

The mapping is learned, not hard-coded, because Numark doesn't publish the DJ2GO2 Touch's MIDI table and I could not verify one; learning works regardless of firmware and also works with other MIDI controllers. LED feedback is not implemented.

Keyboard: `Q`/`P` play · `A`/`L` cue · `Z`/`M` sync · `,` `.` crossfader.

## Notes

- Tracks are decoded into memory (~23 MB per minute of stereo audio), which is what makes scratching instant; very long mixes use a lot of RAM.
- SYNC matches tempo; it does not phase-align beats. Nudge with the jog wheel.
- Library entries are not kept between launches (the sandboxed app window can't see file paths); drop your folder in again.

## Development

```bash
npm install
npm start
```
