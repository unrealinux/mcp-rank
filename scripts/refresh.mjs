// Full data refresh: registry → dataset → stars → curated catalog.
// Run: GH_TOKEN=$(gh auth token) node scripts/refresh.mjs
import { execFileSync } from 'node:child_process';

const run = (file) => {
  console.error(`\n=== ${file}`);
  execFileSync(process.execPath, [file], { stdio: 'inherit' });
};

run('scripts/crawl-registry.mjs');
run('scripts/build-dataset.mjs');
run('scripts/fetch-stars.mjs');
run('scripts/build-catalog.mjs');
console.error('\n数据已刷新，重启 server.mjs 生效。');
