const { validateSlug } = require("./artist-marketplace");

const PAGE_SIZE = 10000;

async function sendArtistSitemap(response, database, origin, part, head) {
  if (part !== "index" && (!/^[1-9]\d*$/.test(part) || !Number.isSafeInteger(Number(part)))) {
    response.writeHead(404);
    return response.end();
  }

  const db = database();
  const [artists, slugs] = await Promise.all([
    db.collection("artists").where("status", "==", "approved").get(),
    db.collection("artistSlugs").where("status", "==", "approved").get()
  ]);
  const approvedSlugs = new Map(slugs.docs.map((entry) => [entry.id, entry.data().artistUid]));
  const paths = [];
  for (const artist of artists.docs) {
    const slug = artist.data().slug;
    if (approvedSlugs.get(slug) !== artist.id) continue;
    if (validateSlug(slug) !== slug) throw new Error("An approved artist has an invalid canonical slug.");
    paths.push(slug);
  }
  paths.sort();

  let xml;
  if (part === "index") {
    const locations = [`${origin}/sitemap.xml`];
    for (let page = 1; page <= Math.ceil(paths.length / PAGE_SIZE); page++) {
      locations.push(`${origin}/sitemap-artists-${page}.xml`);
    }
    xml = `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
      locations.map((loc) => `  <sitemap><loc>${loc}</loc></sitemap>`).join("\n") +
      "\n</sitemapindex>\n";
  } else {
    const start = (Number(part) - 1) * PAGE_SIZE;
    const page = paths.slice(start, start + PAGE_SIZE);
    if (!page.length) {
      response.writeHead(404);
      return response.end();
    }
    xml = `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
      page.map((slug) => `  <url><loc>${origin}/artist/${encodeURIComponent(slug)}</loc></url>`).join("\n") +
      "\n</urlset>\n";
  }
  response.setHeader("Content-Type", "application/xml; charset=utf-8");
  response.setHeader("Content-Length", String(Buffer.byteLength(xml)));
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.writeHead(200);
  return response.end(head ? undefined : xml);
}

module.exports = { sendArtistSitemap };
