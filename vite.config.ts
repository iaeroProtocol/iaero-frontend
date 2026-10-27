import {defineConfig} from 'vitest/config';
import tailwindcss from '@tailwindcss/vite';
import {fileURLToPath} from 'node:url';
import {baseApiMiddleware} from './server/base-rpc.ts';

export default defineConfig({
  envDir: false,
  resolve: {alias:{'@':fileURLToPath(new URL('./src/restored',import.meta.url))}},
  plugins: [tailwindcss(),{name:'public-client-routing',generateBundle(){const commit=process.env.IAERO_RELEASE_COMMIT;this.emitFile({type:'asset',fileName:'frontend-config.json',source:JSON.stringify({protocolDataOrigin:process.env.VITE_PROTOCOL_DATA_URL||null,stage:process.env.VITE_APP_STAGE==='production'?'production':'local',sourceCommit:commit&&/^[0-9a-f]{40}$/.test(commit)?commit:null})+'\n'});}},{name:'local-base-read-api',configureServer(server){server.middlewares.use(baseApiMiddleware({collect:false}));},configurePreviewServer(server){server.middlewares.use(baseApiMiddleware({collect:false}));}}],
  server: {host: '127.0.0.1', port: 4317, strictPort: true},
  preview: {host: '127.0.0.1', port: 4317, strictPort: true},
  define: {
    'process.env.NEXT_PUBLIC_SAERO_ENABLED': 'false',
    'process.env.NEXT_PUBLIC_SAERO_ADDRESSES_JSON': 'undefined'
  },
  build: {sourcemap: true,reportCompressedSize:false,rolldownOptions:{onLog(level,log,handler){if(log.code==='MODULE_LEVEL_DIRECTIVE')return;handler(level,log);}}},
  test: {include: ['test/**/*.test.ts']}
});
