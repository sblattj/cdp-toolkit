/**
 * Action results name the element they touched (`element: 'button "Save"'`), so a reader of the
 * tool output sees what was clicked instead of a bare uid. Two layers are pinned here without a
 * browser: the in-page describe source (run against a fake element), and the shared-tools wiring
 * (describe happens BEFORE the action, and a failed or missing describe never breaks the action).
 */
import { describe, expect, test } from "bun:test";
import type { BrowserDriver, PageDriver, PageInfo } from "../src/driver.ts";
import { click, describeElementSource, drag, fill, fillForm, hover } from "../src/shared-tools.ts";

/* ------------------------------ in-page describe source ------------------------------ */

interface FakeEl {
  nodeType: number;
  tagName: string;
  attrs?: Record<string, string>;
  text?: string;
  ownerDocument?: { getElementById(id: string): { textContent: string } | null; querySelector(): null };
}

function runDescribe(el: FakeEl | null): unknown {
  const fake = el && {
    nodeType: el.nodeType,
    tagName: el.tagName,
    textContent: el.text ?? "",
    innerText: el.text ?? "",
    isContentEditable: false,
    getAttribute: (k: string) => el.attrs?.[k] ?? null,
    closest: () => null,
    ownerDocument: el.ownerDocument ?? { getElementById: () => null, querySelector: () => null },
  };
  // The source is a function literal; wrap it in parens so it evaluates to the function.
  const fn = new Function(`return (${describeElementSource()});`)() as (this: unknown) => unknown;
  return fn.call(fake);
}

describe("describeElementSource()", () => {
  test("a button is named by its text", () => {
    expect(runDescribe({ nodeType: 1, tagName: "BUTTON", text: "  Add   new   item " })).toBe('button "Add new item"');
  });
  test("an explicit role and aria-label win", () => {
    expect(runDescribe({ nodeType: 1, tagName: "DIV", attrs: { role: "tab", "aria-label": "Details" }, text: "ignored" })).toBe('tab "Details"');
  });
  test("a text input is named by its placeholder, not its value", () => {
    expect(runDescribe({ nodeType: 1, tagName: "INPUT", attrs: { type: "email", placeholder: "Email" } })).toBe('textbox "Email"');
  });
  test("aria-labelledby resolves through the document", () => {
    const ownerDocument = { getElementById: (id: string) => (id === "lbl" ? { textContent: "Search" } : null), querySelector: () => null };
    expect(runDescribe({ nodeType: 1, tagName: "INPUT", attrs: { "aria-labelledby": "lbl" }, ownerDocument })).toBe('textbox "Search"');
  });
  test("a role-less element falls back to its tag and own text", () => {
    expect(runDescribe({ nodeType: 1, tagName: "SPAN", text: "Row 3" })).toBe('span "Row 3"');
  });
  test("an element with neither name nor text is just its role", () => {
    expect(runDescribe({ nodeType: 1, tagName: "BUTTON" })).toBe("button");
  });
  test("long names are truncated with an ellipsis", () => {
    const out = runDescribe({ nodeType: 1, tagName: "BUTTON", text: "x".repeat(500) }) as string;
    expect(out.length).toBeLessThan(140);
    expect(out.endsWith('…"')).toBe(true);
  });
  test("a non-element yields null", () => {
    expect(runDescribe({ nodeType: 3, tagName: "#text" })).toBeNull();
    expect(runDescribe(null)).toBeNull();
  });
});

/* ------------------------------------ wiring ------------------------------------ */

const INFO: PageInfo = { id: "TAB-1", url: "https://example.test/app", title: "App", type: "page" };

function stubDriver(describe: (loc: unknown) => Promise<unknown>) {
  const calls: string[] = [];
  const page = {
    info: INFO,
    async callOnElement(loc: unknown): Promise<unknown> {
      calls.push(`describe ${JSON.stringify(loc)}`);
      return describe(loc);
    },
    async click(loc: unknown): Promise<{ x: number; y: number }> {
      calls.push(`click ${JSON.stringify(loc)}`);
      return { x: 1, y: 2 };
    },
    async hover(): Promise<{ x: number; y: number }> {
      calls.push("hover");
      return { x: 3, y: 4 };
    },
    async setValue(loc: unknown): Promise<void> {
      calls.push(`setValue ${JSON.stringify(loc)}`);
    },
    async drag(): Promise<{ from: { x: number; y: number }; to: { x: number; y: number } }> {
      calls.push("drag");
      return { from: { x: 0, y: 0 }, to: { x: 9, y: 9 } };
    },
    async release(): Promise<void> {},
  };
  const driver = {
    scheme: "cdp",
    capabilities: new Set(),
    async page(): Promise<PageDriver> {
      return page as unknown as PageDriver;
    },
  };
  return { driver: driver as unknown as BrowserDriver, calls };
}

describe("action results carry the described element", () => {
  test("click describes first, then clicks, and reports element", async () => {
    const { driver, calls } = stubDriver(async () => 'button "Save"');
    const result = await click(driver, { uid: "42" as never });
    expect(result).toEqual({ clicked: true, element: 'button "Save"', x: 1, y: 2 });
    expect(calls).toEqual(['describe {"uid":"42"}', 'click {"uid":"42"}']);
  });
  test("a describe that throws omits element and the click still lands", async () => {
    const { driver, calls } = stubDriver(async () => {
      throw new Error("node detached");
    });
    const result = await click(driver, { selector: "#go" });
    expect(result).toEqual({ clicked: true, x: 1, y: 2 });
    expect(calls).toContain('click {"css":"#go"}');
  });
  test("a non-string describe result is ignored", async () => {
    const { driver } = stubDriver(async () => null);
    expect(await hover(driver, { selector: "a" })).toEqual({ hovered: true, x: 3, y: 4 });
  });
  test("fill reports the field, and still echoes the value", async () => {
    const { driver } = stubDriver(async () => 'textbox "Email"');
    expect(await fill(driver, { selector: "#email", value: "a@b.test" })).toEqual({ filled: true, element: 'textbox "Email"', value: "a@b.test" });
  });
  test("fill_form lists one description per field, null where none", async () => {
    const { driver } = stubDriver(async (loc) => ((loc as { css?: string }).css === "#a" ? 'textbox "A"' : undefined));
    const result = await fillForm(driver, { fields: [{ selector: "#a", value: "1" }, { selector: "#b", value: "2" }] });
    expect(result).toEqual({ filled: 2, fields: 2, elements: ['textbox "A"', null] });
  });
  test("drag names both ends when `to` is an element, and only the source for a point", async () => {
    const { driver } = stubDriver(async (loc) => `listitem ${JSON.stringify((loc as { css: string }).css)}`);
    const toEl = await drag(driver, { from: { selector: "#card" }, to: { selector: "#lane" } });
    expect(toEl.element).toBe('listitem "#card"');
    expect(toEl.target_element).toBe('listitem "#lane"');
    const toPoint = await drag(driver, { from: { selector: "#card" }, to: { x: 5, y: 5 } });
    expect(toPoint.element).toBe('listitem "#card"');
    expect("target_element" in toPoint).toBe(false);
  });
});
