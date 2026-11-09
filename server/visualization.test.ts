import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileInfo, fileResponse, pagePolicy } from "./file-view.ts";

test("visualization rendering adds local compatibility without widening the file sandbox", async () => {
  const root = mkdtempSync(join(tmpdir(), "ovis-visualization-"));
  try {
    const path = join(root, "fragment.html");
    writeFileSync(path, '<div id="example">Diagram</div><script>document.querySelector("#example").dataset.ready="yes"</script>');
    const info = fileInfo(path)!;
    const normal = await fileResponse(info, false, true);
    expect(await normal.text()).not.toContain("ovis-visualization-content");
    const response = await fileResponse(info, false, true, null, new Request("http://local/api/fs/file?render=1&visualize=1"));
    expect(response.headers.get("content-security-policy")).toBe(pagePolicy(null));
    const html = await response.text();
    expect(html).toContain("ovis-visualization-content");
    expect(html).toContain("ovis-visualization-ready");
    expect(html).toContain("--viz-series-1");
    expect(html).toContain('id="example"');
    expect(html.indexOf("window.openai")).toBeLessThan(html.indexOf('id="example"'));
    const source = await fileResponse(info, false, false, null, new Request("http://local/api/fs/file?visualize=1"));
    expect(source.headers.get("content-type")).toContain("text/plain");
    expect(await source.text()).not.toContain("ovis-visualization-content");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
