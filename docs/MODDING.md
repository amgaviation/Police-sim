# Modding Patrol

A mod is plain JSON. It adds or tunes game data (call types, laws, vehicles, uniforms, district numbers, voices, dispatch
scripts) without touching code. Mods are validated with clear error messages, stored in the browser, switched on and off in
the mod manager and applied when the page loads.

- Everything is **data**. There is no scripting language and a mod cannot run code.
- The TypeScript validators in `src/mods/schema.ts` are authoritative. The JSON Schema files in `docs/schemas/` describe the
  same shapes for editors (draft 2020-12); a test keeps their required properties in step with the validators.
- Examples: `examples/mods/night-shift-pack.json` (one file) and `examples/mods/example-folder/` (a folder with `mod.json`).

## 1. Installing, enabling, ordering

1. Open the **mod manager** (main menu, Mods) and pick a `.json` file, or pick a whole folder that contains `mod.json`.
2. The mod is validated when it is installed. Every problem is listed with the mod id, a dotted path and a message, for
   example `night-shift-pack: districts.harbor.crimeFactor: must be in [0.2, 3], got 9`. A mod with any error is not
   installed at all; nothing is accepted partially.
3. Enable the mod and put the enabled mods in **load order** (later mods win, see section 4). When the list is saved, the
   enabled set is validated together; two mods that define the same content id cannot be enabled at the same time.
4. **Reload the page.** Mods are applied once, at page load, before the game data is read. Changing the list never
   changes a running game.

The enabled list is kept in the browser (`localStorage` key `patrol-mods-enabled`), the mods themselves in IndexedDB
(database `patrol-mods`). Both stay on your machine.

### Safe mode

- Open the game with `?nomods` in the address (for example `http://localhost:5173/?nomods`) to start without any mod. Nothing
  is deleted.
- If the game fails to start while mods are active (for example after a game update changed a table a mod relied on), the
  game turns on **safe mode**: it sets the `patrol-mods-safe` flag in `localStorage`, reloads without mods, and the mod
  manager shows "Mods were disabled after a failed start". Re-enabling mods in the manager clears the flag.

### Saves and determinism

The simulation is deterministic, and mods change the data it reads. A save therefore records the active mods (id, version
and a content hash). Loading a save without the same mods enabled fails with a message that names the missing or changed
mods; enable them (in the same order) and reload. Removing or editing a mod after saving has the same effect.

## 2. File formats

### One file (a bundle)

```json
{
  "format": "patrol-mod",
  "version": 1,
  "id": "night-shift-pack",
  "name": "Night shift pack",
  "author": "Example author",
  "description": "What the mod does.",
  "modVersion": "1.0.0",
  "content": { "districts": { "harbor": { "label": "Harbor Row" } } }
}
```

| Field | Rule |
|---|---|
| `format` | exactly `"patrol-mod"` |
| `version` | exactly `1` (the bundle format version) |
| `id` | `/^[a-z0-9][a-z0-9-]{1,39}$/`: 2 to 40 characters of lower-case letters, digits and `-` |
| `name` | 1 to 60 characters |
| `author` | at most 60 characters (may be empty) |
| `description` | at most 400 characters (may be empty) |
| `modVersion` | `major.minor.patch`, for example `1.0.0` |
| `content` | an object with at least one content kind (section 3); unknown kinds and unknown manifest keys are errors |

### A folder

Pick a folder that contains `mod.json`. `mod.json` is the manifest above, **without** `content` and with a `files` map from
content kind to relative paths:

```json
{
  "format": "patrol-mod", "version": 1, "id": "example-folder", "name": "Example folder mod",
  "author": "Example author", "description": "Folder form of a mod.", "modVersion": "1.0.0",
  "files": {
    "callTypes": ["calls/noise.json"],
    "rulesets": ["laws/example-city.json"],
    "dispatchScripts": ["scripts/quiet-harbor.json"],
    "voicePacks": ["voices/steady.json"],
    "uniforms": ["uniforms/colors.json"],
    "districts": ["districts/table.json"]
  }
}
```

The loader reads each listed file and builds the same bundle a single file would be:

- `callTypes`: each file is one `{ "family": "...", "types": [...] }` document (a leading `"version": 1`, as in the base
  files, is ignored).
- `statutes`: each file is one statute row, or an array of rows.
- `rulesets`, `vehicles`, `voicePacks`, `dispatchScripts`: one document per file. A ruleset file must be named after its
  id (`laws/example-city.json` holds `"id": "example-city"`).
- `uniforms`, `districts`: each file is a patch object; several files are merged in the listed order (later files win per
  key).

Paths are relative to the folder of `mod.json`. The folder name itself is ignored, so it does not matter whether the
browser reports `pack/calls/x.json` or `calls/x.json`.

## 3. Content kinds

Every id a mod adds must be new: it may not exist in the base game or in another enabled mod. Patches (uniforms, districts,
voice packs) change existing things instead. The "copy from" files are in `src/data/`.

### `callTypes`

An array of `{ "family", "types" }`. `family` must be an existing call family id (`src/data/calls/families.json`: for
example `parking`, `disturbance`, `welfare`, `property`). Each type is a row like those in `src/data/calls/types/<family>.json`
and **inherits the family defaults** for every key it does not set (priority weights, location, units, on-scene time,
callers, district weights, dispositions).

Required per type: `id` (new), `label`, `category` (a crime category of `src/environment/crime.ts`), `generated`
(`true` lets the random generator pick it), `weight` (greater than 0 when generated), `narratives` (at least two strings;
placeholders such as `{address}`, `{near}`, `{street}`, `{cross}`, `{vehicle}`, `{plate}`). Optional: `codeKey`, `priority`,
`location`, `districts`, `units`, `onSceneS`, `callers`, `fill`, `dispositions`, `branchWeights`, `variants`.

```json
{ "family": "parking", "types": [ {
  "id": "loadingZoneBlocked", "label": "Loading zone blocked", "category": "traffic", "generated": true, "weight": 0.2,
  "narratives": [
    "Business reports a {vehicle}, plate {plate}, blocking the loading zone at {address}.",
    "Delivery driver at {address} advises a car, plate {plate}, has been in the loading zone all night."
  ] } ] }
```

New call types go through the same validators as the shipped ones (`validateCatalog` and `validateCallTypes`), so a wrong
branch name, an unknown disposition or an unknown placeholder is reported with its path, for example
`callTypes[0].types[0].category: must be one of ..., got "nonsense"`. A new family is not possible; use an existing one.
Copy from: `src/data/calls/types/*.json`.

### `statutes`

An array of statute rows (the `statutes` array of `src/data/cad/statutes.json`):

```json
{ "id": "TR-399", "title": "Blocking a loading zone", "category": "traffic", "class": "infraction",
  "fine": 90, "citeable": true, "bookable": false }
```

`id` looks like `TR-399` (two capital letters, a hyphen, three digits) and must be new. `category` is `traffic` or
`criminal`; `class` is `infraction`, `misdemeanor`, `felony` or `warrant`; `fine` is 0 to 1,000,000; `speed` is optional.
Mod statutes are appended to the table; the maps that connect violations and plate issues to statutes are not extendable.

### `rulesets`

An array of full jurisdiction ruleset documents like `src/data/legal/rulesets/generic.json` (copy it and change what you
want). The `id` must be new and usable as a file name (`/^[a-z][a-z0-9-]{1,39}$/`). The whole document is checked by the
same parser as the shipped rulesets, field by field (`rulesets[0].pursuit.maxDurationS: must be in [1, Infinity], got 0`).
The jurisdiction picker lists the new ruleset next to `generic` and `strict`.

### `vehicles`

An array of vehicle model documents like `src/data/vehicles/*.json`. Copy the closest base model, give it a **new** `id`
(`/^[a-z][a-z0-9_]{1,39}$/`, also its file name) and change what you need. The parser reports the exact field
(`vehicles[0].body.length: must be in [...]`). Mod models are appended after the shipped ones and take the next model
indexes, so saves that refer to a base model keep working. The game supports at most **255** vehicle models in total.
Models are generic boxes with procedural bodies: use your own names and colours, not brands or real liveries.
A mod vehicle also has upper limits (about three times the largest shipped value, for example `mass` 60000, `body.length` 25,
`engine.maxSpeedKmh` 400, `tires.radius` 1.2, `trafficWeight` 100); a value beyond them is rejected with its path
(`vehicles[0].mass: must be at most 60000 for a mod vehicle, got 1e+300`). Call type and branch `weight` values are limited to 1000.

### `uniforms`

A patch over `src/data/uniform/uniforms.json`:

```json
{ "classes": [ { "id": "classB", "label": "Class B (night duty)", "top": "#1f3d4d" } ],
  "department": { "badge": { "enamel": "#1b4d2e" } } }
```

- `classes`: each entry's `id` must be an existing class (`classA`, `classB`, `tactical`, `bike`, `motor`, `swat`,
  `detective`); you cannot add classes. The listed keys replace the same keys of that class; colours are `"#rrggbb"`.
- `department`: merged into the department block; `patch` and `badge` are merged key by key (so `{ "badge": { "enamel":
  "#1b4d2e" } }` keeps the badge shape, metal and text). Use generic names and initials; no real agency.

The patched document is parsed by the normal uniform parser, so a bad colour or hat name is reported with its path.

### `districts`

An object keyed by district name (`downtown`, `suburbs`, `industrial`, `highway`, `rural`, `campus`, `hospital`, `airport`,
`harbor`, `park`, `water`); this is the "map" mod: it tunes numbers per district, it does not change the city geometry.

| Field | Range | Effect |
|---|---|---|
| `label` | 1 to 40 characters | display name shown in the UI (`districtLabel`) |
| `crimeFactor` | 0.2 to 3 | multiplies the district's base crime level in the persistent world |
| `trustBaseline` | 0.05 to 0.95 | replaces the district's neighbourhood trust baseline |

At least one field per district. Unknown districts are errors.

### `voicePacks`

An array of voice packs; the **last enabled pack wins**.

```json
{ "id": "night-desk", "name": "Night desk",
  "voices": { "dispatcher": { "pitch": [0.9, 1.0], "rate": [1.0, 1.08], "prefer": ["en-GB"] } },
  "phrases": { "accept": { "tenCode": ["{unit}, {code:ack}, I'll take it, {code:enRoute}."], "plain": ["{unit}, copy, taking it, on my way."] } } }
```

- `voices`: any of `dispatcher`, `officer`, `agency`, `player`. Each needs `pitch` and `rate` as `[min, max]` (both between
  0.5 and 2, min not above max) and `prefer`, at most 8 strings. Every speaker of that kind gets a pitch and rate inside the
  range (derived from its callsign, as before). `prefer` narrows the browser's voice list to voices whose name or language
  contains one of the strings (case-insensitive); when none match, all voices stay available. `dispatcher` narrows the
  dispatcher voice; `officer` narrows the pool used for every other speaker.
- `phrases`: keys are radio phrase kinds (`assign`, `unitAck`, `accept`, `code4`, ...; the full list is `PHRASE_KINDS` in
  `src/radio/data.ts`). `tenCode` and `plain` are the two radio styles; each array **replaces** the shipped lines of that
  kind and style. Templates are checked with the radio rules (known `{placeholders}` and `{code:key}` only).

### `dispatchScripts`

An array of `patrol-dispatch-script` documents for the dispatch-only mode (see `src/data/training/scripts/*.json`):
`format`, `version`, `id`, `name`, `description`, `generator` (`on` or `off`), `durationS` (60 to 7200) and `steps` (1 to
100, sorted by `atS`). Each step has `atS`, `typeId`, `near` (`{ "poi": ... }`, `{ "district": ... }` or `{ "x", "z" }`) and
optional `priority`, `narrative`, `radio`. A script may use the call types of the base game **and** of the same mod; errors
read like `dispatchScripts[0].steps[3].typeId: unknown call type "barFightt"`.

## 4. Load order and precedence

- The enabled list is the load order. Mods are applied first to last.
- **Content ids** (call types, statutes, rulesets, vehicles, dispatch scripts) must be unique across the base game and all
  enabled mods. If a later mod repeats an id of an earlier one, the later mod is not loaded and the error names both.
- **Patches** are different, later wins:
  - `districts`: for each district key the later mod's entry replaces the earlier one completely.
  - `uniforms`: patches are applied in order; a later patch overrides the same keys.
  - `voicePacks`: only the last pack of the last mod that has one is used.
- Call types are appended after the shipped ones, mods in load order, so the random generator's choices stay stable for
  a given set of mods.

## 5. Limits

- A mod file (or all files of a folder together) is at most **2 MiB**.
- At most 255 vehicle models in total (base plus mods).
- Text limits are listed per field above. Numbers must be finite.
- Mods are validated when installed and again, as a set, when the enabled list is saved. If a game update later breaks an
  enabled combination, the game starts in safe mode (section 1).

## 6. Error messages

Every problem is reported as `<mod id>: <path>: <message>`:

```
night-shift-pack: districts.moonbase: unknown district "moonbase" (known: downtown, suburbs, ...)
night-shift-pack: vehicles[0].id: "patrol_sedan" already exists in the base game
night-shift-pack: callTypes[0].family: unknown call family "noSuchFamily" (known: animal, ...)
night-shift-pack: voicePacks[0].voices.dispatcher.pitch[0]: must be in [0.5, 2], got 0.4
```

`path` is a dotted JSON path inside the bundle (`content` is not repeated). Reading problems come first and name the file:
`calls/noise.json: not valid JSON (Unexpected token ...)`, `No mod.json in the selected folder`, `Mod is 3.1 MiB; the limit
is 2.0 MiB`. All problems found are listed, not only the first.

## 7. No copyrighted content

Mods must be your own work. Do **not** include real agency names, badges, logos, liveries, vehicle makes or models,
trademarks, or assets from other games (including GTA or LSPDFR content). Use generic names ("City Police") and invented
vehicles. The game ships no third-party assets, and mods are plain data that cannot contain images or audio.
