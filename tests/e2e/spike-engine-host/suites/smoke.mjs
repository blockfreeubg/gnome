// Quick end-to-end check of the whole stack (not part of the default suite list): one page per engine.
export async function run(ctx) {
  const browser = await ctx.launch();
  try {
    const context = await ctx.newContext(browser);
    const app = await ctx.openApp(context, {});
    ctx.log('init', JSON.stringify(app.init));
    const r1 = await app.navigate(1, 'https://example.com/', { create: true, engine: 'scramjet' });
    ctx.record({ engine: 'scramjet', transport: 'libcurl', test: 'example.com', result: r1.ok ? 'pass' : 'fail', notes: JSON.stringify({ ms: r1.ms, title: r1.title, error: r1.error }) });
    const r2 = await app.navigate(2, 'https://example.com/', { create: true, engine: 'ultraviolet' });
    ctx.record({ engine: 'ultraviolet', transport: 'epoxy', test: 'example.com', result: r2.ok ? 'pass' : 'fail', notes: JSON.stringify({ ms: r2.ms, title: r2.title, error: r2.error }) });
    ctx.log('stats', JSON.stringify(await app.stats()).slice(0, 1500));
    ctx.log('console', JSON.stringify(app.console.slice(-30)).slice(0, 3000));
    await context.close();
  } finally {
    await browser.close();
  }
}
