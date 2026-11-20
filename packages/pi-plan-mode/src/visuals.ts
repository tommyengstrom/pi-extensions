import { createHash, randomUUID } from "node:crypto";
import { constants, linkSync, lstatSync, mkdirSync, realpathSync, unlinkSync } from "node:fs";
import { open } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, normalize, sep } from "node:path";
import { resizeImage } from "@earendil-works/pi-coding-agent";
import { getImageDimensions, Marked } from "@earendil-works/pi-tui";
import type { PlanArtifacts } from "./artifacts.js";

const MAX_BYTES = 20 * 1024 * 1024;
const MAX_PIXELS = 16_777_216;
const VISUAL_NAME = /^(before|after)(?:-[1-9]\d{0,4})?\.(?:png|jpg)$/;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const IEND = Buffer.from("0000000049454e44ae426082", "hex");

/** Derive authority from the store directory, never from a saved absolute path. */
export function visualWorkspace(storeDirectory: string, artifacts?: PlanArtifacts) {
  const ws = artifacts?.workspace;
  if (!ws || !UUID.test(ws.id)) return undefined;
  const expected = join(storeDirectory, "artifacts", ws.id);
  return expected === ws.directory ? expected : undefined;
}

export type VisualHashes = Record<string, string>;
export function visualGuidance(pins?: VisualHashes) {
  return pins
    ? `\nApproved image SHA-256 fingerprints (filenames in the plan's visuals directory): ${JSON.stringify(pins)}. Verify before using an image. If bytes differ or an image is missing, stop and ask to restore it or review a new plan revision.`
    : "";
}
export function validVisualHashes(value: unknown): value is VisualHashes {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.entries(value).every(
      ([name, hash]) => VISUAL_NAME.test(name) && typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash),
    )
  );
}

/** Only direct targets in this plan's visual directory are actionable. The label is not authority. */
export function visualLinks(markdown: string, workspace: string) {
  const links = new Map<string, { filename: string; relative: string; label: string }>();
  const prefix = `artifacts/${basename(workspace)}/visuals/`;
  if (!markdown.includes(prefix)) return [];
  const parser = new Marked();
  parser.walkTokens(parser.lexer(markdown), (token) => {
    if ((token.type !== "link" && token.type !== "image") || !token.href.startsWith(prefix)) return;
    const filename = token.href.slice(prefix.length);
    const match = VISUAL_NAME.exec(filename);
    const relative = prefix + filename;
    if (!match) return;
    links.set(filename, {
      filename,
      relative,
      label: `${match[1] === "before" ? "Current — screenshot" : "Proposed — mockup"}: ${filename}`,
    });
  });
  return [...links.values()];
}

function assertCanonical(path: string) {
  if (
    !isAbsolute(path) ||
    (process.platform === "win32" && !/^[A-Za-z]:\\/.test(path)) ||
    path.split(sep).includes("..") ||
    normalize(path) !== path ||
    realpathSync.native(path) !== path
  )
    throw new Error("Use a canonical absolute local path without symlinks or traversal.");
}

function visualDirectory(workspace: string, create: boolean) {
  const artifacts = dirname(workspace);
  assertCanonical(dirname(artifacts));
  if (basename(artifacts) !== "artifacts" || !UUID.test(basename(workspace)))
    throw new Error("Invalid visual workspace.");
  const directory = join(workspace, "visuals");
  for (const path of [artifacts, workspace, directory]) {
    if (create) {
      try {
        mkdirSync(path, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    if (!lstatSync(path).isDirectory()) throw new Error("Visual directories must be real directories, not symlinks.");
  }
  return directory;
}

async function readBoundedFile(path: string) {
  assertCanonical(path);
  if (!lstatSync(path).isFile()) throw new Error("Choose a regular PNG or JPEG file.");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || !stat.size || stat.size > MAX_BYTES)
      throw new Error("Choose a regular image of at most 20 MiB.");
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) throw new Error("Image changed while being read.");
      offset += bytesRead;
    }
    return { bytes, stat };
  } finally {
    await file.close();
  }
}

function rasterExtension(bytes: Buffer) {
  if (bytes.subarray(0, PNG.length).equals(PNG) && bytes.subarray(-IEND.length).equals(IEND)) return "png";
  if (bytes.length >= 5 && bytes.readUIntBE(0, 3) === 0xffd8ff && bytes.readUInt16BE(bytes.length - 2) === 0xffd9)
    return "jpg";
  throw new Error("Expected a complete PNG or JPEG image.");
}

function checkIdentity(path: string, stat: Awaited<ReturnType<typeof readBoundedFile>>["stat"]) {
  assertCanonical(path);
  const now = lstatSync(path);
  if (now.dev !== stat.dev || now.ino !== stat.ino || now.ctimeMs !== stat.ctimeMs || now.size !== stat.size)
    throw new Error("Image changed during validation.");
}

// Only cache successful decoder results, never path checks, file bytes, or approval decisions.
const decoded = new Set<string>();
async function readRaster(path: string, expected?: string) {
  const { bytes, stat } = await readBoundedFile(path);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (expected !== undefined && sha256 !== expected)
    throw new Error(
      `Plan image ${basename(path)} changed. Restore the original or import a new revision and review again.`,
    );
  const extension = rasterExtension(bytes);
  if (!decoded.has(sha256)) {
    await validateRaster(bytes, extension);
    if (decoded.size >= 64) decoded.clear();
    decoded.add(sha256);
  }
  checkIdentity(path, stat);
  return { bytes, extension, sha256 };
}

async function validateRaster(bytes: Buffer, extension: "png" | "jpg") {
  const mime = extension === "png" ? "image/png" : "image/jpeg";
  const size = getImageDimensions(bytes.toString("base64"), mime);
  if (!size || size.widthPx < 1 || size.heightPx < 1 || size.widthPx * size.heightPx > MAX_PIXELS)
    throw new Error("Invalid image dimensions or image exceeds 16 megapixels.");
  // Pi decodes on a worker. These limits request validation without resizing or changing the original bytes.
  if (!(await resizeImage(bytes, mime, { maxWidth: MAX_PIXELS, maxHeight: MAX_PIXELS, maxBytes: MAX_BYTES * 2 })))
    throw new Error("Pi could not decode this image. Supply a valid PNG or JPEG.");
}

export async function importVisual(workspace: string, role: unknown, source: unknown, isCurrent: () => boolean) {
  if ((role !== "before" && role !== "after") || typeof source !== "string" || source.length > 4096)
    throw new Error("Expected a before/after role and a local image path.");
  const check = () => {
    if (!isCurrent()) throw new Error("Visual import cancelled: the UI plan changed.");
  };
  check();
  const { bytes, extension } = await readRaster(source);
  check();
  const dir = visualDirectory(workspace, true);
  const identity = lstatSync(dir);
  const sameDirectory = () => {
    const now = lstatSync(visualDirectory(workspace, false));
    if (now.dev !== identity.dev || now.ino !== identity.ino)
      throw new Error("Visual directory changed during import.");
  };
  const tmp = join(dir, `.import-${randomUUID()}.tmp`);
  const file = await open(tmp, "wx", 0o600);
  try {
    try {
      check();
      sameDirectory();
      await file.writeFile(bytes);
    } finally {
      await file.close();
    }
    check();
    sameDirectory();
    for (let i = 1; i <= 10_000; i++) {
      const filename = `${role}${i === 1 ? "" : `-${i}`}.${extension}`;
      try {
        linkSync(tmp, join(dir, filename));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
        throw error;
      }
      return `[${filename}](artifacts/${basename(workspace)}/visuals/${filename})`;
    }
    throw new Error("Visual filename limit reached.");
  } finally {
    sameDirectory();
    unlinkSync(tmp);
  }
}

function visualFile(workspace: string, filename: string) {
  if (!VISUAL_NAME.test(filename)) throw new Error("Invalid visual filename.");
  const path = join(visualDirectory(workspace, false), filename);
  assertCanonical(path);
  if (!lstatSync(path).isFile()) throw new Error("Visual target must be a regular file.");
  return path;
}

async function checkedVisual(workspace: string, filename: string, expected: string | undefined, captureNew: boolean) {
  if (!expected && !captureNew) throw new Error(`No fingerprint for ${filename}. Re-save the UI plan and review it.`);
  const path = visualFile(workspace, filename);
  const { extension, sha256 } = await readRaster(path, expected);
  if (!filename.endsWith(`.${extension}`)) throw new Error("Image format does not match its filename.");
  return { path, sha256 };
}

export async function resolveVisual(workspace: string, filename: string, expected: string | undefined) {
  return (await checkedVisual(workspace, filename, expected, false)).path;
}

/** Only planning may pin a new link. Never silently re-pin an existing filename to new bytes. */
export async function checkPlanVisuals(
  plan: string,
  directory: string,
  artifacts: PlanArtifacts | undefined,
  pins?: VisualHashes,
  captureNew = false,
): Promise<VisualHashes | undefined> {
  if (!artifacts) return;
  const workspace = visualWorkspace(directory, artifacts);
  const links = visualLinks(plan, join(directory, "artifacts", artifacts.workspace.id));
  if (!captureNew && pins && links.length !== Object.keys(pins).length)
    throw new Error("The plan's set of images changed. Re-save the revised plan in planning mode and review it.");
  if (!links.length) return;
  if (!workspace) throw new Error("Invalid plan visual workspace.");
  const hashes: VisualHashes = {};
  for (const { filename } of links) {
    try {
      hashes[filename] = (await checkedVisual(workspace, filename, pins?.[filename], captureNew)).sha256;
    } catch (cause) {
      throw new Error(
        `Invalid or broken visual link to ${filename}. ${cause instanceof Error ? cause.message : "Restore the image or import a new revision."}`,
        { cause },
      );
    }
  }
  return hashes;
}
