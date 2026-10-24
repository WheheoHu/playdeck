import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import path from 'node:path';
import { defineConfig } from 'vite';

// Main and preload are built separately: a shared chunk would make the sandboxed preload require() a
// sibling file, which Electron's sandbox does not allow.
const ENTRIES = { main: 'electron/main.ts', preload: 'electron/preload.ts' } as const;

function resolveBuildVersion(): string {
  if (process.env.PLAYDECK_BUILD_VERSION) return process.env.PLAYDECK_BUILD_VERSION;
  try {
    return execFileSync(path.join(__dirname, 'scripts', 'version.sh'), { encoding: 'utf8' }).trim();
  } catch {
    const pkg = JSON.parse(readFileSync(path.join(__dirname, 'package.json'), 'utf8')) as { version: string };
    return `${pkg.version.replace(/-.*$/, '')}_unknown_${process.env.PLAYDECK_CHANNEL || 'Dev'}`;
  }
}

export default defineConfig(({ mode }) => {
  const entry = ENTRIES[mode as keyof typeof ENTRIES];
  if (!entry) throw new Error(`unknown electron build mode: ${mode}`);
  return {
    define: {
      __PLAYDECK_VERSION__: JSON.stringify(resolveBuildVersion()),
    },
    build: {
      outDir: 'dist-electron',
      emptyOutDir: mode === 'main',
      target: 'node22',
      minify: false,
      sourcemap: true,
      lib: { entry, formats: ['cjs'], fileName: () => `${mode}.cjs` },
      rollupOptions: {
        external: ['electron', ...builtinModules, ...builtinModules.map((name) => `node:${name}`)],
      },
    },
  };
});
