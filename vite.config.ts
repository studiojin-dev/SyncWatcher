import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import license from 'rollup-plugin-license';
import path from 'path';

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

const MIT_LICENSE_BODY = `Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;

const licenseOverrides: Record<string, { licenseText: string; noticeText: string }> = {
  'react-remove-scroll-bar@2.3.8': {
    licenseText: `MIT License\n\nCopyright (c) Anton Korzunov\n\n${MIT_LICENSE_BODY}`,
    noticeText: 'The published package declares MIT but omits its LICENSE file. This text is supplied from the package metadata and upstream repository.',
  },
  'use-composed-ref@1.4.0': {
    licenseText: `MIT License\n\nCopyright (c) Mateusz Burzyński and contributors\n\n${MIT_LICENSE_BODY}`,
    noticeText: 'The published package declares MIT but omits its LICENSE file. This text is supplied from the package metadata and upstream repository history.',
  },
};

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    license({
      thirdParty: {
        output: {
          file: path.join(__dirname, 'dist', 'oss-licenses.json'),
          encoding: 'utf-8',
          template(dependencies) {
            return JSON.stringify(dependencies.map(dep => {
              const override = licenseOverrides[`${dep.name}@${dep.version}`];
              return {
                name: dep.name,
                version: dep.version,
                license: dep.license,
                repository: dep.repository,
                url: dep.homepage || dep.repository?.url,
                author: dep.author?.name,
                licenseText: dep.licenseText || override?.licenseText,
                noticeText: dep.noticeText || override?.noticeText,
              };
            }), null, 2);
          },
        },
      },
    }),
  ],

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
        protocol: "ws",
        host,
        port: 1421,
      }
      : undefined,
    watch: {
      // 3. tell vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
});
