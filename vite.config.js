import { defineConfig } from 'vite';
import { readFileSync } from 'node:fs';

export default defineConfig({
  base: '/market-valuation/',
  plugins: [{
    name: 'valuation-data',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'data/valuation.json', source: readFileSync(new URL('./src/data/valuation.json', import.meta.url), 'utf8') });
    }
  }]
});
