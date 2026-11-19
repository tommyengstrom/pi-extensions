import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface Settings {
  size: number;
  thinking: boolean;
}
const settingsPath = () => join(getAgentDir(), "pi-activity-digest.json");
const validSize = (size: unknown): size is number => typeof size === "number" && Number.isSafeInteger(size) && size > 0;
const limit = 64 * 1024;

export function parseChange(args: string): Partial<Settings> {
  const words = args.trim().split(/\s+/u);
  if (words.length === 2) {
    const [key, value] = words;
    if (key === "size" && /^\d+$/u.test(value) && validSize(Number(value))) return { size: Number(value) };
    if (key === "thinking" && (value === "on" || value === "off")) return { thinking: value === "on" };
  }
  throw new Error("Use /digest size <positive integer> or /digest thinking on|off");
}

function validate(value: unknown): Settings {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const { size = 5, thinking = false } = value as Record<string, unknown>;
    if (validSize(size) && typeof thinking === "boolean") return { size, thinking };
  }
  throw new Error("Invalid activity digest settings");
}

function document(path: string): Record<string, unknown> {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error("Cannot open activity digest settings");
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > limit) throw new Error();
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(fd)));
    validate(value);
    return value as Record<string, unknown>;
  } catch {
    throw new Error("Invalid activity digest settings; file left untouched");
  } finally {
    closeSync(fd);
  }
}

export function readSettings(path = settingsPath()): Settings {
  return validate(document(path));
}

export function updateSettings(change: Partial<Settings>, path = settingsPath()): Settings {
  const next = { ...document(path), ...change };
  const settings = validate(next);
  const contents = `${JSON.stringify(next, null, 2)}\n`;
  if (Buffer.byteLength(contents) > limit) throw new Error("Activity digest settings too large");
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, contents, { flag: "wx", mode: 0o600 });
    renameSync(tmp, path);
  } finally {
    rmSync(tmp, { force: true });
  }
  return settings;
}
