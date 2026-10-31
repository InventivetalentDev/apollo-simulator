import { defineConfig, type Plugin } from 'vite';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { PROGRAMS } from './src/programs.ts';
import { parseBinsource } from './src/yul/binsource.ts';
import { ropeHash } from './src/yul/rope-hash.ts';

// Serves the original AGC source files from the vendor/Apollo-11 submodule as
// one gzipped JSON document per program (agc/<id>.json.gz), which the browser
// unzips and assembles. The file is gzipped here, not by the host: Cloudflare
// took 5-9 s to Brotli-compress the Luminary099 bundle on every request, and
// it does not compress a file that is already gzipped.
// Also includes a hash of the 1969 octal listing so the page can confirm that
// what it assembled matches the flown core rope, and the submodule commit for
// links back to the source on GitHub.
function agcSources(): Plugin {
  // The checked-out submodule commit, so the page can link each line to the
  // same line on GitHub.
  let sourceCommit: string | null = null;
  const commit = (): string => {
    if (sourceCommit) return sourceCommit;
    try {
      sourceCommit = execFileSync('git', ['-C', 'vendor/Apollo-11', 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    } catch (err) {
      throw new Error(`Could not read the vendor/Apollo-11 commit with git: ${err instanceof Error ? err.message : err}`);
    }
    return sourceCommit;
  };
  const bundle = (id: string): string | null => {
    const program = PROGRAMS.find((p) => p.id === id);
    if (!program) return null;
    const dir = join('vendor/Apollo-11', program.directory);
    if (!existsSync(join(dir, 'MAIN.agc'))) {
      throw new Error(`${dir}/MAIN.agc is missing. Run "git submodule update --init" first.`);
    }
    const files: Record<string, string> = {};
    for (const f of readdirSync(dir).sort()) if (f.endsWith('.agc')) files[f] = readFileSync(join(dir, f), 'utf8');
    const fixture = join('test/fixtures', `${id}.binsource`);
    const expectedRopeHash = existsSync(fixture) ? ropeHash(parseBinsource(readFileSync(fixture, 'utf8'))) : null;
    return JSON.stringify({ program: id, files, expectedRopeHash, sourceCommit: commit() });
  };
  return {
    name: 'agc-sources',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const m = /\/agc\/([A-Za-z0-9]+)\.json\.gz(\?.*)?$/.exec(req.url ?? '');
        const body = m ? bundle(m[1]) : null;
        if (!body) return next();
        res.setHeader('Content-Type', 'application/gzip');
        res.end(gzipSync(body, { level: 9 }));
      });
    },
    generateBundle() {
      for (const p of PROGRAMS) this.emitFile({ type: 'asset', fileName: `agc/${p.id}.json.gz`, source: gzipSync(bundle(p.id)!, { level: 9 }) });
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [agcSources()],
  worker: { format: 'es' },
  build: { target: 'es2022' },
});
