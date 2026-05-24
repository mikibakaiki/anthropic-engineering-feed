# Anthropic Engineering RSS — Setup Guide

## What this does
A Cloudflare Worker (free) fetches `anthropic.com/engineering` daily (triggered by Make.com),
parses articles, and commits a valid RSS feed XML to your GitHub repo.
Inoreader subscribes to the raw GitHub URL.

---

## Step 1: GitHub

1. Fork `0xSMW/rss-feeds` (or use your own repo)
2. Create a Personal Access Token:
   - GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens
   - Permissions: **Contents** → Read and write
   - Copy the token

---

## Step 2: Cloudflare Worker

1. Sign up at **cloudflare.com** (free)
2. Go to **Workers & Pages** → Create → Create Worker
3. Replace the default code with the contents of `worker.js`
4. Click **Save and Deploy**
5. Go to **Settings → Variables** and add these secrets:

| Variable | Value |
|---|---|
| `GITHUB_TOKEN` | Your GitHub PAT from Step 1 |
| `GITHUB_OWNER` | Your GitHub username |
| `GITHUB_REPO` | `rss-feeds` (or your repo name) |
| `GITHUB_PATH` | `feeds/feed_anthropic_engineering.xml` |
| `SECRET_TOKEN` | Any random string, e.g. `myrandomsecret123` |

6. Note your worker URL: `https://anthropic-engineering-rss.<your-subdomain>.workers.dev`

### Seed the feed (first run)
Hit the worker URL manually once to populate the feed:
```
https://anthropic-engineering-rss.<your-subdomain>.workers.dev/?token=myrandomsecret123
```
Check the JSON response — it should list articles found and confirm a GitHub commit.

---

## Step 3: Make.com

1. Sign up at **make.com** (free tier: 1,000 ops/month)
2. Create a new Scenario
3. Add module: **Schedule** → every 1 day
4. Add module: **HTTP → Make a request**
   - URL: `https://anthropic-engineering-rss.<your-subdomain>.workers.dev/?token=myrandomsecret123`
   - Method: GET
5. Save and activate

That's it — Make.com pings the Worker daily, the Worker fetches + commits.

---

## Step 4: Inoreader

Add this feed URL:
```
https://raw.githubusercontent.com/<GITHUB_OWNER>/<GITHUB_REPO>/main/feeds/feed_anthropic_engineering.xml
```

Or if you have GitHub Pages enabled:
```
https://<GITHUB_OWNER>.github.io/<GITHUB_REPO>/feeds/feed_anthropic_engineering.xml
```

---

## Costs
- Cloudflare Workers free tier: 100,000 requests/day — way more than enough
- Make.com free tier: 1,000 operations/month, 2 ops per daily run = 62/month
- GitHub: free
- **Total: $0**
