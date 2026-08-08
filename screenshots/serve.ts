const root = new URL("../web/", import.meta.url).pathname;
Bun.serve({ port: 8877, async fetch(req) {
  let p = new URL(req.url).pathname; if (p === "/") p = "/index.html";
  const f = Bun.file(root + p);
  if (await f.exists()) return new Response(f);
  return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
}});
console.log("up 8877");
