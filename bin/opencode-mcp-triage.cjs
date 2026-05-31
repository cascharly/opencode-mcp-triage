#!/usr/bin/env node
import("./cli.js").catch(e => { console.error(e); process.exit(1); });
