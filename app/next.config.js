/** @type {import('next').NextConfig} */
const nextConfig = {
  // Standalone output for minimal Docker images
  output: 'standalone',
  // Custom port
  env: {
    PORT: '6969',
  },
  // Baileys is added as an external because it has optional image-processing
  // deps (jimp, sharp) that are imported via `import('...').catch(() => {})`
  // at runtime. Turbopack's static module resolution flags these as missing
  // at build time even though Baileys handles their absence gracefully. We
  // only send text, so those deps are never reached. Treating Baileys as
  // an external also keeps puppeteer/baileys out of the client bundle.
  serverExternalPackages: ['puppeteer', 'israeli-bank-scrapers', 'bufferutil', 'utf-8-validate', '@whiskeysockets/baileys', 'jimp', 'sharp'],
  // instrumentation.ts's WhatsApp module chain (whatsapp-client.js -> the
  // messages.upsert handler -> whatsappCategorizationListener.js) reaches
  // pages/api/db.js -> config/resource-config.js via a dynamic import several
  // hops deep from a non-page entry point. Next's automatic output-file
  // tracing missed that transitive file in the standalone build (confirmed:
  // config/resource-config.js was simply absent from the built image,
  // causing "Cannot find module" only when a real incoming WhatsApp message
  // triggered that code path) - force-include it explicitly.
  outputFileTracingIncludes: {
    '/**': ['./config/**/*'],
  },
};

export default nextConfig;
