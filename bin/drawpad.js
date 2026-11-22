#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
// Node >= 22.18 runs the TypeScript sources directly (type stripping): no build step.
import '../src/cli.ts';
