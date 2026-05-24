/**
 * Anthropic Engineering RSS Feed Generator
 * Cloudflare Worker
 *
 * Environment variables (set in Cloudflare dashboard → Worker → Settings → Variables):
 *   GITHUB_TOKEN  - Fine-grained PAT with Contents read/write
 *   GITHUB_OWNER  - Your GitHub username
 *   GITHUB_REPO   - Repo name (e.g. "anthropic-rss")
 *   GITHUB_PATH   - File path in repo (e.g. "feed_anthropic_engineering.xml")
 *   SECRET_TOKEN  - Any random string to secure the endpoint
 */

const BASE_URL = "https://www.anthropic.com";
const ENGINEERING_URL = `${BASE_URL}/engineering`;

// ─── Fetch ────────────────────────────────────────────────────────────────────

async function fetchPage(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

// ─── Parsing ──────────────────────────────────────────────────────────────────

function parseArticleLinks(html) {
  const linkRe = /href="(\/engineering\/[a-z0-9][a-z0-9-]+)"/gi;
  const seen = new Set();
  const links = [];
  let m;
  while ((m = linkRe.exec(html)) !== null) {
    const path = m[1];
    if (!seen.has(path)) {
      seen.add(path);
      links.push(BASE_URL + path);
    }
  }
  return links;
}

function extractDate(html) {
  // Try multiple patterns to find the article date, in order of specificity.
  // All patterns look for month-name dates like "Apr 23, 2026" or "April 23, 2026".
  const patterns = [
    // JSON-LD structured data — most reliable if present
    /"datePublished"\s*:\s*"([^"]+)"/,
    // <time> element
    /<time[^>]+datetime="([^"]+)"/,
    // Common date class patterns
    /class="[^"]*date[^"]*"[^>]*>([A-Z][a-z]+ \d{1,2},? \d{4})/,
    /class="[^"]*timestamp[^"]*"[^>]*>([A-Z][a-z]+ \d{1,2},? \d{4})/,
    // Date appearing right after the h1 (Anthropic's typical pattern)
    /<\/h1>[\s\S]{0,500}?([A-Z][a-z]{2,8} \d{1,2},\s*\d{4})/,
    // Any standalone date in the page
    /([A-Z][a-z]{2,8} \d{1,2},\s*\d{4})/,
  ];

  for (const pattern of patterns) {
    const m = html.match(pattern);
    if (m) {
      const parsed = new Date(m[1]);
      if (!isNaN(parsed.getTime())) {
        return parsed.toUTCString();
      }
    }
  }
  return null; // unknown — caller decides what to do
}

function extractMeta(html, url) {
  // Title
  const titleM = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const title = titleM
    ? titleM[1].replace(/<[^>]+>/g, "").trim()
    : url.split("/").pop().replace(/-/g, " ");

  // Date
  const pubDate = extractDate(html);

  // Hero image — prefer og:image meta tag, fall back to first CDN image
  let heroImg = null;
  const ogM = html.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/i)
    || html.match(/<meta[^>]+content="([^"]+)"[^>]+property="og:image"/i);
  if (ogM) {
    heroImg = ogM[1].replace(/\.heif(\?|$)/, ".jpg$1");
  } else {
    const imgM = html.match(/src="(https:\/\/(?:cdn\.sanity\.io|www-cdn\.anthropic\.com)[^"]+)"/);
    if (imgM) {
      // Unwrap Next.js image proxy URLs
      const raw = imgM[1];
      if (raw.includes("/_next/image")) {
        const inner = raw.match(/url=([^&]+)/);
        heroImg = inner ? decodeURIComponent(inner[1]).replace(/\.heif(\?|$)/, ".jpg$1") : null;
      } else {
        heroImg = raw.replace(/\.heif(\?|$)/, ".jpg$1");
      }
    }
  }

  // Description — og:description is cleanest
  const descM = html.match(/<meta[^>]+property="og:description"[^>]+content="([^"]+)"/i)
    || html.match(/<meta[^>]+content="([^"]+)"[^>]+property="og:description"/i);
  let description = descM ? descM[1].trim() : "";
  if (!description) {
    const pM = html.match(/<h1[\s\S]*?<\/h1>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/i);
    if (pM) description = pM[1].replace(/<[^>]+>/g, "").trim().slice(0, 300);
  }

  // Article body
  const bodyM =
    html.match(/<article[^>]*>([\s\S]*?)<\/article>/i) ||
    html.match(/<main[^>]*>([\s\S]*?)<\/main>/i);

  let contentHtml = "";
  if (bodyM) {
    let body = bodyM[1];
    body = body.replace(/<(script|style|noscript|nav|footer|form)[^>]*>[\s\S]*?<\/\1>/gi, "");
    // Unwrap Next.js image proxy
    body = body.replace(
      /src="[^"]*\/_next\/image\?url=([^&"]+)[^"]*"/g,
      (_, enc) => {
        const real = decodeURIComponent(enc).replace(/\.heif(\?|$)/, ".jpg$1");
        return `src="${real}"`;
      }
    );
    // Fix HEIF images elsewhere
    body = body.replace(/\.(heif)(\?|"|')/g, ".jpg$2");
    // Make relative hrefs absolute
    body = body.replace(/href="(\/[^"]+)"/g, `href="${BASE_URL}$1"`);
    contentHtml = body.trim();
  }

  // Prepend hero image
  if (heroImg) {
    contentHtml =
      `<p><img src="${heroImg}" alt="${escapeXml(title)}" style="max-width:100%;height:auto;" /></p>\n` +
      contentHtml;
  }

  return { title, pubDate, description, contentHtml, heroImg };
}

// ─── GitHub ───────────────────────────────────────────────────────────────────

async function getExistingFeed(env) {
  const { GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO, GITHUB_PATH } = env;
  const apiUrl = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${GITHUB_PATH}`;
  const res = await fetch(apiUrl, {
    headers: {
      Authorization: `token ${GITHUB_TOKEN}`,
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "cf-rss-worker",
    },
  });
  if (res.status === 404) return { sha: null, xml: null };
  if (!res.ok) throw new Error(`GitHub GET ${res.status}`);
  const data = await res.json();
  const xml = atob(data.content.replace(/\n/g, ""));
  return { sha: data.sha, xml };
}

async function commitFeed(env, xml, sha) {
  const { GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO, GITHUB_PATH } = env;
  const apiUrl = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${GITHUB_PATH}`;
  const body = {
    message: `Update engineering RSS feed ${new Date().toISOString().slice(0, 10)}`,
    content: btoa(unescape(encodeURIComponent(xml))),
    ...(sha ? { sha } : {}),
  };
  const res = await fetch(apiUrl, {
    method: "PUT",
    headers: {
      Authorization: `token ${GITHUB_TOKEN}`,
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "cf-rss-worker",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`GitHub PUT ${res.status}: ${err}`);
  }
}

// ─── XML ──────────────────────────────────────────────────────────────────────

function escapeXml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function extractExistingItems(xml) {
  const items = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRe.exec(xml)) !== null) {
    const block = m[1];
    const guidM = block.match(/<guid[^>]*>(.*?)<\/guid>/);
    const pubM = block.match(/<pubDate>(.*?)<\/pubDate>/);
    if (guidM) {
      items.push({
        block: m[0],
        url: guidM[1].trim(),
        // Preserve the original date exactly as stored — never overwrite it
        date: pubM ? new Date(pubM[1].trim()) : new Date(0),
      });
    }
  }
  return items;
}

function buildItem(url, meta) {
  const { title, pubDate, description, contentHtml, heroImg } = meta;
  const mediaTag = heroImg
    ? `\n    <media:content url="${escapeXml(heroImg)}" medium="image"/>`
    : "";
  // If we couldn't determine a date, omit pubDate rather than lying
  const pubDateTag = pubDate ? `\n    <pubDate>${pubDate}</pubDate>` : "";

  return `  <item>
    <title>${escapeXml(title)}</title>
    <link>${escapeXml(url)}</link>
    <guid isPermaLink="true">${escapeXml(url)}</guid>${pubDateTag}
    <description>${escapeXml(description)}</description>
    <content:encoded><![CDATA[${contentHtml}]]></content:encoded>${mediaTag}
  </item>`;
}

function buildXml(items, feedUrl) {
  // Sort: items with dates first (newest first), undated items at end
  const withDate = items.filter(i => i.date > new Date(0)).sort((a, b) => b.date - a.date);
  const withoutDate = items.filter(i => i.date <= new Date(0));
  const sorted = [...withDate, ...withoutDate];

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
  xmlns:content="http://purl.org/rss/1.0/modules/content/"
  xmlns:media="http://search.yahoo.com/mrss/"
  xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>Anthropic Engineering</title>
    <link>${BASE_URL}/engineering</link>
    <description>Inside the team building reliable AI systems</description>
    <language>en-us</language>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
    <atom:link href="${escapeXml(feedUrl)}" rel="self" type="application/rss+xml"/>
${sorted.map(i => i.block).join("\n")}
  </channel>
</rss>`;
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.searchParams.get("token") !== env.SECRET_TOKEN) {
      return new Response("Unauthorized", { status: 401 });
    }

    const log = [];

    try {
      const feedUrl = `https://raw.githubusercontent.com/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/main/${env.GITHUB_PATH}`;

      // 1. Load existing feed (to preserve already-fetched items and their dates)
      const { sha, xml: existingXml } = await getExistingFeed(env);
      const existingItems = existingXml ? extractExistingItems(existingXml) : [];
      const existingUrls = new Set(existingItems.map(i => i.url));
      log.push(`Existing items: ${existingItems.length}`);

      // 2. Get article list from engineering index
      const indexHtml = await fetchPage(ENGINEERING_URL);
      const articleUrls = parseArticleLinks(indexHtml);
      log.push(`Found ${articleUrls.length} URLs on index page`);

      // 3. Fetch only new articles
      const newItems = [];
      for (const artUrl of articleUrls) {
        if (existingUrls.has(artUrl)) continue;
        try {
          const artHtml = await fetchPage(artUrl);
          const meta = extractMeta(artHtml, artUrl);
          const block = buildItem(artUrl, meta);
          newItems.push({
            block,
            url: artUrl,
            date: meta.pubDate ? new Date(meta.pubDate) : new Date(0),
          });
          log.push(`+ ${artUrl} [${meta.pubDate || "no date found"}]`);
          await new Promise(r => setTimeout(r, 300));
        } catch (e) {
          log.push(`! Failed ${artUrl}: ${e.message}`);
        }
      }

      // 4. Merge and commit
      const allItems = [...newItems, ...existingItems];
      if (newItems.length > 0) {
        const newXml = buildXml(allItems, feedUrl);
        await commitFeed(env, newXml, sha);
        log.push(`Committed ${newItems.length} new article(s) to GitHub`);
      } else {
        log.push("No new articles — nothing committed");
      }

      return new Response(JSON.stringify({ ok: true, log }, null, 2), {
        headers: { "Content-Type": "application/json" },
      });
    } catch (err) {
      log.push(`ERROR: ${err.message}`);
      return new Response(JSON.stringify({ ok: false, log, error: err.message }, null, 2), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  },
};
