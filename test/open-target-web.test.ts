import { expect, test } from "bun:test";
import { webTargetUrl } from "../web/shared/web-target.js";

test("bare web domains gain HTTPS, including paths, ports, queries and fragments", () => {
  for (const target of ["kaufland.de", "paloptic.com/paloptic/", "space.paloptic.com/issues#a", "example.io:8080/x", "kaufland.de?x=1#sale", "example.technology", "KAUFLAND.DE"]) {
    expect(webTargetUrl(target)).toBe(`https://${target}`);
  }
  expect(webTargetUrl("www.kaufland.de")).toBe("https://www.kaufland.de");
  expect(webTargetUrl("http://kaufland.de/path")).toBe("http://kaufland.de/path");
});

test("local files, explicit paths, emails and malformed hosts stay out of browser routing", () => {
  for (const target of ["web/src/links.js", "src/server/http.ts:614", "README.md", "build.sh", "/Users/x/y.txt", "~/projects", "./kaufland.de", "../example.com", "file:///a.txt", "package.json", "state.db", "archive.tar.gz", "127.0.0.1", "alice@kaufland.de", "-bad.de", "bad-.de", "a..de", "kaufland.de:99999", "kaufland.de:80:30", "javascript:alert(1)"]) {
    expect(webTargetUrl(target)).toBeNull();
  }
});
