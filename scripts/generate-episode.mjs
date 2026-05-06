#!/usr/bin/env node

import { loadLocalEnv } from "../lib/load-local-env.mjs";
import { generateEpisode } from "../lib/episode-pipeline.mjs";

loadLocalEnv();

const args = parseArgs(process.argv.slice(2));

try {
  const episode = await generateEpisode({
    inputPath: args.input ?? "content/today.md",
    mock: Boolean(args.mock),
  });

  console.log(`Generated episode: ${episode.id}`);
  console.log(`Title: ${episode.title}`);
  console.log(`Audio: ${episode.audioPath}`);
} catch (error) {
  console.error(error?.stack ?? error);
  process.exit(1);
}

function parseArgs(argv) {
  const parsed = {};

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (!current.startsWith("--")) {
      continue;
    }

    const key = current.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      parsed[key] = true;
      continue;
    }

    parsed[key] = next;
    index += 1;
  }

  return parsed;
}
