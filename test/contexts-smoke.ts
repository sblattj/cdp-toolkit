/**
 * Live smoke for execution-context selection (issue #12), through the real stdio MCP server.
 *
 * Serves its own fixture: a top page on localhost embedding a cross-site iframe (127.0.0.1, an
 * out-of-process iframe TARGET, like an Electron webview), which inserts a NESTED same-process
 * iframe ~600ms after load. The input lives in that nested frame: a plain `fill` cannot see it.
 * Then: fill / click / evaluate_script{allContexts} / list_contexts / take_snapshot with `context`.
 *
 * SAFETY: opens ONE background tab of its own (new_page) and closes it; never touches other tabs.
 * Run: CDP_BASE=http://127.0.0.1:9222 bun run contexts:smoke
 */
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { fileURLToPath } from "node:url";

declare const Bun: { serve(o: { port: number; fetch(req: Request): Response }): { port: number; stop(force?: boolean): void } };

const inner = `<div style="padding:30px"><input id="chat-input" placeholder="Ask" style="width:200px">
<div id="editor" contenteditable="true" style="width:200px;height:40px;border:1px solid #888"></div>
<input id="second" style="width:200px">
<button id="send" onclick="window.clicks=(window.clicks||0)+1" onmouseover="window.hovered=true">send</button></div>`;
const html = (body: string) => new Response(`<!doctype html><html><body style="margin:0">${body}</body></html>`, { headers: { "content-type": "text/html" } });
const server = Bun.serve({
  port: 0,
  fetch(req: Request) {
    const u = new URL(req.url);
    const port = server.port;
    if (u.pathname === "/") return html(`<h1>top</h1><iframe src="http://127.0.0.1:${port}/webview" style="margin:25px 0 0 55px;border:7px solid #00a;width:600px;height:420px"></iframe>`);
    if (u.pathname === "/webview") {
      return html(`<h3>webview host</h3><script>setTimeout(function(){var f=document.createElement('iframe');f.name='active-frame';
f.src='/inner';f.style.cssText='margin:40px 0 0 70px;border:9px solid #0a0;width:400px;height:260px';document.body.appendChild(f);},600);</script>`);
    }
    if (u.pathname === "/inner") return html(inner);
    return new Response("nf", { status: 404 });
  },
});

const childEnv: Record<string, string> = { CDP_TOOL_PROFILE: "full" };
for (const [k, v] of Object.entries(process.env)) if (v !== undefined) childEnv[k] = v;
childEnv.CDP_TOOL_PROFILE = "full";
const client = new Client({ name: "cdp-contexts-smoke", version: "0.0.0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL("../src/mcp.ts", import.meta.url))], env: childEnv }));

type Res = { content: Array<{ type: string; text?: string }>; isError?: boolean };
const call = async (name: string, args: Record<string, unknown>) => {
  const r = (await client.callTool({ name, arguments: args })) as Res;
  const text = r.content.map((c) => c.text ?? "").join("");
  return { isError: r.isError === true, text, json: (() => { try { return JSON.parse(text); } catch { return undefined; } })() };
};
let failures = 0;
const verdict = (label: string, ok: boolean, detail: string) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${label}: ${detail}`);
  if (!ok) failures++;
};

let tab: string | undefined;
try {
  const created = await call("new_page", { url: `http://localhost:${server.port}/`, background: true });
  tab = created.json?.targetId ?? created.json?.id;
  verdict("new_page", !!tab, `targetId=${tab?.slice(0, 8)}`);
  await new Promise((r) => setTimeout(r, 300));
  const webview = `frame:${server.port}/webview`;

  const plain = await call("fill", { target: webview, selector: "#chat-input", value: "nope" });
  verdict("CONTROL fill without context fails", plain.isError && plain.text.includes("matched no element"), plain.text.slice(0, 90));

  const filled = await call("fill", { target: webview, selector: "#chat-input", value: "hello from #12", context: "auto" });
  verdict("fill context:auto", !filled.isError && filled.json?.context?.frameUrl?.endsWith("/inner"), JSON.stringify(filled.json?.context ?? filled.text.slice(0, 120)));

  const read = await call("evaluate_script", { target: webview, context: "name:active-frame", expression: 'document.querySelector("#chat-input").value' });
  verdict("value landed in the nested input", read.json === "hello from #12" || read.text.includes("hello from #12"), read.text.slice(0, 80));

  const clicked = await call("click", { target: webview, selector: "#send", context: "auto" });
  const clicks = await call("evaluate_script", { target: webview, context: "name:active-frame", expression: "window.clicks ?? 0" });
  verdict("click context:auto hit the nested button", !clicked.isError && clicks.text.trim() === "1", `click=${clicked.text.slice(0, 80)} clicks=${clicks.text}`);

  // The issue's input was a ProseMirror contenteditable, not an <input>: fill must reach that too.
  const ce = await call("fill", { target: webview, selector: "#editor", value: "pm text", context: "auto" });
  const ceText = await call("evaluate_script", { target: webview, context: "name:active-frame", expression: 'document.querySelector("#editor").textContent' });
  verdict("fill context:auto into a nested contenteditable", !ce.isError && ceText.text.includes("pm text"), `${ce.text.slice(0, 50).replace(/\n/g, " ")} -> ${ceText.text}`);
  await call("evaluate_script", { target: webview, context: "name:active-frame", expression: 'document.querySelector("#editor").textContent = ""' });

  const typed = await call("type_text", { target: webview, selector: "#editor", text: "rich text", context: "auto" });
  const editor = await call("evaluate_script", { target: webview, context: "name:active-frame", expression: 'document.querySelector("#editor").textContent' });
  verdict("type_text context:auto into a nested contenteditable", !typed.isError && editor.text.includes("rich text"), `${typed.text.slice(0, 60)} -> ${editor.text}`);

  const hovered = await call("hover", { target: webview, selector: "#send", context: "auto" });
  const hov = await call("evaluate_script", { target: webview, context: "name:active-frame", expression: "window.hovered === true" });
  verdict("hover context:auto reached the nested button", !hovered.isError && hov.text.trim() === "true", hov.text);

  const form = await call("fill_form", { target: webview, context: "auto", fields: [{ selector: "#chat-input", value: "f1" }, { selector: "#second", value: "f2" }] });
  const vals = await call("evaluate_script", { target: webview, context: "name:active-frame", expression: '[document.querySelector("#chat-input").value, document.querySelector("#second").value].join(",")' });
  verdict("fill_form context:auto fills both nested fields", !form.isError && vals.text.includes("f1,f2"), vals.text);

  const rows = await call("evaluate_script", { target: webview, allContexts: true, expression: 'document.querySelector("#chat-input") !== null' });
  const arr = Array.isArray(rows.json) ? (rows.json as Array<{ value: unknown; frameUrl?: string }>) : [];
  console.log(JSON.stringify(arr.map((r) => [r.value, (r as any).isDefault, (r as any).type, r.frameUrl])));
  verdict("allContexts finds exactly the nested frame", arr.filter((r) => r.value === true && (r as any).isDefault).length === 1 && arr.find((r) => r.value === true && (r as any).isDefault)?.frameUrl?.endsWith("/inner") === true, `${arr.length} rows`);

  const listed = await call("list_contexts", { target: webview });
  verdict("list_contexts names the nested frame", (listed.json?.contexts ?? []).some((c: { frameName?: string }) => c.frameName === "active-frame"), `count=${listed.json?.count}`);

  const top = await call("take_snapshot", { target: webview });
  verdict("CONTROL take_snapshot without context shows the host, not the nested input", !top.isError && top.text.includes("webview host") && !top.text.includes("send"), top.text.slice(0, 80).replace(/\n/g, " "));
  const snap = await call("take_snapshot", { target: webview, context: "name:active-frame" });
  verdict("take_snapshot context shows the nested frame's tree", !snap.isError && snap.text.includes("send") && !snap.text.includes("webview host"), snap.text.slice(0, 80).replace(/\n/g, " "));

  // The loop the skill teaches: snapshot the frame, take a uid, click it by uid (no context needed:
  // a uid is a backend node id, valid across the target's frames).
  const uid = /\[(\d+)\] button "send"/.exec(snap.text.replace(/\\"/g, '"'))?.[1];
  const byUid = uid ? await call("click", { target: webview, uid }) : undefined;
  const after = await call("evaluate_script", { target: webview, context: "name:active-frame", expression: "window.clicks ?? 0" });
  verdict("snapshot uid -> click {uid} hits the nested button", !!uid && !byUid?.isError && after.text.trim() === "2", `uid=${uid} clicks=${after.text}`);
} catch (e) {
  verdict("smoke", false, (e as Error).message);
} finally {
  if (tab) {
    const closed = await call("close_page", { target: tab });
    verdict("close_page", !closed.isError, closed.text.slice(0, 60));
  }
  await client.close();
  server.stop(true);
}
console.log(failures ? `${failures} FAILED` : "ALL PASS");
process.exit(failures ? 1 : 0);
