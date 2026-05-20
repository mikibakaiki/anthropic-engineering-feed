import asyncio
from playwright.async_api import async_playwright
from feedgen.feed import FeedGenerator
import datetime

async def scrape_anthropic():
    async with async_playwright() as p:
        # Launch browser
        browser = await p.chromium.launch(headless=True)
        
        # Add a real User-Agent so Anthropic's servers don't block the headless browser
        context = await browser.new_context(
            user_agent="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
        )
        page = await context.new_page()
        
        print("Navigating to Anthropic news page...")
        # Wait until the network is somewhat idle to ensure React/Next.js loads
        await page.goto("https://www.anthropic.com/engineering", wait_until="networkidle")
        
        # Wait an extra 3 seconds for client-side rendering to finish populating the DOM
        await page.wait_for_timeout(3000)
        
        print("Extracting articles...")
        # Broaden the search: Look for all anchor tags pointing to news articles
        articles = await page.evaluate(
            """() => {
                const links = Array.from(document.querySelectorAll("a[href*='/news/']"));
                const results = [];
                
                links.forEach(link => {
                    const href = link.href;
                    // Skip the main news index, paginations, or author tags
                    if (href === 'https://www.anthropic.com/engineering' || href.includes('?')) return;
                    
                    // Try to find the title inside the link
                    let title = link.innerText.trim();
                    const heading = link.querySelector('h1, h2, h3, h4, h5, h6, strong, p');
                    if (heading && heading.innerText.trim().length > 10) {
                        title = heading.innerText.trim();
                    }
                    
                    // Clean up the title (split by newlines if it grabbed the date/excerpt too)
                    title = title.split('\\n')[0].trim();
                    
                    // Filter out links that are just 'Read more' or too short to be titles
                    if (title.length > 10 && title.toLowerCase() !== 'read more') {
                        results.push({
                            title: title,
                            link: href
                        });
                    }
                });
                
                // Deduplicate by URL in case the same article appears twice (e.g., image link and text link)
                const uniqueMap = new Map();
                results.forEach(item => {
                    if (!uniqueMap.has(item.link)) {
                        uniqueMap.set(item.link, item);
                    }
                });
                
                return Array.from(uniqueMap.values());
            }"""
        )
        
        await browser.close()
        return articles

def build_feed(articles):
    fg = FeedGenerator()
    fg.title('Anthropic Updates')
    fg.link(href='https://www.anthropic.com/engineering', rel='alternate')
    fg.description('Scraped feed of Anthropic news and engineering updates.')
    
    if not articles:
        print("WARNING: No articles found! The website structure may have changed or the bot was blocked.")
        
    for article in articles:
        print(f"Adding to feed: {article['title']}")
        fe = fg.add_entry()
        fe.title(article['title'])
        fe.link(href=article['link'])
        
        # Default to the time the script runs
        now = datetime.datetime.now(datetime.timezone.utc)
        fe.published(now) 
        
    fg.rss_file('anthropic_feed.xml')
    print("Feed generated successfully: anthropic_feed.xml")

async def main():
    articles = await scrape_anthropic()
    build_feed(articles)

if __name__ == "__main__":
    asyncio.run(main())
