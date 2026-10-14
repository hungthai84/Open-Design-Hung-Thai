# Third-party software notices

This folder is part of the bundled design-template resource tree. It must ship
with any binary distribution that includes this renderer. The repository's
Apache-2.0 license does not replace third-party licenses.

| Component | Version / source | License / notice |
|---|---|---|
| Painting/timeline toolkit by John Heibel | ClaudeAnimationBase `0ac8bf2b31942376cb6b8c4074715595d512acd2` | MIT, original notice in ../LICENSE |
| p5.js, Processing Foundation and contributors | 2.3.3, https://github.com/processing/p5.js/tree/v2.3.3 | LGPL-2.1, p5-LGPL-2.1.txt |
| p5.brush, Alejandro Campos Uribe | 2.2.3, https://github.com/acamposuribe/p5.brush | MIT, p5.brush-MIT.txt |

## p5.js corresponding source

p5-2.3.3-source.tar.gz contains unmodified library sources, shaders, interface
files, translations, build utilities/configuration, package metadata and lockfile
from the official v2.3.3 source archive. Non-build tests, examples and contributor
illustrations are omitted. This ships the source itself instead of relying on a
future written offer or a third-party download link.

Archive SHA-256: 82ce89f35c4a4155ac9c3c7ec43d399e9a63ba905314abbb7a699e27e23ebd61.

The LGPL applies to p5.js, separately from the integration. Recipients retain
its modification and redistribution rights. Extract the archive, run npm ci and
npm run build in its root, then replace the separate p5 package's lib/p5.min.js
with the rebuilt file. The daemon reads that file at render time without a hash
allowlist. Rebuilding OpenDesign from its public source is another way to use a
modified library. The library is unmodified and is not compiled into OD's own
application source. See the complete LGPL text for the precise terms.

The installed p5 package also includes its unminified lib/p5.js, containing
third-party module notices; keep it and the package license when distributing
that package. Before publishing an installer, verify that this notices/source
folder and the complete p5 package remain accessible in the shipped resources.
No license or permission to Anthropic trademarks or mascot artwork is claimed.
