# PS Spark 1.7.1 — Windows & macOS

A Photoshop (UXP) panel for AI image generation and editing: text-to-image, reference-guided
variations, inpainting, outpainting, object removal, cutout, layer decomposition and history —
all without leaving Photoshop.

Licensed under **AGPL-3.0**. Not an Adobe product; not affiliated with or endorsed by Adobe.

## Downloads

| Platform | Package | Default UI |
|---|---|---|
| Windows 10/11 | 1.7.1 build to follow (use the 1.7.0 package in the meantime) | English |
| macOS | `PS-Spark-1.7.1-mac-2026-11-06.zip` | English |

The Windows package will be refreshed separately to 1.7.1. The language can be switched at
runtime under Settings ▸ Language.

## What's new

- Model catalog adds `gpt-image-2.6` and uses it as the default for new installs.
- Version 1.7.1 aligns the release tag and source archive with the shipped package; 1.7.0 had
  the 2.6 code only on `main`.
- Windows 1.7.1 package follows separately.

## Features

- **Generate** — text to image, similar image from a reference, batch variations
- **Edit** — local redraw, outpaint, erase, cutout, recolor, retouch, art fusion, composite
- **Decompose** — split one image into separate layers; each element keeps its original
  position and scale, with a transparent background
- **History** — browse past results, insert as a layer, rerun
- **Local ComfyUI (optional)** — run supported workflows on your own machine; cloud features
  do not depend on it
- **Bilingual UI** — English and Chinese, switchable at runtime

## Requirements

- Windows 10/11 or macOS
- Photoshop 24.4 or newer (2023+), with Developer Mode enabled
- An API key for the image service, or a local ComfyUI install

## Install — Windows

1. Download the Windows package above and extract it.
2. Run `Install-Windows.bat`, or copy the `com.psspark.ps.assistant_1.7.1` folder into
   `%APPDATA%\Adobe\UXP\Plugins\External\`.
3. In Photoshop: Edit ▸ Preferences ▸ Plug-ins ▸ enable **Developer Mode**.
4. Restart Photoshop, then open **Plugins ▸ PS Spark**.
5. In the panel: Settings ▸ Service, paste your API key.

## Install — macOS

1. Download the macOS package above and extract it.
2. Copy the `com.psspark.ps.assistant_1.7.1` folder into the UXP plug-ins directory:

   ```bash
   mkdir -p ~/Library/Application\ Support/Adobe/UXP/Plugins/External
   cp -R com.psspark.ps.assistant_1.7.1 ~/Library/Application\ Support/Adobe/UXP/Plugins/External/
   ```

3. In Photoshop: Settings ▸ Plug-ins ▸ enable **Developer Mode**.
4. Quit Photoshop completely, reopen it, then open **Plug-ins ▸ PS Spark**.
5. In the panel: Settings ▸ Service, paste your API key.

Full instructions and troubleshooting: `INSTALL-Windows.txt` / `INSTALL-macOS.txt`.

## Notes

- Local models are supported through ComfyUI, but they are not plug-and-play: adapt the
  workflow to the model files installed on your machine. The local models tested on Windows
  and on macOS are not the same set, so a preset may need adapting after moving machines.
- API keys are stored locally (UXP secure storage) and are never uploaded.
- Review generated or edited content before commercial use.
- Diagnostics log:
  `%APPDATA%\Adobe\UXP\PluginsStorage\PHSP\<PS major>\External\com.psspark.ps.assistant\PluginData\psspark_debug.log` (Windows) ·
  `~/Library/Application Support/Adobe/UXP/PluginsStorage/PHSP/<PS major>/External/com.psspark.ps.assistant/PluginData/psspark_debug.log` (macOS)
- Feedback: **psspark-feedback@hotmail.com**

## License

AGPL-3.0. See [LICENSE](https://github.com/henry-cao1/ps-spark/blob/main/LICENSE). If you
distribute a modified version you must also make the complete source available under the same
license.
