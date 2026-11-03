<div align="center">

# PS Spark

**Text-to-image, in-canvas editing and layer decomposition for Adobe Photoshop.**

A UXP panel that puts cloud image models and your local ComfyUI on the same canvas —
selections, layers and a job queue that behave like Photoshop natives.

[Features](#features) · [Install](#installation) · [Quick start](#quick-start) ·
[ComfyUI](#local-comfyui-optional) · [Build & test](#build--test) · [中文说明](README.zh-CN.md)

![License](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)
![Photoshop](https://img.shields.io/badge/Photoshop-24.4%2B-31A8FF.svg)
![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows-lightgrey.svg)
![Tests](https://img.shields.io/badge/tests-705%20passing-brightgreen.svg)

</div>

---

PS Spark is a third-party plugin for Adobe Photoshop (UXP). It connects hosted image
models and a local ComfyUI instance directly to the document you are working on. Instead
of exporting a file, switching to a browser, and dragging the result back, you work with a
selection or a layer — the result comes back aligned, on its own layer, in the same document.

The panel has four tabs: **Generate**, **Edit**, **Decompose**, **History**. Everything else
(model choice, ComfyUI presets, language, defaults) lives behind one settings button.

PS Spark is free software under AGPL-3.0. If you paid someone for it, ask for a refund —
nobody is allowed to charge you for this plugin.

## Features

| Area | What you get |
|---|---|
| **Generate** | Text-to-image (1–4 candidates), similar image from the current canvas, product shots, multi-image fusion |
| **Edit** | Local redraw (selection or full canvas), erase / watermark removal, recolor, content retouch (including text), HD restore, old-photo restore, portrait retouch, line-art colorize, art fusion, in-place composite, image fusion |
| **Structure** | Outpaint with real canvas expansion (percent or pixels), cutout with transparent output |
| **Decompose** | Vision analysis → editable layer blueprint → per-layer extraction → layer group |
| **Local models** | ComfyUI presets, 4 built-in templates, one-click adaptation to the models actually installed |
| **Queue** | Cloud jobs 2 at a time, local jobs serial, results land in queue order, cancel one or all, append while running |
| **History** | Every result archived locally, re-insert into any document, cache management |
| **Languages** | Chinese / English, switchable at runtime; open-source builds default to English |
| **Developer** | Dev-only workbench: per-branch prompt overrides, model bench, diagnostic log |

### 16 tools, one registry

`js/registry.js` is the single source of truth. Each tool declares its input slots, prompt
policy, parameters, selection requirement, output shape and cost. The UI is generated from
those declarations, so a tool behaves the same whether it targets a cloud model or a local
workflow.

```
Generate   text2img · similar · product_shot · image_fusion
Redraw     local_redraw · erase · recolor · content_retouch
Repair     hd_restore · photo_restore · portrait_retouch
Creative   colorize · art_fusion · composite
Structure  outpaint · cutout
```

### What makes it different

**Selections and layers are first-class.** Edit tools export only the selected region or
layer, send it to the model, and place the result back at the same coordinates. When the
model returns a different aspect ratio, the result is cover-fitted and trimmed with a real
layer mask instead of being stretched.

**One queue for cloud and local.** Cloud requests run two at a time, local ComfyUI jobs run
serially, and results are written to the document in queue order. Each job carries a snapshot
of which layers existed when you clicked Run, so a concurrent result never leaks into the
next job's input. Cancelling one job does not disturb the others.

**Decomposition ends in editable layers, not a flattened image.** A vision model proposes a
layer blueprint; you edit names and descriptions; each layer is extracted separately. Element
layers are keyed against a flat background colour and then rebuilt from the original pixels,
so colour and lighting match the source. If a model ignores the flat-background instruction,
the plugin detects it and says so instead of producing an invisible layer.

**Local models without re-authoring workflows every time.** Built-in templates are adapted to
the model files actually present on the machine: subdirectories, backslashes, quantisation
levels and case differences are matched; GGUF loaders fall back to standard loaders when the
custom nodes are missing. Adaptation also runs before submission, so moving to another
machine usually needs no manual step.

## Requirements

- Adobe Photoshop **24.4 or newer** with UXP panel support
- macOS or Windows
- An API key for the image service (hosted models), and optionally one for a vision/text model
- [ComfyUI](https://github.com/comfyanonymous/ComfyUI) — optional, for local generation
- Node.js **20+** — build and tests only, not needed to run the plugin

## Installation

PS Spark is side-loaded, so Photoshop's developer mode must be on:
**Photoshop ▸ Settings (Windows: Edit ▸ Preferences) ▸ Plugins ▸ Enable Developer Mode**,
then restart Photoshop.

### Windows

1. Quit Photoshop completely.
2. Unzip the release package to a path without spaces or non-ASCII characters.
3. Run `Install-Windows.bat`. It copies the plugin to
   `%APPDATA%\Adobe\UXP\Plugins\External\` and removes older copies.
4. Start Photoshop → **Plugins ▸ PS Spark**.

### macOS

```bash
mkdir -p ~/Library/Application\ Support/Adobe/UXP/Plugins/External
cp -R ps-spark ~/Library/Application\ Support/Adobe/UXP/Plugins/External/
```

Quit and reopen Photoshop → **Plugins ▸ PS Spark**.

> The manifest id is `com.psspark.ps.assistant`. UXP settings and secure storage are scoped
> by id: builds before 1.7.0 used a different id, so API keys, presets and history from those
> builds are not carried over. Re-enter them once after upgrading. The panel and the menu
> always show **PS Spark**.

## Quick start

1. **Connect the service** — Settings ▸ Image service: base URL and API key. The key goes into
   Photoshop's encrypted secure storage when available, with local storage as a fallback.
   Nothing is sent anywhere except the endpoints you configure.
2. **Pick a model per job** — Generate, Edit and Decompose each remember their own model, so
   you can use a fast model for drafts and a larger one for final output.
3. **Generate** — type a prompt, choose a ratio and candidate count, press Run. Results land
   on a new layer and in History.
4. **Edit** — make a selection (or select a layer), choose a tool, describe the change. With
   no selection, redraw works on the whole canvas.
5. **Decompose** — analyse the current canvas or a layer, edit the blueprint, then extract
   the checked layers into a group.

## Local ComfyUI (optional)

Start ComfyUI (`Start-ComfyUI.command` / `Start-ComfyUI.bat` are included for convenience),
then go to **Settings ▸ Local ComfyUI**:

1. **Add built-in template** — four starting points are included:

   | Template | Graph |
   |---|---|
   | Klein 4B · text to image | GGUF unet + CLIP + VAE → KSampler → VAE decode |
   | Klein 4B · reference image | same stack, image-to-image with denoise |
   | Klein 4B · inpaint | same stack, mask-based latent |
   | Generic checkpoint · text to image | `CheckpointLoaderSimple` → CLIP encode ×2 → empty latent → KSampler |

2. **Adapt local models** — rewrites the workflow to the files this machine actually has:
   subdirectories, separators, quantisation and case are normalised; GGUF loaders are swapped
   for `UNETLoader` / `CLIPLoader` when the custom nodes are absent, with required defaults
   filled in. Ambiguous matches are reported, never guessed.
3. **Probe all** — checks every preset against the running server and reports missing model
   files or missing node classes separately.

Presets are grouped by their underlying model, so the model dropdown shows one entry per model
even when you keep separate text-to-image, reference and inpaint workflows.

For any other architecture (Flux dev, Qwen-Image, …), export an API workflow from ComfyUI
(**Workflow ▸ Export (API)**) and import the JSON. Mark only the capabilities the graph really
supports — claiming inpainting for a graph without an image input will fail at submit time.

## How it works

```
index.html, js/ui.js     Panel shell, registry-driven forms, result viewer
js/registry.js           16 tool declarations, prompt specs, parameter schema
js/app.js                Orchestration, queue, history, decomposition pipeline
js/ps.js                 Photoshop document/layer operations (batchPlay)
js/services.js           Configuration, model tables, ComfyUI adaptation
js/api.js                HTTP, polling, ComfyUI submission
js/store.js              Local archive and cache
js/i18n.js               Chinese/English dictionary and runtime translation
js/diag.js               Diagnostic log and progress reporting
```

Four mechanics do most of the work:

- **Per-job source snapshot** — before exporting a reference image, layers created after the
  job was queued (and previous plugin results) are temporarily hidden. If you select a layer,
  it is always kept: selecting it means you want to iterate on it.
- **Aligned result placement** — results are placed with cover-fit; when the aspect ratio
  differs by more than 1%, the overflow is trimmed with an editable layer mask.
- **Decomposition** — flat background keying, probe of the four corners, original-pixel
  reconstruction, then a mask rebuilt from alpha so the layer stays editable.
- **Queue** — a slot-based scheduler: two cloud slots, one local slot, ordered landing,
  per-job cancellation, and stale `running` jobs recovered after a crash.

## Build & test

```bash
node tools/build.mjs                 # release build (default UI language: Chinese)
node tools/build.mjs --channel=dev   # dev build with the developer workbench
node tools/build.mjs --target=oss    # open-source build (default UI language: English)
node tools/package-win.mjs --channel=release --lang=en  # English Windows zip

cd bench && npm install && npm test  # 9 suites, 705 assertions
```

The release build strips every developer-only module and fails if any marker survives. Tests
cover the panel UI, ComfyUI adaptation and execution, queue scheduling, Photoshop command
retries, prompt composition, the web bench and the concurrency pool.

```
ps-spark-plugin/     Plugin source (manifest.json, index.html, js/, icons/)
bench/               Automated tests, fixtures, prompt packs, web bench
docs/                Development log, acceptance checklists, integration notes
tools/build.mjs      Build script (dev / release / oss)
tools/package-win.mjs  Windows delivery packaging
```

## Status

Version **1.7.0**. The plugin runs on macOS and Windows against Photoshop 24.4+.

- Automated coverage: **705 assertions** across 9 suites
- Manual acceptance: features are verified on real Photoshop documents; passed chapters are
  archived separately so regressions only re-run what changed
- Known limits: decomposition quality depends on the image model following a flat background;
  extreme outpaint ratios are blocked with a confirmation rather than silently degraded

Planned: English documentation, more local workflow templates, preset sharing, CI.

## Documentation

The development documentation is currently written in Chinese; English translations are in
progress.

- [Development log](docs/dev/开发纪要-2026-10-30.md) — timeline, decisions, pitfalls, open items
- [Docs index](docs/README.md) — one-line summary of every design, plan and integration note
- [Acceptance checklist](docs/bench/实机验收清单-2026-11-01.md) — feature-by-feature manual checks
- [Windows test guide](docs/bench/Windows测试指南.md) — install, developer mode, smoke test
- [Local ComfyUI notes](docs/dev/integration/本地ComfyUI接入说明-2026-10.md)
- [Web bench guide](docs/bench/Web测试台-使用说明-2026-10.md)

## Contributing

Issues and pull requests are welcome. Before submitting, make sure that:

- no API keys, tokens or personal paths are included;
- no third-party copyrighted documents, prompts or assets are added;
- new UI text is added to both language dictionaries (`js/i18n.js`);
- `cd bench && npm test` passes.

By submitting a pull request you agree to license your contribution under AGPL-3.0.

## Privacy

No analytics, no telemetry, no phone-home. The plugin talks only to the image service,
text service and ComfyUI endpoints you configure. API keys are stored in Photoshop's
encrypted secure storage when available (local storage as a fallback). Generation history is
kept on your machine and can be cleared from the History tab.

## License

[AGPL-3.0](LICENSE). Commercial use is allowed. If you modify PS Spark and distribute it — or
offer it as a network service — you must make the corresponding source available under the
same license. See [NOTICE](NOTICE) for third-party components and trademark attribution.

## Disclaimer

PS Spark is not affiliated with, endorsed by, or certified by Adobe. "Adobe" and "Photoshop"
are trademarks of Adobe and are used only to describe the runtime. Model names and provider
names belong to their respective owners. You are responsible for API costs and for ensuring
that the content you generate or edit complies with the law and with the terms of the services
you use.

---

Copyright (C) 2026 Cao · [中文说明](README.zh-CN.md)
