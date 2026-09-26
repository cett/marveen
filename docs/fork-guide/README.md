# Fork Guide

Telepítési és üzemeltetési útmutató saját Marveen-példány futtatásához.

**Installation and operations guide for running your own Marveen instance.**

---

## Tartalom / Contents

| # | Magyar | English |
|---|--------|---------|
| F00 | [Előfeltételek](hu/F00-elofeltetelek.md) | [Prerequisites](en/F00-prerequisites.md) |
| F01 | [Telepítés](hu/F01-telepites.md) | [Installation](en/F01-installation.md) |
| F02 | [Konfiguráció](hu/F02-konfiguracio.md) | [Configuration](en/F02-configuration.md) |
| F03 | [Üzemeltetés](hu/F03-uzemeltetes.md) | [Operations](en/F03-operations.md) |
| F04 | [Architektúra](hu/F04-architektura.md) | [Architecture](en/F04-architecture.md) |
| F05 | [Csatornák konfigurálása](hu/F05-csatornak.md) | [Channel configuration](en/F05-channels.md) |
| F06 | [MCP connectorok](hu/F06-mcp.md) | [MCP connectors](en/F06-mcp.md) |
| F07 | Fleet és tenant-kezelés *(hamarosan)* | Fleet and tenant management *(coming soon)* |

---

## Gyors kezdés / Quick start

```bash
git clone https://github.com/Szotasz/marveen.git
cd marveen
./install.sh          # macOS / Linux
# .\install-windows.ps1  # Windows (PowerShell)
```

Dashboard: `http://localhost:3420`
