import type { ExtensionUIContext, KeybindingsManager } from "@earendil-works/pi-coding-agent";
import {
  Editor,
  type EditorComponent,
  type EditorTheme,
  type Focusable,
  isFocusable,
  Key,
  matchesKey,
  type TUI,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";

type EditorFactory = NonNullable<ReturnType<ExtensionUIContext["getEditorComponent"]>>;
const BRACKETED_PASTE_START = "\u001b[200~";
const BRACKETED_PASTE_END = "\u001b[201~";

export class RawPreservingEditor implements Focusable {
  private readonly editor: EditorComponent & { dispose?(): void };
  private readonly rawByMarker = new Map<string, string>();
  private markerCodePoint = 0xe000;
  private pasteBuffer: string | undefined;
  private inputDraft: string | undefined;
  private readonly preserveDraft: boolean;

  constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager, factory?: EditorFactory) {
    this.preserveDraft = !factory;
    this.editor = factory ? factory(tui, theme, keybindings) : new Editor(tui, theme, { paddingX: 0 });
  }

  get wantsKeyRelease(): boolean | undefined {
    return this.editor.wantsKeyRelease;
  }

  get isPasting(): boolean {
    return this.pasteBuffer !== undefined;
  }

  get focused(): boolean {
    return isFocusable(this.editor) && this.editor.focused;
  }

  set focused(value: boolean) {
    if (isFocusable(this.editor)) this.editor.focused = value;
  }

  dispose(): void {
    this.focused = false;
    this.editor.onChange = undefined;
    this.editor.onSubmit = undefined;
    this.pasteBuffer = undefined;
    this.rawByMarker.clear();
    this.editor.dispose?.();
  }

  set onChange(handler: ((value: string) => void) | undefined) {
    this.editor.onChange = handler ? () => handler(this.getExpandedText()) : undefined;
  }

  set onSubmit(handler: ((value: string) => void) | undefined) {
    this.editor.onSubmit = handler
      ? (value) => {
          // Only the questionnaire's default Editor needs trim/clear compensation.
          // A custom editor's onSubmit value is authoritative, even when it equals draft.trim().
          handler(
            this.decode(this.inputDraft !== undefined && value === this.inputDraft.trim() ? this.inputDraft : value),
          );
        }
      : undefined;
  }

  handleInput(data: string): void {
    if (this.pasteBuffer !== undefined) {
      this.pasteBuffer += data;
      this.flushPasteBuffer();
      return;
    }
    if (matchesKey(data, Key.backspace)) {
      this.forwardInput(data);
      return;
    }
    const pasteStart = data.indexOf(BRACKETED_PASTE_START);
    if (pasteStart >= 0) {
      if (pasteStart > 0) this.forwardInput(data.slice(0, pasteStart));
      this.pasteBuffer = data.slice(pasteStart + BRACKETED_PASTE_START.length);
      this.flushPasteBuffer();
      return;
    }
    if ([...data].some((character) => isUnsafeDirectEditorCharacter(character) || this.rawByMarker.has(character))) {
      this.forwardInput(this.encode(data));
      return;
    }
    this.forwardInput(data);
  }

  private forwardInput(data: string): void {
    this.inputDraft = this.preserveDraft ? (this.editor.getExpandedText?.() ?? this.editor.getText()) : undefined;
    try {
      this.editor.handleInput(data);
    } finally {
      this.inputDraft = undefined;
    }
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    return this.editor.handleMouse?.(event);
  }

  render(width: number): string[] {
    return this.editor
      .render(width)
      .map((line) => [...line].map((character) => (this.rawByMarker.has(character) ? " " : character)).join(""));
  }

  invalidate(): void {
    this.editor.invalidate();
  }

  setText(value: string): void {
    this.rawByMarker.clear();
    this.markerCodePoint = 0xe000;
    this.pasteBuffer = undefined;
    this.editor.setText(this.encode(value));
  }

  getExpandedText(): string {
    return this.decode(this.editor.getExpandedText?.() ?? this.editor.getText());
  }

  private flushPasteBuffer(): void {
    if (this.pasteBuffer === undefined) return;
    const pasteEnd = this.pasteBuffer.indexOf(BRACKETED_PASTE_END);
    if (pasteEnd < 0) return;
    const raw = this.pasteBuffer.slice(0, pasteEnd);
    const remaining = this.pasteBuffer.slice(pasteEnd + BRACKETED_PASTE_END.length);
    this.pasteBuffer = undefined;
    this.forwardInput(`${BRACKETED_PASTE_START}${this.encode(raw)}${BRACKETED_PASTE_END}`);
    if (remaining) this.handleInput(remaining);
  }

  private encode(value: string): string {
    const forbidden = new Set([
      ...value,
      ...(this.editor.getExpandedText?.() ?? this.editor.getText()),
      ...this.rawByMarker.keys(),
    ]);
    return [...value]
      .map((character) => {
        if (!isUnsafeEditorCharacter(character) && !this.rawByMarker.has(character)) {
          return character;
        }
        const marker = this.nextMarker(forbidden);
        this.rawByMarker.set(marker, character);
        forbidden.add(marker);
        return marker;
      })
      .join("");
  }

  private decode(value: string): string {
    return [...value].map((character) => this.rawByMarker.get(character) ?? character).join("");
  }

  private nextMarker(forbidden: ReadonlySet<string>): string {
    for (;;) {
      if (this.markerCodePoint === 0xf900) this.markerCodePoint = 0xf0000;
      if (this.markerCodePoint === 0xffffe) this.markerCodePoint = 0x100000;
      if (this.markerCodePoint > 0x10fffd) {
        throw new Error("Questionnaire editor exhausted its safe input markers");
      }
      const marker = String.fromCodePoint(this.markerCodePoint++);
      if (!forbidden.has(marker)) return marker;
    }
  }
}

function isUnsafeDirectEditorCharacter(character: string): boolean {
  const codePoint = character.codePointAt(0) ?? 0;
  return (
    (codePoint >= 0x7f && codePoint <= 0x9f) || codePoint === 0x2028 || codePoint === 0x2029 || isBidiControl(codePoint)
  );
}

function isUnsafeEditorCharacter(character: string): boolean {
  const codePoint = character.codePointAt(0) ?? 0;
  return (
    character !== "\n" &&
    (codePoint <= 0x1f ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      codePoint === 0x2028 ||
      codePoint === 0x2029 ||
      isBidiControl(codePoint))
  );
}

export function isBidiControl(codePoint: number): boolean {
  return (
    codePoint === 0x061c ||
    codePoint === 0x200e ||
    codePoint === 0x200f ||
    (codePoint >= 0x202a && codePoint <= 0x202e) ||
    (codePoint >= 0x2066 && codePoint <= 0x2069)
  );
}
