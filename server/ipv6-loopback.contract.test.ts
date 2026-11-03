import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "./index.ts";

test("IPv4, IPv6 and localhost share one server without redirecting origins", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "ovis-ipv6-loopback-"));
  const app = createServer({ hostname: "127.0.0.1", port: 0, stateDir, ipv6Loopback: true });
  try {
    let boot: string | undefined;
    for (const host of ["127.0.0.1", "[::1]", "localhost"]) {
      const response = await fetch(`http://${host}:${app.port}/api/health`, { redirect: "manual" });
      expect(response.status).toBe(200);
      const current = (await response.json()).web_ui.boot_id as string;
      expect(current).toBe(boot ?? current);
      boot = current;
      const page = await fetch(`http://${host}:${app.port}/`, { headers: { accept: "text/html" }, redirect: "manual" });
      expect(page.status).toBe(200);
      expect(page.headers.get("location")).toBeNull();
      await page.arrayBuffer();
      const socket = new WebSocket(`ws://${host}:${app.port}/ws`);
      try {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("WebSocket did not open")), 3000);
          socket.onopen = () => { clearTimeout(timer); resolve(); };
          socket.onerror = () => { clearTimeout(timer); reject(new Error("WebSocket connection failed")); };
        });
        expect(socket.readyState).toBe(WebSocket.OPEN);
      } finally { socket.close(); }
    }
  } finally { app.stop(); rmSync(stateDir, { recursive: true, force: true }); }
  const replacement = Bun.serve({ hostname: "::1", port: app.port, fetch: () => new Response("ok") });
  replacement.stop(true);
});
