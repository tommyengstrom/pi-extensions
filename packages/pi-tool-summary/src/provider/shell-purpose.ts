// A description of simple shell commands, not a shell interpreter. Only fixed
// vocabulary appears in the local label; this does not shape the provider request.
const subjects = new Map(
  Object.entries({
    html: "HTML",
    json: "JSON",
    css: "CSS",
    api: "API",
    export: "export",
    import: "import",
    auth: "authentication",
    config: "configuration",
    settings: "settings",
    render: "rendering",
    renderer: "renderer",
    renderers: "renderer",
    session: "session",
    test: "test",
    schema: "schema",
  }),
);

function purpose([exe, ...args]: string[]): string | undefined {
  if (exe === "rg" || exe === "grep") {
    // Don't mistake an option's operand (e.g. --glob '*.html') for a pattern.
    let i = 0;
    while (/^-[inFESwH]+$/u.test(args[i] ?? "")) i++;
    if (args[i] === "-e" || args[i] === "--") i++;
    const pattern = args[i];
    const terms: string[] =
      pattern && !pattern.startsWith("-")
        ? (pattern
            .replace(/([a-z])([A-Z])/gu, "$1 $2")
            .toLowerCase()
            .match(/[a-z]+/gu) ?? [])
        : [];
    const topic = [...subjects]
      .filter(([word]) => terms.includes(word))
      .map(([, label]) => label)
      .slice(0, 2)
      .join(" ");
    return topic ? `Locate ${topic} references` : "Search for matching text";
  }
  if (exe === "git") {
    if (args[0] === "diff") return args.includes("--stat") ? "Review git diff stats" : "Inspect git changes";
    if (args[0] === "status") return "Check working tree status";
    if (args[0] === "log") return "Inspect commit history";
  }
  if (exe === "ls") return "List directory entries";
  if (exe === "cat") return "Read file contents";
  if (exe === "find") return "Find matching paths";
  if (["bun", "npm", "pnpm"].includes(exe)) {
    const script = args[0] === "run" ? args[1] : args[0];
    if (script === "test") return "Run tests";
    if (script === "build") return "Build the project";
    if (script === "typecheck") return "Check types";
  }
  return undefined;
}

export function shellPurpose(command: string): string | undefined {
  // Decline complex shell syntax rather than mistaking quoted data, a here-doc
  // or a nested script for a separate command. Never execute or expand tokens.
  if (command.length > 4096 || /[\n\r`$(){}<>#\\]/u.test(command)) return undefined;
  const token = /\s+|&&|\|\||[;|]|'[^']*'|"[^"]*"|[^\s;&|'"`]+/gy;
  const actions = new Map<string, string>();
  let words: string[] = [];
  const finish = () => {
    const action = purpose(words);
    const kind = words[0] === "rg" || words[0] === "grep" ? "search" : action;
    if (action && kind && (!actions.has(kind) || actions.get(kind) === "Search for matching text"))
      actions.set(kind, action);
    words = [];
  };
  while (token.lastIndex < command.length) {
    const match = token.exec(command);
    if (!match) return undefined;
    const value = match[0];
    if (/^\s/u.test(value)) continue;
    if ([";", "|", "&&", "||"].includes(value)) finish();
    else words.push(/^["']/u.test(value) ? value.slice(1, -1) : value);
  }
  finish();
  const [first, second] = actions.values();
  return first && second ? `${first} and ${second[0].toLowerCase()}${second.slice(1)}` : first;
}
