# Fluo
Voor de fluo-actie van SFE.

Een web-app die bijhoudt hoeveel keer een leerling met **helm** ⛑️ en/of **fluovestje** 🦺 naar school kwam.
Per dag levert elk 1 punt op. Werkt in de browser op iPhone, Android en pc, en alle toestellen zien dezelfde gegevens.

## Wat kan je ermee?

**Iedereen**
- Startscherm: kies **Klassen** of **Zoeken**
- Klassen: kies het jaar (gegroepeerd per graad) → de klas → namenlijst, alfabetisch op achternaam, met klasnummer,
  punten per leerling en het klastotaal
- Tik op een leerling → duid **Helm** en/of **Fluovestje** aan (+1 punt elk). Verkeerd getikt? Nog eens tikken maakt het ongedaan.
  Per dag kan een leerling dus max. 2 punten krijgen.
- Zonder internet werkt het verder: tikken worden later verstuurd (bolletje rechtsboven wordt rood zolang dat zo is).

**Beheerder** (link onderaan het startscherm, met wachtwoord)
- 📊 **Overzicht**: alle leerlingen, filteren op graad/jaar/klas/naam, sorteren op punten (of klas, naam…).
  Tik op een leerling om punten manueel bij te stellen, de gegevens te wijzigen of de leerling te verwijderen.
- 🎲 **Loting**: kies het aantal winnaars. Elk punt is één lotje (7 punten = 7× zoveel kans als 1 punt) en
  niemand kan twee keer winnen. De filters bepalen wie meedoet (bv. enkel de 1e graad).
- 👥 **Leerlingen**: importeren uit CSV/Excel, één leerling toevoegen, alles op nul zetten,
  en **exporteren naar Excel**.

## Openen in Excel

In **Beheerder → Leerlingen → Exporteren** download je:
- `fluo-totalen-<datum>.csv`: per leerling jaar, klas, nr, naam, dagen helm, dagen fluo, correctie en punten
- `fluo-registraties-<datum>.csv`: elke aanduiding per dag (handig voor statistieken)

Dubbelklik het bestand en Excel opent het meteen in kolommen (puntkomma als scheidingsteken en UTF-8,
zodat namen met é, ë… goed blijven). De database zelf is het bestand `fluo.db` (SQLite) naast `server.py`.

## Leerlingen importeren

Maak in Excel een blad met de kolommen `klas`, `nr`, `achternaam`, `voornaam` en kies
**Opslaan als → CSV (gescheiden door lijstscheidingsteken)**. Zie [voorbeeld_leerlingen.csv](voorbeeld_leerlingen.csv).
Het jaar wordt afgeleid uit het eerste cijfer van de klas (`3A` → 3e jaar), of uit een kolom `jaar`.
Opnieuw importeren werkt bestaande leerlingen bij (zelfde klas + naam) zonder punten te verliezen.

## Starten

Enkel Python 3.9 of nieuwer is nodig, geen extra pakketten.

```bash
FLUO_ADMIN_PASSWORD=geheim python3 server.py
```

Open daarna `http://<ip-van-de-computer>:8080` op de gsm (zelfde netwerk). Op iPhone: **Deel → Zet op beginscherm**,
op Android: **⋮ → Toevoegen aan startscherm**, dan staat de app als icoon op het toestel.

Instellingen (omgevingsvariabelen):

| Variabele | Betekenis | Standaard |
|---|---|---|
| `FLUO_ADMIN_PASSWORD` | wachtwoord voor het beheerdersgedeelte | `admin` (aanpassen!) |
| `FLUO_CODE` | schoolcode die elk toestel één keer moet ingeven (leeg = geen code) | leeg |
| `FLUO_PORT` | poort | `8080` |
| `FLUO_DB` | pad naar de database | `fluo.db` |

### Op een Raspberry Pi (altijd aan)

```bash
git clone -b V1 https://github.com/weggos2000/Fluo.git ~/Fluo
sudo cp ~/Fluo/fluo.service /etc/systemd/system/
sudo nano /etc/systemd/system/fluo.service   # wachtwoord en eventueel schoolcode invullen
sudo systemctl enable --now fluo
```

Moet de app ook buiten het schoolnetwerk werken (bv. mobiele data), zet er dan een tunnel voor
(bv. Cloudflare Tunnel of Tailscale Funnel) zodat je een https-adres krijgt. Gebruik in dat geval zeker een `FLUO_CODE`.

**Back-up**: kopieer af en toe `fluo.db`, of download de Excel-export.
