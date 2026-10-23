#!/usr/bin/env python3
"""Fluo-app server: web-app + gedeelde database voor de fluo/helm-actie.

Alleen de standaardbibliotheek van Python is nodig (3.9+), dus dit draait
zonder extra installaties op een Raspberry Pi, een schoolserver of een pc.

Starten:   python3 server.py
Instellen via omgevingsvariabelen:
  FLUO_ADMIN_PASSWORD  wachtwoord voor het beheerdersgedeelte (verplicht aan te passen!)
  FLUO_CODE            optionele schoolcode die elke gebruiker één keer moet ingeven
  FLUO_PORT            poort (standaard 8080)
  FLUO_DB              pad naar de database (standaard fluo.db naast dit bestand)
"""
import csv
import hmac
import io
import json
import os
import random
import sqlite3
import threading
from datetime import date
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

BASE = Path(__file__).resolve().parent
STATIC = BASE / "static"
DB_PATH = Path(os.environ.get("FLUO_DB", BASE / "fluo.db"))
ADMIN_PASSWORD = os.environ.get("FLUO_ADMIN_PASSWORD", "admin")
ACCESS_CODE = os.environ.get("FLUO_CODE", "")
PORT = int(os.environ.get("FLUO_PORT", "8080"))

db_lock = threading.Lock()
db = sqlite3.connect(DB_PATH, check_same_thread=False)
db.row_factory = sqlite3.Row
db.executescript("""
PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS leerlingen (
    id         INTEGER PRIMARY KEY,
    klas       TEXT NOT NULL,
    jaar       INTEGER NOT NULL,
    nr         INTEGER,
    achternaam TEXT NOT NULL,
    voornaam   TEXT NOT NULL,
    correctie  INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS registraties (
    leerling_id INTEGER NOT NULL REFERENCES leerlingen(id) ON DELETE CASCADE,
    datum       TEXT NOT NULL,
    helm        INTEGER NOT NULL DEFAULT 0,
    fluo        INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (leerling_id, datum)
);
CREATE TABLE IF NOT EXISTS meta (sleutel TEXT PRIMARY KEY, waarde TEXT);
INSERT OR IGNORE INTO meta VALUES ('versie', '1');
""")
db.execute("PRAGMA foreign_keys=ON")
db.commit()


def bump_version():
    """Elke wijziging verhoogt de versie, zodat toestellen weten dat ze moeten verversen."""
    db.execute("UPDATE meta SET waarde = CAST(waarde AS INTEGER) + 1 WHERE sleutel = 'versie'")


def current_version():
    return int(db.execute("SELECT waarde FROM meta WHERE sleutel = 'versie'").fetchone()[0])


def year_from_class(klas):
    digits = "".join(ch for ch in klas if ch.isdigit())
    return int(digits[0]) if digits else 0


def all_students():
    today = date.today().isoformat()
    rows = db.execute("""
        SELECT l.*,
               COALESCE(SUM(r.helm), 0) AS helm_dagen,
               COALESCE(SUM(r.fluo), 0) AS fluo_dagen,
               COALESCE(MAX(CASE WHEN r.datum = ? THEN r.helm END), 0) AS helm_vandaag,
               COALESCE(MAX(CASE WHEN r.datum = ? THEN r.fluo END), 0) AS fluo_vandaag
        FROM leerlingen l LEFT JOIN registraties r ON r.leerling_id = l.id
        GROUP BY l.id
        ORDER BY l.jaar, l.klas, l.nr IS NULL, l.nr, l.achternaam COLLATE NOCASE, l.voornaam COLLATE NOCASE
    """, (today, today)).fetchall()
    result = []
    for r in rows:
        d = dict(r)
        d["punten"] = max(0, d["helm_dagen"] + d["fluo_dagen"] + d["correctie"])
        result.append(d)
    return result


def parse_students_csv(text):
    """Leest een CSV/Excel-export. Herkent kolommen op naam; anders volgorde klas;nr;achternaam;voornaam."""
    text = text.lstrip("﻿")
    sample = text[:2000]
    delimiter = ";" if sample.count(";") >= sample.count(",") else ","
    if "\t" in sample and sample.count("\t") > sample.count(delimiter):
        delimiter = "\t"
    rows = [r for r in csv.reader(io.StringIO(text), delimiter=delimiter) if any(c.strip() for c in r)]
    if not rows:
        return []

    aliases = {
        "klas": ("klas", "klasgroep", "class", "groep"),
        "nr": ("nr", "nummer", "klasnummer", "klasnr", "nr.", "number"),
        "achternaam": ("achternaam", "naam", "familienaam", "lastname", "last name"),
        "voornaam": ("voornaam", "firstname", "first name"),
        "jaar": ("jaar", "leerjaar", "year"),
    }
    header = [c.strip().lower() for c in rows[0]]
    cols = {}
    for key, names in aliases.items():
        for i, h in enumerate(header):
            if h in names and i not in cols.values():
                cols[key] = i
                break
    if "klas" in cols and "achternaam" in cols:
        rows = rows[1:]
    else:
        cols = {"klas": 0, "nr": 1, "achternaam": 2, "voornaam": 3}

    def cell(row, key):
        i = cols.get(key)
        return row[i].strip() if i is not None and i < len(row) else ""

    students = []
    for row in rows:
        klas = cell(row, "klas").upper().replace(" ", "")
        achternaam = cell(row, "achternaam")
        if not klas or not achternaam:
            continue
        nr = cell(row, "nr")
        jaar = cell(row, "jaar")
        students.append({
            "klas": klas,
            "nr": int(nr) if nr.isdigit() else None,
            "achternaam": achternaam,
            "voornaam": cell(row, "voornaam"),
            "jaar": int(jaar) if jaar.isdigit() else year_from_class(klas),
        })
    return students


def draw_winners(candidates, count):
    """Gewogen loting zonder teruglegging: elk punt is één lotje, elke leerling wint max. 1 keer."""
    rng = random.SystemRandom()
    pool = [c for c in candidates if c["punten"] > 0]
    winners = []
    while pool and len(winners) < count:
        pick = rng.choices(pool, weights=[c["punten"] for c in pool], k=1)[0]
        winners.append(pick)
        pool.remove(pick)
    return winners


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(STATIC), **kwargs)

    def end_headers(self):
        # Laat browsers altijd controleren op een nieuwe versie, zodat updates meteen op elke gsm staan
        if not self.path.startswith("/api/"):
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def log_message(self, fmt, *args):
        if not self.path.startswith("/api/state"):
            super().log_message(fmt, *args)

    # --- hulpfuncties -------------------------------------------------------
    def send_json(self, data, status=HTTPStatus.OK):
        body = json.dumps(data, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_csv(self, filename, header, rows):
        buf = io.StringIO()
        writer = csv.writer(buf, delimiter=";")  # ; zodat Excel (Belgische instellingen) het meteen goed opent
        writer.writerow(header)
        writer.writerows(rows)
        body = ("﻿" + buf.getvalue()).encode("utf-8")
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "text/csv; charset=utf-8")
        self.send_header("Content-Disposition", f'attachment; filename="{filename}"')
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def read_json(self):
        length = int(self.headers.get("Content-Length") or 0)
        if not length:
            return {}
        return json.loads(self.rfile.read(length).decode("utf-8"))

    def has_access(self):
        return not ACCESS_CODE or hmac.compare_digest(self.headers.get("X-Code", ""), ACCESS_CODE)

    def is_admin(self):
        return hmac.compare_digest(self.headers.get("X-Admin", ""), ADMIN_PASSWORD)

    # --- routes -------------------------------------------------------------
    def do_GET(self):
        url = urlparse(self.path)
        query = parse_qs(url.query)
        if not url.path.startswith("/api/"):
            return super().do_GET()

        if url.path == "/api/config":
            return self.send_json({"codeNodig": bool(ACCESS_CODE)})
        if not self.has_access() and not self.is_admin():
            return self.send_json({"fout": "Verkeerde schoolcode"}, HTTPStatus.UNAUTHORIZED)

        if url.path == "/api/state":
            with db_lock:
                version = current_version()
                if query.get("versie", [""])[0] == str(version):
                    return self.send_json({"versie": version, "ongewijzigd": True})
                return self.send_json({
                    "versie": version,
                    "vandaag": date.today().isoformat(),
                    "leerlingen": all_students(),
                })

        if not self.is_admin():
            return self.send_json({"fout": "Enkel voor de beheerder"}, HTTPStatus.FORBIDDEN)

        if url.path == "/api/admin/export.csv":
            with db_lock:
                students = all_students()
            return self.send_csv(
                f"fluo-totalen-{date.today().isoformat()}.csv",
                ["jaar", "klas", "nr", "achternaam", "voornaam", "dagen helm", "dagen fluo", "correctie", "punten"],
                [[s["jaar"], s["klas"], s["nr"] or "", s["achternaam"], s["voornaam"],
                  s["helm_dagen"], s["fluo_dagen"], s["correctie"], s["punten"]] for s in students],
            )
        if url.path == "/api/admin/registraties.csv":
            with db_lock:
                rows = db.execute("""
                    SELECT r.datum, l.klas, l.nr, l.achternaam, l.voornaam, r.helm, r.fluo
                    FROM registraties r JOIN leerlingen l ON l.id = r.leerling_id
                    WHERE r.helm OR r.fluo
                    ORDER BY r.datum, l.klas, l.nr IS NULL, l.nr, l.achternaam COLLATE NOCASE
                """).fetchall()
            return self.send_csv(
                f"fluo-registraties-{date.today().isoformat()}.csv",
                ["datum", "klas", "nr", "achternaam", "voornaam", "helm", "fluo"],
                [[r["datum"], r["klas"], r["nr"] or "", r["achternaam"], r["voornaam"], r["helm"], r["fluo"]]
                 for r in rows],
            )
        self.send_json({"fout": "Onbekend"}, HTTPStatus.NOT_FOUND)

    def do_POST(self):
        url = urlparse(self.path)
        try:
            data = self.read_json()
        except (ValueError, UnicodeDecodeError):
            return self.send_json({"fout": "Ongeldige gegevens"}, HTTPStatus.BAD_REQUEST)

        if url.path == "/api/admin/login":
            return self.send_json({"ok": self.is_admin()})
        if url.path == "/api/code":
            return self.send_json({"ok": self.has_access()})
        if not self.has_access() and not self.is_admin():
            return self.send_json({"fout": "Verkeerde schoolcode"}, HTTPStatus.UNAUTHORIZED)

        if url.path == "/api/markeer":
            # Zet de stand van vandaag (idempotent: twee keer tikken = geen dubbel punt)
            try:
                student_id = int(data["id"])
            except (KeyError, TypeError, ValueError):
                return self.send_json({"fout": "Ongeldige leerling"}, HTTPStatus.BAD_REQUEST)
            helm, fluo = int(bool(data.get("helm"))), int(bool(data.get("fluo")))
            with db_lock:
                if not db.execute("SELECT 1 FROM leerlingen WHERE id = ?", (student_id,)).fetchone():
                    return self.send_json({"fout": "Leerling niet gevonden"}, HTTPStatus.NOT_FOUND)
                db.execute("""
                    INSERT INTO registraties (leerling_id, datum, helm, fluo) VALUES (?, ?, ?, ?)
                    ON CONFLICT (leerling_id, datum) DO UPDATE SET helm = excluded.helm, fluo = excluded.fluo
                """, (student_id, date.today().isoformat(), helm, fluo))
                bump_version()
                db.commit()
            return self.send_json({"ok": True})

        if not self.is_admin():
            return self.send_json({"fout": "Enkel voor de beheerder"}, HTTPStatus.FORBIDDEN)

        with db_lock:
            if url.path == "/api/admin/correctie":
                db.execute("UPDATE leerlingen SET correctie = correctie + ? WHERE id = ?",
                           (int(data.get("delta", 0)), int(data["id"])))
            elif url.path == "/api/admin/leerling":
                klas = str(data.get("klas", "")).upper().replace(" ", "")
                achternaam = str(data.get("achternaam", "")).strip()
                if not klas or not achternaam:
                    return self.send_json({"fout": "Klas en achternaam zijn verplicht"}, HTTPStatus.BAD_REQUEST)
                nr = data.get("nr")
                values = (klas, year_from_class(klas), int(nr) if str(nr or "").isdigit() else None,
                          achternaam, str(data.get("voornaam", "")).strip())
                if data.get("id"):
                    db.execute("UPDATE leerlingen SET klas=?, jaar=?, nr=?, achternaam=?, voornaam=? WHERE id=?",
                               values + (int(data["id"]),))
                else:
                    db.execute("INSERT INTO leerlingen (klas, jaar, nr, achternaam, voornaam) VALUES (?,?,?,?,?)",
                               values)
            elif url.path == "/api/admin/verwijder":
                db.execute("DELETE FROM leerlingen WHERE id = ?", (int(data["id"]),))
            elif url.path == "/api/admin/import":
                students = parse_students_csv(str(data.get("csv", "")))
                if not students:
                    return self.send_json({"fout": "Geen leerlingen gevonden in het bestand"}, HTTPStatus.BAD_REQUEST)
                if data.get("vervangen"):
                    db.execute("DELETE FROM registraties")
                    db.execute("DELETE FROM leerlingen")
                added = updated = 0
                for s in students:
                    existing = db.execute(
                        "SELECT id FROM leerlingen WHERE klas=? AND achternaam=? AND voornaam=? COLLATE NOCASE",
                        (s["klas"], s["achternaam"], s["voornaam"])).fetchone()
                    if existing:
                        db.execute("UPDATE leerlingen SET nr=?, jaar=? WHERE id=?", (s["nr"], s["jaar"], existing[0]))
                        updated += 1
                    else:
                        db.execute("INSERT INTO leerlingen (klas, jaar, nr, achternaam, voornaam) VALUES (?,?,?,?,?)",
                                   (s["klas"], s["jaar"], s["nr"], s["achternaam"], s["voornaam"]))
                        added += 1
                bump_version()
                db.commit()
                return self.send_json({"ok": True, "toegevoegd": added, "bijgewerkt": updated})
            elif url.path == "/api/admin/reset":
                db.execute("DELETE FROM registraties")
                db.execute("UPDATE leerlingen SET correctie = 0")
            elif url.path == "/api/admin/loting":
                students = all_students()
                ids = set(data.get("ids") or [s["id"] for s in students])
                candidates = [s for s in students if s["id"] in ids]
                winners = draw_winners(candidates, max(1, int(data.get("aantal", 1))))
                return self.send_json({
                    "winnaars": winners,
                    "deelnemers": sum(1 for c in candidates if c["punten"] > 0),
                    "lotjes": sum(c["punten"] for c in candidates),
                })
            else:
                return self.send_json({"fout": "Onbekend"}, HTTPStatus.NOT_FOUND)
            bump_version()
            db.commit()
        self.send_json({"ok": True})


if __name__ == "__main__":
    if ADMIN_PASSWORD == "admin":
        print("LET OP: het beheerderswachtwoord is nog 'admin'. Stel FLUO_ADMIN_PASSWORD in!")
    print(f"Fluo-app draait op http://0.0.0.0:{PORT}  (database: {DB_PATH})")
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
