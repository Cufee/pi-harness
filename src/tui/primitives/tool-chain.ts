import { Container, type Component, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import { ToolPill } from "./message-card.js";
import { disclosureGlyph, statusGlyph, titleRow } from "./rows.js";
import type { HarnessTheme } from "./theme.js";

class ToolChain implements Component {
  private open = false;
  private readonly calls: ToolPill[] = [];

  constructor(private readonly theme: HarnessTheme) {}

  add(call: ToolPill): void {
    this.calls.push(call);
  }

  invalidate(): void {
    for (const call of this.calls) call.invalidate();
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.type !== "click" || event.button !== "left" || event.y !== 0) return undefined;
    this.open = !this.open;
    return { handled: true };
  }

  render(width: number): readonly string[] {
    if (width <= 0) return [];
    const failed = this.calls.filter((call) => call.status === "error").length;
    const running = this.calls.some((call) => call.status === "running");
    const status = failed ? "error" : running ? "running" : this.calls.some((call) => call.status === "ok") ? "ok" : "called";
    const count = this.calls.length;
    const summary = titleRow(this.theme, {
      glyph: `${disclosureGlyph(this.theme, this.open)} ${statusGlyph(this.theme, status)}`,
      title: `${count} tool call${count === 1 ? "" : "s"}`,
      detail: failed ? `${failed} failed${running ? " · running" : ""}` : running ? "running" : undefined,
    }, width);
    return this.open ? [summary, ...this.calls.flatMap((call) => call.render(width))] : [summary];
  }
}

/** Groups adjacent calls while keeping each chain and its disclosure state in the transcript. */
export class ToolTranscript extends Container {
  constructor(private readonly theme: HarnessTheme) {
    super();
  }

  override addChild(component: Component): void {
    if (!(component instanceof ToolPill)) {
      super.addChild(component);
      return;
    }
    const previous = this.children.at(-1);
    const chain = previous instanceof ToolChain ? previous : new ToolChain(this.theme);
    chain.add(component);
    if (chain !== previous) super.addChild(chain);
  }
}
