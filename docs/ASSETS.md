# Third-party assets

Every non-code third-party asset (models, textures, audio, fonts, images) used by Patrol is listed here with its license.
Patrol ships **none**: every visual and audio element is original and generated in code at run time, so there is nothing
to attribute or license.

| Asset | Source | License | Used for |
|-------|--------|---------|----------|
| none | | | |

Libraries (three.js, Rapier, bitECS and the dev tooling) are code dependencies, not assets; they are pinned in
`package.json`.

## Procedural content

Everything the player sees and hears is produced by code in this repository:

**Audio** (`src/audio`, Web Audio; no audio files exist in the repository or the build):
- Sirens (wail, yelp, phaser, hi-lo), the air horn and the manual siren: oscillators with Doppler shift by relative velocity.
- Engines (8 profiles by vehicle style, from the driven car's RPM and throttle, and 3 pooled traffic engines), tire squeal and
  gravel crunch: oscillators and seeded noise through filters.
- Ambience beds (traffic rumble, mains hum, wind, rain, birds, crickets, water) by district, hour and weather.
- Radio effects (squelch, key-up and key-down tones, static) and radio chatter (unintelligible formant babble under live
  traffic); spoken lines use the browser's own text-to-speech where the user's browser provides it (not bundled, optional).
- Interface sounds (move, select, back, open, close, error, notify).
- All randomness in audio comes from seeded streams, and the tuning tables are JSON under `src/data/audio/`.

**Textures** (generated on canvases at run time or flat colours):
- Building window textures, drawn on a canvas (`src/world/render/cityMaterials.ts`); roads, markings and the ground use flat colours and geometry.
- Livery atlases: the 1024x512 colour atlas and the reflective atlas painted from the livery layers (stripes, shapes, text,
  decals) by `src/livery` and `LiveryRenderer`.
- The in-car MDT screen (a canvas) and the bodycam / evidence thumbnails (160x90 JPEG captures of the live canvas, stored locally in the browser).

**Meshes and effects** (built from code):
- The city (buildings, roads, signals, props), vehicles (17 generic models from `src/data/vehicles/*.json`), people (bone-less
  instanced limbs and a uniform outfit built from accessory boxes), interiors (generated floor plans and furniture boxes).
- Light-bar glow, ground light pools, headlight cones, particles, the TASER arc, rain splashes and the wet-road sheen
  (`src/render/vfx`, shaders written in this repository).

**Data**: names, streets, call types, statutes, rulesets, dialogue and radio phrasing are original generic content in
`src/data/**/*.json`.

## Rules

- No real agency names, badges, logos, patches, uniforms or liveries. Everything uses generic names ("Generic State",
  numbered units, invented street and district names).
- No real vehicle brands or marks, no real product names or trademarks.
- No assets, code, models, textures, sounds or text from GTA, LSPDFR or any other game.
- No recorded or licensed audio, no music files, no bundled fonts or images.
- A third-party asset is added only after a row for it exists in the table above (source, license, what it is used for); prefer
  generating the content in code instead. Mods are the player's own files and are not part of the repository.
