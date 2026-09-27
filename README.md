# ThunderFox — Loudness Normalizer

Is the dialogue too quiet in the movie you're watching? And are the explosions too loud? This extension will even out the audio levels, ensuring a more predictable listening experience. ThunderFox is a lightweight Firefox extension that applies loudness maximization to media elements (audio and video) on web pages. Additionally, a customizable EQ can be applied.

The processing has three stages: an OTT-style multiband compressor, a graphic equaliser and a look-ahead brickwall limiter.

## Features

- Three-band upward **and** downward ("OTT-style") compression in an AudioWorklet, split by a 4th-order Linkwitz-Riley crossover at 120 Hz and 5 kHz (adjustable under Advanced).
- OTT's controls: **Depth**, **Mix**, **Attack**, **Release**, global **Upward**/**Downward**, plus per-band Up, Down and Gain, with OTT's stock preset as the defaults.
- A true look-ahead brickwall limiter in an AudioWorklet: no clipping, no saturation, no waveshaping. Material below the ceiling passes through untouched.
- **Inter-sample peak (true peak) detection** in the limiter, so the output does not overshoot 0 dBFS once a downstream resampler or codec reconstructs it.
- A single Loudness macro that drives multiband depth and limiter drive together.
- 8-band equaliser with shelves at the extremes and a live response curve.
- Global highpass ("Bass cut"), user-toggleable, between the multiband stage and the limiter.
- Input and output level meters.
- A site exemption list, and automatic detection of media ThunderFox cannot safely process.

## Signal chain

```
media element(s)
  -> shared input
  -> pre-boost (0 to +24 dB, user)
  -> OTT worklet: LR4 crossover -> per band { downward + upward comp, makeup, band gain }
  -> highpass (optional)
  -> 8-band EQ (optional)
  -> drive (Loudness macro, 0 to +24 dB)
  -> look-ahead brickwall limiter (AudioWorklet, 5 ms, true-peak)
  -> destination
```

Every media element on the page feeds one shared chain, so two videos playing at once share a master bus rather than each getting its own compressor.

Three properties of this chain matter:

- **All makeup gain is upstream of the limiter.** Nothing adds level after the limiting stage. Loudness is raised by driving the limiter harder, never by amplifying its output.
- **The crossover sums flat.** The three bands reconstruct to within 0.001 dB from 20 Hz to 19 kHz, so there is no empirical band trim anywhere in the code.
- **The limiter is transparent, not a clipper.** It delays the signal and computes the gain envelope from samples that have not played yet, so peaks are handled by a smooth gain curve rather than by reshaping the waveform.

**Depth scales the compression ratios; Mix is a per-band dry/wet blend.** Both are safe against comb filtering because the blend happens *inside* each band, between the band signal and its own gain-scaled self — the two paths are sample-aligned by construction. Do not add a dry path around the whole chain: the limiter's look-ahead delays the wet path, and an undelayed dry sum would comb.

### The crossover

A Linkwitz-Riley 4th-order filter is two cascaded Butterworth sections, and its two halves do not sum to unity — they sum to a second-order allpass:

```
LP_LR4 + HP_LR4 = (s^2 - sqrt2 s + 1) / (s^2 + sqrt2 s + 1)
```

because `(s^2 + 1)^2 - 2 s^2 = s^4 + 1`. Splitting twice therefore leaves the low band one allpass short of the other two. Running the low band through that same allpass makes all three sum to `AP(f1) * AP(f2)` — flat magnitude, no crossover notch. That correction is exact, which is why no band needs a measured trim.

### The compressor core

 Each band and channel runs two asymmetric one-pole envelopes on the *squared* sample — one for the downward stage, one for the upward — with per-band base times (low 2.8/40 ms, mid 1.4/28 ms, high 0.7/15 ms attack/release) that the Attack and Release knobs scale exponentially. The downward envelope is clamped to at least the upper threshold and the upward envelope to at most the lower threshold, so each stage is exactly unity until its threshold is crossed. The gain is a power law of the envelope's distance from threshold, and the combined upward gain is clamped at +30 dB. Channels are **not** linked — left and right compress independently, as in OTT.

Two web-specific behaviours: the band gains (the stock +16.3/+11.7/+16.3 dB makeup) are scaled by Depth, so Depth 0 is a true bypass and the Loudness macro's low end stays gentle; and the upward stage plus the positive band gain fade out between −60 and −80 dBFS on a slow envelope of their own (20 ms up, 400 ms down). Without that fade, a noise floor or the gap between tracks comes up by 30 dB plus makeup.

## The Loudness control

Loudness drives two things at once:

| | 0% | 100% |
| --- | --- | --- |
| Multiband depth | 15% | 100% |
| Limiter drive | +0 dB | +24 dB |

Switching on Advanced hands the Depth control to you; Loudness keeps driving the limiter either way.

## Installation (Developer / Temporary)

1. Open Firefox and go to `about:debugging#/runtime/this-firefox`.
2. Click "Load Temporary Add-on..." and select the `manifest.json` file from this repository.
3. The extension will appear in the toolbar. Use the popup to enable and configure.

## Usage

1. Click the ThunderFox toolbar icon to open the popup.
2. Toggle the main switch to enable processing.
3. Toggle "Bass cut" to insert or remove a 200 Hz highpass after the multiband stage and before the limiter.
4. Adjust "Loudness". It raises multiband depth and limiter drive together, so it adds density rather than peak level.
5. Use the "Equalizer" section for tonal shaping, and "Reset" to flatten it.
6. Switch on "Advanced" for OTT-style and limiter controls (see below).
7. Use "Exempt this site" to make ThunderFox ignore the current site, or "Manage exempt sites" to edit the whole list.

## Site compatibility

ThunderFox only takes over a media element's audio when it can do so safely, and it decides **before** touching the element, because the decision cannot be undone.

- **Cross-origin media without CORS headers is skipped.** `createMediaElementSource()` on such an element produces silence, per spec, and there is no way to hand the element back. Media served from `blob:`, `data:` or the page's own origin is safe, which covers YouTube, Twitch and essentially every adaptive/MSE player.
- **Cross-origin media *with* CORS headers is reloaded in CORS mode and then taken.** The page's own `fetch()` probes the URL first; if that passes, the element gets `crossorigin="anonymous"`, is reloaded, and its position and play state are put back. If the CORS load fails anyway the attribute is cleared and the element reloaded once more, leaving it as the page had it. Reddit's direct MP4s (`v.redd.it`) take this path; Bandcamp's streams (`t4.bcbits.com`) send no CORS headers, which is why `bandcamp.com` is exempted by default and cannot be processed.
- **DRM (EME) content is skipped.** The element is checked for `mediaKeys` and watched for the `encrypted` event from the moment it is discovered.
- **Wiring is deferred until first playback.** At page load `currentSrc` is often empty and `setMediaKeys()` has not been called yet, so neither check above can be made. Waiting for the first `playing` event also means the `AudioContext` is created at a point where the browser will let it start.
- **Media inside shadow DOM and `about:blank`/`srcdoc` frames is discovered**, so players built as web components are covered. `Element.prototype.attachShadow` is hooked in the page's world at `document_start`, because attaching a shadow root produces no mutation record and players like Reddit's attach theirs only once their bundle has loaded. Closed roots are covered too. The hook is removed again on an exempted page.
- **A silence watchdog** compares what the page claims to be playing against what actually reaches the graph. If the page is playing but the audio reads as digital silence for two seconds, the popup says so and points at the exemption, which does restore it.

If a site still misbehaves, exempt it — the popup reloads the tab, which is the only genuine bypass.

## Advanced settings

The Advanced section is off by default. While it is off, the built-in defaults are used; your own values stay in storage and come back when you switch it on again.

| Control | Range | Default | Applies to |
| --- | --- | --- | --- |
| In gain | 0 to +24 dB | 0 dB | Input gain ahead of the crossover |
| Depth | 0-100% | 50% | Scales the compression ratios and band gains, all bands |
| Mix | 0-100% | 100% | Per-band dry/wet blend |
| Upward / Downward | 0-200% | 100% | Global multiplier on each compression direction |
| Attack / Release | 0-100% | 50% | Envelope times, all bands (exponential, ±55x around the base) |
| Crossover | 20 Hz to 18 kHz | 120 Hz / 5 kHz | Both band-split points, two thumbs on one slider |
| Lin. phase | on/off | off | Linear-phase FIR band split (adds latency and CPU) |
| Up / Down | 0-100% | OTT preset | Per-band ratio of each compression direction |
| Gain | ±30 dB | +16.3 / +11.7 / +16.3 dB | Per-band output gain (OTT's makeup), scaled by Depth |
| Attack (limiter) | 0.2-5 ms | 2.5 ms | Limiter gain-envelope smoothing |
| Release (limiter) | 10-1000 ms | 80 ms | Limiter gain recovery |
| Hold | 0-50 ms | 20 ms | Delay before the limiter starts recovering |
| Ceiling | −3 to 0 dB | −0.3 dB | Limiter output ceiling |
| True peak | on/off | on | Inter-sample peak detection |

**Attack and Release** scale each band's base envelope times exponentially: 50% is the base (low 2.8/40 ms, mid 1.4/28 ms, high 0.7/15 ms), the ends are about 55 times faster or slower. Below about −60 dBFS in a band, the upward gain and the positive band gain fade out so silence stays silent; that fade follows its own slow envelope (20 ms up, 400 ms down) so it closes on a genuine pause rather than fluttering on quiet content.

**Up and Down** are the per-band ratios. At 100% Down with full Depth a band is pinned to its upper threshold; smaller values are gentler. The stock preset is 80% Up on every band and 90/85.7/100% Down.

**Attack (limiter)** is the width of the limiter's gain smoothing, not a conventional attack time. A look-ahead limiter has no attack in the usual sense, because the gain is already in position when the peak arrives; what this sets is how gradually it gets there. It is capped at the worklet's 5 ms look-ahead, since the envelope cannot be smoothed over more samples than it can see.

**Release (limiter)** is the time to recover 99% of the gain reduction, not one time constant. Recovery is a single exponential toward unity: a 100 ms release reaches 99% of the way back in about 100 ms, and there is no stage switch to hear.

**Hold** keeps the gain where it is for that long after the envelope last asked for it, and restarts each time it asks again. The 20 ms default covers one half-cycle down to 25 Hz, which is what keeps a driven limiter from modulating bass within the cycle.

**In gain** sits before the crossover, so it drives the compressors harder rather than just making things louder.

**Crossover** is one slider with two thumbs: the left thumb is the low/mid split, the right the mid/high split. The split stays sum-flat wherever they sit, because the three bands always reconstruct to the same allpass pair. The thumbs cannot cross — each stops one step (about 0.1 octave) short of the other, so the mid band never inverts into an overlap remnant — and crossed values from older versions are swapped into order when read.

The time and frequency sliders are logarithmic, because a linear control across three orders of magnitude would bunch every useful value into the first few pixels. Decibels and percentages are linear.

## Site exemptions

- A rule matches the listed domain and all of its subdomains.
- Exempting a page also exempts everything it embeds in an iframe. A frame cannot read its top-level URL cross-origin, so the background page resolves it.
- On an exempted page the content script creates no `AudioContext`, observes no DOM and never touches a media element.
- **Changing an exemption requires a page reload, and the popup toggle performs one for you.** Once `createMediaElementSource()` has been called on a `<video>` or `<audio>` element, that element's audio belongs to the `AudioContext` permanently. Disconnecting only reroutes it; it cannot be handed back to the browser.
- Turning off an exemption that came from a parent domain removes the parent rule, which affects that domain's other subdomains too. The popup says so before you click.

## Tuning guidance

- If output is overly compressed or pumping, lower "Loudness", or raise "Release" under Advanced to slow the bands down.
- If transients sound dulled, lower "Attack"; if they sound spiky, raise the limiter "Attack".
- For less bass movement specifically, lower the low band's "Down" rather than changing anything global.
- For the classic OTT squash, raise "Loudness"; for gentler glue, lower "Depth" or "Mix".

## Troubleshooting

- **No audio at all on one site.** Check the console. ThunderFox logs which elements it skipped and why (`cross-origin`, `drm`), and whether a cross-origin element was reloaded with CORS. If it logs that the page reads as silent, the media is being tainted in a way the pre-check missed — exempt the site.
- **Some videos on a site are processed and others are not.** The ones left alone are usually served cross-origin from a host that sends no CORS headers; the console says so per element.
- **Very quiet output.** Raise "Loudness" first, then "In gain" under Advanced.
- **Distortion.** The limiter applies a gain envelope and nothing else. A little grit on sustained bass is the multiband envelope itself (its ripple is part of the sound; raise "Release" to tame it); anything worse is upstream — back off In gain and Loudness first. The applied compressor gain is smoothed over 0.2 ms, which keeps the envelope's supersonic ripple from folding back as inharmonic alias tones on bright content.
- **Audio and video drift out of sync.** The chain adds about 5.1 ms: the limiter's look-ahead plus 6 samples for the true-peak detector. The multiband stage is IIR and adds none. That is well inside normal lip-sync tolerance.

## Development notes

- **Offline DSP tests: `npm test`** (or `node tests/run.js`, no dependencies). `tests/harness.js` evaluates the two worklet files in a `vm` context with `AudioWorkletProcessor`, `registerProcessor` and `sampleRate` shimmed, so the file the extension ships is what runs. `tests/signals.js` has tone, stepped-tone and impulse generators plus peak, RMS, Goertzel THD and gain-trajectory measurements. The tests check the limiter's ceiling on tones and impulses, that measured latency equals the reported latency, that each Release setting recovers in about that time, distortion on driven bass, OTT flatness at depth 0, the OTT transfer curve (quiet up, loud down, range compressed), that the Attack and Release knobs move the envelope times, and steady-tone distortion per band. Measured values are printed next to each result so tuning changes can be compared.

- **Both worklets or neither.** If either AudioWorklet module fails to load, `buildAudioContext()` closes the context and throws, and the page plays natively. A partially built chain — drive with no limiter behind it — is worse than not processing at all.
- **The limiter has to be an AudioWorklet.** Look-ahead means reading samples before they play, which no built-in node can do. `DynamicsCompressorNode` has no look-ahead so it always overshoots, and a `WaveShaper` bounds the output only by reshaping the waveform, which is distortion by definition.
- The limiter's guarantee is structural, and [content/limiter-processor.js](content/limiter-processor.js) carries the proof in its header comment: the gain applied to any sample is an average of running minima whose windows all contain that sample, so it can never exceed what that sample required. Anything added to the gain path must only ever *lower* the gain.
- `LOOKAHEAD_SECONDS` is fixed on purpose. Changing it while audio is running would resize the delay line and click, so the user-facing timing control adjusts the smoothing width within that window instead. The true-peak history delay is applied whether or not ISP is enabled, for the same reason.
- **Structural worklet parameters must be stepped, not ramped.** `setTargetAtTime` on the limiter's `smoothing` makes it a different integer on nearly every render quantum, and each change rebuilds the boxcar sum on the audio thread. `setParam()` exists for these; `rampParam()` is for everything else.
- **Do not delete entries from `STATE.mediaNodes`.** A `MediaElementAudioSourceNode` binds to its element permanently and cannot be recreated; a second `createMediaElementSource()` on the same element throws. Removal from the DOM disconnects, it does not forget. Dropping the entry is what used to mute an element for good the moment a framework re-rendered it.
- **`MutationObserver` removals are processed before additions.** A remove-then-append in one task produces two records, and handling the addition first leaves the element detached from the graph it was just reconnected to.
- Settings are applied by comparing against the last applied value (`STATE.applied`). The popup both writes storage and messages the tab, so every change arrives twice; without the comparison the second arrival's `cancelScheduledValues` cuts the first ramp short.
- `common/settings.js` holds defaults, ranges and the Loudness morph, and is loaded by the content script and the popup. Before it existed the popup declared its own copy of every range and they drifted — the EQ sliders were ±12 in the markup and ±18 everywhere else.
- **Stored settings carry a schema version.** `SETTINGS_VERSION` in `common/settings.js` is bumped whenever a default changes in a way stored values should follow, with a matching entry in `MIGRATIONS`. The background page runs `migrateStored()` on install and update. A migration moves a value only when it still equals the old default, because a stored value silently overrides `DEFAULTS` and there is no other way to tell "never touched" from "set deliberately".
- The EQ's `Q` is 1.27, matched to the 1.11-octave band spacing (`Q = sqrt(2^BW) / (2^BW - 1)`). At `Q = 1.0` the bands are 26% wider than their spacing and eight sliders at +12 dB give about +15 dB. The highpass `Q` is `1/sqrt(2)`; at 1.0 it puts a +1.25 dB bump just above cutoff, on a control called "Bass cut".
- Switch inputs are hidden with `opacity: 0`, never `display: none`, which would take them out of the tab order and the accessibility tree.
- **Metering is host-side, not worklet-side.** Two `AnalyserNode` taps — one on the shared input, one on the limiter output — are polled from the content script, and only while a popup is connected on the meter port. Posting levels from inside the worklets would put the work on the audio thread and keep doing it for pages nobody is looking at. The analyser window (4096 samples, 85 ms at 48 kHz) is deliberately longer than the 60 ms poll interval so the windows overlap and no peak falls between two reads.
- The popup scrolls past 580 px rather than trying to fit Advanced's twenty-one rows. `.controls` sets `grid-template-columns: minmax(0, 1fr)` because grid items default to `min-width: auto`, which otherwise lets a row's min-content width push the column wider than the popup.

## License

AGPL3