import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { SettingsProvider } from "../lib/settings.ts";
import { KeyBar, type KeyBarProps } from "./KeyBar.tsx";

const render = (props: Partial<KeyBarProps>): string => {
  const saved = Object.getOwnPropertyDescriptor(navigator, "languages");
  Object.defineProperty(navigator, "languages", { configurable: true, value: ["en"] });
  try {
    return renderToStaticMarkup(createElement(SettingsProvider, {
      children: createElement(KeyBar, { onKey: () => {}, modifiers: { ctrl: false, alt: false, shift: false }, onToggleModifier: () => {}, items: [], ...props }),
    }));
  } finally {
    if (saved) Object.defineProperty(navigator, "languages", saved);
    else Reflect.deleteProperty(navigator, "languages");
  }
};

describe("the key bar's Attach files key", () => {
  it("opens a picker of several files, after the keyboard control", () => {
    const html = render({ onToggleKeyboard: () => {}, onAttach: () => {} });
    expect(html).toContain('data-key="attach"');
    expect(html).toContain('aria-label="Attach files"');
    expect(html).toMatch(/<input[^>]*type="file"[^>]*multiple/);
    expect(html.indexOf('data-key="keyboard"')).toBeLessThan(html.indexOf('data-key="attach"'));
  });

  it("is greyed out with the keys when the terminal cannot take input", () => {
    expect(render({ onAttach: () => {}, disabled: true })).toMatch(/<button[^>]*disabled=""[^>]*data-key="attach"/);
    expect(render({ onAttach: () => {} })).not.toMatch(/<button[^>]*disabled=""[^>]*data-key="attach"/);
  });

  it("is not there without a place for the files (the input line has its own)", () => {
    const html = render({ onToggleKeyboard: () => {} });
    expect(html).not.toContain('data-key="attach"');
    expect(html).not.toContain('type="file"');
  });
});
