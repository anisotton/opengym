# Third-party notices

openGym — Copyright (C) 2026 Duarte Santos.
openGym's own code is licensed under the **GNU AGPL v3.0** (see [LICENSE](LICENSE)).

## Modified version

This repository, <https://github.com/anisotton/opengym>, is a **modified version** of openGym,
forked from <https://github.com/DuarteSantos8/openGym> on 2026-09-29 and maintained by
Anderson Isotton (Isotton Corp). It remains under the **GNU AGPL v3.0**; the original copyright
and every notice below are kept unchanged. As required by section 5(a) of the AGPL, changes made
in this fork are recorded in its git history (commits after upstream `e88062e`), and the complete
source of the version running on any instance is published here. This fork also ships its own
media, **© Brilhart Fitness** rather than AGPL, for 128 exercises — see "Brilhart exercise media"
below.

## App store exception

As an additional permission under section 7 of the AGPL v3.0, the copyright holder permits
distribution of the openGym mobile application through app store platforms (such as the
Apple App Store and Google Play) whose terms of service would otherwise be incompatible
with the AGPL, provided the corresponding source code remains available under the AGPL at
the project repository. This permission applies to the distribution channel only and does
not otherwise limit the license.

## Brilhart exercise media

`frontend/public/brilhart/` ships Brilhart's own images and animations for 128 exercises,
**© Brilhart Fitness, all rights reserved**:

- the 4 port de bras exercises added for this fork (`frontend/src/lib/exercises-brilhart.js`,
  ids `bf01`–`bf04`) — their text (name, instructions) is Brilhart's own too, not from the
  dataset below;
- 124 of the 1,324 built-in exercises from the dataset below (`frontend/src/lib/
  exercises-brilhart-124.js` overlays the media onto the matching `frontend/src/lib/
  exercises-data.js` id) — only the image and animation are Brilhart's; the exercise's name,
  attributes and instructions stay the dataset's own MIT-licensed text, unchanged.

This media is **not** licensed under the MIT license that covers the built-in exercises' text
below, and **not** under openGym's AGPL — it is included in this repository only as an aggregate
work alongside the AGPL code, per AGPL section 5. Reuse outside this app needs Brilhart Fitness's
written permission. See `frontend/public/brilhart/COPYRIGHT.md`.

As of this version, the app's own exercise library, search, filters, muscle explorer and
exercise picker show only these 128 Brilhart-illustrated exercises plus a user's own custom
ones — the rest of the dataset below stays in the app text-only, resolving normally for any
routine, workout or history entry that already cites one, but no longer offered to browse or
add.

## Body diagram geometry

The muscle outlines the body maps are drawn from (`frontend/src/lib/body-paths.js`) are derived
from [**MuscleMap**](https://github.com/melihcolpan/MuscleMap) by Melih Colpan, used under the
**MIT License** and reproduced below. MuscleMap ships its path data as Swift source rather than
`.svg` files; the paths were converted to a JSON module, its sub-group shapes were dropped, and
nothing else about the artwork was changed.

```
MIT License

Copyright (c) 2026 Melih Colpan

Permission is hereby granted, free of charge, to any person obtaining a copy
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
SOFTWARE.
```

## Exercise text (names, muscles, descriptions, instructions)

The catalogue in `catalogue/` is openGym's own and is edited by its community (see
`catalogue/README.md`). Entries marked `"textSource": "exercisedb"` (the 1,324 exercises openGym
shipped before v1.4.0) keep names, muscles and instructions that originate from
[**ExerciseDB v1**](https://exercisedb.dev/) by AscendAPI and reached openGym through
[**hasaneyldrm/exercises-dataset**](https://github.com/hasaneyldrm/exercises-dataset), under the MIT
licence reproduced below. Everything else in the catalogue (the newer exercises, every description,
the muscle-map corrections and all translations) was written for openGym and is covered by
openGym's AGPL.

```
MIT License

Copyright (c) 2026 Hasan Emir Yıldırım

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation and data files (the "Software"),
to deal in the Software without restriction, including without limitation the
rights to use, copy, modify, merge, publish, distribute, sublicense, and/or
sell copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### Images & animations — removed, third-party, never MIT nor AGPL

**Removed from this project as of ISO-1601/ISO-1603.** The exercise thumbnails (180×180) and
animations described below — the disputed-ownership ones this section is about — are no longer
shipped, downloaded or referenced anywhere in this repository, its container images or its
mobile builds. 124 of the 1,324 built-in exercises since gained different, Brilhart-owned media
instead ("Brilhart exercise media" above); the rest stay text-only (metadata and instructions,
MIT, above). The history below is kept for provenance; it no longer describes what this project
does.

The thumbnails and animations were **not** covered by the MIT license above and **not** by
openGym's AGPL. Their ownership was **unresolved**, and openGym stated this plainly rather than
guessing:

- The upstream dataset attributes them to **© [Gym visual](https://gymvisual.com/)**, redistributed
  there with that rights holder's written permission — a permission granted to *that dataset* and
  **not transferable**.
- **ExerciseDB/AscendAPI** describes itself as "the original creator and owner" of this content and
  publishes its own [terms](https://exercisedb.io/faq), which permit self-hosting, bundling and
  commercial display, while prohibiting redistribution of the raw dataset or media as a standalone
  or competing content package.

These two claims contradicted each other, and were never resolved before the decision above to
remove the media entirely.

**openGym never redistributed it.** It was not in this repository, not in its history, and not in
the published container images or the Android APK — a self-hosted instance downloaded it from the
upstream source on first `docker compose up`, and the mobile and demo builds loaded it from a CDN
at runtime. None of that happens anymore.

If you want to reuse the media yourself — in openGym or anywhere else, commercially or not —
**clear it with the rights holder first**, and keep any attribution that accompanies it intact.

Brazilian Portuguese exercise instructions and names (now in `catalogue/i18n/pt-BR.json`) are original translations of that
English source produced with OpenAI Codex and Anthropic Claude Code
language-model assistance. They are not copied from a separate Portuguese
dataset. Their review status and translation policy are documented alongside
the source files.

## Gym check-in QR codes

The gym check-in feature (a saved membership code shown as a QR code on the phone, added by
typing, importing a photo, or scanning with the camera) uses three third-party packages. All are
permissively licensed and compatible with openGym's AGPL, and all load on demand: the QR renderer
and the browser decoder only when a card is shown or scanned, the ML Kit plugin only in the
Android/iOS app.

### QR/barcode rendering — `lean-qr`

openGym renders each saved code on the phone with [**lean-qr**](https://github.com/davidje13/lean-qr)
by David Evans, used under the **MIT License** and reproduced below. Only the code's stored value
is kept; the picture is generated fresh from that value each time it is shown, never stored.
It runs the same way in the app and in the browser/PWA.

```
MIT License

Copyright (c) 2021-2025 David Evans

Permission is hereby granted, free of charge, to any person obtaining a copy
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
SOFTWARE.
```

### Camera scan & photo decode in the browser — `jsQR`

In a browser (including the installed PWA), reading a code from the camera or from an imported
photo uses [**jsQR**](https://github.com/cozmo/jsQR) by Cosmo Wolfe, under the **Apache License
2.0** (text at <https://www.apache.org/licenses/LICENSE-2.0> and in the package's own `LICENSE`).
Where the browser has a native `BarcodeDetector`, that is tried first and jsQR is the fallback.
Video frames are decoded in memory and never uploaded or stored.

### Camera scan & photo decode in the app — `@capacitor-mlkit/barcode-scanning`

In the Android/iOS app, reading a code — from the camera or from an imported photo — uses the
[**@capacitor-mlkit/barcode-scanning**](https://github.com/capawesome-team/capacitor-mlkit) plugin
by the Capawesome Team (Robin Genz), a Capacitor wrapper around Google's ML Kit, used under the
**Apache License 2.0**. openGym pins the `7.x` line to stay on Capacitor 7. The full license text is
available at <https://www.apache.org/licenses/LICENSE-2.0> and in the package's own `LICENSE` file.
The decoded string is what openGym keeps; the photo itself is never stored.
