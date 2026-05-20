import asyncio
from playwright.async_api import async_playwright
from feedgen.feed import FeedGenerator
import datetime

async def scrape_anthropic():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        page = await browser.new_page()
        
        # Anthropic groups engineering/research into their main news directory
        await page.goto("https://www.anthropic.com/news")
        
        # Wait for the client-side article list to render
        await page.wait_for_selector("a[href^='/news/']")
        
        articles = await page.eval_on_selector_all(
            "a[href^='/news/']",
            """elements => elements.map(el => {
                const titleEl = el.querySelector('h3');
                const dateEl = el.querySelector('div');
                return {
                    title: titleEl ? titleEl.innerText : '',
                    link: el.href,
                    date: dateEl ? dateEl.innerText : ''
                }
            })"""
        )
        
        await browser.close()
        return [a for a in articles if a['title']]

def build_feed(articles):
    fg = FeedGenerator()
    fg.title('Anthropic Updates')
    fg.link(href='https://www.anthropic.com/news', rel='alternate')
    fg.description('Scraped feed of Anthropic news and engineering updates.')
    
    for article in articles:
        fe = fg.add_entry()
        fe.title(article['title'])
        fe.link(href=article['link'])
        
        # Default to today if date parsing fails, but feedgen requires timezone-aware dates
        now = datetime.datetime.now(datetime.timezone.utc)
        fe.published(now) 
        
    fg.rss_file('anthropic_feed.xml')
    print("Feed generated successfully: anthropic_feed.xml")

async def main():
    print("Scraping Anthropic...")
    articles = await scrape_anthropic()
    build_feed(articles)

if __name__ == "__main__":
    asyncio.run(main())
