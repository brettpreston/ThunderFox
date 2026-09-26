'use strict';

/**
 * Runs the AudioWorklet processors outside a browser.
 *
 * Each processor file is evaluated in its own vm context with the handful of
 * globals the AudioWorklet scope provides: `AudioWorkletProcessor`,
 * `registerProcessor` and `sampleRate`. Nothing in either processor touches
 * anything else, so the same file the extension ships is what gets tested.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const RENDER_QUANTUM = 128;
const ROOT = path.resolve(__dirname, '..');

function loadProcessor(relativePath, sampleRate) {
    const source = fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
    const registered = {};

    class AudioWorkletProcessor {
        constructor() {
            // Messages the processor posts are kept, so a test can read the
            // latency report the limiter sends from its constructor.
            const posted = [];
            this.port = {
                onmessage: null,
                posted,
                postMessage(message) { posted.push(message); }
            };
        }
    }

    const sandbox = {
        sampleRate,
        AudioWorkletProcessor,
        registerProcessor(name, ctor) { registered[name] = ctor; },
        console
    };
    vm.createContext(sandbox);
    vm.runInContext(source, sandbox, { filename: relativePath });

    const names = Object.keys(registered);
    if (names.length !== 1) throw new Error(`${relativePath} registered ${names.length} processors`);
    const Processor = registered[names[0]];

    const descriptors = Processor.parameterDescriptors;
    const defaults = {};
    descriptors.forEach((d) => { defaults[d.name] = d.defaultValue; });

    return {
        name: names[0],
        sampleRate,
        defaults,
        create() { return new Processor(); },

        /**
         * Push `input` (array of Float32Array channels, equal length) through
         * `processor` and return the output channels. `params` maps parameter
         * names to a number, or to a function of the block's start frame that
         * returns one, so a test can move a control mid-run. `onBlock`, if
         * given, is called with (processor, startFrame) after every quantum.
         * `quantum` overrides the 128-frame render quantum; a test that wants
         * the processor's internal state sample by sample passes 1.
         */
        run(processor, input, params, onBlock, quantum) {
            const step = quantum || RENDER_QUANTUM;
            const channels = input.length;
            const length = input[0].length;
            const output = [];
            for (let c = 0; c < channels; c++) output.push(new Float32Array(length));

            const merged = Object.assign({}, defaults, params || {});
            const paramArrays = {};
            Object.keys(merged).forEach((key) => { paramArrays[key] = new Float32Array(1); });

            for (let start = 0; start < length; start += step) {
                const frames = Math.min(step, length - start);
                const inBlock = input.map((ch) => ch.subarray(start, start + frames));
                const outBlock = output.map((ch) => ch.subarray(start, start + frames));

                Object.keys(merged).forEach((key) => {
                    const value = merged[key];
                    paramArrays[key][0] = typeof value === 'function' ? value(start) : value;
                });

                processor.process([inBlock], [outBlock], paramArrays);
                if (onBlock) onBlock(processor, start);
            }

            return output;
        }
    };
}

module.exports = { loadProcessor, RENDER_QUANTUM };
