# ThunderFox - Loudness Normalizer by 7nihilate

Is the dialogue too quiet in the movie you're watching? Are the explosions too loud? This extension will even out the audio levels, ensuring a more predictable listening experience. ThunderFox is a lightweight Firefox extension that applies loudness maximization to media elements (audio and video) on web pages.

## Features

- Multiband processing (Low / Mid / High) using linear-phase FIR bandpasses when supported, with biquad fallbacks.
- Parallel upward and downward compression inside each band to both raise low-level content and control peaks.
- Global highpass filter (user-toggleable) placed after band summing and before the limiter to remove  sub-bass frequencies if desired.
- Final limiter with threshold control and automatic gain compensation so lowering the threshold increases output gain to approach 0 dB peaks.
- Persistent controls in the popup: enable/disable processing, toggle highpass, and adjust limiter threshold.

## Installation (Developer / Temporary)

1. Open Firefox and go to `about:debugging#/runtime/this-firefox`.
2. Click "Load Temporary Add-on..." and select the `manifest.json` file from this repository.
3. The extension will appear in the toolbar. Use the popup to enable and configure.

## Usage

1. Click the ThunderFox toolbar icon to open the popup.
2. Toggle the main switch to enable processing for the active tab.
3. Toggle "Highpass (100 Hz) On" to insert/remove a 100 Hz (approx.) highpass filter after the multiband summing stage but before the limiter.
4. Adjust the "Limiter Threshold" slider to set the limiter threshold in dB. Lowering the threshold causes the internal gain compensation to increase so peaks are pushed toward 0 dB (maximizing loudness).

Notes:
- The popup persists settings to `browser.storage.local` and messages the content script to apply changes in the active tab.

## Tuning guidance

- If output is overly compressed or pumping, raise the limiter threshold (closer to 0 dB) or reduce per-band makeup values.
- If you want a steeper highpass slope, the code can be updated to cascade multiple biquad highpass stages or to use longer FIR filters (at the cost of latency).

## Troubleshooting

- No audio output from the extension:
  - Ensure the extension is enabled in the popup and that the tab is active.
  - Check the web console for errors from the content script.

- Very quiet output:
  - Check `masterGain` / pre-gain values in `content/content.js` (the extension applies pre-gains and per-band makeup gains which affect how hard the limiter engages).
  - Verify the limiter threshold in the popup; if threshold is too high the limiter won't boost.

- Distortion or clipping:
  - Reduce makeup gains or master gain, or raise the limiter threshold. Hard clipping isn't used by default to avoid audible distortion.

## Development notes

- The code favors linear-phase FIR filters for band splitting to avoid phase artifacts between bands. Those are created via `generateFIRFilter` and applied with `ConvolverNode` for minimal phase distortion.

## License

AGPL3

## Limks
https://brettpreston.github.io
https://github.com/brettpreston
