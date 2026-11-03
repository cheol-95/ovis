import { describe, expect, it } from "bun:test";
import { userGalleryImages } from "./chatImages.ts";
import { imageMention } from "./compose.ts";

const t = (text: string) => text;
const images = (text: string) => userGalleryImages("fixture pc", "w1:p1", [], text, t);

describe("mentioned chat images", () => {
  it("shows a composer attachment under an iCloud folder containing spaces", () => {
    const path = "/Users/test/Library/Mobile Documents/iCloud~md~obsidian/Documents/notes/.ovis/paste-20261103-065352-8f69b25b.png";
    const gallery = images(`${imageMention(path)}왜 이렇게 나와?`);
    expect(gallery).toHaveLength(1);
    expect(gallery[0]!.name).toBe(path);
    expect(gallery[0]!.file).toBe("paste-20261103-065352-8f69b25b.png");
    const url = new URL(gallery[0]!.src, "http://fixture");
    expect(url.pathname).toBe("/api/machines/fixture%20pc/fs/file");
    expect(url.searchParams.get("pane_id")).toBe("w1:p1");
    expect(url.searchParams.get("path")).toBe(path);
  });

  it("keeps multiple spaced paths separate, in order, without the following prose", () => {
    const paths = ["/My Images/one.png", "/Other Folder/two.JPEG"];
    expect(images(`${paths.map(imageMention).join("")}compare these images`).map((image) => image.name)).toEqual(paths);
    expect(images(`${imageMention(paths[0]!)}설명에 다른 image.png도 있음`).map((image) => image.name)).toEqual([paths[0]!]);
  });

  it("supports Windows absolute paths with spaces", () => {
    const path = "C:\\Users\\Test User\\My Images\\one.webp";
    expect(images(imageMention(path)).map((image) => image.name)).toEqual([path]);
  });

  it("preserves relative and no-space mentions and deduplicates each path", () => {
    expect(images("@shots/one.gif @/tmp/two.png @shots/one.gif").map((image) => image.name)).toEqual(["shots/one.gif", "/tmp/two.png"]);
    expect(images("@shots/me@home.png @/Users/test@example/My Images/one.png").map((image) => image.name)).toEqual(["shots/me@home.png", "/Users/test@example/My Images/one.png"]);
  });

  it("does not join paths across lines, tabs or another mention", () => {
    for (const text of ["@/My Folder\nnot-an-attachment.png", "@/My Folder\rnot-an-attachment.png", "@/My Folder\tnot-an-attachment.png", "@/My Folder @other prose.png"]) {
      expect(images(text)).toEqual([]);
    }
    expect(images("@/My Folder @/Other Folder/two.png").map((image) => image.name)).toEqual(["/Other Folder/two.png"]);
  });

  it("leaves addresses, unsupported types and extension prefixes alone", () => {
    for (const text of ["person@example.png", "@/My Folder/notes.txt", "@/My Folder/one.png.backup", "@/My Folder/one.pngsuffix"]) expect(images(text)).toEqual([]);
  });

  it("keeps native attachments before mentioned files", () => {
    const gallery = userGalleryImages("local", "p:1", [{ kind: "image", ref: "codex-example", media_type: "image/jpeg" }], "@/My Images/one.png", t);
    expect(gallery.map((image) => image.file)).toEqual(["image-1.jpg", "one.png"]);
    expect(new URL(gallery[0]!.src, "http://fixture").searchParams.get("ref")).toBe("codex-example");
  });
});
