import { defineConfig, type Plugin } from 'vite';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PROGRAMS } from './src/programs.ts';
import { parseBinsource } from './src/yul/binsource.ts';
import { ropeHash } from './src/yul/rope-hash.ts';

// Serves the original AGC source files from the vendor/Apollo-11 submodule as
// one JSON document per program (agc/<id>.json), which the browser assembles.
// Also includes a hash of the 1969 octal listing so the page can confirm that
// what it assembled matches the flown core rope.
function agcSources(): Plugin {
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
    return JSON.stringify({ program: id, files, expectedRopeHash });
  };
  return {
    name: 'agc-sources',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const m = /\/agc\/([A-Za-z0-9]+)\.json(\?.*)?$/.exec(req.url ?? '');
        const body = m ? bundle(m[1]) : null;
        if (!body) return next();
        res.setHeader('Content-Type', 'application/json');
        res.end(body);
      });
    },
    generateBundle() {
      for (const p of PROGRAMS) this.emitFile({ type: 'asset', fileName: `agc/${p.id}.json`, source: bundle(p.id)! });
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [agcSources()],
  worker: { format: 'es' },
  build: { target: 'es2022' },
});
