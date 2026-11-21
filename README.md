# TOS Companion for TerraMaster

A Chrome and Microsoft Edge extension for quick access to your TerraMaster NAS (TOS 7) from the browser toolbar.

> Unofficial. Not affiliated with TerraMaster.

## Features

- **Overview:** System info, CPU, memory, network, volume health, temperatures and fan speed.
- **Apps:** Launch installed TOS apps from the popup.
- **Notifications:** View, dismiss or clear notifications, with an unread badge on the toolbar icon.
- **Docker:** Start, stop and restart projects or containers, and open container terminals or logs.
- **TOS terminal:** Reliable copy/paste, clickable links (`Cmd`/`Ctrl`+click) and scrollback search (`Cmd+F` / `Ctrl+Shift+F`).
- **Multi-NAS support:** Add multiple NAS devices or addresses (such as a local IP and a domain) and customise which tabs and badges appear.

## Install

Requires Chrome or Microsoft Edge (116 or later) and TerraMaster TOS 7.

**[Install from the Chrome Web Store](https://chromewebstore.google.com/detail/tos-companion-for-terrama/lkhbcgmcpkbaeaoeppghoicfdllmkbgh)**. In Microsoft Edge, turn on **Allow extensions from other stores** when prompted. After installing, add your NAS address (e.g. `https://192.168.1.10:5443`) in settings and allow access.

### Manual install

1. Download and unzip the latest release (or clone this repo).
2. Open `chrome://extensions` or `edge://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and select the extracted folder.
4. Add your NAS address in settings and allow access.

## Privacy

No passwords are stored. The extension uses your existing browser sign-in for the NAS addresses you add and sends nothing elsewhere. See the [privacy policy](docs/privacy.md).

## AI disclosure

TOS Companion was developed with assistance from Claude, an AI model by Anthropic.

## Licence

[MIT](LICENSE)
