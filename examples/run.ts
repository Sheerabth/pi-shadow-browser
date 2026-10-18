/** Example: search, open the top result, read it. No keys. */

import { closeSession, open, search } from "../src/index.js";
import type { SearchEngine } from "../src/index.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const query = arg(args, "--query") ?? "population of Zurich";
  const engine = (arg(args, "--engine") ?? "google") as SearchEngine;

  const t0 = Date.now();
  const results = await search(query, { engine, maxResults: 5 });
  console.log(`search (${Date.now() - t0}ms):`);
  for (const [i, r] of results.entries()) console.log(`  ${i + 1}. ${r.title}\n     ${r.url}`);
  if (results.length === 0) return;

  const page = await open(results[0].url);
  console.log(`\nopened ${page.title} (${Date.now() - t0}ms total):`);
  console.log(page.text.slice(0, 1000));
}

function arg(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    // Release our browser. Other agents run their own browsers, but an
    // open browser keeps the node event loop alive, so exit explicitly
    // once our work is done.
    await closeSession().catch(() => undefined);
    process.exit(process.exitCode ?? 0);
  });
