# F06 MCP connectorok

Az MCP (Model Context Protocol) connectorok kiterjesztik az ágensek eszközkészletét: fájlrendszer-elérés, webes keresés, Google Workspace, GitHub, kommunikációs eszközök és más külső rendszerek. A Marveen beépített MCP katalógust tartalmaz, amelyet a dashboard Beállítások > MCP oldalán kezelhetsz.

## MCP konfiguráció helye

Az MCP szerverek a Claude Code `.mcp.json` fájlokban vannak definiálva:

| Fájl | Hatókör |
|------|---------|
| `.mcp.json` (projekt gyökér) | Minden ágens által örökölt alap-konfiguráció |
| `agents/<name>/.mcp.json` | Egy adott ágensre vonatkozó konfiguráció |

Az ágensek indításkor betöltik a projekt-szintű és a saját `.mcp.json` konfiguráción belül definiált összes szervert.

### .mcp.json struktúra

```json
{
  "mcpServers": {
    "szerver-neve": {
      "command": "npx",
      "args": ["-y", "@szervezet/mcp-szerver-csomag"],
      "env": {
        "API_KEY": "vault:az-api-kulcs-id"
      }
    }
  }
}
```

Távoli (HTTP) MCP szerver esetén:

```json
{
  "mcpServers": {
    "szerver-neve": {
      "type": "http",
      "url": "https://api.pelda.com/mcp",
      "headers": {
        "Authorization": "Bearer vault:token-id"
      }
    }
  }
}
```

## Beépített katalógus

A Marveen 14 előre konfigurált MCP connectort tartalmaz:

### Produktivitás

| Connector | Típus | Hitelesítés |
|-----------|-------|------------|
| Google Drive | lokális | OAuth |
| Gmail | lokális | OAuth |
| Google Calendar | távoli | OAuth |
| Notion | távoli | OAuth |
| Fireflies | lokális | OAuth |

### Kommunikáció

| Connector | Típus | Hitelesítés |
|-----------|-------|------------|
| Slack | távoli | OAuth |

### Fejlesztés és rendszer

| Connector | Típus | Hitelesítés |
|-----------|-------|------------|
| GitHub | lokális | API kulcs |
| Filesystem | lokális | nincs |
| Playwright (böngésző) | lokális | nincs |

### Keresés és AI

| Connector | Típus | Hitelesítés |
|-----------|-------|------------|
| Brave Search | lokális | API kulcs |
| ElevenLabs | lokális | API kulcs |
| fal.ai | távoli | OAuth |

### Pénzügy

| Connector | Típus | Hitelesítés |
|-----------|-------|------------|
| Billingo | távoli | OAuth |
| Wise | távoli | OAuth |

## MCP connector hozzáadása (dashboard)

1. Nyisd meg a dashboard Beállítások > MCP oldalt
2. Válaszd ki a kívánt connectort a katalógusból
3. Add meg a szükséges hitelesítési adatokat (API kulcs vagy OAuth)
4. Hatókör kiválasztása: projekt-szintű vagy adott ágens
5. Mentés -- az ágens következő indításakor betölti a szervert

### OAuth connectorok

Az OAuth-alapú connectoroknál (Google Drive, Gmail, Slack stb.) az első aktiváláskor megnyílik a böngésző a bejelentkezési oldalra. A bejelentkezés után a token a Vault-ba kerül.

### API kulcsos connectorok

Az API kulcsos connectoroknál (Brave Search, GitHub, ElevenLabs) a kulcsot a Vault tárolja. A `.mcp.json` fájlban a kulcs `vault:<id>` hivatkozásként szerepel, soha nem sima szövegként.

Példa Brave Search beállításra:

```json
{
  "mcpServers": {
    "brave-search": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-brave-search"],
      "env": {
        "BRAVE_API_KEY": "vault:brave-api-key"
      }
    }
  }
}
```

## Vault integráció

Az MCP konfigurációkban a titkos értékek (API kulcsok, tokenek) `vault:<id>` hivatkozásokkal tárolhatók. A Marveen három wrapper szkriptet biztosít a Vault-értékek injektálásához (részletesen lásd [F02 Konfiguráció](F02-konfiguracio.md)):

| Szkript | Mikor használd |
|---------|---------------|
| `vault-env-wrapper.sh` | A titkos értéket env-változóként várja az MCP szerver |
| `vault-file-materializer.sh` | A titkos értéket fájlútvonalként várja (pl. hitelesítési JSON) |
| `vault-inject-http-mcp.sh` | HTTP MCP szerver fejléciben (`headers`) lévő vault hivatkozások feloldása |

A `vault-inject-http-mcp.sh` csak a Claude Code indítása előtt fut, és a `~/.claude.json` `mcpServers.*.headers` mezőit olvassa -- a titkos értékeket soha nem írja fájlba.

## Egyéni MCP szerver hozzáadása

A katalógusban nem szereplő egyéni MCP szervereket közvetlenül a `.mcp.json` fájlba is felveheted:

```json
{
  "mcpServers": {
    "sajat-szerver": {
      "command": "node",
      "args": ["/az/en/mcp-szerverem/index.js"],
      "env": {
        "TITKOS_KULCS": "vault:sajat-api-kulcs"
      }
    }
  }
}
```

A projektgyökér `.mcp.json`-t az update.sh nem módosítja -- az egyéni kiegészítések megőrződnek frissítés után is.

## Connector hozzárendelése ágensekhez

Alapértelmezetten az ágensek öröklik a projektgyökér `.mcp.json` összes szerverét. Ha egy adott connector csak egy ágensnek szükséges, tedd az `agents/<name>/.mcp.json` fájlba:

```bash
# Csak az adott ágens látja ezt a connectort
agents/
  <name>/
    .mcp.json   # csak erre az ágensre vonatkozik
```

Fordítva: ha egy connector mindenkinek szükséges, a projekt gyökerében `.mcp.json`-ban definálld.

## Hibaelhárítás

### Az MCP szerver nem indul el

A connectorok indulási naplója a channels session pane-ben látható (`tmux attach -t <agent-id>`). Közös okok:

- Az `npx` nem érhető el: ellenőrizd, hogy a `node_modules/.bin` elérési útban van-e
- Hibás API kulcs: ellenőrizd a Vault-bejegyzést a dashboard Beállítások > Vault oldalán
- OAuth token lejárt: a dashboard MCP oldalán az adott connector újrahitelesíthető

### "vault:<id> not found" hiba

A hivatkozott Vault-bejegyzés nem létezik. Hozd létre a dashboard Beállítások > Vault oldalán, a bejegyzés ID-ja egyezzen meg a `.mcp.json`-ban használt hivatkozással.

### Playwright / böngésző connector

A Playwright connector Chrome/Chromium installációt igényel. Ha nincs telepítve:

```bash
npx playwright install chromium
```

---

*Előző fejezet: [F05 Csatornák konfigurálása](F05-csatornak.md)*
*Következő fejezet: F07 Fleet és tenant-kezelés (hamarosan)*
