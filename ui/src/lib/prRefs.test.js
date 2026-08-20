import { expect, test } from "bun:test";
import { chromium } from "playwright";

const moduleSource = Bun.file(new URL("./prRefs.js", import.meta.url));

test("bare PR references link before and after title enrichment", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.route("http://pr-refs.test/**", async (route) => {
      if (new URL(route.request().url()).pathname === "/prRefs.js") {
        await route.fulfill({ contentType: "text/javascript", body: await moduleSource.text() });
      } else {
        await route.fulfill({ contentType: "text/html", body: "<!doctype html><body></body>" });
      }
    });
    await page.goto("http://pr-refs.test/");

    const refs = await page.evaluate(async () => {
      const { linkifyBareRefs } = await import("/prRefs.js");
      const render = (title) => {
        const doc = new DOMParser().parseFromString("<p>Fixes #6275.</p>", "text/html");
        linkifyBareRefs(doc, "example-org/webapp", () => title);
        const link = doc.querySelector("a");
        return {
          text: link.textContent,
          href: link.getAttribute("href"),
          target: link.getAttribute("target"),
          rel: link.getAttribute("rel"),
        };
      };
      return {
        cold: render(null),
        cached: render("Chunk calendar bulk upserts"),
      };
    });

    expect(refs.cold).toEqual({
      text: "#6275",
      href: "https://github.com/example-org/webapp/issues/6275",
      target: "_blank",
      rel: "noopener",
    });
    expect(refs.cached).toEqual({
      text: "Chunk calendar bulk upserts #6275",
      href: "#/pr/example-org/webapp/6275",
      target: null,
      rel: null,
    });
  } finally {
    await browser.close();
  }
});
