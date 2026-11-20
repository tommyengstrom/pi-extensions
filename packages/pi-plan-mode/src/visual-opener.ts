import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

function desktopOpener() {
  if (process.platform === "darwin") return "/usr/bin/open";
  if (process.platform === "win32") {
    const root = process.env.SystemRoot;
    if (!root || !isAbsolute(root)) throw new Error("Windows system directory unavailable.");
    return join(root, "System32", "rundll32.exe");
  }
  const opener = ["/usr/bin/xdg-open", "/run/current-system/sw/bin/xdg-open"].find(existsSync);
  if (!opener) throw new Error("Install xdg-utils to open images on this desktop.");
  return opener;
}

/** Called only after an explicit TUI preview. Never execute a command from the plan. */
export function openVisual(path: string, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  if (process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY)
    throw new Error("No local desktop display available.");
  const windows = process.platform === "win32";
  const command = desktopOpener();
  return new Promise((resolve, reject) => {
    const child = spawn(command, windows ? ["url.dll,FileProtocolHandler", path] : [path], {
      cwd: dirname(command),
      stdio: "ignore",
      detached: true,
      shell: false,
      windowsHide: true,
    });
    // Some openers wait for the viewer. Stop observing it on dismissal, without closing the user's viewer.
    const dismiss = () => resolve();
    signal.addEventListener("abort", dismiss, { once: true });
    child.once("error", (error) => {
      signal.removeEventListener("abort", dismiss);
      reject(error);
    });
    child.once("exit", (code) => {
      signal.removeEventListener("abort", dismiss);
      if (code === 0) resolve();
      else reject(new Error(`${command} did not open the image`));
    });
    child.unref(); // The user's viewer may stay open after review or Pi exits.
  });
}
