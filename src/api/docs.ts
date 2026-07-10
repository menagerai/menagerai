import { getAbsoluteFSPath } from 'swagger-ui-dist';
import { config } from '../config';

// Absolute path to the swagger-ui-dist assets shipped in node_modules. We serve
// these ourselves (same-origin) rather than from a public CDN: gated pages must
// not depend on third-party CDNs that the GFW may block.
export function swaggerAssetsPath(): string {
  return getAbsoluteFSPath();
}

// Minimal Swagger UI host page. `assetBase` is the URL the swagger-ui-dist assets
// are served from; `specUrl` is our generated OpenAPI document. We hand-write the
// initializer so it points at our spec instead of the bundled petstore demo.
export function swaggerHtml(assetBase: string, specUrl: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${config.brandName} Admin API — Docs</title>
  <link rel="stylesheet" href="${assetBase}/swagger-ui.css">
  <style>body { margin: 0; } .topbar { display: none; }</style>
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="${assetBase}/swagger-ui-bundle.js" crossorigin></script>
  <script src="${assetBase}/swagger-ui-standalone-preset.js" crossorigin></script>
  <script>
    window.ui = SwaggerUIBundle({
      url: ${JSON.stringify(specUrl)},
      dom_id: '#swagger-ui',
      deepLinking: true,
      presets: [SwaggerUIBundle.presets.apis, SwaggerUIStandalonePreset],
      layout: 'StandaloneLayout',
      persistAuthorization: true,
      // The spec is behind admin auth, so the public validator.swagger.io service
      // can't fetch it — disable the validator badge (the "Invalid" it shows is
      // "can't read the file", not an actual spec error).
      validatorUrl: null,
    });
  </script>
</body>
</html>`;
}
