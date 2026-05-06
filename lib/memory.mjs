import { readFile, appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

async function readTextFile(filePath, fallback) {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      return fallback;
    }
    throw error;
  }
}

async function readJsonFile(filePath, fallback) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

export async function loadMemory(cwd) {
  const [profile, taste, hostBible] = await Promise.all([
    readTextFile(path.join(cwd, "memory", "profile.md"), ""),
    readTextFile(path.join(cwd, "memory", "taste.md"), ""),
    readTextFile(path.join(cwd, "memory", "host-bible.md"), ""),
  ]);

  return { profile, taste, hostBible };
}

export async function loadInterests(cwd) {
  return readJsonFile(path.join(cwd, "memory", "interests.json"), { version: 1, interests: [] });
}

export async function saveInterests({ cwd, interests }) {
  await mkdir(path.join(cwd, "memory"), { recursive: true });
  await writeFile(
    path.join(cwd, "memory", "interests.json"),
    `${JSON.stringify({ version: 1, interests }, null, 2)}\n`,
  );
}

export async function appendTasteSuggestion({ cwd, feedback }) {
  // Deprecated — feedback now only goes to feedback.jsonl.
  // Summarization happens after 5 accumulated entries.
}

const SUMMARY_MARKER = "## 自动总结";
const SUMMARY_STATE_FILE = ".summary-state.json";
const FEEDBACK_THRESHOLD = 5;

export async function readFeedbackCount(cwd) {
  const raw = await readTextFile(path.join(cwd, "memory", "feedback.jsonl"), "");
  return raw.trim().split("\n").filter(Boolean).length;
}

export async function readFeedbackEntries(cwd) {
  const raw = await readTextFile(path.join(cwd, "memory", "feedback.jsonl"), "");
  return raw.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

export function readSummaryState(cwd) {
  return readJsonFile(path.join(cwd, "memory", SUMMARY_STATE_FILE), { summarizedCount: 0 });
}

export async function writeSummaryState(cwd, count) {
  await mkdir(path.join(cwd, "memory"), { recursive: true });
  await writeFile(
    path.join(cwd, "memory", SUMMARY_STATE_FILE),
    `${JSON.stringify({ summarizedCount: count }, null, 2)}\n`,
  );
}

export function shouldSummarize(currentCount, summarizedCount) {
  return currentCount - summarizedCount >= FEEDBACK_THRESHOLD;
}

export async function writeTasteSummary(cwd, summary) {
  const tastePath = path.join(cwd, "memory", "taste.md");
  const current = await readTextFile(tastePath, "");

  const markerIndex = current.indexOf(SUMMARY_MARKER);
  const manualSection = markerIndex >= 0
    ? current.slice(0, markerIndex).trimEnd()
    : current.trimEnd();

  await writeFile(tastePath, `${manualSection}\n\n${SUMMARY_MARKER}\n\n${summary}\n`);
}

export { readTextFile, readJsonFile };
