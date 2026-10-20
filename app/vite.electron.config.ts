import { builtinModules } from 'node:module';
import { defineConfig } from 'vite';

// Main and preload are built separately: a shared chunk would make the sandboxed preload require() a
// sibling file, which Electron's sandbox does not allow.
const ENTRIES = { main: 'electron/main.ts', preload: 'electron/preload.ts' } as const;

export default defineConfig(({ mode }) => {
  const entry = ENTRIES[mode as keyof typeof ENTRIES];
  if (!entry) throw new Error(`unknown electron build mode: ${mode}`);
  return {
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
